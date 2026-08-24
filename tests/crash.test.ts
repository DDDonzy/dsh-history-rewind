/**
 * Crash-semantics integration test: when resume fails (the process dies before
 * the rewind is recorded), git must hold NO rewind record while the disk file
 * is already the target's bytes — the documented "未记录，重做即可" condition.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeSubprocess } from './fake-subprocess.ts'
import { takeSnapshot, type PersistenceLike, type SessionLike } from '../src/snapshot.ts'
import { rewindSession } from '../src/rewind.ts'
import { runGit } from '../src/git-runner.ts'
import { argvLogAll, argvUpdateRef } from '../src/git-commands.ts'

test('crash before resume: file replaced, git unrecorded, backup kept', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-crash-'))
  const cwd = join(root, 'ws')
  const historyRoot = join(root, 'history')
  const sessionsRoot = join(root, 'sessions')
  const sessionId = 'crash-test'
  const officialDir = join(sessionsRoot, '--E-test--', `session-${sessionId}`)
  const official = join(officialDir, 'session.jsonl.zstd')
  const repoDir = join(historyRoot, 'repos', `session-${sessionId}.git`)
  await mkdir(officialDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(official, Buffer.from('AAAAAAAA'))

  const session: SessionLike = { id: sessionId, header: { cwd } }
  const persistence: PersistenceLike = { locate: () => ({ kind: 'jsonl', path: official }) }
  const snapA = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-start', seq: 1 })
  assert.equal(snapA.ok, true)
  await writeFile(official, Buffer.from('BBBBBBBB'))
  const snapB = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 9 })
  assert.equal(snapB.ok, true)
  const mainBefore = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'rev-parse', 'refs/heads/main'], root)

  // 1. resume THROWS (crash right at the load step, before git recording).
  const agents = {
    get: () => ({ status: 'idle' }),
    detachEntered: () => undefined,
    resume: async () => { throw new Error('simulated crash during load') },
    store: new Map<string, { id: string }>(),
  }
  agents.store.set(sessionId, { id: sessionId })
  const sessions = {
    get: (id: string) => (id === sessionId ? session : undefined),
    flush: async () => true,
    liveEntryFor: () => ({ id: sessionId }),
    detachEntered: () => undefined,
  }
  const result = await rewindSession(subprocess, historyRoot, sessions, persistence, agents, sessionId, snapA.commit!, false)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'resume-failed')
  assert.equal(result.detached, true)
  assert.ok(result.error)

  // 2. File already replaced with the target bytes (self-consistent on disk).
  const bytes = await readFile(official)
  assert.equal(bytes.toString('utf8'), 'AAAAAAAA')

  // 3. Git records NOTHING: main unchanged, no marker, no road refs
  //    (recovery state: disk file = target, git untouched — redo the jump).
  const mainAfter = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'rev-parse', 'refs/heads/main'], root)
  assert.equal(mainAfter.stdout.trim(), mainBefore.stdout.trim())
  const log = await runGit(subprocess, argvLogAll({ gitDir: repoDir }), root)
  assert.ok(!log.stdout.includes('rewind'))
  const refs = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'for-each-ref', '--format=%(refname)'], root)
  assert.ok(!refs.stdout.includes('road-'))

  // 4. Backup taken (redo is possible; user redoes the jump).
  assert.ok(result.backup?.session !== undefined)

  // 5. Redo succeeds after the runtime comes back: file again correct; the
  //    next CHANGED snapshot forks a road from the target (jump target set).
  const agents2 = { ...agents, resume: async () => undefined }
  const redo = await rewindSession(subprocess, historyRoot, sessions, persistence, agents2, sessionId, snapA.commit!, false)
  assert.equal(redo.ok, true)
  await writeFile(official, Buffer.from('AAA+X'))
  const fork = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 11 })
  assert.equal(fork.ok, true)
  assert.equal(fork.fork, true)
  assert.equal(fork.base, snapA.commit)

  await rm(root, { recursive: true, force: true })
})
