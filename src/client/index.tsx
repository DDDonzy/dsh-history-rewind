/**
 * Browser half of @deepseek-ai/dsh-history: a flat, Trajectory/DevTools-inspired
 * timeline panel that renders the session's git graph, lists commits concisely,
 * takes manual snapshots, and rewinds in place via the Host channel.
 *
 * @module @deepseek-ai/dsh-history/client
 */

import type { Context } from '@deepseek-ai/cordis'
import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { fetchTimeline, rewind, manualSnapshot, get, type TimelineRow } from './api.ts'
import { ROUTE_PREFIX } from '../constants.ts'
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
} from './styles.ts'

/** Services the browser half requires before it can contribute. */
export const inject = ['sessions', 'slots']

/** Structural view of the client sessions service */
interface SessionsFace {
  list: {
    getSnapshot(): { current?: string; ids?: string[] }
    subscribe(listener: () => void): () => void
  }
  clear?(): void
  open?(id: string): void
  scopes?: Map<string, unknown>
  deferredRemovals?: Set<string>
  dropScope?(id: string, record: unknown): void
}

/** Small delay helper. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** Rebind session view */
async function rebindView(sessions: SessionsFace, sessionId: string): Promise<string> {
  await wait(250)
  const record = sessions.scopes?.get(sessionId)
  const dropScope = sessions.dropScope
  const clearSelection = sessions.clear
  const openSession = sessions.open
  if (record === undefined || dropScope === undefined || clearSelection === undefined || openSession === undefined) {
    setTimeout(() => { window.location.reload() }, 400)
    return '原语缺失，已自动刷新页面'
  }
  try {
    sessions.deferredRemovals?.delete(sessionId)
    sessions.scopes?.delete(sessionId)
    dropScope(sessionId, record)
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

/** Render a changed-file chip line: at most MAX_FILES chips + "+N" indicator. */
function FileChips(props: { files: string[] }): ReactNode {
  const { files } = props
  if (files.length === 0) return null
  return createElement('div', { className: FILE_LIST },
    files.slice(0, MAX_FILES).map((file) =>
      createElement('code', { className: FILE_CHIP, title: file, key: file }, file),
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
          shown.map((file) =>
            createElement('code', { className: FILE_CHIP, title: file, key: file }, file),
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
      createElement(FileChips, { files }),
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
  height: number
  /** Non-null when some row is hovered: shas on that row's ancestor path. */
  hoverPath: Set<string> | null
}) {
  const { row, lanes, colors, headLanes, isHead, isHovered, height, hoverPath } = props
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
    return onHead(edge.lane) ? colors[edge.lane % colors.length]! : grey
  }
  const nodeColor = onPath
    ? HOVER
    : hovering ? grey : (onHead(row.lane) ? colors[row.lane % colors.length]! : grey)
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
        strokeWidth: onPath ? 2.6 : 2,
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
}) {
  const { row, lanes, colors, headLanes, isHead, isHovered, isSelected, hoverPath, onHover, onSelect, anchor, headSha } = props
  const height = rowHeightOf(row)
  return createElement('div', {
    className: `${ROW} ${isSelected ? 'is-selected' : ''}`,
    style: { minHeight: height },
    'data-sha': row.sha,
    ...(anchor ? { 'data-anchor': row.sha } : {}),
    onMouseEnter: () => onHover(row.sha),
    onMouseLeave: () => onHover(null),
    onClick: () => onSelect(row),
  },
    createElement(GraphCell, { row, lanes, colors, headLanes, isHead, isHovered, height, hoverPath }),
    createElement(RowContentNode, { row, isHead }),
  )
}

/** History Panel */
function HistoryPanel(props: { sessionId: string; rebind: (sessionId: string) => Promise<string> }) {
  const { sessionId, rebind } = props
  const [rows, setRows] = useState<TimelineRow[] | null | undefined>(undefined)
  const [head, setHead] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<TimelineRow | null>(null)
  const [notice, setNotice] = useState<string>('')
  /** Row currently hovered (sha), for ancestor-path highlight. */
  const [hoverSha, setHoverSha] = useState<string | null>(null)
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
    setBusy(true)
    setNotice('')
    const result = await rewind(sessionId, selected.sha, withWorkspace)
    setSelected(null)
    setBusy(false)
    if (!result.ok) {
      setNotice(`${result.reason ?? 'failed'}${result.error !== undefined ? `：${result.error}` : ''}`)
      return
    }
    setNotice(`已回退 ✓ ${result.target !== undefined ? `目标 ${result.target.slice(0, 7)}` : ''}（继续对话将开辟新分支）${result.workspaceRestored === true ? ' · 工作区已恢复' : ''}${result.noWorkspaceSnapshot === true ? ' · 无配对工作区快照' : ''}${result.compositionWarning !== undefined ? ` · ⚠ ${result.compositionWarning}` : ''}`)
    await load()
    if (result.detached === true) {
      setTimeout(() => { window.location.reload() }, 400)
      return
    }
    const detail = await rebind(sessionId)
    setNotice(`${notice !== '' ? `${notice} · ` : ''}${detail}`)
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
      createElement('div', { style: { color: 'var(--dsw-alias-label-secondary, #888)', textAlign: 'center', maxWidth: 360, lineHeight: 1.5, fontSize: 12 } },
        '当前会话尚未产生快照。发送消息后，TURN 开始与结束将自动记录。',
      ),
      createElement('button', { className: `${BUTTON} primary`, disabled: busy, onClick: () => void doSnapshot() }, '立即快照'),
    )
  }

  // Slice the laid-out rows by the current window. layout output is oldest
  // first; the window indexes into it directly.
  const laid = graph !== null && winStart !== null && winStart.rows === graph.rows.length
    ? graph.rows.slice(winStart.start, winStart.end)
    : graph !== null ? graph.rows.slice(Math.max(0, graph.rows.length - PAGE * 2)) : null

  return createElement('div', { className: PANEL },
    // Scrollable Flat Timeline List (Trajectory style), windowed ±20 around HEAD
    createElement('div', {
      className: MODAL_BODY,
      ref: (node: HTMLDivElement | null): void => { listRef.current = node },
      onScroll,
    },
      laid !== null && laid.map((row) =>
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
        }),
      ),
    ),

    // Selected Row Rewind Dialog (DSH Modal 451:18655 — mask + centered card)
    selected !== null
      ? createElement('div', {
          className: MODAL_BACKDROP,
          style: { position: 'absolute', inset: 0, zIndex: 50, padding: 16 },
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

/** Mount floating widget */
export function apply(ctx: Context): void {
  const svc = ctx.get('sessions') as SessionsFace | undefined
  if (svc === undefined) return
  injectStyles()

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

  const HistoryPanelShell = () => {
    const current = svc.list.getSnapshot().current
    const [, force] = useState(0)
    useEffect(() => {
      const listener = (): void => force((v) => v + 1)
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }, [])
    useEffect(() => svc.list.subscribe(() => force((v) => v + 1)), [])
    // Focus the panel when it opens, and close it on Escape.
    const cardRef = { current: null as HTMLDivElement | null }
    useEffect(() => {
      if (!open) return
      const card = cardRef.current
      card?.focus()
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') setOpen(false)
      }
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    }, [open])
    if (!open || current === undefined) return null
    return createElement('div', {
      className: MODAL_BACKDROP,
      onClick: () => setOpen(false),
    },
      createElement('div', {
        className: MODAL_CARD,
        tabIndex: -1,
        ref: (node: HTMLDivElement | null): void => { cardRef.current = node },
        style: { outline: 'none' },
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
        createElement(HistoryPanel, { sessionId: current, rebind: (id) => rebindView(svc, id) }),
      ),
    )
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
  }, 'dsh-history: floating history panel')
}
