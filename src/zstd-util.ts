/**
 * Session-file decode + semantic compare for the diff-driven snapshot dedup.
 *
 * The official session artifact is a multi-frame zstd JSONL log; the
 * persistence protocol is APPEND-ONLY (frames are never rewritten), so every
 * historical snapshot blob is a byte-prefix of any later file. After a rewind
 * the loader appends a small bookkeeping tail on resume (`session/end-seed`,
 * plus a turn-drain pair when the target ended mid-turn).
 *
 * "内容没变" is judged on decoded EVENTS: the target's events plus only
 * bookkeeping => unchanged (nothing produced); any real conversation event
 * appended => changed (fork/commit). Decoding is local via node:zlib.
 */

import { readFile } from 'node:fs/promises'
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/** One decoded zstd frame range. */
export interface FrameRange {
  start: number
  end: number
}

/** Scan complete zstd frames; a torn tail is tolerated, corrupt magic throws. */
export function scanZstdFrames(buffer: Buffer): FrameRange[] {
  const frames: FrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return frames
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt zstd frame magic at ${offset}`)
    offset += 4
    if (offset === buffer.length) return frames
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    for (;;) {
      if (buffer.length - offset < 3) return frames
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      const payloadBytes = blockType === 1 ? 1 : blockSize
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return frames
}

/**
 * Byte length of the artifact prefix that ends JUST BEFORE the latest turn's
 * user message — i.e. the start offset of the last zstd frame that contains a
 * `turn/start` event. Because the persistence writes the turn-opening frame
 * (turn/start + the inbox splice that carries the user message) separately
 * from the earlier idle state, this prefix is a valid append-only artifact
 * representing "the user has NOT yet sent this turn's message".
 *
 * Returns bytes.length when no turn/start frame is found (nothing to trim) so
 * callers can hash the whole file unchanged.
 * @param bytes - raw artifact bytes.
 * @returns the truncation length (0..bytes.length).
 */
export function preTurnPrefixLength(bytes: Buffer): number {
  let cut = bytes.length
  for (const frame of scanZstdFrames(bytes)) {
    const text = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (t.length === 0) continue
      try {
        if ((JSON.parse(t) as { type?: unknown }).type === 'turn/start') { cut = frame.start; break }
      } catch {
        // Non-JSON line inside a frame: ignore.
      }
    }
  }
  return cut
}

/** Latest human/assistant message text found in one artifact (for commit previews). */
export interface MessagePreviews {
  /** Last genuine user message (source.kind === 'user'; injected context excluded). */
  user?: string
  /** Last assistant message. */
  assistant?: string
}

/** Join the text parts of a message content array into one string. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const part of content) {
    if (part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = (part as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join(' ')
}

/**
 * Extract the latest user and assistant message text from an artifact.
 *
 * Frames are scanned NEWEST-first and decompressed only until both previews
 * are found (turn boundaries sit at the tail), so a multi-MB history costs a
 * couple of frame decodes, not a full decompress. A corrupt tail is tolerated
 * (returns whatever was found). Injected context (source.kind !== 'user') is
 * never treated as a user message.
 * @param bytes - raw artifact bytes.
 * @returns the newest user/assistant previews (fields absent when not found).
 */
export function extractMessagePreviews(bytes: Buffer): MessagePreviews {
  let frames: FrameRange[]
  try {
    frames = scanZstdFrames(bytes)
  } catch {
    return {}
  }
  let user: string | undefined
  let assistant: string | undefined
  for (let f = frames.length - 1; f >= 0; f -= 1) {
    const frame = frames[f]!
    let plaintext: string
    try {
      plaintext = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')
    } catch {
      continue
    }
    const lines = plaintext.split('\n')
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const text = lines[i]!.trim()
      if (text.length === 0) continue
      let parsed: { type?: unknown; data?: Record<string, unknown> }
      try {
        parsed = JSON.parse(text) as typeof parsed
      } catch {
        continue
      }
      const data = parsed.data
      if (assistant === undefined && parsed.type === 'assistant/message' && data !== undefined) {
        const message = data.message as { content?: unknown } | undefined
        const content = message?.content ?? (data as { content?: unknown }).content
        const value = textOf(content)
        if (value.length > 0) assistant = value
      } else if (user === undefined && parsed.type === 'user/message' && data !== undefined) {
        const source = data.source as { kind?: unknown } | undefined
        if (source?.kind === 'user') {
          const value = textOf((data as { content?: unknown }).content)
          if (value.length > 0) user = value
        }
      }
      if (user !== undefined && assistant !== undefined) return { user, assistant }
    }
  }
  return {
    ...(user !== undefined ? { user } : {}),
    ...(assistant !== undefined ? { assistant } : {}),
  }
}

/** Composition facts read from one session artifact (rewind target content). */
export interface TargetFacts {
  /** Agent preset the artifact records (header value or last selection), when present. */
  agentPreset?: string
  /** Provider/model from the artifact's last `request/header` config. */
  route?: { provider?: string; model?: string }
}

/**
 * Read the composition facts that determine the wire request prefix.
 *
 * The artifact's head `session` line carries the creation-time preset; later
 * `agent-preset/selected` events win (the session may have switched while
 * blank). The last `request/header` config is the provider/model route the
 * artifact's history was produced under. A corrupt artifact yields no facts —
 * callers then fall back to the uncomposed resume, never fail on decode.
 * @param bytes - raw artifact bytes.
 * @returns the resolved facts (empty object when nothing is readable).
 */
export function decodeTargetFacts(bytes: Buffer): TargetFacts {
  let headerAgentPreset: string | undefined
  let lastAgentPreset: string | undefined
  let lastRoute: { provider?: string; model?: string } | undefined
  let lastRouteSeen = false
  for (const frame of scanZstdFrames(bytes)) {
    const plaintext = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')
    for (const line of plaintext.split('\n')) {
      const text = line.trim()
      if (text.length === 0) continue
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(text) as Record<string, unknown>
      } catch {
        continue
      }
      if (parsed.type === 'session' && typeof parsed.agentPreset === 'string') {
        headerAgentPreset = parsed.agentPreset
      } else if (parsed.type === 'agent-preset/selected') {
        const data = parsed.data as Record<string, unknown> | undefined
        if (data !== undefined && typeof data.agentPreset === 'string') lastAgentPreset = data.agentPreset
      } else if (parsed.type === 'request/header') {
        const data = parsed.data as { header?: { config?: Record<string, unknown> } } | undefined
        const config = data?.header?.config
        if (config !== undefined && typeof config === 'object') {
          lastRouteSeen = true
          lastRoute = {
            ...(typeof config.provider === 'string' ? { provider: config.provider } : {}),
            ...(typeof config.model === 'string' ? { model: config.model } : {}),
          }
        }
      }
    }
  }
  const agentPreset = lastAgentPreset ?? headerAgentPreset
  return {
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(lastRouteSeen && lastRoute !== undefined ? { route: lastRoute } : {}),
  }
}

/** One decoded event line (owned JSON; only leaf scalars kept). */
export interface SessionEventLite {
  type: string
  seq: number
  time: number
  json: string
}

/** Decode all frames of one artifact (raw bytes) into event lines. */
export function decodeSessionEventsFromBytes(bytes: Buffer): SessionEventLite[] {
  const frames = scanZstdFrames(bytes)
  const events: SessionEventLite[] = []
  for (const frame of frames) {
    const plaintext = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')
    for (const line of plaintext.split('\n')) {
      const text = line.trim()
      if (text.length === 0) continue
      const parsed = JSON.parse(text) as { type?: string; seq?: number; time?: number }
      // The header frame line carries no seq/type — skip it.
      if (typeof parsed.type !== 'string' || typeof parsed.seq !== 'number') continue
      events.push({ type: parsed.type, seq: parsed.seq, time: parsed.time ?? 0, json: text })
    }
  }
  events.sort((a, b) => a.seq - b.seq)
  return events
}

/** Bookkeeping event types the loader appends on resume (never conversation). */
const BOOKKEEPING_TYPES = new Set(['session/end-seed'])

/** True when the event is the loader's replay-drain of a mid-turn target. */
function isDrainEvent(event: SessionEventLite, baseLastTime: number): boolean {
  return event.time <= baseLastTime + 1 && (event.type === 'step/end' || event.type === 'turn/end')
}

/**
 * Semantic equality: the base (rewind target) event list vs the current
 * (post-jump, post-resume) event list. Bookkeeping appends are ignored:
 *   - session/end-seed (every resume);
 *   - trailing step/end + turn/end replay-drain pair whose timestamps equal
 *     the base's last event time (target ended mid-turn).
 * The base events must be the exact HEAD of the current list (append-only).
 * @param current - events decoded from the live artifact.
 * @param base - events decoded from the base blob's bytes.
 * @returns true when the conversation content is unchanged.
 */
export function semanticallyEqual(current: SessionEventLite[], base: SessionEventLite[]): boolean {
  const baseLastTime = base.length > 0 ? base[base.length - 1]!.time : 0
  let i = 0
  let j = 0
  while (i < current.length) {
    const event = current[i]!
    if (BOOKKEEPING_TYPES.has(event.type)) {
      i += 1
      continue
    }
    if (j < base.length) {
      // Position-sensitive: base events must be the current head exactly.
      if (base[j]!.json !== event.json) return false
      j += 1
      i += 1
      continue
    }
    // Anything after the base head is an append: real unless it is the replay
    // drain that immediately follows a mid-turn target's resume.
    if (isDrainEvent(event, baseLastTime)) {
      i += 1
      continue
    }
    return false
  }
  return j === base.length
}

/**
 * Append a bare EMPTY turn pair (`turn/start` → `turn/end`, no messages) as a
 * NEW zstd frame, ALWAYS. Every BASELINE (turn-start) snapshot carries its own
 * turn/start, so ANY snapshot is a valid non-blank conversation state: DSH's
 * `sessionBlank` check passes for every backup point without having to know
 * whether it was the first message. The empty turn contributes no message to
 * the model (an empty turn projects no surface content).
 * @param bytes - the artifact bytes to extend.
 * @returns the extended bytes (unchanged when the format is unreadable).
 */
export function appendEmptyTurn(bytes: Buffer): Buffer {
  try {
    const events = decodeSessionEventsFromBytes(bytes)
    // Existing event seqs are 0-based and contiguous; new events follow on.
    const baseSeq = events.length > 0 ? events[events.length - 1]!.seq + 1 : 0
    const now = Date.now()
    const seedLines = [
      JSON.stringify({ type: 'turn/start', seq: baseSeq, time: now, data: { turn: 1 } }),
      JSON.stringify({ type: 'turn/end', seq: baseSeq + 1, time: now, data: { turn: 1, reason: { kind: 'completed' } } }),
    ]
    const frame = zstdCompressSync(Buffer.from(seedLines.join('\n') + '\n', 'utf8'))
    return Buffer.concat([bytes, frame])
  } catch {
    return bytes
  }
}

/**
 * Blank-session fix (mirrors dsh-session-tree's seed trick): DSH's
 * `sessionBlank` treats a log with NO `turn/start` as a brand-new session —
 * the hero page, hidden from lists, reused by New Session. Rewinding onto
 * such a pre-send empty state would therefore blank the chat window. When the
 * target really has no `turn/start`, append a bare empty turn pair (see
 * `appendEmptyTurn`); targets that already carry one are left untouched.
 * @param bytes - the target artifact bytes (multi-frame zstd JSONL).
 * @returns the possibly-extended bytes (original when no seeding is needed).
 */
export function seedBlankSession(bytes: Buffer): Buffer {
  try {
    const events = decodeSessionEventsFromBytes(bytes)
    if (events.some((event) => event.type === 'turn/start')) return bytes
    return appendEmptyTurn(bytes)
  } catch {
    // Unreadable/unexpected format: leave the bytes as they are.
    return bytes
  }
}
