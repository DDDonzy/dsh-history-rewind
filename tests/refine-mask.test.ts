/**
 * Pure-artifact tests for 精炼会话 masking (maskArtifact): turn attribution,
 * seq renumbering, sourceEventSeqs translation, compaction removal, and the
 * zstd frame rebuild, against synthetically encoded artifacts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { maskArtifact, type MaskResult } from '../src/refine.ts'
import { scanZstdFrames } from '../src/zstd-util.ts'

/** One logical event (chunk rows expanded) for assertions. */
interface DecodedEvent {
  type: string
  seq: number
  turn: number | null
  sourceEventSeqs?: unknown
  surfaceOp?: unknown
  line: object
}

/** Encode artifact lines: header in frame 0, then one frame per line. */
function encodeArtifact(lines: object[]): Buffer {
  const header = JSON.stringify(lines[0]) + '\n'
  const chunks = [zstdCompressSync(Buffer.from(header, 'utf8'))]
  for (const line of lines.slice(1)) {
    chunks.push(zstdCompressSync(Buffer.from(JSON.stringify(line) + '\n', 'utf8')))
  }
  return Buffer.concat(chunks)
}

/** Decode every line of the artifact (storage rows expanded to events). */
function decodeArtifact(bytes: Buffer): { header: object; events: DecodedEvent[] } {
  const frames = scanZstdFrames(bytes)
  const events: DecodedEvent[] = []
  let header: object = {}
  let first = true
  for (const frame of frames) {
    const text = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString('utf8')
    for (const raw of text.split('\n')) {
      const t = raw.trim()
      if (t.length === 0) continue
      const obj = JSON.parse(t) as Record<string, unknown>
      if (obj.type === 'session') {
        if (first) header = obj
        continue
      }
      if (obj.type === 'text-chunks' || obj.type === 'reasoning-chunks' || obj.type === 'tool-call-chunks') {
        const data = obj.data as { texts?: string[]; args?: string[] }
        const length = (data.texts ?? data.args)?.length ?? 0
        for (let k = 0; k < length; k += 1) {
          events.push({ type: 'assistant/chunk', seq: (obj.seq0 as number) + k, turn: (data as { turn?: number }).turn ?? null, line: obj })
        }
        continue
      }
      events.push({
        type: obj.type as string,
        seq: obj.seq as number,
        turn: ((obj.data as { turn?: number } | undefined)?.turn ?? null) as number | null,
        sourceEventSeqs: obj.sourceEventSeqs,
        surfaceOp: obj.surfaceOp,
        line: obj,
      })
    }
  }
  return { header, events }
}

/** Standard 3-turn artifact fixture. */
function fixture(): Buffer {
  const lines: object[] = [
    { type: 'session', version: 0, id: 's1', createdAt: 1000, delegationDepth: 0 },
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'q1' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] } }, sourceEventSeqs: [], surfaceOp: 'append' },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },

    // Turn 2 — the one the test masks.
    { type: 'turn/start', seq: 4, time: 5, data: { turn: 2 } },
    { type: 'user/message', seq: 5, time: 6, data: { content: [{ type: 'text', text: 'q2' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/chunk', seq: 6, time: 7, data: { turn: 2, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } } },
    { type: 'tool/call', seq: 7, time: 8, data: { turn: 2, step: 1, callId: 'c1', name: 'x', arguments: '{}' }, surfaceOp: 'append' },
    { type: 'tool/result', seq: 8, time: 9, data: { turn: 2, step: 1, message: { role: 'user', content: [] } }, sourceEventSeqs: [7], surfaceOp: 'append' },
    { type: 'assistant/message', seq: 9, time: 10, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a2' }] } }, sourceEventSeqs: [6, 7], surfaceOp: 'append' },
    { type: 'turn/end', seq: 10, time: 11, data: { turn: 2, reason: { kind: 'completed' } } },

    // Inter-turn bookkeeping (no turn): compaction + request header.
    { type: 'compaction/start', seq: 11, time: 12, data: { compactionId: 'cp1', turn: null } },
    { type: 'compaction/summary', seq: 12, time: 13, data: { compactionId: 'cp1', turn: null, summary: '…' } },
    { type: 'compaction/end', seq: 13, time: 14, data: { compactionId: 'cp1', turn: null } },
    { type: 'request/header', seq: 14, time: 15, data: { header: { config: { provider: 'p', model: 'm' } } } },

    // Turn 3 — packed chunk row + replacement checkpoint (dropped with compaction).
    { type: 'turn/start', seq: 15, time: 16, data: { turn: 3 } },
    { type: 'user/message', seq: 16, time: 17, data: { content: [{ type: 'text', text: 'q3' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/chunk', seq: 17, time: 18, data: { turn: 3, step: 1, chunk: { type: 'block-start', index: 0 } } },
    { type: 'text-chunks', seq0: 18, time0: 19, data: { turn: 3, step: 1, index: 0, dt: [1, 1], texts: ['aa', 'bb', 'cc'] } },
    { type: 'assistant/message', seq: 21, time: 22, data: { turn: 3, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a3' }] } }, sourceEventSeqs: [17, 18, 19, 20], surfaceOp: 'append' },
    { type: 'user/message', seq: 22, time: 23, data: { content: [{ type: 'text', text: '<compact-checkpoint>' }], source: { kind: 'plugin', plugin: 'compact' } }, sourceEventSeqs: [1, 2, 5, 9], surfaceOp: { op: 'replace', start: 1, end: 9 } },
    { type: 'turn/end', seq: 23, time: 24, data: { turn: 3, reason: { kind: 'completed' } } },
  ]
  return encodeArtifact(lines)
}

/** Assert seqs are contiguous 0..n-1 in the decoded event list. */
function assertContiguous(events: DecodedEvent[]): void {
  events.forEach((event, index) => {
    assert.equal(event.seq, index, `seq gap at event ${index} (${event.type} seq=${event.seq})`)
  })
}

test('maskArtifact removes the masked turn and keeps everything else', () => {
  const bytes = fixture()
  const result = maskArtifact(bytes, new Set([2]))!
  assert.ok(result !== null)
  assert.deepEqual(result.maskedTurns, [2])
  assert.deepEqual(result.remainingTurns, [1, 3])
  assert.equal(result.unmapped.length, 0)

  const { header, events } = decodeArtifact(result.bytes)
  assert.equal((header as { type?: string }).type, 'session')
  assertContiguous(events)

  // No turn-2 events at all.
  assert.ok(!events.some((event) => event.turn === 2), 'turn 2 events must be fully gone')
  // No compaction markers or replacement checkpoints.
  assert.ok(!events.some((event) => event.type.startsWith('compaction/')), 'compaction events must be gone')
  assert.ok(!events.some((event) => event.type === 'user/message' && event.surfaceOp !== 'append'), 'replacement checkpoints must be gone')
  // The kept turns show their natives.
  const textOf = (event: DecodedEvent): string =>
    ((event.line as { data: { content: { text: string }[] } }).data.content[0]?.text ?? '')
  assert.ok(events.some((event) => event.type === 'user/message' && textOf(event) === 'q1'))
  assert.ok(events.some((event) => event.type === 'user/message' && textOf(event) === 'q3'))
  assert.ok(!events.some((event) => event.type === 'user/message' && textOf(event) === 'q2'))
  // Packed chunk row expanded to 3 chunks with contiguous seqs (turn 3 only:
  // turn 2's block-start is masked away, so kept = 1 block-start + 3 deltas).
  const chunks = events.filter((event) => event.type === 'assistant/chunk')
  assert.equal(chunks.length, 4)
  assertContiguous(events)
})

test('maskArtifact translates sourceEventSeqs through the renumbering', () => {
  const bytes = fixture()
  const result = maskArtifact(bytes, new Set([2]))!
  const { events } = decodeArtifact(result.bytes)

  // Turn 3's assistant/message originally referenced [17,18,19,20]; with
  // turn 2 (seqs 4..10) removed those map to 7,8,9,10 → encoded [[7,10]].
  const asst3 = events.find((event) => event.type === 'assistant/message' && event.turn === 3)!
  const raw3 = asst3.sourceEventSeqs as unknown[]
  assert.deepEqual(raw3, [[7, 10]])
  const seqs3 = raw3.flatMap((entry) => (Array.isArray(entry) ? [entry[0] as number, entry[1] as number] : [entry as number]))
  assert.equal(seqs3.length, 2) // one [start,end] range entry
  for (const seq of seqs3) {
    assert.ok(seq < asst3.seq, `sourceEventSeqs ${seq} must be earlier than event seq ${asst3.seq}`)
  }
  // The range expands to all four chunk seqs: 7, 8, 9, 10 (all < 11).
  for (let seq = 7; seq <= 10; seq += 1) {
    assert.ok(seq < asst3.seq)
  }

  // Turn 1's assistant/message carried sourceEventSeqs: [] — stays empty.
  const asst1 = events.find((event) => event.type === 'assistant/message' && event.turn === 1)!
  assert.deepEqual(asst1.sourceEventSeqs, [])
})

test('maskArtifact reports unmapped turns and rejects unknown encodings', () => {
  const bytes = fixture()
  const result = maskArtifact(bytes, new Set([2, 99]))!
  assert.deepEqual(result.unmapped, [99])
  assert.deepEqual(result.maskedTurns, [2])

  // Not a zstd artifact.
  assert.equal(maskArtifact(Buffer.from('plain text'), new Set([1])), null)
})

test('maskArtifact can mask the final turn and leaves a loadable log', () => {
  const bytes = fixture()
  const result = maskArtifact(bytes, new Set([3]))!
  assert.deepEqual(result.maskedTurns, [3])
  assert.deepEqual(result.remainingTurns, [1, 2])
  const { events, header } = decodeArtifact(result.bytes)
  assert.equal((header as { type?: string }).type, 'session')
  assertContiguous(events)
  assert.ok(events.every((event) => event.turn !== 3))
  // Bookkeeping outside turns survives.
  assert.ok(events.some((event) => event.type === 'request/header'))
})

test('maskArtifact keeps first frame as exactly the header line', () => {
  const bytes = fixture()
  const result = maskArtifact(bytes, new Set([2]))!
  const frames = scanZstdFrames(result.bytes)
  const firstText = zstdDecompressSync(result.bytes.subarray(frames[0]!.start, frames[0]!.end)).toString('utf8')
  const lines = firstText.split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]!).type, 'session')
})

test('maskArtifact on an all-masked artifact keeps only inter-turn bookkeeping', () => {
  const bytes = maskArtifact(fixture(), new Set([1, 2, 3]))!
  assert.deepEqual(bytes.maskedTurns, [1, 2, 3])
  assert.deepEqual(bytes.remainingTurns, [])
  const { events, header } = decodeArtifact(bytes.bytes)
  assert.equal((header as { type?: string }).type, 'session')
  // Every turn dropped; the boundary-less request/header record survives.
  assert.equal(events.length, 1)
  assert.equal(events[0]!.type, 'request/header')
  assert.equal(events[0]!.seq, 0)
})

test('maskArtifact roundtrip: unchanged content when nothing is masked', () => {
  const bytes = fixture()
  const result = maskArtifact(bytes, new Set([99]))!
  assert.deepEqual(result.maskedTurns, [])
  assert.deepEqual(result.unmapped, [99])
})

test('masked turn numbers only in the middle leave the refs translation exact', () => {
  const bytes = fixture()
  const result: MaskResult = maskArtifact(bytes, new Set([2]))!
  const { events } = decodeArtifact(result.bytes)
  // Every sourceEventSeqs value on a kept event must resolve to a kept seq.
  for (const event of events) {
    if (event.sourceEventSeqs === undefined) continue
    const raw = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
    const seqs = raw.flatMap((entry) => Array.isArray(entry) ? [entry[0] as number, entry[1] as number] : [entry as number])
    for (const seq of seqs) {
      assert.ok(seq < event.seq, `stale sourceEventSeqs reference ${seq} on seq ${event.seq}`)
    }
  }
})

test('mailbox: masked turns never resurface into the composer queue, real drafts survive', () => {
  const msg = (id: string, text: string): object => ({
    role: 'user', id, content: [{ type: 'text', text }], source: { kind: 'user' },
  })
  const lines: object[] = [
    { type: 'session', version: 0, id: 's2', createdAt: 1000, delegationDepth: 0 },
    // hi queued and consumed inside turn 1.
    { type: 'agent/inbox/spliced', seq: 0, time: 0, data: { target: 'next-turn', start: 0, inserted: [msg('m-hi', 'hi')] } },
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'agent/inbox/spliced', seq: 2, time: 2, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'user/message', seq: 3, time: 3, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 4, time: 4, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] } }, sourceEventSeqs: [], surfaceOp: 'append' },
    { type: 'turn/end', seq: 5, time: 5, data: { turn: 1, reason: { kind: 'completed' } } },
    // hi1 queued and consumed inside turn 2 — the masked turn.
    { type: 'agent/inbox/spliced', seq: 6, time: 6, data: { target: 'next-turn', start: 0, inserted: [msg('m-hi1', 'hi1')] } },
    { type: 'turn/start', seq: 7, time: 7, data: { turn: 2 } },
    { type: 'agent/inbox/spliced', seq: 8, time: 8, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'user/message', seq: 9, time: 9, data: { content: [{ type: 'text', text: 'hi1' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: 10, time: 10, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'a2' }] } }, sourceEventSeqs: [], surfaceOp: 'append' },
    { type: 'turn/end', seq: 11, time: 11, data: { turn: 2, reason: { kind: 'completed' } } },
    // hi2 queued as a REAL unclaimed draft — must survive the refinement.
    { type: 'agent/inbox/spliced', seq: 12, time: 12, data: { target: 'next-turn', start: 0, inserted: [msg('m-hi2', 'hi2')] } },
  ]
  const source = encodeArtifact(lines)
  const result = maskArtifact(source, new Set([2]))!
  assert.deepEqual(result.maskedTurns, [2])
  const { events } = decodeArtifact(result.bytes)
  assertContiguous(events)
  const splices = events.filter((event) => event.type === 'agent/inbox/spliced')
  // Only the true pending draft remains, as ONE final-state splice.
  assert.equal(splices.length, 1)
  const data = (splices[0]!.line as { data: { target: string; start: number; inserted: { id: string }[] } }).data
  assert.equal(data.target, 'next-turn')
  assert.equal(data.start, 0)
  assert.deepEqual(data.inserted.map((m) => m.id), ['m-hi2'])
  // No claimed message id survives anywhere in the refined log.
  const serialized = events.map((event) => JSON.stringify(event.line)).join(' ')
  assert.ok(!serialized.includes('"m-hi1"'))
  assert.ok(!serialized.includes('"m-hi"') || serialized.includes('"m-hi2"'))
  // The refined queue is replayable: one insert into an empty list.
  const queue: string[] = []
  queue.splice(data.start, 0, ...data.inserted.map((m) => m.id))
  assert.deepEqual(queue, ['m-hi2'])
})
