/**
 * Unit tests for the commit-message contract and TURN derivation.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionMessage, buildWorkspaceMessage, parseMessage, previewOf, PREVIEW_WIDTH } from '../src/messages.ts'
import { deriveTurn } from '../src/snapshot.ts'
import { claimHistoryCommand } from '../src/client/history-command.ts'

test('session message: turn-start is a CHECK POINT (no preview, keeps ws)', () => {
  const message = buildSessionMessage({
    kind: 'turn-start', turn: 3, phase: 'start', seq: 42,
    session: 'abc-123', ws: 'bbbb',
  })
  assert.equal(message, '[TURN 0003][CHECK POINT][bbbb]')
  const meta = parseMessage(message)
  assert.equal(meta?.kind, 'turn-start')
  assert.equal(meta?.phase, 'start')
  assert.equal(meta?.turn, 3)
  assert.equal(meta?.message, undefined)
  assert.equal(meta?.userMessage, undefined)
  assert.equal(meta?.ws, 'bbbb')
})

test('session message: turn-end carries USER + ASST on one line, keeps ws', () => {
  const message = buildSessionMessage({
    kind: 'turn-end', turn: 12, phase: 'end', seq: 99,
    session: 'abc-123', userMessage: '你好世界', asstMessage: 'Done.', ws: 'cccc',
  })
  assert.equal(message, '[TURN 0012][USER] 你好世界[ASST] Done.[cccc]')
  const meta = parseMessage(message)
  assert.equal(meta?.kind, 'turn-end')
  assert.equal(meta?.phase, 'end')
  assert.equal(meta?.turn, 12)
  assert.equal(meta?.userMessage, '你好世界')
  assert.equal(meta?.asstMessage, 'Done.')
  assert.equal(meta?.message, 'Done.') // back-compat alias
  assert.equal(meta?.ws, 'cccc')
})

test('turn-end parses with an empty user or assistant side', () => {
  const onlyAsst = buildSessionMessage({ kind: 'turn-end', turn: 1, phase: 'end', asstMessage: 'hi', ws: 'w' })
  assert.equal(onlyAsst, '[TURN 0001][USER] [ASST] hi[w]')
  const m1 = parseMessage(onlyAsst)
  assert.equal(m1?.kind, 'turn-end')
  assert.equal(m1?.userMessage, undefined)
  assert.equal(m1?.asstMessage, 'hi')
  assert.equal(m1?.ws, 'w')

  const bothEmpty = buildSessionMessage({ kind: 'turn-end', turn: 2, phase: 'end', ws: 'x' })
  assert.equal(bothEmpty, '[TURN 0002][USER] [ASST] [x]')
  const m2 = parseMessage(bothEmpty)
  assert.equal(m2?.kind, 'turn-end')
  assert.equal(m2?.userMessage, undefined)
  assert.equal(m2?.asstMessage, undefined)
  assert.equal(m2?.ws, 'x')
})

test('session message: manual + rewind', () => {
  const manual = buildSessionMessage({ kind: 'manual', turn: 7, ws: 'cc' })
  assert.equal(manual, '[TURN 0007][MANUAL][cc]')
  assert.deepEqual(parseMessage(manual), { kind: 'manual', turn: 7, ws: 'cc' })

  const rewind = buildSessionMessage({ kind: 'rewind', target: 'deadbeef' })
  assert.equal(rewind, '[REWIND → deadbeef]')
  assert.deepEqual(parseMessage(rewind), { kind: 'rewind', target: 'deadbeef' })
})

test('session message: Context Curation stores baseline + masked TURN ids and keeps legacy formats', () => {
  const message = buildSessionMessage({ kind: 'refine', turn: 5, maskedTurns: [3, 1, 2, 2], ws: 'curated-ws' })
  assert.equal(message, '[CURATE][BASE:5][TURNS:1,2,3][curated-ws]')
  assert.deepEqual(parseMessage(message), {
    kind: 'refine', turn: 5, maskedTurns: [1, 2, 3], ws: 'curated-ws',
  })
  assert.equal(buildWorkspaceMessage({ kind: 'refine', maskedTurns: [1, 2, 3] }), '[CURATE]')
  assert.deepEqual(parseMessage('[CURATE][TURNS:1,2][old-curate-ws]'), {
    kind: 'refine', maskedTurns: [1, 2], ws: 'old-curate-ws',
  })
  assert.deepEqual(parseMessage('[REFINE][legacy-ws]'), { kind: 'refine', ws: 'legacy-ws' })
})

test('workspace message: turn-end uses ASST preview, NO ws bracket', () => {
  const message = buildWorkspaceMessage({
    kind: 'turn-end', turn: 4, phase: 'end', seq: 7, session: 's2', asstMessage: 'ok', ws: 'y',
  })
  assert.equal(message, '[TURN 0004][ASST] ok')
  const meta = parseMessage(message)
  assert.equal(meta?.kind, 'turn-end')
  assert.equal(meta?.ws, undefined)
})

test('workspace message: turn-start is a CHECK POINT', () => {
  const message = buildWorkspaceMessage({ kind: 'turn-start', turn: 4, phase: 'start', ws: 'y' })
  assert.equal(message, '[TURN 0004][CHECK POINT]')
  assert.equal(parseMessage(message)?.kind, 'turn-start')
})

test('CHECK POINT parses with no ws bracket at all', () => {
  const meta = parseMessage('[TURN 0001][CHECK POINT]')
  assert.equal(meta?.kind, 'turn-start')
  assert.equal(meta?.turn, 1)
  assert.equal(meta?.ws, undefined)
})

test('previewOf: width-truncates CJK at 100 chars, ASCII at 200, strips brackets/newlines', () => {
  // 120 Chinese chars → cut to 100 (width 200) + …
  const cn = '一二三四五六七八九十'.repeat(12)
  const pcn = previewOf(cn)
  assert.equal([...pcn].length, 101) // 100 chars + …
  assert.equal(pcn, '一二三四五六七八九十'.repeat(10) + '…')

  // 240 ASCII chars → cut to 200 + …
  const en = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(4)
  const pen = previewOf(en)
  assert.equal(pen.length, 201)
  assert.ok(pen.endsWith('…'))

  // brackets + newlines sanitized (they would break the parser)
  assert.equal(previewOf('a[b]\nc\td'), 'ab c d')
  // exactly at the width boundary: no ellipsis
  assert.equal(previewOf('x'.repeat(PREVIEW_WIDTH)), 'x'.repeat(PREVIEW_WIDTH))
})

test('preview round-trips through parse safely even with tricky content', () => {
  const rawUser = '修复了 [snapshot] 的 bug\n换行也在'
  const rawAsst = '好的 [done]\n收到'
  const message = buildSessionMessage({
    kind: 'turn-end', turn: 2, phase: 'end', userMessage: rawUser, asstMessage: rawAsst, ws: 'ff',
  })
  const meta = parseMessage(message)
  assert.equal(meta?.kind, 'turn-end')
  assert.equal(meta?.turn, 2)
  assert.equal(meta?.ws, 'ff')
  // sanitized previews (no brackets/newlines), width-bounded
  assert.equal(meta?.userMessage, previewOf(rawUser))
  assert.equal(meta?.asstMessage, previewOf(rawAsst))
  for (const value of [meta!.userMessage!, meta!.asstMessage!]) {
    assert.ok(!value.includes('['))
    assert.ok(!value.includes(']'))
  }
})

test('workspace A/M/D manifest round-trips through a subject-safe marker', () => {
  const changes = [
    { status: 'A' as const, path: 'src/新增 file.ts' },
    { status: 'M' as const, path: 'README.md' },
    { status: 'D' as const, path: 'old/[draft].txt' },
  ]
  const message = buildSessionMessage({
    kind: 'turn-end', turn: 3, phase: 'end', userMessage: 'question', asstMessage: 'answer', ws: 'abcd', changes,
  })
  assert.match(message, /\[F1:[A-Za-z0-9_-]+\]$/)
  const meta = parseMessage(message)
  assert.deepEqual(meta?.changes, changes)
  assert.equal(meta?.userMessage, 'question')
  assert.equal(meta?.asstMessage, 'answer')

  const many = Array.from({ length: 10_000 }, (_, index) => ({
    status: (index % 3 === 0 ? 'A' : index % 3 === 1 ? 'M' : 'D') as 'A' | 'M' | 'D',
    path: `src/generated/module-${index}/file-${index}.ts`,
  }))
  const large = buildSessionMessage({ kind: 'manual', turn: 4, ws: 'large', changes: many })
  assert.equal(parseMessage(large)?.changes?.length, many.length)
  assert.ok(large.length < JSON.stringify(many).length, 'manifest is compressed before entering the commit subject')
})

test('deriveTurn: empty history -> turn 1 on start', () => {
  assert.equal(deriveTurn([], 'start'), 1)
})

test('deriveTurn: continue after end (new format)', () => {
  const subjects = ['[TURN 0005][USER] hi[ASST] done[bbbb]', '[TURN 0003][CHECK POINT][aaaa]']
  assert.equal(deriveTurn(subjects, 'start'), 6)
  assert.equal(deriveTurn(subjects, 'end'), 6)
})

test('deriveTurn: after a CHECK POINT (turn-start) the same turn is still open', () => {
  // Newest is a turn-start (phase start): ending it stays on that turn.
  const subjects = ['[TURN 0005][CHECK POINT][bbbb]', '[TURN 0004][USER] a[ASST] b[aaaa]']
  assert.equal(deriveTurn(subjects, 'start'), 6)
  assert.equal(deriveTurn(subjects, 'end'), 5)
})

test('deriveTurn: independent curation baseline continues local TURN numbering', () => {
  const subjects = ['[CURATE][BASE:5][TURNS:2,3]']
  assert.equal(deriveTurn(subjects, 'start'), 6)
  assert.equal(deriveTurn(subjects, 'end'), 6)
})

test('deriveTurn: empty independent curation baseline starts at TURN 1', () => {
  const subjects = ['[CURATE][BASE:0][TURNS:1,2]']
  assert.equal(deriveTurn(subjects, 'start'), 1)
  assert.equal(deriveTurn(subjects, 'end'), 1)
})

test('deriveTurn: manual and rewind lines are skipped (new format)', () => {
  const subjects = [
    '[REWIND → aaaa]',
    '[TURN 0009][MANUAL][cccc]',
    '[TURN 0003][USER] hi[ASST] ok[aaaa]',
  ]
  assert.equal(deriveTurn(subjects, 'start'), 4)
  assert.equal(deriveTurn(subjects, 'end'), 4)
})

test('legacy dsh-history format still parses (back-compat)', () => {
  const meta = parseMessage('dsh-history: turn 3 end (seq 99) session-abc-123 snap=turn-3-end-99 base=aaaa ws=bbbb')
  assert.equal(meta?.kind, 'turn-end')
  assert.equal(meta?.turn, 3)
  assert.equal(meta?.ws, 'bbbb')
  // legacy deriveTurn input still works
  assert.equal(deriveTurn(['dsh-history: turn 5 end (seq 8) session-s snap=x base=a ws=b'], 'start'), 6)
})

test('parse rejects foreign subjects', () => {
  assert.equal(parseMessage('hello world'), null)
  assert.equal(parseMessage(''), null)
  assert.equal(parseMessage('[NOTATAG] foo'), null)
})

test('history command auto-open is claimed once per session and command', () => {
  const session = `history-command-${Date.now()}-${Math.random()}`
  assert.equal(claimHistoryCommand(session, 'cmd-1'), true)
  assert.equal(claimHistoryCommand(session, 'cmd-1'), false)
  assert.equal(claimHistoryCommand(session, 'cmd-2'), true)
  assert.equal(claimHistoryCommand(`${session}-other`, 'cmd-1'), true)
})

test('history command without a stable command id never auto-opens', () => {
  const session = `history-command-${Date.now()}-${Math.random()}`
  assert.equal(claimHistoryCommand(session, undefined), false)
  assert.equal(claimHistoryCommand(session, ''), false)
})
