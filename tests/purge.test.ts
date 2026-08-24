/**
 * Purge integration test: abandoned roads erased, reflog/gc prunes the
 * unreachable objects, backups rotated to the newest `keep`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeSubprocess } from './fake-subprocess.ts'
import { purgeSession } from '../src/purge.ts'
import { takeSnapshot, type PersistenceLike, type SessionLike } from '../src/snapshot.ts'
import { runGit } from '../src/git-runner.ts'
import { sessionBackupDir } from '../src/store.ts'

test('purge: abandoned refs removed, objects pruned, backups rotated', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-purge-'))
  const cwd = join(root, 'ws')
  const historyRoot = join(root, 'history')
  const sessionsRoot = join(root, 'sessions')
  const sessionId = 'purge-test'
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

  // Simulate a rewind: main -> marker(A), old tip under an abandoned ref.
  // Simulate a post-jump fork: main tip B with a road-<ts> branch, plus a
  // legacy abandoned-* ref from the old model (purge must clear both).
  const road = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'update-ref', 'refs/heads/road-1700000000000', snapB.commit!], root)
  assert.equal(road.exitCode, 0)
  const legacy = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'update-ref', 'refs/heads/abandoned-1700000001000', snapB.commit!], root)
  assert.equal(legacy.exitCode, 0)
  const reflog = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'reflog', 'expire', '--expire=now', '--all'], root)
  assert.equal(reflog.exitCode, 0)
  // Re-create a reflog entry so expire has something to do.
  await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'update-ref', '--create-reflog', 'refs/heads/main', snapA.commit!], root)
  await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'update-ref', 'refs/heads/main', snapB.commit!], root)

  // Backups: 5 pre-rewind files -> keep 2.
  const backupDir = sessionBackupDir(historyRoot, sessionId)
  await mkdir(backupDir, { recursive: true })
  for (let i = 0; i < 5; i++) {
    await writeFile(join(backupDir, `pre-rewind-${1700000000000 + i * 1000}.zstd`), 'x')
  }

  const result = await purgeSession(subprocess, historyRoot, sessionId, cwd, 2)
  assert.equal(result.ok, true)
  assert.equal(result.sessionRefs, 2) // road + legacy abandoned
  assert.equal(result.sessionPruned, true)
  assert.equal(result.backupsDeleted, 3)

  const refs = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'for-each-ref', '--format=%(refname)'], root)
  assert.ok(!refs.stdout.includes('road-'))
  assert.ok(!refs.stdout.includes('abandoned-'))
  const remaining = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'for-each-ref', '--format=%(refname)', 'refs/heads/'], root)
  assert.ok(remaining.stdout.includes('refs/heads/main'))
  assert.ok(!remaining.stdout.includes('road-'))

  await rm(root, { recursive: true, force: true })
})
