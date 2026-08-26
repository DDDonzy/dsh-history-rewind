/**
 * Semantic-compare tests: after a rewind the loader appends bookkeeping
 * events; the dedup must still judge the conversation unchanged, and a real
 * new message must count as changed.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zstdCompressSync } from 'node:zlib'
import { decodeSessionEventsFromBytes, semanticallyEqual, preTurnPrefixLength, extractMessagePreviews } from '../src/zstd-util.ts'

function frame(lines: string[]): Buffer {
  return zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8'))
}

function header(): string {
  return JSON.stringify({ kind: 'session-log', version: 1 })
}

const BASE_EVENTS = [
  JSON.stringify({ type: 'permission/preset', seq: 0, time: 1000, data: {} }),
  JSON.stringify({ type: 'user/message', seq: 1, time: 1001, data: { content: [{ type: 'text', text: 'hello' }] } }),
  JSON.stringify({ type: 'turn/start', seq: 2, time: 1002, data: {} }),
  JSON.stringify({ type: 'request/context', seq: 3, time: 1002, data: { provider: 'x' } }),
]

function artifact(frames: Buffer[]): Buffer {
  return Buffer.concat(frames)
}

test('semantic compare: base events + end-seed only => unchanged', () => {
  const base = decodeSessionEventsFromBytes(artifact([frame([header()]), frame(BASE_EVENTS)]))
  const tail = [
    JSON.stringify({ type: 'session/end-seed', seq: 4, time: 2000, data: {} }),
  ]
  const current = decodeSessionEventsFromBytes(artifact([frame([header()]), frame(BASE_EVENTS), frame(tail)]))
  assert.equal(semanticallyEqual(current, base), true)
})

test('semantic compare: base events + mid-turn drain pair + end-seed => unchanged', () => {
  const base = decodeSessionEventsFromBytes(artifact([frame([header()]), frame(BASE_EVENTS)]))
  const tail = [
    JSON.stringify({ type: 'step/end', seq: 4, time: 1002, data: { turn: 1, step: 1 } }),
    JSON.stringify({ type: 'turn/end', seq: 5, time: 1002, data: { turn: 1, reason: { kind: 'interrupted' } } }),
    JSON.stringify({ type: 'session/end-seed', seq: 6, time: 2000, data: {} }),
  ]
  const current = decodeSessionEventsFromBytes(artifact([frame([header()]), frame(BASE_EVENTS), frame(tail)]))
  assert.equal(semanticallyEqual(current, base), true)
})

test('semantic compare: real new user message => changed', () => {
  const base = decodeSessionEventsFromBytes(artifact([frame([header()]), frame(BASE_EVENTS)]))
  const tail = [
    JSON.stringify({ type: 'step/end', seq: 4, time: 1002, data: { turn: 1, step: 1 } }),
    JSON.stringify({ type: 'turn/end', seq: 5, time: 1002, data: { turn: 1, reason: { kind: 'interrupted' } } }),
    JSON.stringify({ type: 'session/end-seed', seq: 6, time: 2000, data: {} }),
    JSON.stringify({ type: 'user/message', seq: 7, time: 3000, data: { content: [{ type: 'text', text: 'new talk' }] } }),
  ]
  const current = decodeSessionEventsFromBytes(artifact([frame([header()]), frame(BASE_EVENTS), frame(tail)]))
  assert.equal(semanticallyEqual(current, base), false)
})

test('semantic compare: same set but seq-reordered bookkeeping => unchanged', () => {
  const base = decodeSessionEventsFromBytes(artifact([frame([header()]), frame(BASE_EVENTS)]))
  const tail = [
    JSON.stringify({ type: 'session/end-seed', seq: 6, time: 2000, data: {} }),
    JSON.stringify({ type: 'turn/end', seq: 5, time: 1002, data: { turn: 1, reason: { kind: 'interrupted' } } }),
  ]
  const current = decodeSessionEventsFromBytes(artifact([frame([header()]), frame(BASE_EVENTS), frame(tail)]))
  // 按 seq 排序后仍是「base + 纯记账尾」→ 语义未变（安全侧：只忽略记账）。
  assert.equal(semanticallyEqual(current, base), true)
})

test('preTurnPrefixLength: cuts at the start of the LATEST turn/start frame', () => {
  const idle = frame([header()])
  const setup = frame([JSON.stringify({ type: 'permission/preset', seq: 0, time: 1, data: {} })])
  // turn 1 opens (turn/start + inbox splice carrying the message) in ONE frame,
  // then the message body lands in the next frame.
  const turn1Open = frame([
    JSON.stringify({ type: 'agent/inbox/spliced', seq: 3, time: 10, data: {} }),
    JSON.stringify({ type: 'turn/start', seq: 4, time: 11, data: { turn: 1 } }),
  ])
  const turn1Body = frame([
    JSON.stringify({ type: 'user/message', seq: 7, time: 12, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi1' }] } }),
    JSON.stringify({ type: 'assistant/message', seq: 21, time: 20, data: { message: { content: [{ type: 'text', text: 'reply' }] } } }),
    JSON.stringify({ type: 'turn/end', seq: 23, time: 21, data: { turn: 1 } }),
  ])
  const seed = frame([JSON.stringify({ type: 'session/end-seed', seq: 24, time: 30, data: {} })])
  const turn2Open = frame([
    JSON.stringify({ type: 'turn/start', seq: 26, time: 40, data: { turn: 2 } }),
  ])

  // Before turn 1 is opened: prefix must drop turn1Open and everything after.
  const atTurn1 = artifact([idle, setup, turn1Open, turn1Body])
  const cut1 = preTurnPrefixLength(atTurn1)
  assert.equal(cut1, idle.length + setup.length)
  // The prefix decodes to only the pre-turn idle state (no turn/start, no message).
  const preEvents = decodeSessionEventsFromBytes(atTurn1.subarray(0, cut1))
  assert.equal(preEvents.some((e) => e.type === 'turn/start'), false)
  assert.equal(preEvents.some((e) => e.type === 'user/message'), false)

  // At turn 2 open: prefix keeps through turn 1 end + seed, drops turn2Open.
  const atTurn2 = artifact([idle, setup, turn1Open, turn1Body, seed, turn2Open])
  const cut2 = preTurnPrefixLength(atTurn2)
  assert.equal(cut2, idle.length + setup.length + turn1Open.length + turn1Body.length + seed.length)
  const pre2 = decodeSessionEventsFromBytes(atTurn2.subarray(0, cut2))
  assert.equal(pre2.at(-1)?.type, 'session/end-seed')
  assert.equal(pre2.filter((e) => e.type === 'turn/start').length, 1) // only turn 1's

  // No turn/start at all => no truncation.
  const noTurn = artifact([idle, setup])
  assert.equal(preTurnPrefixLength(noTurn), noTurn.length)
})

/** One complete turn: turn/start … messages … turn/end. */
function turnLines(opts: {
  startSeq: number
  endSeq: number
  user?: string
  asst?: string
  injected?: string
}): string[] {
  const lines = [JSON.stringify({ type: 'turn/start', seq: opts.startSeq, time: opts.startSeq, data: {} })]
  if (opts.user !== undefined) {
    lines.push(JSON.stringify({ type: 'user/message', seq: opts.startSeq + 1, time: opts.startSeq + 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: opts.user }] } }))
  }
  if (opts.injected !== undefined) {
    lines.push(JSON.stringify({ type: 'user/message', seq: opts.startSeq + 2, time: opts.startSeq + 2, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: opts.injected }] } }))
  }
  if (opts.asst !== undefined) {
    lines.push(JSON.stringify({ type: 'assistant/message', seq: opts.endSeq - 1, time: opts.endSeq - 1, data: { message: { content: [{ type: 'text', text: opts.asst }] } } }))
  }
  lines.push(JSON.stringify({ type: 'turn/end', seq: opts.endSeq, time: opts.endSeq, data: {} }))
  return lines
}

test('extractMessagePreviews: user (source=user) and assistant text, injected context ignored', () => {
  const art = artifact([
    frame([header()]),
    frame(turnLines({ startSeq: 6, endSeq: 22, user: '请只回复一个字：好', injected: 'injected context', asst: '好' })),
  ])
  const previews = extractMessagePreviews(art)
  assert.equal(previews.user, '请只回复一个字：好')
  assert.equal(previews.assistant, '好')
})

test('extractMessagePreviews: turn-bounded — the NEXT turn\'s message never leaks in', () => {
  // The exact production race: turn 15 ends and the user sends message 16 in the
  // same instant, so the artifact already carries turn 16's user message (and its
  // turn/start) by the time the capture reads the file. Turn 15's commit must
  // still pair turn 15's own question with turn 15's own answer.
  const turn15 = turnLines({ startSeq: 100, endSeq: 120, user: 'USER和ASST 内容字体可以修改一下吗？', asst: '当然可以。当前正文是等宽代码字体…' })
  const turn16Opening = [
    JSON.stringify({ type: 'turn/start', seq: 121, time: 121, data: {} }),
    JSON.stringify({ type: 'user/message', seq: 122, time: 122, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '右边的滚动条，默认不显示。' }] } }),
  ]
  const raced = artifact([frame([header()]), frame(turn15), frame(turn16Opening)])

  // Bound by the turn/end seq the snapshot serves (the hardening cross-check).
  const pinned = extractMessagePreviews(raced, 120)
  assert.equal(pinned.user, 'USER和ASST 内容字体可以修改一下吗？')
  assert.equal(pinned.assistant, '当然可以。当前正文是等宽代码字体…')

  // Even without the seq hint, the LAST COMPLETED turn is turn 15 — turn 16 has
  // no turn/end yet, so its user message is still out of bounds.
  const inferred = extractMessagePreviews(raced)
  assert.equal(inferred.user, 'USER和ASST 内容字体可以修改一下吗？')
  assert.equal(inferred.assistant, '当然可以。当前正文是等宽代码字体…')
})

test('extractMessagePreviews: seq selects the exact turn, not just the newest', () => {
  const art = artifact([
    frame([header()]),
    frame(turnLines({ startSeq: 10, endSeq: 20, user: 'first question', asst: 'first answer' })),
    frame(turnLines({ startSeq: 30, endSeq: 40, user: 'second question', asst: 'second answer' })),
  ])
  // An older boundary is addressable: a slow gate snapshotting turn 1 while
  // turn 2 already landed still commits turn 1's own pair.
  const older = extractMessagePreviews(art, 20)
  assert.equal(older.user, 'first question')
  assert.equal(older.assistant, 'first answer')

  const newer = extractMessagePreviews(art, 40)
  assert.equal(newer.user, 'second question')
  assert.equal(newer.assistant, 'second answer')

  // Newest completed turn when no seq is pinned.
  const latest = extractMessagePreviews(art)
  assert.equal(latest.user, 'second question')
})

test('extractMessagePreviews: unresolvable boundary yields nothing (never a wrong pairing)', () => {
  // No turn/end at all: the turn is still open, so there is no completed pair.
  const openTurn = artifact([
    frame([header()]),
    frame([
      JSON.stringify({ type: 'turn/start', seq: 5, time: 5, data: {} }),
      JSON.stringify({ type: 'user/message', seq: 6, time: 6, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'in flight' }] } }),
    ]),
  ])
  assert.deepEqual(extractMessagePreviews(openTurn), {})

  // A seq that matches no turn/end must not silently fall back to another turn.
  const complete = artifact([
    frame([header()]),
    frame(turnLines({ startSeq: 10, endSeq: 20, user: 'q', asst: 'a' })),
  ])
  assert.deepEqual(extractMessagePreviews(complete, 999), {})
})

test('extractMessagePreviews: turn spanning multiple frames still resolves', () => {
  // Long turns are flushed across several frames; the boundary pair must be
  // found even when start and end live in different frames.
  const art = artifact([
    frame([header()]),
    frame([
      JSON.stringify({ type: 'turn/start', seq: 50, time: 50, data: {} }),
      JSON.stringify({ type: 'user/message', seq: 51, time: 51, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'spanning question' }] } }),
    ]),
    frame([
      JSON.stringify({ type: 'assistant/message', seq: 60, time: 60, data: { message: { content: [{ type: 'text', text: 'partial' }] } } }),
    ]),
    frame([
      JSON.stringify({ type: 'assistant/message', seq: 61, time: 61, data: { message: { content: [{ type: 'text', text: 'final reply' }] } } }),
      JSON.stringify({ type: 'turn/end', seq: 62, time: 62, data: {} }),
    ]),
  ])
  const previews = extractMessagePreviews(art, 62)
  assert.equal(previews.user, 'spanning question')
  // The reply that CLOSED the turn wins over earlier partial messages.
  assert.equal(previews.assistant, 'final reply')
})
