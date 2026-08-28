/**
 * Commit-message contract for the dsh-history shadow repos.
 *
 * The format is the timeline's parse basis and MUST stay stable. Snapshots now
 * have two natures:
 *
 *   turn-start == a CHECK POINT captured just before the user sends this turn's
 *     message (the pre-send state). It carries no conversation preview.
 *   turn-end == the completed turn: BOTH the user message that opened it and
 *     the assistant reply that closed it, on separate body lines.
 *
 *   session side (built second; the trailing [ws] is the same-turn ws commit):
 *     [TURN 0001][CHECK POINT][<ws-hash>]
 *     [TURN 0001][USER] <user-preview>
 *     [ASST] <asst-preview>
 *     [<ws-hash>]
 *     [TURN 0001][MANUAL][<ws-hash>]
 *     [REWIND → <commit>]
 *   workspace side (built first; single-line attribution — no ws bracket):
 *     [TURN 0001][CHECK POINT]
 *     [TURN 0001][ASST] <asst-preview>
 *     [TURN 0001][MANUAL]
 *
 * The turn-end message is MULTI-LINE, so the timeline reads the full commit
 * body (%B), not just the subject (%s). The workspace commit is built first
 * and referenced by the session commit's trailing [ws]; there is no
 * back-reference (same-cycle mutual reference is impossible).
 *
 * Legacy `dsh-history: turn N start|end (seq M) …` and the older single-line
 * `[TURN n][USER: …]` / `[ASST: …]` subjects still parse (old sessions keep
 * working); only the NEW format is produced.
 */

import { Buffer } from 'node:buffer'
import { deflateRawSync, inflateRawSync } from 'node:zlib'

export type SnapKind = 'turn-start' | 'turn-end' | 'manual' | 'rewind'

export type WorkspaceChangeStatus = 'A' | 'M' | 'D'

/** One workspace path changed by the snapshot relative to its parent tree. */
export interface WorkspaceChange {
  status: WorkspaceChangeStatus
  path: string
}

/** Parsed commit-message payload (only leaf scalars; owned JSON). */
export interface SnapMeta {
  kind: SnapKind
  /** TURN number for turn snapshots (undefined for manual/rewind). */
  turn?: number
  /** Phase for turn snapshots: 'start' | 'end'. */
  phase?: 'start' | 'end'
  /** Event seq M for turn snapshots (legacy format only; absent in new format). */
  seq?: number
  /** Session id (legacy format only; the new format omits it). */
  session?: string
  /** Pairing key (legacy format only). */
  snap?: string
  /** Anchor commit (legacy format only). */
  base?: string
  /** Workspace commit of the same pairing (session snapshot only). */
  ws?: string
  /** Rewind target commit (rewind marker only). */
  target?: string
  /**
   * Legacy single-line preview (old-format USER/ASST turns, and the assistant
   * preview surfaced for a turn-end so existing callers keep a value).
   */
  message?: string
  /** User message preview that opened this turn (turn-end only, new format). */
  userMessage?: string
  /** Assistant message preview that closed this turn (turn-end only). */
  asstMessage?: string
  /** Workspace A/M/D manifest captured with this snapshot. */
  changes?: WorkspaceChange[]
}

/** Max display width of a message preview (CJK counts 2, ASCII 1 → 100 CJK ≈ 200 ASCII). */
export const PREVIEW_WIDTH = 200

/** True for East-Asian wide / fullwidth code points (rendered as 2 columns). */
function isWide(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) || // Hangul Jamo
    (codePoint >= 0x2e80 && codePoint <= 0x303e) || // CJK radicals / Kangxi / punctuation
    (codePoint >= 0x3041 && codePoint <= 0x33ff) || // Hiragana, Katakana, CJK symbols
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Ext A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified
    (codePoint >= 0xa000 && codePoint <= 0xa4cf) || // Yi
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK compat
    (codePoint >= 0xfe30 && codePoint <= 0xfe4f) || // CJK compat forms
    (codePoint >= 0xff00 && codePoint <= 0xff60) || // Fullwidth forms
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) || // Fullwidth signs
    (codePoint >= 0x1f300 && codePoint <= 0x1faff) || // emoji / pictographs
    (codePoint >= 0x20000 && codePoint <= 0x3fffd) // CJK Ext B+
  )
}

/**
 * Sanitize + width-truncate a message preview for a single-line commit
 * subject: strip newlines/controls and the bracket chars that frame the
 * format, collapse whitespace, then cut at PREVIEW_WIDTH columns (append … ).
 * @param raw - the raw message text.
 * @returns a safe, bounded one-line preview.
 */
export function previewOf(raw: string): string {
  const cleaned = raw
    .replace(/[\r\n\t]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  let width = 0
  let out = ''
  for (const ch of cleaned) {
    const w = isWide(ch.codePointAt(0)!) ? 2 : 1
    if (width + w > PREVIEW_WIDTH) return `${out}…`
    width += w
    out += ch
  }
  return out
}

/** Format a TURN number as a zero-padded 4-digit field (wider when needed). */
function turnField(turn: number | undefined): string {
  return `TURN ${String(turn ?? 0).padStart(4, '0')}`
}

/** Prefer the turn-end user/assistant previews, falling back to `message`. */
function userPreviewOf(meta: SnapMeta): string {
  return previewOf(meta.userMessage ?? '')
}
function asstPreviewOf(meta: SnapMeta): string {
  return previewOf(meta.asstMessage ?? meta.message ?? '')
}

const FILES_MARKER = /\[F1:([A-Za-z0-9_-]+)\]$/

/** Encode file changes into a subject-safe, versioned tail marker. */
function fileChangesSuffix(changes: readonly WorkspaceChange[] | undefined): string {
  if (changes === undefined || changes.length === 0) return ''
  const tuples = changes.map((change) => [change.status, change.path])
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(tuples), 'utf8'))
  return `[F1:${compressed.toString('base64url')}]`
}

/** Remove and decode the optional file manifest before parsing the base subject. */
function splitFileChanges(subject: string): { subject: string; changes?: WorkspaceChange[] } {
  const match = FILES_MARKER.exec(subject)
  if (match === null) return { subject }
  const base = subject.slice(0, match.index)
  try {
    const bytes = Buffer.from(match[1]!, 'base64url')
    const parsed = JSON.parse(inflateRawSync(bytes).toString('utf8')) as unknown
    if (!Array.isArray(parsed)) return { subject: base }
    const changes: WorkspaceChange[] = []
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) return { subject: base }
      const [status, path] = entry
      if ((status !== 'A' && status !== 'M' && status !== 'D') || typeof path !== 'string' || path.length === 0) {
        return { subject: base }
      }
      changes.push({ status, path })
    }
    return changes.length === 0 ? { subject: base } : { subject: base, changes }
  } catch {
    return { subject: base }
  }
}

/**
 * Build one session-side commit message (always single line — git subjects
 * carry no newline; the Web UI splits turn-end into two display lines).
 *
 * turn-start is a CHECK POINT; turn-end carries the user and assistant
 * previews plus the trailing [ws]. Manual and rewind are unchanged.
 * @param meta - the snapshot's metadata.
 * @returns the commit subject.
 */
export function buildSessionMessage(meta: SnapMeta): string {
  if (meta.kind === 'rewind') return `[REWIND → ${meta.target ?? ''}]`
  const ws = meta.ws !== undefined && meta.ws.length > 0 ? meta.ws : ''
  const head = `[${turnField(meta.turn)}]`
  let subject: string
  if (meta.kind === 'manual') subject = `${head}[MANUAL][${ws}]`
  else if (meta.kind === 'turn-start') subject = `${head}[CHECK POINT][${ws}]`
  else subject = `${head}[USER] ${userPreviewOf(meta)}[ASST] ${asstPreviewOf(meta)}[${ws}]`
  return `${subject}${fileChangesSuffix(meta.changes)}`
}

/**
 * Build one workspace-side commit message (single-line attribution; no ws
 * bracket — the workspace repo is never parsed for the timeline).
 * @param meta - the snapshot's metadata.
 * @returns the commit subject.
 */
export function buildWorkspaceMessage(meta: SnapMeta): string {
  const head = `[${turnField(meta.turn)}]`
  if (meta.kind === 'manual') return `${head}[MANUAL]`
  if (meta.kind === 'turn-start') return `${head}[CHECK POINT]`
  return `${head}[ASST] ${asstPreviewOf(meta)}`
}

/**
 * Parse one commit subject into metadata. Unrelated subjects yield null.
 * Recognizes the new bracket format and the legacy `dsh-history:` format.
 * @param subject - a full commit subject.
 * @returns parsed metadata, or null when the subject carries no contract line.
 */
export function parseMessage(subject: string): SnapMeta | null {
  const split = splitFileChanges(subject.trim())
  const meta = parseBracket(split.subject) ?? parseLegacy(split.subject)
  if (meta === null) return null
  return split.changes === undefined ? meta : { ...meta, changes: split.changes }
}

/** Parse the new bracket format. */
function parseBracket(line: string): SnapMeta | null {
  const rewind = /^\[REWIND → (\S*)\]$/.exec(line)
  if (rewind !== null) return { kind: 'rewind', target: rewind[1]! }

  // [TURN 0001][MANUAL][ws?]
  const manual = /^\[TURN (\d+)\]\[MANUAL\](?:\[([^\]]*)\])?$/.exec(line)
  if (manual !== null) {
    return {
      kind: 'manual',
      turn: Number(manual[1]),
      ...(manual[2] !== undefined && manual[2].length > 0 ? { ws: manual[2] } : {}),
    }
  }

  // [TURN 0001][CHECK POINT][ws?] — the pre-send checkpoint (turn-start).
  const check = /^\[TURN (\d+)\]\[CHECK POINT\](?:\[([^\]]*)\])?$/.exec(line)
  if (check !== null) {
    return {
      kind: 'turn-start',
      phase: 'start',
      turn: Number(check[1]),
      ...(check[2] !== undefined && check[2].length > 0 ? { ws: check[2] } : {}),
    }
  }

  // [TURN 0001][USER] <preview>[ASST] <preview>[ws?] — the completed turn.
  // Previews are bracket-free (sanitized), so the segment boundaries are the
  // literal [ASST] and trailing [ws] brackets.
  const end = /^\[TURN (\d+)\]\[USER\] ([^[]*)\[ASST\] ([^[]*)(?:\[([^\]]*)\])?$/.exec(line)
  if (end !== null) {
    const user = end[2]!.trim()
    const asst = end[3]!.trim()
    return {
      kind: 'turn-end',
      phase: 'end',
      turn: Number(end[1]),
      ...(user.length > 0 ? { userMessage: user } : {}),
      ...(asst.length > 0 ? { asstMessage: asst, message: asst } : {}),
      ...(end[4] !== undefined && end[4].length > 0 ? { ws: end[4] } : {}),
    }
  }

  // Workspace-side attribution: [TURN 0001][ASST] <preview> (no USER, no ws).
  const wsAttr = /^\[TURN (\d+)\]\[ASST\] ([^[]*)$/.exec(line)
  if (wsAttr !== null) {
    const asst = wsAttr[2]!.trim()
    return {
      kind: 'turn-end',
      phase: 'end',
      turn: Number(wsAttr[1]),
      ...(asst.length > 0 ? { asstMessage: asst, message: asst } : {}),
    }
  }

  // Legacy single-line [TURN 0001][USER|ASST: preview][ws?] (old format).
  const turn = /^\[TURN (\d+)\]\[(USER|ASST): ([^\]]*)\](?:\[([^\]]*)\])?$/.exec(line)
  if (turn !== null) {
    const role = turn[2]!
    return {
      kind: role === 'ASST' ? 'turn-end' : 'turn-start',
      phase: role === 'ASST' ? 'end' : 'start',
      turn: Number(turn[1]),
      ...(turn[3]!.length > 0 ? { message: turn[3]! } : {}),
      ...(turn[4] !== undefined && turn[4].length > 0 ? { ws: turn[4] } : {}),
    }
  }
  return null
}

/** Parse the legacy `dsh-history:` format (kept so old sessions still render). */
function parseLegacy(line: string): SnapMeta | null {
  const PREFIX = 'dsh-history:'
  if (!line.startsWith(PREFIX)) return null
  const rest = line.slice(PREFIX.length).trim()
  if (rest.startsWith('rewind')) {
    const meta: SnapMeta = { kind: 'rewind' }
    const target = /target=(\S+)/.exec(rest)
    if (target !== null) meta.target = target[1]!
    const snap = /snap=(\S+)/.exec(rest)
    if (snap !== null) meta.snap = snap[1]!
    return meta
  }
  if (rest.startsWith('manual snapshot')) {
    const meta: SnapMeta = { kind: 'manual' }
    const session = /session-([\w-]+)/.exec(rest)
    if (session !== null) meta.session = session[1]!
    const snap = /snap=(\S+)/.exec(rest)
    if (snap !== null) meta.snap = snap[1]!
    const base = /base=(\S+)/.exec(rest)
    if (base !== null) meta.base = base[1]!
    const ws = /ws=(\S+)/.exec(rest)
    if (ws !== null) meta.ws = ws[1]!
    return meta
  }
  const turnMatch = /^turn (\d+) (start|end) \(seq (\d+)\)(?: session-([\w-]+))?(?: snap=(\S*))?(?: base=(\S*))?(?: ws=(\S*))?$/.exec(rest)
  if (turnMatch === null) return null
  return {
    kind: turnMatch[2] === 'start' ? 'turn-start' : 'turn-end',
    turn: Number(turnMatch[1]),
    phase: turnMatch[2] as 'start' | 'end',
    seq: Number(turnMatch[3]),
    ...(turnMatch[4] !== undefined && turnMatch[4].length > 0 ? { session: turnMatch[4] } : {}),
    ...(turnMatch[5] !== undefined && turnMatch[5].length > 0 ? { snap: turnMatch[5] } : {}),
    ...(turnMatch[6] !== undefined && turnMatch[6].length > 0 ? { base: turnMatch[6] } : {}),
    ...(turnMatch[7] !== undefined && turnMatch[7].length > 0 ? { ws: turnMatch[7] } : {}),
  }
}
