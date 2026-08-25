/**
 * Regression: after jumping back to an EMPTY baseline (workspace had no files
 * at that point), the exact-restore removes the files created later. The next
 * turn-start with NO user change must NOT create a spurious BASELINE node.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeSubprocess } from './fake-subprocess.ts'
import { takeSnapshot, type PersistenceLike, type SessionLike } from '../src/snapshot.ts'
import { rewindSession } from '../src/rewind.ts'
import { runGit } from '../src/git-runner.ts'
import { clearJumpTarget } from '../src/state.ts'

test('no spurious BASELINE after jumping back to an empty baseline (nothing modified)', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-history-regr-'))
  const cwd = join(root, 'ws')
  const historyRoot = join(root, 'history')
  const sessionsRoot = join(root, 'sessions')
  const sessionId = 'regr-baseline'
  const officialDir = join(sessionsRoot, '--D-test--', `session-${sessionId}`)
  const official = join(officialDir, 'session.jsonl.zstd')
  const repoDir = join(historyRoot, 'repos', `session-${sessionId}.git`)
  await mkdir(officialDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  clearJumpTarget(sessionId)

  const session: SessionLike = { id: sessionId, header: { cwd } }
  const persistence: PersistenceLike = { locate: () => ({ kind: 'jsonl', path: official }) }

  // TURN 1 start: workspace EMPTY (no files yet) — the "empty baseline".
  await writeFile(official, Buffer.from('SESSION-A'))
  const baseline = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-start', seq: 3 })
  assert.equal(baseline.ok, true)
  assert.equal(baseline.unchanged, undefined) // first-ever snapshot is created

  // AI creates a file, TURN 1 end.
  await writeFile(join(cwd, 'game.html'), '<html>v1</html>')
  await writeFile(official, Buffer.from('SESSION-A-plus-turn1'))
  const turn1 = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 9 })
  assert.equal(turn1.ok, true)

  const agents = {
    get: () => ({ status: 'idle' }),
    detachEntered: () => undefined,
    resume: async () => undefined,
    store: new Map<string, { id: string }>([[sessionId, { id: sessionId }]]),
  }
  const sessions = {
    get: (id: string) => (id === sessionId ? session : undefined),
    flush: async () => true,
    liveEntryFor: () => ({ id: sessionId }),
    detachEntered: () => undefined,
  }

  // JUMP back to the empty baseline (session + workspace). Exact-restore deletes game.html.
  const jumped = await rewindSession(subprocess, historyRoot, sessions, persistence, agents, sessionId, baseline.commit!, true)
  assert.equal(jumped.ok, true)
  assert.equal(await import('node:fs').then((m) => m.existsSync(join(cwd, 'game.html'))), false) // file removed

  const countBaselines = async (): Promise<number> => {
    const log = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'log', '--all', '--pretty=%s'], root)
    return log.stdout.split('\n').filter((l) => l.includes('[CHECK POINT]')).length
  }
  const before = await countBaselines()

  // The user CONTINUES chatting after the jump (session content genuinely
  // changes) but does NOT touch any code file. The workspace is still the
  // empty baseline state. A turn-start here must NOT create a BASELINE — the
  // CHECK POINT gate only fires on real workspace (code) changes.
  await writeFile(official, Buffer.from('SESSION-A-new-chat-turn-no-code-change'))
  const afterJump = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-start', seq: 12 })
  assert.equal(afterJump.ok, true)
  const after = await countBaselines()

  assert.equal(after, before, `expected no new BASELINE (workspace unchanged), but count went ${before} -> ${after}`)

  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})
