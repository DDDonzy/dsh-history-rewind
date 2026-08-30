/**
 * Context Curation creates an independent DSH Session from a normalized subset
 * of the source Session's native events.
 *
 * Production chain:
 *   flush source durability -> sessionController.inspect(source)
 *   -> remove selected TURN event intervals + normalize event references/mailbox
 *   -> sessionController.createDerivedSession(seed, composition source)
 *   -> initial CURATE snapshot in the NEW Session's own shadow repositories.
 *
 * The source Session, its official artifact, Agent lifecycle, Git refs, backup
 * directory, and workspace files are never replaced or rewound. DSH's derived-
 * Session API inherits cwd, Workspace accounting, effective preset, and model
 * route while publishing a new ordinary Session identity. Future conversation
 * and workspace snapshots therefore belong entirely to that new Session.
 *
 * `maskArtifact` remains exported as a storage-level compatibility/test helper;
 * production creation uses `curateSessionEvents` over DSH-owned expanded events.
 * Both normalization paths enforce these rules:
 *  - events between turn/start and its paired turn/end (inclusive) are the
 *    turn's content; masked TURN ranges are dropped entirely;
 *  - compaction transactions (compaction/start|summary|end|prune) and any
 *    surface replacement (surfaceOp.replace) are dropped too - the refined
 *    derived Session keeps the NATIVE USER/ASST content, never the compressed summary;
 *  - the composer mailbox (`agent/inbox/spliced` history) is re-emitted as its
 *    TRUE pending state: the original splices are replayed and ONE final-state
 *    splice per target replaces them, so masked messages can never resurface
 *    in the send queue while genuinely pending drafts are preserved;
 *  - remaining events are RENUMBERED contiguously (the JSONL loader rejects
 *    seq gaps) and sourceEventSeqs / surfaceOp ranges are translated through
 *    the old-to-new seq map.
 *
 * @module dsh-history-rewind/refine
 */

import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import type { SubprocessLike } from './git-runner.ts'
import { scanZstdFrames } from './zstd-util.ts'
import { takeSnapshot, type PersistenceLike } from './snapshot.ts'
import type { AgentRegistryLike, SessionsServiceLike } from './rewind.ts'

// ---------------------------------------------------------------------------
// Pure artifact rewrite
// ---------------------------------------------------------------------------

/** One parsed storage line of the session artifact. */
interface ArtifactLine {
  /** Index of the original zstd frame the line came from. */
  frame: number
  /** Raw line text (stripped of the trailing newline). */
  text: string
  /** Parsed JSON (mutated in place when the line is renumbered). */
  parsed: Record<string, unknown>
  /** Event type (or `session` for the header line). */
  type: string
  /** First logical seq this line covers (header: null). */
  start: number | null
  /** Exclusive end of the logical seq range (header: null). */
  end: number | null
  /** data.turn of the line itself, when present. */
  ownTurn: number | null
  /** Turn attributed by the turn/start..turn/end walk (null = outside any turn). */
  intervalTurn: number | null
  /** Whether the line survives into the refined artifact. */
  keep: boolean
  /** New first seq after renumbering (header: 0). */
  newStart: number
  /** True for reconstructed mailbox events (no original seq to map). */
  synthetic?: boolean
}

/** Event types that make up a compaction transaction (never conversation). */
const COMPACTION_TYPES = new Set(['compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune'])

/** Whether a parsed line is a packed chunk row (multi-event storage row). */
function isChunkRow(parsed: Record<string, unknown>): boolean {
  return parsed.type === 'text-chunks' || parsed.type === 'reasoning-chunks' || parsed.type === 'tool-call-chunks'
}

/** Number of logical events one line stores (1 for plain events). */
function lineLength(line: ArtifactLine): number {
  if (line.start === null || line.end === null) return 0
  return line.end - line.start
}

/** Parse a raw line into a light record; null when the line is unparsable. */
function parseLine(frame: number, text: string): ArtifactLine | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  const type = typeof obj.type === 'string' ? obj.type : ''
  if (type === 'session') {
    // Header line: no seq, always kept.
    return { frame, text, parsed: obj, type, start: null, end: null, ownTurn: null, intervalTurn: null, keep: true, newStart: 0 }
  }
  const data = (obj.data ?? null) as Record<string, unknown> | null
  const ownTurn = data !== null && typeof data.turn === 'number' && Number.isSafeInteger(data.turn) ? data.turn : null
  let start: number | null = null
  let end: number | null = null
  if (isChunkRow(obj)) {
    const seq0 = typeof obj.seq0 === 'number' && Number.isSafeInteger(obj.seq0)
      ? obj.seq0
      : typeof obj.seq === 'number' && Number.isSafeInteger(obj.seq) ? obj.seq : null
    if (seq0 !== null) {
      const payload = data !== null
        ? (Array.isArray(data.texts) ? data.texts : Array.isArray(data.args) ? data.args : null)
        : null
      const length = payload !== null ? payload.length : 0
      if (length > 0) {
        start = seq0
        end = seq0 + length
      }
    }
  } else if (typeof obj.seq === 'number' && Number.isSafeInteger(obj.seq)) {
    start = obj.seq
    end = obj.seq + 1
  }
  return { frame, text, parsed: obj, type, start, end, ownTurn, intervalTurn: null, keep: true, newStart: 0 }
}

/** Composer mailbox replay target: which pending list a splice belongs to. */
type InboxTarget = 'next-turn' | 'next-step'

/** Final pending state of the composer mailbox after replaying all splices. */
type InboxPending = { [T in InboxTarget]: unknown[] }

/**
 * Replay every durable `agent/inbox/spliced` event with standard splice
 * semantics - exactly what the runtime's {@link Inbox} projection does on a
 * cold load. The mailbox (send queue is NOT part of the turn record: a message
 * is inserted before its turn and claimed (removed) inside the turn, so a
 * naive per-turn mask would keep the inserts and drop the claims, and the
 * masked messages would resurface in the composer queue. This replay computes
 * the TRUE pending state, which the refined artifact re-emits as a single
 * final-state splice.
 * @param lines - all decoded artifact lines (any order; sorted by seq here).
 */
function replayInboxPending(lines: readonly ArtifactLine[]): InboxPending {
  const state: InboxPending = { 'next-turn': [], 'next-step': [] }
  const splices = lines
    .filter((line) => line.type === 'agent/inbox/spliced')
    .slice()
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
  for (const line of splices) {
    const data = (line.parsed.data ?? {}) as Record<string, unknown>
    const target: InboxTarget = data.target === 'next-step' ? 'next-step' : 'next-turn'
    const inserted = Array.isArray(data.inserted) ? data.inserted : []
    const list = state[target]
    // Same normalization as the runtime's Inbox.mutate: negative/NaN-tolerant
    // splice coordinates clamped to the current list.
    const start = typeof data.start === 'number' ? Math.trunc(data.start) : 0
    const deleteCount = typeof data.removedCount === 'number' ? Math.trunc(data.removedCount) : 0
    const actualStart = Math.max(0, Math.min(start, list.length))
    const actualDelete = Math.max(0, Math.min(deleteCount, list.length - actualStart))
    list.splice(actualStart, actualDelete, ...inserted)
  }
  return state
}

/** Result of masking one artifact. */
export interface MaskResult {  /** Refined artifact bytes (recompressed frames, renumbered seqs). */
  bytes: Buffer
  /** Turn numbers actually removed. */
  maskedTurns: number[]
  /** Turn numbers requested but absent from the artifact. */
  unmapped: number[]
  /** Distinct turns that remain in the refined artifact. */
  remainingTurns: number[]
  /** Number of storage lines dropped. */
  droppedLines: number
}

/**
 * Mask selected TURN ranges out of a session artifact and renumber all
 * remaining events contiguously (the JSONL loader requires `seq === index`).
 * @param bytes - raw multi-frame zstd JSONL artifact.
 * @param masked - turn numbers to remove (data.turn of turn/start boundaries).
 * @returns the refined bytes + bookkeeping, or null when the artifact cannot
 *   be decoded (unsupported encoding / corrupt frames).
 */
export function maskArtifact(bytes: Buffer, masked: ReadonlySet<number>): MaskResult | null {
  let frames
  try {
    frames = scanZstdFrames(bytes)
  } catch {
    return null
  }
  if (frames.length === 0) return null

  // 1. Decode every frame into lines (file order).
  const lines: ArtifactLine[] = []
  for (let i = 0; i < frames.length; i += 1) {
    let plaintext: string
    try {
      plaintext = zstdDecompressSync(bytes.subarray(frames[i]!.start, frames[i]!.end)).toString('utf8')
    } catch {
      return null
    }
    for (const raw of plaintext.split('\n')) {
      const text = raw.trim()
      if (text.length === 0) continue
      const line = parseLine(i, text)
      if (line !== null) lines.push(line)
    }
  }
  if (lines.length === 0 || lines[0]!.type !== 'session') return null

  // 2. Turn attribution walk over seq order. Each turn/start opens an interval
  //    that closes at its paired turn/end; every line inside the interval gets
  //    that turn's number, lines outside any interval (header, inter-turn
  //    bookkeeping like request/header or compaction markers) keep `null`.
  const seqOrdered = lines
    .filter((line) => line.start !== null)
    .slice()
    .sort((a, b) => (a.start! - b.start!) || (a.frame - b.frame))
  let open: { turn: number; start: number } | null = null
  let fallbackTurn = 1
  for (const line of seqOrdered) {
    if (line.type === 'turn/start') {
      const turn = line.ownTurn ?? fallbackTurn
      if (line.ownTurn === null) fallbackTurn += 1
      open = { turn, start: line.start! }
      line.intervalTurn = turn
      continue
    }
    if (line.type === 'turn/end') {
      if (open !== null) line.intervalTurn = open.turn
      open = null
      continue
    }
    if (open !== null) line.intervalTurn = open.turn
    // Chunk rows carry their own data.turn; trust the walk (identical in
    // practice, but the walk cannot be fooled by duplicate turn numbers).
    if (isChunkRow(line.parsed) && line.ownTurn !== null) line.intervalTurn = line.intervalTurn ?? line.ownTurn
  }

  // 3. Decide keep/drop.
  const present = new Set<number>()
  for (const line of lines) {
    if (line.intervalTurn !== null) present.add(line.intervalTurn)
  }
  const unmapped: number[] = []
  for (const turn of masked) {
    if (!present.has(turn)) unmapped.push(turn)
  }
  for (const line of lines) {
    if (line.type !== 'session') {
      if (COMPACTION_TYPES.has(line.type)) { line.keep = false; continue }
      // Mailbox splices are always dropped: their history is replaced by one
      // final-state splice below. Keeping the raw splice history would
      // resurrect masked messages into the composer queue (the claims that
      // removed them are inside the masked turns and get dropped with them).
      if (line.type === 'agent/inbox/spliced') { line.keep = false; continue }
      // Any surface replacement (compaction checkpoint, tool-result prune)
      // shadows earlier nodes we may have removed; the refined branch keeps
      // native content, so replace copies never survive.
      const surfaceOp = line.parsed.surfaceOp
      if (surfaceOp !== undefined && surfaceOp !== null && surfaceOp !== 'append' && typeof surfaceOp === 'object') {
        line.keep = false
        continue
      }
      if (line.intervalTurn !== null && masked.has(line.intervalTurn)) { line.keep = false; continue }
    }
    line.keep = true
  }

  // 3b. Re-emit the true mailbox state: the composer queue of the refined
  //     session equals the original pending state, as one splice per target
  //     at the end of the log (the replay applies them onto empty lists).
  const pending = replayInboxPending(lines)
  const syntheticFrame = Math.max(0, ...lines.map((line) => line.frame)) + 1
  for (const target of ['next-turn', 'next-step'] as const) {
    const inserted = pending[target]
    if (inserted.length === 0) continue
    const parsed: Record<string, unknown> = {
      type: 'agent/inbox/spliced',
      seq: 0, // renumbered below
      time: Date.now(),
      data: { target, start: 0, inserted },
    }
    lines.push({
      frame: syntheticFrame,
      text: '',
      parsed,
      type: 'agent/inbox/spliced',
      start: null,
      end: null,
      ownTurn: null,
      intervalTurn: null,
      keep: true,
      newStart: 0,
      synthetic: true,
    })
  }

  // 4. Renumber kept lines in file order and build the old-to-new seq map.
  const oldToNew = new Map<number, number>()
  let counter = 0
  for (const line of lines) {
    if (!line.keep) continue
    if (line.synthetic === true) {
      // Reconstructed event: no original seq to map, only assign the new one.
      line.newStart = counter
      line.parsed.seq = counter
      counter += 1
      line.text = JSON.stringify(line.parsed)
      continue
    }
    if (line.start === null || line.end === null) continue // header line kept verbatim
    line.newStart = counter
    for (let s = line.start; s < line.end; s += 1) oldToNew.set(s, counter++)
    const obj = line.parsed
    if (isChunkRow(obj)) {
      if (typeof obj.seq0 === 'number') obj.seq0 = line.newStart
      else if (typeof obj.seq === 'number') obj.seq = line.newStart
    } else {
      obj.seq = line.newStart
    }
    line.text = JSON.stringify(obj)
  }

  // 5. Translate sourceEventSeqs (storage form: numbers or [start,end] pairs).
  for (const line of lines) {
    if (!line.keep || line.type === 'session') continue
    const raw = line.parsed.sourceEventSeqs
    if (raw === undefined) continue
    const mapped = translateSeqs(raw, oldToNew)
    if (mapped === undefined) continue
    if (mapped.length === 0) {
      // The JSONL surface validation forbids an empty array except on
      // assistant/message; omitting the advisory field is always accepted.
      if (line.type !== 'assistant/message') delete line.parsed.sourceEventSeqs
      else line.parsed.sourceEventSeqs = []
      continue
    }
    line.parsed.sourceEventSeqs = encodeSeqs(mapped)
    line.text = JSON.stringify(line.parsed)
  }

  // 6. Rebuild: keep the header alone in frame 0, then one recompressed frame
  //    per original frame that still has kept lines (locality preserved).
  const groups = new Map<number, string[]>()
  for (const line of lines) {
    if (!line.keep) continue
    if (line.type === 'session') continue
    const bucket = groups.get(line.frame) ?? []
    bucket.push(line.text)
    groups.set(line.frame, bucket)
  }
  // The header line's own frame is always the first; a frame 0 that carries
  // more than the header would violate the reader's single-line-header rule,
  // so overflow lines move into the first event frame.
  const headerLine = lines.find((line) => line.type === 'session')
  const headerText = headerLine?.text ?? '{"type":"session"}'
  const chunks: Buffer[] = [zstdCompressSync(Buffer.from(headerText + '\n', 'utf8'))]
  let overflow: string[] = []
  for (const [frame, bucket] of Array.from(groups.entries()).sort((a, b) => a[0] - b[0])) {
    if (frame === 0) {
      overflow = bucket
      continue
    }
    chunks.push(zstdCompressSync(Buffer.from([...overflow, ...bucket].join('\n') + '\n', 'utf8')))
    overflow = []
  }
  if (overflow.length > 0) {
    chunks.push(zstdCompressSync(Buffer.from(overflow.join('\n') + '\n', 'utf8')))
  }

  const maskedTurns: number[] = []
  for (const turn of masked) if (present.has(turn)) maskedTurns.push(turn)
  maskedTurns.sort((a, b) => a - b)
  const remainingTurns: number[] = []
  for (const line of lines) {
    if (line.keep && line.intervalTurn !== null && !remainingTurns.includes(line.intervalTurn)) {
      remainingTurns.push(line.intervalTurn)
    }
  }
  remainingTurns.sort((a, b) => a - b)
  const droppedLines = lines.filter((line) => !line.keep).length
  return {
    bytes: Buffer.concat(chunks),
    maskedTurns,
    unmapped,
    remainingTurns,
    droppedLines,
  }
}

/** Expanded Session event shape returned by `sessionController.inspect()`. */
export interface CuratableSessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, unknown>
  surfaceOp?: 'append' | { op: 'replace'; start: number; end: number }
  sourceEventSeqs?: number[]
}

/** Event-level Context Curation result accepted by createDerivedSession(). */
export interface CurateEventsResult {
  events: CuratableSessionEvent[]
  maskedTurns: number[]
  unmapped: number[]
  remainingTurns: number[]
  /** Last contiguous TURN number in the derived Session (0 for an empty seed). */
  baselineTurn: number
  droppedEvents: number
}

/** Lossless JSON clone over the Session event value domain. */
function cloneJson<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value
}

/** Replay expanded durable inbox events into their true final pending state. */
function replayEventInbox(events: readonly CuratableSessionEvent[]): InboxPending {
  const state: InboxPending = { 'next-turn': [], 'next-step': [] }
  for (const event of events) {
    if (event.type !== 'agent/inbox/spliced') continue
    const data = event.data
    const target: InboxTarget = data.target === 'next-step' ? 'next-step' : 'next-turn'
    const inserted = Array.isArray(data.inserted) ? data.inserted : []
    const list = state[target]
    const start = typeof data.start === 'number' ? Math.trunc(data.start) : 0
    const deleteCount = typeof data.removedCount === 'number' ? Math.trunc(data.removedCount) : 0
    const actualStart = Math.max(0, Math.min(start, list.length))
    const actualDelete = Math.max(0, Math.min(deleteCount, list.length - actualStart))
    list.splice(actualStart, actualDelete, ...cloneJson(inserted))
  }
  return state
}

/** Map an ordinary in-memory seq list through the curated old-to-new map. */
function mapEventSeqs(value: unknown, oldToNew: Map<number, number>): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const mapped: number[] = []
  const seen = new Set<number>()
  for (const source of value) {
    if (typeof source !== 'number' || !Number.isSafeInteger(source) || source < 0) continue
    const next = oldToNew.get(source)
    if (next === undefined || seen.has(next)) continue
    seen.add(next)
    mapped.push(next)
  }
  return mapped
}

/**
 * Curate expanded Session events into one independent, contiguous seed.
 * Unlike `maskArtifact`, this operates on DSH-owned event objects and is the
 * production path used by `sessionController.createDerivedSession()`.
 */
export function curateSessionEvents(
  sourceEvents: readonly CuratableSessionEvent[],
  masked: ReadonlySet<number>,
): CurateEventsResult {
  const ordered = sourceEvents.slice().sort((a, b) => a.seq - b.seq)
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index]!.seq !== index) {
      throw new Error(`source event seq gap at index ${index} (read ${ordered[index]!.seq})`)
    }
  }

  const pending = replayEventInbox(ordered)
  const turnOf = new Map<number, number>()
  const present = new Set<number>()
  const turnOrder: number[] = []
  let openTurn: number | null = null
  for (const event of ordered) {
    const ownTurn = typeof event.data.turn === 'number' && Number.isSafeInteger(event.data.turn)
      ? event.data.turn
      : null
    if (event.type === 'turn/start') {
      openTurn = ownTurn
      if (openTurn !== null) {
        turnOf.set(event.seq, openTurn)
        if (!present.has(openTurn)) turnOrder.push(openTurn)
        present.add(openTurn)
      }
      continue
    }
    if (event.type === 'turn/end') {
      const turn = openTurn ?? ownTurn
      if (turn !== null) {
        turnOf.set(event.seq, turn)
        if (!present.has(turn)) turnOrder.push(turn)
        present.add(turn)
      }
      openTurn = null
      continue
    }
    if (openTurn !== null) {
      turnOf.set(event.seq, openTurn)
      present.add(openTurn)
    }
  }

  const unmapped = Array.from(masked).filter((turn) => !present.has(turn)).sort((a, b) => a - b)
  const preliminary = ordered.filter((event) => {
    if (COMPACTION_TYPES.has(event.type)) return false
    if (event.type === 'session/end-seed' || event.type === 'session/title-llm-request') return false
    if (event.type === 'agent/inbox/spliced') return false
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return false
    const turn = turnOf.get(event.seq)
    return turn === undefined || !masked.has(turn)
  })

  // Title provenance is event-seq based. Drop automatic metadata whose entire
  // cited prompt set was curated away; explicit user renames legitimately cite none.
  const preliminarySeqs = new Set(preliminary.map((event) => event.seq))
  const kept = preliminary.filter((event) => {
    const messageSeqs = event.data.messageSeqs
    if (!Array.isArray(messageSeqs)) return true
    const cited = messageSeqs.filter((seq) => typeof seq === 'number') as number[]
    const retained = cited.length > 0 && cited.every((seq) => preliminarySeqs.has(seq))
    if (event.type === 'session/title') {
      const source = event.data.source as { kind?: unknown } | undefined
      return source?.kind === 'user' || retained
    }
    return true
  })

  // A derived Session is a new relation domain: retained source TURN ids may
  // contain holes, but DSH requires turn/start values 1..N with no gaps.
  const retainedTurnOrder = turnOrder.filter((turn) => !masked.has(turn))
  const turnToDerived = new Map<number, number>()
  for (let index = 0; index < retainedTurnOrder.length; index += 1) {
    turnToDerived.set(retainedTurnOrder[index]!, index + 1)
  }

  const oldToNew = new Map<number, number>()
  for (let index = 0; index < kept.length; index += 1) oldToNew.set(kept[index]!.seq, index)
  const events: CuratableSessionEvent[] = kept.map((source, index) => {
    const event = cloneJson(source)
    event.seq = index
    const sourceTurn = source.data.turn
    if (typeof sourceTurn === 'number' && Number.isSafeInteger(sourceTurn)) {
      const derivedTurn = turnToDerived.get(sourceTurn)
      if (derivedTurn !== undefined) event.data.turn = derivedTurn
    }
    const mappedSources = mapEventSeqs(source.sourceEventSeqs, oldToNew)
    if (mappedSources !== undefined) {
      if (mappedSources.length > 0 || event.type === 'assistant/message') event.sourceEventSeqs = mappedSources
      else delete event.sourceEventSeqs
    }
    const mappedMessages = mapEventSeqs(source.data.messageSeqs, oldToNew)
    if (mappedMessages !== undefined) event.data.messageSeqs = mappedMessages
    return event
  })

  let nextTime = 1
  for (const event of ordered) nextTime = Math.max(nextTime, event.time + 1)
  const append = (type: string, data: Record<string, unknown>): void => {
    events.push({ type, seq: events.length, time: nextTime++, data: cloneJson(data) })
  }
  // Replace the historical splice ledger by the exact final pending state.
  for (const target of ['next-turn', 'next-step'] as const) {
    if (pending[target].length === 0) continue
    append('agent/inbox/spliced', { target, start: 0, inserted: pending[target] })
  }

  const maskedTurns = Array.from(masked).filter((turn) => present.has(turn)).sort((a, b) => a - b)
  const remainingTurns = Array.from(present).filter((turn) => !masked.has(turn)).sort((a, b) => a - b)
  return {
    events,
    maskedTurns,
    unmapped,
    remainingTurns,
    baselineTurn: retainedTurnOrder.length,
    droppedEvents: sourceEvents.length - kept.length,
  }
}
function translateSeqs(value: unknown, oldToNew: Map<number, number>): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const decoded: number[] = []
  for (const entry of value) {
    if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) {
      decoded.push(entry)
    } else if (Array.isArray(entry) && entry.length === 2
      && typeof entry[0] === 'number' && Number.isSafeInteger(entry[0]) && entry[0]! >= 0
      && typeof entry[1] === 'number' && Number.isSafeInteger(entry[1]) && entry[1]! >= entry[0]!) {
      for (let s = entry[0]!; s <= entry[1]!; s += 1) decoded.push(s)
    } else {
      return undefined
    }
  }
  const mapped: number[] = []
  const seen = new Set<number>()
  for (const seq of decoded) {
    const next = oldToNew.get(seq)
    if (next === undefined || seen.has(next)) continue
    seen.add(next)
    mapped.push(next)
  }
  return mapped
}

/** Encode strictly increasing seqs as compact [start,end] ranges, else plain. */
function encodeSeqs(values: readonly number[]): Array<number | [number, number]> {
  const encoded: Array<number | [number, number]> = []
  let increasing = true
  for (let i = 1; i < values.length; i += 1) {
    if (values[i]! <= values[i - 1]!) { increasing = false; break }
  }
  if (!increasing) return [...values]
  let start = 0
  while (start < values.length) {
    let end = start
    while (end + 1 < values.length && values[end + 1] === values[end]! + 1) end += 1
    if (end - start >= 2) encoded.push([values[start]!, values[end]!])
    else for (let i = start; i <= end; i += 1) encoded.push(values[i]!)
    start = end + 1
  }
  return encoded
}

// ---------------------------------------------------------------------------
// Independent derived-Session creation
// ---------------------------------------------------------------------------

/** Result of one refine attempt (owned JSON for the wire). */
export interface RefineResult {
  ok: boolean
  reason?: string
  /** Source-Session TURN ids omitted from the derived seed. */
  maskedTurns?: number[]
  /** Requested turns absent from the artifact (nothing was removed for them). */
  unmapped?: number[]
  /** Source-Session TURN ids retained in the derived seed. */
  remainingTurns?: number[]
  /** Error text of a failed stage, for diagnostics. */
  error?: string
  /** Independent ordinary Session created from the curated seed. */
  newSessionId?: string
  /** Initial Context Curation commit in the new Session's shadow repo. */
  curationCommit?: string
  /** Whether Workspace registry accounting attached the new Session. */
  workspaceAttached?: boolean
  /** Workspace identity inherited by the new Session, when resolved. */
  workspaceId?: string
  /** Post-publication Workspace accounting warning. */
  workspaceAttachmentFailure?: { code: string; workspaceId: string; message: string }
  /** Success but a non-fatal post-publication step degraded. */
  warning?: string
}

/** Latest visible source title, with a deterministic fallback for blank sessions. */
function sourceSessionTitle(
  inspected: { meta: { [key: string]: unknown }; events: readonly CuratableSessionEvent[] },
): string {
  let title = typeof inspected.meta.title === 'string' ? inspected.meta.title.trim() : ''
  for (const event of inspected.events) {
    if (event.type === 'session/title' && typeof event.data.title === 'string') {
      const candidate = event.data.title.trim()
      if (candidate.length > 0) title = candidate
    }
  }
  return title.length > 0 ? title : '未命名会话'
}

/** Host Session Controller face used to publish and name an independent derived Session. */
export interface SessionControllerLike {
  inspect(sessionId: string): Promise<{
    meta: { id: string; cwd?: string; [key: string]: unknown }
    events: CuratableSessionEvent[]
  }>
  createDerivedSession(request: {
    seed: readonly CuratableSessionEvent[]
    compositionSourceSessionId: string
  }): Promise<{
    sessionId: string
    workspaceId?: string
    workspaceAttached: boolean
    workspaceAttachmentFailure?: { code: string; workspaceId: string; message: string }
  }>
  rename(request: { sessionId: string; title: string }): Promise<{ title: string; seq: number }>
}

/**
 * Create one independent Context Curation Session. The source Session, its
 * official artifact, its shadow Git repo, and the workspace files are never
 * replaced or rewound. DSH's official derived-session API owns composition,
 * persistence publication, Workspace accounting, and the new live Agent.
 */
export async function refineSession(
  subprocess: SubprocessLike,
  root: string,
  sessions: SessionsServiceLike | undefined,
  persistence: PersistenceLike | undefined,
  agents: AgentRegistryLike | undefined,
  sessionController: SessionControllerLike | undefined,
  sourceSessionId: string,
  maskedTurns: number[],
): Promise<RefineResult> {
  const source = sessions?.get(sourceSessionId)
  if (source === undefined || source.header === undefined) return { ok: false, reason: 'no-session' }
  if (agents?.get(sourceSessionId)?.status === 'running') return { ok: false, reason: 'session-running' }
  if (sessionController === undefined) return { ok: false, reason: 'derived-session-unavailable' }
  if (persistence === undefined) return { ok: false, reason: 'no-persistence' }

  const desired = new Set(maskedTurns.filter((turn) => Number.isSafeInteger(turn) && turn >= 0))
  if (desired.size === 0) return { ok: false, reason: 'bad-args' }

  let inspected: Awaited<ReturnType<SessionControllerLike['inspect']>>
  try {
    inspected = await sessionController.inspect(sourceSessionId)
  } catch (error) {
    return { ok: false, reason: 'inspect-failed', error: error instanceof Error ? error.message : String(error) }
  }

  let curated: CurateEventsResult
  try {
    curated = curateSessionEvents(inspected.events, desired)
  } catch (error) {
    return { ok: false, reason: 'curation-failed', error: error instanceof Error ? error.message : String(error) }
  }
  if (curated.maskedTurns.length === 0) {
    return {
      ok: false,
      reason: 'nothing-masked',
      ...(curated.unmapped.length > 0 ? { unmapped: curated.unmapped } : {}),
    }
  }

  let created: Awaited<ReturnType<SessionControllerLike['createDerivedSession']>>
  try {
    created = await sessionController.createDerivedSession({
      seed: curated.events,
      compositionSourceSessionId: sourceSessionId,
    })
  } catch (error) {
    return { ok: false, reason: 'create-derived-failed', error: error instanceof Error ? error.message : String(error) }
  }

  const warnings: string[] = []
  const requestedTitle = `CTX-${sourceSessionTitle(inspected)}`
  try {
    await sessionController.rename({ sessionId: created.sessionId, title: requestedTitle })
  } catch (error) {
    // Publication already succeeded. Keep the derived Session usable and expose
    // title failure as a non-fatal warning rather than deleting the new history.
    warnings.push(`Derived Session rename failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (created.workspaceAttachmentFailure !== undefined) {
    warnings.push(`Workspace attachment failed: ${created.workspaceAttachmentFailure.message}`)
  }
  if (curated.remainingTurns.length === 0) warnings.push('Curated session contains no original conversation TURN')

  // Bootstrap only the new Session shadow repo. Deliberately skip workspace
  // snapshotting here: Context Curation must be read-only to the shared cwd.
  // The derived Session's first ordinary turn boundary starts its independent
  // workspace history through the normal snapshot listener.
  const derivedSession = sessions?.get(created.sessionId)
  let curationCommit: string | undefined
  if (derivedSession === undefined) {
    warnings.push('Derived Session was published but is not visible in the Session store yet')
  } else {
    const snapshot = await takeSnapshot(subprocess, root, sessions, persistence, {
      session: derivedSession,
      kind: 'refine',
      maskedTurns: curated.maskedTurns,
      baselineTurn: curated.baselineTurn,
      skipWorkspace: true,
    })
    if (snapshot.ok) curationCommit = snapshot.commit
    else warnings.push(`Initial Context Curation snapshot failed: ${snapshot.reason ?? 'unknown'}`)
  }

  return {
    ok: true,
    newSessionId: created.sessionId,
    maskedTurns: curated.maskedTurns,
    ...(curated.unmapped.length > 0 ? { unmapped: curated.unmapped } : {}),
    ...(curated.remainingTurns.length > 0 ? { remainingTurns: curated.remainingTurns } : {}),
    ...(curationCommit === undefined ? {} : { curationCommit }),
    workspaceAttached: created.workspaceAttached,
    ...(created.workspaceId === undefined ? {} : { workspaceId: created.workspaceId }),
    ...(created.workspaceAttachmentFailure === undefined
      ? {}
      : { workspaceAttachmentFailure: created.workspaceAttachmentFailure }),
    ...(warnings.length === 0 ? {} : { warning: warnings.join('; ') }),
  }
}
