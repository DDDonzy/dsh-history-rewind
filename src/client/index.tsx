/**
 * Browser half of @deepseek-ai/dsh-history-rewind: a flat, Trajectory/DevTools-inspired
 * timeline panel that renders the session's git graph, lists commits concisely,
 * takes manual snapshots, and rewinds in place via the Host channel.
 *
 * @module @deepseek-ai/dsh-history-rewind/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { createElement, Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { fetchTimeline, rewind, manualSnapshot, get, gitStatus, installGit, type TimelineRow } from './api.ts'
import { ROUTE_PREFIX, SETTINGS_NAMESPACE } from '../constants.ts'
import { buildGraph, roadSet, type GraphRow, type RailEdge } from './layout.ts'
import {
  injectStyles,
  PANEL,
  BUTTON,
  ROW,
  ROW_CONTENT,
  ROW_MAIN,
  ROW_SIDE,
  SHA_BADGE,
  MSG_LIST,
  MSG_ITEM,
  MSG_ROLE,
  MSG_ROLE_USER,
  MSG_ROLE_ASST,
  MSG_TEXT,
  SINGLE_LINE,
  SINGLE_TEXT,
  FILE_LIST,
  FILE_CHIP,
  FILE_CLIP,
  FILE_INDENT,
  DIALOG,
  DIALOG_HEAD,
  DIALOG_TITLE,
  DIALOG_CLOSE,
  DIALOG_DESCRIPTION,
  DIALOG_FOOT,
  HINT,
  MODAL_BACKDROP,
  MODAL_CARD,
  MODAL_BODY,
  GRAPH_CELL,
  PROGRESS_MASK,
  PROGRESS_CARD,
} from './styles.ts'

/** Services the browser half requires before it can contribute. */
export const inject = ['sessions', 'slots']

/** Scope record shape: the per-session binding the runtime keeps resident even
 *  while the host session is transiently disposed (staged/frozen view). */
interface ScopeRecordLike {
  binding?: {
    session?: {
      resync?: () => Promise<unknown>
      /** `host/session-removed` flag the runtime sets on the resident instance.
       *  A rewind re-adds the same session id, but the runtime never clears it —
       *  the composer would stay locked as 「会话不可用」 forever. */
      removed?: boolean
    }
  }
}

/** Structural view of the client sessions service */
interface SessionsFace {
  list: {
    getSnapshot(): { current?: string; ids?: string[] }
    subscribe(listener: () => void): () => void
  }
  clear?(): void
  open?(id: string): void
  scopes?: Map<string, ScopeRecordLike>
  deferredRemovals?: Set<string>
  dropScope?(id: string, record: unknown): void
}

/** Small delay helper. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Rebind session view after a rewind — in place when the runtime allows it.
 *
 *  The client Session instance survives the host detach/resume (the runtime's
 *  resident-instance rule: `host/session-removed` only flags it), so the
 *  conversation window can be re-pulled WITHOUT tearing down the scope, without
 *  clearing the selection and without bouncing through the no-session hero.
 *  `session.resync()` is the runtime's own reconnect rebuild: it resets the
 *  window and reruns `open()`, and — because the chat assembler is untouched
 *  until the fresh window installs — the old conversation stays painted while
 *  the fetch runs, then swaps instantly to the rewind target. No flash.
 *
 *  Falls back to the legacy rebuild (scope teardown → clear → reopen, or a
 *  full page reload) only when the runtime exposes neither `resync` nor the
 *  scope primitives (older shells, or the instance was really lost).
 */
async function rebindView(sessions: SessionsFace, sessionId: string): Promise<string> {
  const record = sessions.scopes?.get(sessionId)
  const session = record?.binding?.session
  if (session !== undefined && typeof session.resync === 'function') {
    try {
      // The instance survives the host detach (resident-instance rule), but
      // the runtime never clears the `removed` flag it received from
      // host/session-removed — the composer would stay locked as
      // 「会话不可用」 forever. The session is live again (re-added), so clear
      // the flag as part of the in-place refresh; resync() republishes the
      // snapshot so the composer unlocks immediately.
      if (session.removed === true) session.removed = false
      await session.resync()
      return '会话视图已原位刷新'
    } catch {
      // Instance resync failed (e.g. mid-teardown): fall through to the legacy path.
    }
  }

  await wait(250)
  const record2 = sessions.scopes?.get(sessionId)
  const dropScope = sessions.dropScope
  const clearSelection = sessions.clear
  const openSession = sessions.open
  if (record2 === undefined || dropScope === undefined || clearSelection === undefined || openSession === undefined) {
    setTimeout(() => { window.location.reload() }, 400)
    return '原语缺失，已自动刷新页面'
  }
  try {
    sessions.deferredRemovals?.delete(sessionId)
    sessions.scopes?.delete(sessionId)
    dropScope(sessionId, record2)
  } catch {
    setTimeout(() => { window.location.reload() }, 400)
    return 'dropScope 失败，已自动刷新页面'
  }
  const facade = sessions as SessionsFace & { watched?: unknown }
  let stageMoved = false
  if ('watched' in facade) {
    try {
      facade.watched = undefined
      stageMoved = true
    } catch {
      stageMoved = false
    }
  }
  if (!stageMoved) {
    const other = sessions.list.getSnapshot().ids?.find((id) => id !== sessionId)
    if (other !== undefined) {
      openSession(other)
      setTimeout(() => { openSession(sessionId) }, 250)
      return '已自动切走再切回（stage 复位不可用）'
    }
  }
  clearSelection()
  const attempt = (tries: number): void => {
    openSession(sessionId)
    if (tries <= 0) return
    setTimeout(() => {
      if (sessions.scopes?.has(sessionId) === true) return
      attempt(tries - 1)
    }, 250)
  }
  setTimeout(() => { attempt(3) }, 100)
  return stageMoved ? 'scope 重建 + stage 复位' : 'scope 重建（stage 复位不可用）'
}

/** Clean rail colors */
const RAIL_COLORS = [
  '#4d88ff', // Brand Blue (Main Road)
  '#ec4899', // Pink
  '#10b981', // Emerald
  '#f59e0b', // Amber
  '#8b5cf6', // Purple
  '#06b6d4', // Cyan
]

/** Relative time formatter */
function timeOf(ct: number): string {
  const delta = Date.now() / 1000 - ct
  if (delta < 5) return '刚刚'
  if (delta < 60) return `${Math.floor(delta)} 秒前`
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`
  return `${Math.floor(delta / 86400)} 天前`
}

/** Render Node Content in Flat Trajectory Row */
/** Max changed-file chips shown per row; overflow collapses into "+N". */
const MAX_FILES = 12

/** Render a changed-file chip line: at most MAX_FILES chips + "+N" indicator,
 *  kept on a single line by clipping overflow (BASELINE & TURN rows).
 *  With `indent` (TURN rows) a leading spacer shifts the chips to the message
 *  TEXT column — the line aligns with the USER/ASST content, not the badges. */
function FileChips(props: { files: string[]; indent?: boolean }): ReactNode {
  const { files, indent = false } = props
  if (files.length === 0) return null
  return createElement('div', { className: FILE_LIST },
    ...(indent ? [createElement('span', { className: FILE_INDENT }, null)] : []),
    createElement('div', { className: FILE_CLIP },
      files.slice(0, MAX_FILES).map((file) =>
        createElement('code', { className: FILE_CHIP, title: file, key: file }, file),
      ),
    ),
    files.length > MAX_FILES
      ? createElement('code', { className: FILE_CHIP, style: { color: 'var(--dsw-alias-label-secondary, #999)' } },
          `… +${files.length - MAX_FILES}`,
        )
      : null,
  )
}

function RowContentNode(props: { row: GraphRow; isHead: boolean }): ReactNode {
  const { row, isHead } = props
  const meta = row.meta
  const kind = meta?.kind ?? 'turn-start'
  const turn = meta?.turn
  const fullDate = new Date(row.ct * 1000).toLocaleString()

  // Right-aligned side indicators: relative time + `` id badge on the same line
  const sideElements = createElement('div', { className: ROW_SIDE },
    createElement('span', { className: 'dsh-history-time', title: fullDate }, timeOf(row.ct)),
    createElement('code', { className: SHA_BADGE }, row.sha.slice(0, 7)),
  )

  const files = row.files ?? []

  // 1. Baseline rows (turn-start): BASELINE badge + changed-file chips, all
  //    on one line. The stored commit subject stays "[CHECK POINT]" for
  //    parser compat.
  if (kind === 'turn-start') {
    const shown = files.slice(0, MAX_FILES)
    return createElement('div', { className: ROW_CONTENT },
      createElement('div', { className: ROW_MAIN },
        createElement('div', { className: `${SINGLE_LINE} ${FILE_LIST}` },
          createElement('span', { className: 'dsh-badge dsh-badge-turn-start' }, 'BASELINE'),
          // Chip clip: single line only — overflow clips and each chip shrinks,
          // so the trailing "+N" always stays visible on the same line.
          createElement('div', { className: FILE_CLIP },
            shown.map((file) =>
              createElement('code', { className: FILE_CHIP, title: file, key: file }, file),
            ),
          ),
          files.length > MAX_FILES
            ? createElement('code', { className: FILE_CHIP, style: { color: 'var(--dsw-alias-label-secondary, #999)' } },
                `… +${files.length - MAX_FILES}`,
              )
            : null,
        ),
      ),
      sideElements,
    )
  }

  // 2. Single-line for manual / rewind
  if (kind === 'manual' || kind === 'rewind') {
    const badge = kind === 'manual'
      ? createElement('span', { className: 'dsh-badge dsh-badge-manual' }, '手动快照')
      : createElement('span', { className: 'dsh-badge dsh-badge-rewind' }, `回退 → ${(meta?.target ?? '').slice(0, 7)}`)
    return createElement('div', { className: ROW_CONTENT },
      createElement('div', { className: ROW_MAIN },
        createElement('div', { className: SINGLE_LINE },
          badge,
          meta?.message ? createElement('span', { className: SINGLE_TEXT, title: meta.message }, meta.message) : null,
        ),
      ),
      sideElements,
    )
  }

  // 3. Multi-line for turn-end: USER + ASST message preview, then changed-file
  //    chips on their own line below.
  return createElement('div', { className: ROW_CONTENT },
    createElement('div', { className: ROW_MAIN },
      createElement('div', { className: MSG_LIST },
        meta?.userMessage
          ? createElement('div', { className: MSG_ITEM },
              createElement('span', { className: `${MSG_ROLE} ${MSG_ROLE_USER}` }, 'USER'),
              createElement('span', { className: MSG_TEXT, title: meta.userMessage }, meta.userMessage),
            )
          : null,
        createElement('div', { className: MSG_ITEM },
          createElement('span', { className: `${MSG_ROLE} ${MSG_ROLE_ASST}` }, 'ASST'),
          createElement('span', { className: MSG_TEXT, title: meta?.asstMessage ?? meta?.message ?? '' }, meta?.asstMessage ?? meta?.message ?? '—'),
        ),
      ),
      // Indented chips: align with the message TEXT column (under USER's
      // reply text) rather than with the USER/ASST role badges.
      createElement(FileChips, { files, indent: true }),
    ),
    sideElements,
  )
}

/** Geometry for Git Graph */
const LANE_W = 16
const NODE_R = 4
const RAIL_W = 2
const NODE_GAP = 2

/** Row heights (compact flat list) */
const ROW_H_SINGLE = 22
/** Turn-end rows show one message line per side (USER + ASST). */
const ROW_H_TURN = 46
/** Turn-end row with files: extra line of chips (~16px incl. gap). */
const ROW_H_FILES = 16

function rowHeightOf(row: GraphRow): number {
  if (row.meta?.kind === 'turn-end') {
    return (row.files ?? []).length > 0 ? ROW_H_TURN + ROW_H_FILES : ROW_H_TURN
  }
  // Baseline rows render chips inline with the badge — single line, no bump.
  return ROW_H_SINGLE
}

const laneX = (lane: number): number => 12 + lane * LANE_W

function railPath(edge: RailEdge, y0: number, y1: number): string {
  const x0 = laneX(edge.from)
  const x1 = laneX(edge.to)
  if (x0 === x1) return `M ${x0} ${y0} L ${x1} ${y1}`
  const my = (y0 + y1) / 2
  return `M ${x0} ${y0} C ${x0} ${my}, ${x1} ${my}, ${x1} ${y1}`
}

/** Graph SVG cell */
function GraphCell(props: {
  row: GraphRow
  lanes: number
  colors: string[]
  headLanes: number[]
  isHead: boolean
  isHovered: boolean
  /** Shas NEWER than HEAD ("future" children past the current position).
   * Colour follows the RAIL (its endpoint pair), exactly like the hover
   * highlight: an edge whose child is in this set draws blue-grey; HEAD and
   * its ancestors keep the normal vivid blue. */
  futureSet: Set<string>
  height: number
  /** Non-null when some row is hovered: shas on that row's ancestor path. */
  hoverPath: Set<string> | null
}) {
  const { row, lanes, colors, headLanes, isHead, isHovered, futureSet, height, hoverPath } = props
  // +8 right margin + 12 left inset (laneX base): keeps even hovered ring
  // (r ~ 7.5 + stroke) fully inside the cell.
  const width = Math.max(1, lanes) * LANE_W + 8
  const mid = height / 2
  const nodeX = laneX(row.lane)

  // Rail color is decided by which ROAD the rail (its lane) belongs to, not by
  // the row it happens to cross: a rail is a continuous line across many rows,
  // so the main rail must keep its color even while passing abandoned-row
  // cells, and an abandoned fork rail must be grey even where its row shares
  // the fork point (a head-road row).
  const grey = '#6b6b6d'
  const HOVER = '#4d88ff' // bright accent blue for the hovered ancestor path
  // "Beyond HEAD": a rail whose child is a row NEWER than the current position
  // draws in a blue-grey BETWEEN the brand blue and the rail grey. Like the
  // hover highlight, colour follows the RAIL (endpoint pair), never the row —
  // a rail keeps ONE colour across every row it crosses. HEAD and its
  // ancestors keep the normal vivid blue; abandoned forks stay plain grey.
  const AFTER_HEAD = '#7086ab'
  const onHead = (lane: number): boolean => headLanes.includes(lane)

  // Hover path: shas on the hovered row's ancestor chain (incl. itself).
  // A rail segment lights up when BOTH of its endpoints (childSha, parentSha —
  // constant across the whole rail) lie on that path. This is precise at fork
  // points: only the branch that leads INTO the hovered road highlights, while
  // the other fork goes grey; a rail crossing unrelated rows also keeps its
  // highlight because the endpoint pair does not change along its length.
  //
  // While hovering, EVERYTHING that is not on the path is pushed to grey —
  // the color focus is fully on the ancestors of the hovered commit.
  const hovering = hoverPath !== null
  const onPath = hovering && hoverPath.has(row.sha)
  const hoverEdge = (edge: RailEdge): boolean =>
    hoverPath !== null && hoverPath.has(edge.childSha) && hoverPath.has(edge.parentSha)
  const strokeOf = (edge: RailEdge): string => {
    if (hoverEdge(edge)) return HOVER
    if (hovering) return grey
    // Rail colour is endpoint-driven: an edge leading INTO the future set
    // (its child is newer than HEAD) is the blue-grey, even where it crosses
    // head-row cells; HEAD's own rail keeps the vivid blue.
    if (futureSet.has(edge.childSha)) return AFTER_HEAD
    return onHead(edge.lane) ? colors[edge.lane % colors.length]! : grey
  }
  const nodeColor = onPath
    ? HOVER
    : hovering ? grey
    : isHead ? colors[row.lane % colors.length]!
    : futureSet.has(row.sha) ? AFTER_HEAD
    : (onHead(row.lane) ? colors[row.lane % colors.length]! : grey)
  const railOpacity = (edge: RailEdge): number => {
    if (hoverEdge(edge)) return 1
    if (hovering) return 0.45 // dim non-path rails to keep focus
    return onHead(edge.lane) ? 0.85 : 0.6
  }

  const nodeStop = NODE_R + NODE_GAP
  const rails = [
    ...row.topEdges.map((edge, i) =>
      createElement('path', {
        key: `t${i}`,
        d: railPath(edge, 0, edge.to === row.lane ? mid - nodeStop : mid),
        fill: 'none',
        stroke: strokeOf(edge),
        strokeWidth: hoverEdge(edge) ? RAIL_W + 1.5 : RAIL_W,
        opacity: railOpacity(edge),
      }),
    ),
    ...row.bottomEdges.map((edge, i) =>
      createElement('path', {
        key: `b${i}`,
        d: railPath(edge, edge.from === row.lane ? mid + nodeStop : mid, height),
        fill: 'none',
        stroke: strokeOf(edge),
        strokeWidth: hoverEdge(edge) ? RAIL_W + 1.5 : RAIL_W,
        opacity: railOpacity(edge),
      }),
    ),
  ]

  // Commit Node: dots on the hovered path grow slightly larger; the row under
  // the cursor renders as a hollow ring (same visual language as HEAD).
  const nodeClass = 'dsh-history-node'
  const node = isHead || isHovered
    ? createElement('circle', {
        className: nodeClass,
        cx: nodeX,
        cy: mid,
        r: onPath ? NODE_R + 3 : NODE_R + 1,
        fill: 'var(--dsw-alias-bg-base, #1e1e1e)',
        stroke: nodeColor,
        strokeWidth: onPath ? 2.6 : isHead ? 2.4 : 2,
      })
    : createElement('circle', {
        className: nodeClass,
        cx: nodeX,
        cy: mid,
        r: onPath ? NODE_R + 2 : NODE_R,
        fill: nodeColor,
      })

  return createElement('svg', {
    className: GRAPH_CELL,
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    style: { width, minWidth: width },
  }, ...rails, node)
}

/** Timeline Row component */
function HistoryRow(props: {
  row: GraphRow
  lanes: number
  colors: string[]
  headLanes: number[]
  isHead: boolean
  isHovered: boolean
  isSelected: boolean
  hoverPath: Set<string> | null
  onHover: (sha: string | null) => void
  onSelect: (row: TimelineRow) => void
  /** True for the row that carries the scroll anchor during prepend. */
  anchor: boolean
  /** HEAD sha, for the data-sha hook used by initial centering. */
  headSha: string | null
  /** Measured per-sha row heights (from the live DOM) so the graph rails track
   *  rows that are taller than the estimated constant (e.g. wrapped content). */
  rowHeights: Record<string, number>
  /** Report a row's real painted height up to the panel. */
  onMeasure: (sha: string, height: number) => void
  /** Shas newer than HEAD (see GraphCell.futureSet). */
  futureSet: Set<string>
}) {
  const { row, lanes, colors, headLanes, isHead, isHovered, isSelected, hoverPath, onHover, onSelect, anchor, headSha, rowHeights, onMeasure, futureSet } = props
  const estimatedHeight = rowHeightOf(row)
  // Prefer the measured height once it is available — it reflects wrapped
  // content, so the graph cell (and its rails) fill the whole row.
  const height = rowHeights[row.sha] ?? estimatedHeight
  // Capture the real painted height (>= the estimate) so rails run the full
  // row. A stable ref identity keeps React from re-measuring on re-renders.
  const setRowEl = useCallback((node: HTMLDivElement | null): void => {
    if (node !== null) onMeasure(row.sha, node.offsetHeight)
  }, [row.sha, onMeasure])
  return createElement('div', {
    className: `${ROW} ${isSelected ? 'is-selected' : ''}`,
    style: { minHeight: estimatedHeight },
    ref: setRowEl,
    'data-sha': row.sha,
    ...(anchor ? { 'data-anchor': row.sha } : {}),
    onMouseEnter: () => onHover(row.sha),
    onMouseLeave: () => onHover(null),
    onClick: () => onSelect(row),
  },
    createElement(GraphCell, { row, lanes, colors, headLanes, isHead, isHovered, futureSet, height, hoverPath }),
    createElement(RowContentNode, { row, isHead }),
  )
}

/** Rewind progress reported to the shell: an opaque mask + centered status
 *  card once the panel closes at confirm, fading out after the view refreshed. */
type RewindPhase = 'working' | 'refreshing' | 'done' | 'idle'

/** Session id currently in the middle of a rewind: while set, client-side
 *  `host/session-removed` frames are intercepted so the session is never
 *  dropped from the list store, preventing `current` from becoming undefined
 *  and stopping the chat view from jumping to the initial blank hero page. */
let suppressingSessionId: string | null = null

/** History Panel */
function HistoryPanel(props: {
  sessionId: string
  rebind: (sessionId: string) => Promise<string>
  /** Close the panel (immediately on a confirmed rewind). */
  onRewound: () => void
  /** Reopen the panel with an error notice (rewind failed after immediate close). */
  onRewindFailed: (text: string) => void
  /** Rewind progress: 'working' while the host rewinds, 'refreshing' while the
   *  conversation view re-pulls, 'done' after it landed, 'idle' on failure. */
  onProgress: (phase: RewindPhase, sha: string) => void
  /** Render the confirm dialog into the plugin's own root container so the
   *  panel card can be hidden while the dialog is open. */
  portalTo: HTMLElement
  /** True while the rewind confirm dialog is open (panel card hides for it). */
  onDialogOpen: (open: boolean) => void
  /** Consumed at mount: show a pending failure notice from a rewind that
   *  failed while the panel was closed. */
  initialNotice?: string
  onInitialNoticeConsumed?: () => void
}) {
  const {
    sessionId, rebind, onRewound, onRewindFailed, onProgress, portalTo,
    onDialogOpen, initialNotice, onInitialNoticeConsumed,
  } = props
  const [rows, setRows] = useState<TimelineRow[] | null | undefined>(undefined)
  const [head, setHead] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<TimelineRow | null>(null)
  const [notice, setNotice] = useState<string>(initialNotice ?? '')
  // A failure notice pushed while the panel was closed arrives through the
  // initialNotice prop on the next (re)mount; when it changes while mounted,
  // surface it too, then acknowledge consumption so the shell clears it.
  useEffect(() => {
    if (initialNotice === undefined) return
    setNotice(initialNotice)
    onInitialNoticeConsumed?.()
  }, [initialNotice, onInitialNoticeConsumed])

  // While the rewind dialog is open, the shell hides the panel card; report the
  // open/close transition so the shell can re-show it on cancel.
  const dialogOpen = selected !== null
  useEffect(() => {
    onDialogOpen(dialogOpen)
  }, [dialogOpen, onDialogOpen])
  // Escape cancels the dialog first (the shell's Escape handler skips while the
  // dialog is open — otherwise it would close the whole panel).
  useEffect(() => {
    if (!dialogOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dialogOpen])
  /** Row currently hovered (sha), for ancestor-path highlight. */
  const [hoverSha, setHoverSha] = useState<string | null>(null)
  /** Measured per-sha row heights (real DOM height), keyed by sha. Falling back
   *  to the estimate lets the graph stretch to wrapped/taller rows. */
  const [rowHeights, setRowHeights] = useState<Record<string, number>>({})
  /** Store a row's measured height; no-op re-render when it already matches. */
  const measureRow = useCallback((sha: string, height: number): void => {
    setRowHeights((prev) => (prev[sha] === height ? prev : { ...prev, [sha]: height }))
  }, [])
  /** 500ms hover-delay timer: the graph only switches to the hovered path
   *  after the pointer rests on a row; leaving restores the current style
   *  immediately (the graph stays on HEAD unless the user wants to switch). */
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onHover = (sha: string | null): void => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
    if (sha === null) {
      // Pointer left: restore the current graph instantly.
      setHoverSha(null)
      return
    }
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null
      setHoverSha(sha)
    }, 500)
  }

  const load = async (): Promise<void> => {
    const [result, status] = await Promise.all([
      fetchTimeline(sessionId),
      get(`${ROUTE_PREFIX}/status?sessionId=${encodeURIComponent(sessionId)}`),
    ])
    if (result.ok && result.rows !== undefined) setRows(result.rows)
    else setRows(null)
    if (status !== null && typeof status.activeTip === 'string') setHead(status.activeTip)
  }
  useEffect(() => { void load() }, [sessionId])
  useEffect(() => () => {
    // Clear any pending hover-delay timer on unmount.
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }, [])

  const graph = useMemo(() => (rows === undefined || rows === null ? null : buildGraph(rows, head)), [rows, head])
  const headSha = head

  // HEAD-relative ordering: rows after HEAD's row (oldest-first) are the
  // "future" children. The set drives rail colour by ENDPOINT (like the hover
  // highlight) so a rail keeps one colour across every row it crosses. MUST be
  // declared before the early returns below (hooks order must be stable).
  const headIndex = headSha !== null && graph !== null ? graph.rows.findIndex((r) => r.sha === headSha) : -1
  const futureSet = useMemo(() => {
    const set = new Set<string>()
    if (headIndex < 0 || graph === null) return set
    for (let i = headIndex + 1; i < graph.rows.length; i++) set.add(graph.rows[i]!.sha)
    return set
  }, [graph, headIndex])

  // ---- Windowed timeline: load ±20 around the current (HEAD) position, then
  // extend by pages while scrolling toward either end. The full row list is
  // already in memory (the timeline API returns it in one shot), so "loading"
  // is purely a render-window slice; scroll anchoring keeps the view stable.
  const PAGE = 20
  const [winStart, setWinStart] = useState<{ rows: number; start: number; end: number } | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  /** Pending "center on HEAD" requests: set when the window re-anchors; the
   *  layout effect below consumes it once the new slice is painted. */
  const pendingCenter = useRef<string | null>(null)

  // Re-anchor the window whenever the graph (or HEAD) changes: center on HEAD.
  useEffect(() => {
    if (graph === null) return
    const len = graph.rows.length
    if (len === 0) return
    const headIdx = headSha === null
      ? len - 1
      : Math.max(0, graph.rows.findIndex((r) => r.sha === headSha))
    const start = Math.max(0, headIdx - PAGE)
    const end = Math.min(len, headIdx + PAGE + 1)
    pendingCenter.current = graph.rows[Math.min(headIdx, len - 1)]!.sha
    setWinStart({ rows: len, start, end })
  }, [graph, headSha])

  // Center the HEAD row after the window slice is actually in the DOM.
  useLayoutEffect(() => {
    const el = listRef.current
    if (el === null) return
    const sha = pendingCenter.current
    if (sha === null) return
    const target = el.querySelector(`[data-sha="${sha}"]`) as HTMLElement | null
    if (target === null) return
    el.scrollTop = Math.max(0, target.offsetTop - el.clientHeight / 2 + target.clientHeight / 2)
    pendingCenter.current = null
  }, [winStart, headSha])

  // Extend the window when the scrollport nears either end. Scroll anchoring:
  // when prepending rows above, the previously-visible content shifts down by
  // the added height, so we remember the anchor row and restore it after paint.
  const anchor = useRef({ sha: '', top: 0 })
  const onScroll = (): void => {
    const el = listRef.current
    const win = winStart
    if (el === null || win === null) return
    const nearTop = el.scrollTop < 48
    const nearBottom = el.scrollTop + el.clientHeight > el.scrollHeight - 48
    if (nearTop && win.start > 0) {
      const anchorEl = el.querySelector('[data-anchor]') as HTMLElement | null
      anchor.current = {
        sha: anchorEl?.dataset.anchor ?? '',
        top: anchorEl !== null ? anchorEl.getBoundingClientRect().top - el.getBoundingClientRect().top : 0,
      }
      setWinStart({ rows: win.rows, start: Math.max(0, win.start - PAGE), end: win.end })
    } else if (nearBottom && win.end < win.rows) {
      setWinStart({ rows: win.rows, start: win.start, end: Math.min(win.rows, win.end + PAGE) })
    }
  }

  // Restore the anchor position after a prepend (runs after the new DOM paint).
  useEffect(() => {
    if (anchor.current.sha === '') return
    const el = listRef.current
    if (el === null) return
    const target = el.querySelector(`[data-sha="${anchor.current.sha}"]`) as HTMLElement | null
    if (target !== null) {
      const now = target.getBoundingClientRect().top - el.getBoundingClientRect().top
      el.scrollTop += now - anchor.current.top
    }
    anchor.current = { sha: '', top: 0 }
  }, [winStart])

  // Ancestor path of the hovered row (itself + all parents up to the root):
  // every node and rail on this path highlights blue during hover.
  const hoverPath = useMemo(() => {
    if (hoverSha === null || rows === undefined || rows === null) return null
    return roadSet(rows, hoverSha)
  }, [hoverSha, rows])

  const doRewind = async (withWorkspace: boolean): Promise<void> => {
    if (selected === null) return
    // User confirmed the jump: close the panel NOW, before the host work
    // starts. The rewind runs in the background; the conversation area is
    // refreshed in place once (rebindView below) once the host resumes —
    // the panel is out of the way from the very first click.
    onRewound()
    const target = selected
    setSelected(null)
    const sha = target.sha.slice(0, 7)
    onProgress('working', sha)
    try {
      suppressingSessionId = sessionId
      const result = await rewind(sessionId, target.sha, withWorkspace)
      if (!result.ok) {
        onProgress('idle', '')
        onRewindFailed(`回档失败：${result.reason ?? 'unknown'}${result.error !== undefined ? `（${result.error}）` : ''}`)
        return
      }
      if (result.detached === true) {
        // Resume failed and the session is gone: a full page reload is the only
        // honest recovery for the client view.
        onProgress('idle', '')
        setTimeout(() => { window.location.reload() }, 400)
        return
      }
      // In-place refresh of the conversation window (no hero, no blank flash).
      onProgress('refreshing', sha)
      await rebind(sessionId)
      onProgress('done', sha)
    } finally {
      // Delay clearing slightly so any trailing host/session-removed frames settle
      setTimeout(() => {
        if (suppressingSessionId === sessionId) suppressingSessionId = null
      }, 500)
    }
  }

  /** Restore only the paired workspace tree; the live session is untouched. */
  const doWorkspaceOnly = async (): Promise<void> => {
    if (selected === null) return
    setBusy(true)
    setNotice('')
    const result = await rewind(sessionId, selected.sha, false, true)
    setSelected(null)
    setBusy(false)
    if (!result.ok) {
      setNotice(`仅工作区恢复失败：${result.reason ?? 'unknown'}${result.error !== undefined ? `（${result.error}）` : ''}`)
      return
    }
    setNotice(`已恢复工作区 ✓ ${selected.sha.slice(0, 7)} 的配对快照`)
  }

  const doSnapshot = async (): Promise<void> => {
    setBusy(true)
    setNotice('')
    const result = await manualSnapshot(sessionId)
    setBusy(false)
    setNotice(result.ok ? `已快照 ✓ ${result.snap ?? ''}` : `快照失败：${result.reason ?? 'unknown'}`)
    await load()
  }

  if (rows === undefined) {
    return createElement('div', { className: PANEL, style: { padding: 24, alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-secondary, #888)' } }, '正在读取会话历史…')
  }
  if (rows === null) {
    return createElement('div', { className: PANEL, style: { padding: 24, alignItems: 'center', justifyContent: 'center', gap: 10 } },
      createElement('span', { style: { color: 'var(--dsw-alias-state-error-primary, #f87171)' } }, '时间线不可用（未初始化或数据异常）'),
      createElement('button', { className: `${BUTTON} primary`, onClick: () => void doSnapshot() }, '创建首个快照'),
    )
  }
  if (rows.length === 0) {
    return createElement('div', { className: PANEL, style: { padding: 32, alignItems: 'center', justifyContent: 'center', gap: 12 } },
      createElement('div', { style: { color: 'var(--dsw-alias-label-secondary, #888)', textAlign: 'center', maxWidth: 560, lineHeight: 1.5, fontSize: 12 } },
        '当前会话尚未产生快照。发送消息后，TURN 开始与结束将自动记录。',
      ),
    )
  }

  // Slice the laid-out rows by the current window. layout output is oldest
  // first; the window indexes into it directly.
  const laid = graph !== null && winStart !== null && winStart.rows === graph.rows.length
    ? graph.rows.slice(winStart.start, winStart.end)
    : graph !== null ? graph.rows.slice(Math.max(0, graph.rows.length - PAGE * 2)) : null

  // HEAD-relative ordering is computed at the top (see the hook block near
  // `graph`); nothing hook-related lives after the early returns.

  return createElement('div', { className: PANEL },
    // Scrollable Flat Timeline List (Trajectory style), windowed ±20 around HEAD
    createElement('div', {
      className: MODAL_BODY,
      ref: (node: HTMLDivElement | null): void => { listRef.current = node },
      onScroll,
    },
      laid !== null && laid.map((row, listIdx) =>
        createElement(HistoryRow, {
          key: row.sha,
          row,
          lanes: graph!.lanes,
          colors: RAIL_COLORS,
          headLanes: graph!.headLanes,
          isHead: row.sha === headSha,
          isHovered: hoverSha === row.sha,
          isSelected: selected?.sha === row.sha,
          hoverPath,
          onHover,
          onSelect: (target) => {
            if (selected?.sha === target.sha) {
              setSelected(null)
            } else {
              setSelected(target)
            }
          },
          anchor: row.sha === headSha,
          headSha,
          rowHeights,
          onMeasure: measureRow,
          futureSet,
        }),
      ),
    ),

    // Selected Row Rewind Dialog — portaled into the plugin's own root so the
    // panel card can be hidden while it is open (the dialog floats over the
    // page; cancel returns the timeline exactly as it was).
    selected !== null
      ? createPortal(
          createElement('div', {
            className: MODAL_BACKDROP,
            style: {
              position: 'fixed',
              inset: 0,
              zIndex: 10001,
              padding: 16,
              background: 'transparent',
              backdropFilter: 'none',
            },
            onClick: () => setSelected(null),
          },
            createElement('div', {
              className: DIALOG,
              style: { margin: 0, animation: 'dshSlideUp 0.15s ease-out' },
              onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
            },
              createElement('div', { className: DIALOG_HEAD },
                createElement('h2', { className: DIALOG_TITLE }, '回档'),
                createElement('button', {
                  className: DIALOG_CLOSE,
                  title: '关闭',
                  onClick: () => setSelected(null),
                }, '✕'),
              ),
              // Question line: short commit id, bold. No time element.
              createElement('p', { className: DIALOG_DESCRIPTION },
                '要把当前会话退回到版本 ',
                createElement('code', {
                  style: {
                    fontFamily: 'var(--ds-font-family-code, monospace)',
                    fontSize: '0.92em',
                    fontWeight: 700,
                    color: 'var(--dsw-alias-label-primary, #e8e8e8)',
                  },
                }, selected.sha.slice(0, 7)),
                ' 吗？',
              ),
              createElement('div', { className: DIALOG_FOOT },
                createElement('button', {
                  className: `${BUTTON} outline`,
                  disabled: busy,
                  title: '仅回退会话消息，不动工作区文件',
                  onClick: () => void doRewind(false),
                }, '仅会话'),
                createElement('button', {
                  className: `${BUTTON} outline`,
                  disabled: busy,
                  title: '仅将工作区文件恢复到该版本，不动会话',
                  onClick: () => void doWorkspaceOnly(),
                }, '仅工作区'),
                createElement('button', {
                  className: `${BUTTON} outline`,
                  disabled: busy,
                  title: '回退会话消息并同步恢复配对的工作区文件',
                  onClick: () => void doRewind(true),
                }, busy ? '处理中…' : '会话和工作区'),
              ),
            ),
          ),
          portalTo,
        )
      : null,

    // Transient notice only (no permanent footer bar): rendered on top of the
    // list when there is something to say, and gone otherwise.
    notice !== ''
      ? createElement('div', {
          className: HINT,
          style: {
            padding: '6px 14px',
            borderTop: '1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))',
            background: 'var(--dsw-specific-sidebar-fill, #181818)',
          },
        }, notice)
      : null,
  )
}

/** Plugin config card (设置/插件/插件配置 → history-rewind): reports whether
 *  git is available on the host and offers a one-click install when it is not. */
function GitPluginCard(): ReactNode {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [version, setVersion] = useState('')
  const [installing, setInstalling] = useState(false)
  const [notice, setNotice] = useState('')
  const [detail, setDetail] = useState('')
  const refresh = async (): Promise<void> => {
    const r = await gitStatus()
    setAvailable(r.available)
    setVersion(r.version ?? '')
    if (r.message !== undefined && r.message.length > 0) setNotice(r.message)
  }
  useEffect(() => { void refresh() }, [])
  const doInstall = async (): Promise<void> => {
    setInstalling(true)
    setNotice('')
    setDetail('')
    const r = await installGit()
    setInstalling(false)
    if (r.installed === true) {
      setNotice('已触发安装 Git。安装完成后请重启 DSH，让宿主进程识别新装的 git。')
    } else {
      setNotice(r.message ?? '安装失败。')
      if (r.detail !== undefined && r.detail.length > 0) setDetail(r.detail)
    }
    void refresh()
  }
  const status = available === null
    ? createElement('span', { style: { color: 'var(--dsw-alias-label-secondary, #999)' } }, '检测中…')
    : available
      ? createElement('span', { style: { color: 'var(--dsw-alias-state-success-primary, #34d399)' } }, '可用')
      : createElement('span', { style: { color: 'var(--dsw-alias-state-error-primary, #f87171)' } }, '不可用')
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%' } },
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
      createElement('span', { style: { fontWeight: 600, fontSize: 13 } }, 'Git'),
      status,
      available === true && version.length > 0
        ? createElement('code', { style: { fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12, color: 'var(--dsw-alias-label-secondary, #999)' } }, version)
        : null,
    ),
    available === false
      ? createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #999)', lineHeight: 1.5 } },
            '本插件依赖 Git。检测到 Git 未安装，快照与回退功能将无法使用。'),
          createElement('button', {
            type: 'button',
            disabled: installing,
            onClick: () => void doInstall(),
            style: {
              alignSelf: 'flex-start',
              padding: '6px 14px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))',
              background: 'var(--dsw-alias-button-tool-bar-fill, #2d2d2e)',
              color: 'var(--dsw-alias-label-primary, #e6e6e6)',
              fontSize: 12,
              cursor: installing ? 'default' : 'pointer',
            },
          }, installing ? '正在安装…' : '安装 Git'),
        )
      : null,
    notice.length > 0
      ? createElement('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #999)', lineHeight: 1.5, whiteSpace: 'pre-wrap' } }, notice)
      : null,
    detail.length > 0
      ? createElement('pre', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)', maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap', margin: 0 } }, detail)
      : null,
  )
}

/** Full settings page (设置 → history-rewind): wraps the git status/install
 *  card in a page layout. The shell supplies { close, useSessions,
 *  useWorkspaces }; this card only needs the git check, so extra props are
 *  ignored. */
function HistoryRewindSettingsPage(): ReactNode {
  return createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, width: '100%', padding: '4px 0' } },
    createElement('div', {
      style: {
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
      },
    }, 'history-rewind'),
    createElement('div', {
      style: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary, #999)',
        lineHeight: 1.5,
        maxWidth: 520,
      },
    }, '本插件用 git 影子仓库实现会话快照与回退，因此依赖 Git。'),
    createElement(GitPluginCard),
  )
}

/** Mount floating widget */
export function apply(ctx: Context): void {
  const svc = ctx.get('sessions') as (SessionsFace & {
    handleHostEnvelope?: (env: unknown) => void
    manager?: { handleHostEnvelope?: (env: unknown) => void }
  }) | undefined
  if (svc === undefined) return
  injectStyles()

  // Suppress host/session-removed envelopes for the exact session currently being
  // rewound. The host briefly detaches and resumes the session to restore disk state;
  // suppressing the client-side removal keeps the session resident in the list store,
  // preventing `current` from becoming undefined and completely eliminating the
  // jarring jump/flash to the initial blank hero page!
  if (typeof svc.handleHostEnvelope === 'function') {
    const origHandle = svc.handleHostEnvelope.bind(svc)
    svc.handleHostEnvelope = (envelope: unknown) => {
      const frame = (envelope as { payload?: { type?: string; sessionId?: string } })?.payload
      if (frame?.type === 'host/session-removed' && frame?.sessionId === suppressingSessionId) {
        return
      }
      origHandle(envelope)
    }
  }
  if (svc.manager && typeof svc.manager.handleHostEnvelope === 'function') {
    const origManagerHandle = svc.manager.handleHostEnvelope.bind(svc.manager)
    svc.manager.handleHostEnvelope = (envelope: unknown) => {
      const frame = (envelope as { payload?: { type?: string; sessionId?: string } })?.payload
      if (frame?.type === 'host/session-removed' && frame?.sessionId === suppressingSessionId) {
        return
      }
      origManagerHandle(envelope)
    }
  }

  // The modal shell renders in its own root, always mounted; the HISTORY
  // trigger flips `open` via a shared subscription.
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const listeners = new Set<() => void>()
  let open = false
  const setOpen = (value: boolean): void => {
    if (open === value) return
    open = value
    for (const listener of listeners) listener()
  }
  /** Failure notice from a rewind that failed while the panel was closed
   *  (it closes immediately on confirm); delivered to the next panel mount. */
  let pendingRewindNotice: string | null = null

  const HistoryPanelShell = () => {
    const current = svc.list.getSnapshot().current
    // The runtime's list drops the session while a rewind detaches it on the
    // host (current transiently undefined). Keep the LAST known session id so
    // the panel stays mounted (and its content stable) across that gap instead
    // of unmounting and popping back once the session re-lists — the old
    // disappear → reappear "refresh" flash.
    const lastId = useRef<string | undefined>(undefined)
    useEffect(() => {
      if (current !== undefined) lastId.current = current
    }, [current])
    const sessionId = current ?? lastId.current
    const [, force] = useState(0)
    useEffect(() => {
      const listener = (): void => force((v) => v + 1)
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }, [])
    useEffect(() => svc.list.subscribe(() => force((v) => v + 1)), [])
    // The rewind confirm dialog open state: the panel card hides while the
    // dialog floats over the page (cancel restores the timeline untouched).
    const [dialogOpen, setDialogOpen] = useState(false)
    // Rewind progress: an opaque mask + centered status card from confirm until
    // the conversation view has refreshed in place. The mask hides everything
    // while the host rewinds — including the platform's brief no-session hero
    // between detach and resume — and the whole layer fades out after the
    // "done" beat, revealing the swapped conversation as one designed move.
    const [progress, setProgress] = useState<{ phase: RewindPhase; sha: string; fading: boolean }>({ phase: 'idle', sha: '', fading: false })
    useEffect(() => {
      if (progress.phase !== 'done') return
      const fadeTimer = setTimeout(() => {
        setProgress((prev) => (prev.phase === 'done' ? { ...prev, fading: true } : prev))
      }, 600)
      const doneTimer = setTimeout(() => {
        setProgress((prev) => (prev.phase === 'done' ? { phase: 'idle', sha: '', fading: false } : prev))
      }, 1050)
      return () => { clearTimeout(fadeTimer); clearTimeout(doneTimer) }
    }, [progress.phase])
    // Focus the panel when it opens, and close it on Escape (the dialog owns
    // Escape while it is open — it cancels itself instead).
    const cardRef = { current: null as HTMLDivElement | null }
    useEffect(() => {
      if (!open) return
      const card = cardRef.current
      card?.focus()
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape' && !dialogOpen) setOpen(false)
      }
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    }, [open, dialogOpen])

    const panel = open && sessionId !== undefined
      ? createElement('div', {
          className: MODAL_BACKDROP,
          onClick: () => setOpen(false),
        },
          createElement('div', {
            className: MODAL_CARD,
            tabIndex: -1,
            ref: (node: HTMLDivElement | null): void => { cardRef.current = node },
            // Hidden (kept mounted) while the rewind dialog is open: the dialog
            // is portaled into the plugin's own root and floats alone.
            style: { outline: 'none', ...(dialogOpen ? { display: 'none' } : {}) },
            onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
          },
            createElement('button', {
              className: 'dsh-history-dialog-close',
              title: '关闭',
              style: {
                position: 'absolute',
                top: 16,
                right: 20,
                zIndex: 60,
                background: 'var(--dsw-alias-bg-layer-2, #2d2d2e)',
                border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))',
              },
              onClick: () => setOpen(false),
            }, '✕'),
            createElement(HistoryPanel, {
              sessionId,
              rebind: (id) => rebindView(svc, id),
              onRewound: () => setOpen(false),
              onRewindFailed: (text) => {
                pendingRewindNotice = text
                setOpen(true)
              },
              onProgress: (phase, sha) => setProgress({ phase, sha, fading: false }),
              portalTo: host,
              onDialogOpen: setDialogOpen,
              initialNotice: pendingRewindNotice ?? undefined,
              onInitialNoticeConsumed: () => { pendingRewindNotice = null },
            }),
          ),
        )
      : null

    const progressUi = progress.phase === 'idle'
      ? null
      : createElement(Fragment, null,
          createElement('div', {
            className: PROGRESS_MASK,
            style: { opacity: progress.fading ? 0 : 1 },
          }),
          createElement('div', {
            className: PROGRESS_CARD,
            style: { opacity: progress.fading ? 0 : 1 },
          },
            progress.phase === 'done'
              ? createElement('span', { className: 'dsh-history-progress-done' }, '✓')
              : createElement('div', { className: 'dsh-history-progress-spin' }),
            createElement('div', { className: 'dsh-history-progress-text' },
              createElement('div', { className: 'dsh-history-progress-title' },
                progress.phase === 'working' ? '正在回退…'
                  : progress.phase === 'refreshing' ? '正在刷新会话…'
                  : '已回退'),
              createElement('code', { className: 'dsh-history-progress-sha' }, progress.sha),
            ),
          ),
        )

    return createElement(Fragment, null, panel, progressUi)
  }
  root.render(createElement(HistoryPanelShell))

  // HISTORY header action: register in the utilities row (order 10 puts it
  // AFTER the shipped Session log button, same row).
  const slots = ctx.get('slots') as {
    inject(name: string, provider: () => unknown): void
    register(payload: Record<string, unknown>, component: unknown): unknown
  } | undefined
  if (slots !== undefined) {
    slots.inject('conversation.session.header.utilities', () => slots.register({
      name: 'conversation.session.header.utilities',
      id: 'history',
      order: 10,
    }, HistoryHeaderAction))
  }

  // Settings entry (设置 → history-rewind). DSH's "插件配置" region only lists
  // host-plane plugins; dsh-history-rewind is a profile plugin, so its card
  // never renders there. A dedicated settings.section page is the reliable,
  // guaranteed-visible place for this plugin.
  if (slots !== undefined) {
    slots.inject('settings.section', () => slots.register({
      name: 'settings.section',
      id: SETTINGS_NAMESPACE,
      order: 30,
      label: SETTINGS_NAMESPACE,
    }, HistoryRewindSettingsPage) as unknown)
  }

  // Zero-polling command bridge: register the /history command's durable chat
  // row. The command lifecycle (`command/run` with name 'history') is pushed to
  // the client through the session projection stream; rendering this row means
  // the command just ran, so open the HISTORY panel — same instant delivery the
  // official command UI uses, no polling.
  function HistoryCommandRow(props: { node?: { state?: { outcome?: unknown } } }): ReactNode {
    useEffect(() => { setOpen(true) }, [])
    const done = props.node?.state?.outcome !== undefined
    return createElement('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 12px',
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary, #999)',
      },
    },
      createElement('code', { style: { fontFamily: 'var(--ds-font-family-code, monospace)', fontWeight: 600 } }, '/history'),
      createElement('span', null, done ? 'History panel opened.' : 'Opening history panel…'),
    )
  }
  if (slots !== undefined) {
    try {
      slots.inject('conversation.chat.commandview', () => slots.register({
        name: 'conversation.chat.commandview',
        key: 'history',
      }, HistoryCommandRow) as unknown)
    } catch {
      // Older shells without per-name command rows: commandview unavailable.
    }
  }

  function HistoryHeaderAction(): ReactNode {
    return createElement('button', {
      type: 'button',
      className: 'dsh-history-header-action',
      title: '查看会话版本历史（回档）',
      'aria-label': 'HISTORY',
      onClick: () => setOpen(!open),
    },
      createElement('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
      },
        createElement('path', { d: 'M2.5 8 A 5.5 5.5 0 1 0 8 2.5' }),
        createElement('path', { d: 'M8 0.8 L 5 3.2 L 8 5.6' }),
      ),
      createElement('span', null, 'HISTORY'),
    )
  }

  ctx.effect(() => () => {
    root.unmount()
    host.remove()
  }, 'dsh-history-rewind: floating history panel')
}
