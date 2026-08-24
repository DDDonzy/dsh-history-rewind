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

test('extractMessagePreviews: user (source=user) and assistant text, injected context ignored', () => {
  const art = artifact([
    frame([header()]),
    frame([
      JSON.stringify({ type: 'user/message', seq: 7, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请只回复一个字：好' }] } }),
      JSON.stringify({ type: 'user/message', seq: 8, time: 2, data: { source: { kind: 'plugin' }, content: [{ type: 'text', text: 'injected context' }] } }),
      JSON.stringify({ type: 'assistant/message', seq: 21, time: 3, data: { message: { content: [{ type: 'text', text: '好' }] } } }),
    ]),
  ])
  const previews = extractMessagePreviews(art)
  assert.equal(previews.user, '请只回复一个字：好')
  assert.equal(previews.assistant, '好')
})
