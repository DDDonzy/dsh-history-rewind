/**
 * Debug export integration test: build a real session repo (main + a road
 * fork), export it to a target dir, and verify the clone is a work-tree repo
 * with main + road-* materialized as LOCAL branches and countable commits.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeSubprocess } from './fake-subprocess.ts'
import { takeSnapshot, type PersistenceLike, type SessionLike } from '../src/snapshot.ts'
import { rewindSession } from '../src/rewind.ts'
import { exportShadowRepo } from '../src/export-repo.ts'
import { runGit } from '../src/git-runner.ts'

test('export: clone shadow repo to a work-tree repo with local road branches', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-export-'))
  const cwd = join(root, 'ws')
  const historyRoot = join(root, 'history')
  const sessionsRoot = join(root, 'sessions')
  const sessionId = 'export-test'
  const officialDir = join(sessionsRoot, '--E-test--', `session-${sessionId}`)
  const official = join(officialDir, 'session.jsonl.zstd')
  const repoDir = join(historyRoot, 'repos', `session-${sessionId}.git`)
  // Fake payloads carry a real zstd magic prefix so every blob is a byte-wise
  // distinct binary (no accidental [] == [] semantic dedup on 3-char strings).
  const payloadA = Buffer.from([0xfd, 0x2f, 0xb5, 0x28, 0x41, 0x41])
  const payloadB = Buffer.from([0xfd, 0x2f, 0xb5, 0x28, 0x42, 0x42])
  const payloadX = Buffer.from([0xfd, 0x2f, 0xb5, 0x28, 0x58, 0x58])
  await mkdir(officialDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(official, payloadA)
  const session: SessionLike = { id: sessionId, header: { cwd } }
  const persistence: PersistenceLike = { locate: () => ({ kind: 'jsonl', path: official }) }

  // main: A -> B
  const snapA = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-start', seq: 1 })
  assert.equal(snapA.ok, true)
  await writeFile(official, payloadB)
  const snapB = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 5 })
  assert.equal(snapB.ok, true)

  // fork road: jump to A then change → road-<ts> starting at A
  const agents = {
    get: () => ({ status: 'idle' }),
    detachEntered: () => undefined,
    resume: async () => undefined,
    store: new Map<string, { id: string }>(),
  }
  agents.store.set(sessionId, { id: sessionId })
  const sessions = {
    get: (id: string) => (id === sessionId ? session : undefined),
    flush: async () => true,
    liveEntryFor: () => ({ id: sessionId }),
    detachEntered: () => undefined,
  }
  await rewindSession(subprocess, historyRoot, sessions, persistence, agents, sessionId, snapA.commit!, false)
  await writeFile(official, payloadX)
  const fork = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-start', seq: 6 })
  assert.equal(fork.fork, true)

  // ---- export to an EMPTY target dir ----
  const target = join(root, 'exported')
  await mkdir(target, { recursive: true })
  const result = await exportShadowRepo(subprocess, historyRoot, sessionId, target)
  assert.equal(result.ok, true, `export failed: ${result.reason ?? ''} ${result.detail ?? ''}`)
  assert.equal(result.target, target)
  assert.ok(result.commits !== undefined && result.commits >= 3)
  assert.ok(result.branches !== undefined)
  assert.ok(result.branches.includes('main'))
  assert.ok(result.branches.some((b) => b.startsWith('road-')))

  // The clone is a REAL work-tree repo: .git dir exists.
  const entries = await readdir(target)
  assert.ok(entries.includes('.git'))

  // Local main is checked out with the fork-era file on disk (BBX: jump target
  // was A, road tip contains BBX… main tip is B; the switch pinned main which
  // has BBB).
  const checkout = await runGit(subprocess, ['git', '-C', target, 'symbolic-ref', 'HEAD'], target)
  assert.equal(checkout.stdout.trim(), 'refs/heads/main')

  const blob = await runGit(subprocess, ['git', '-C', target, 'cat-file', 'blob', 'main:session-export-test/session.jsonl.zstd'], target)
  assert.deepEqual(Buffer.from(blob.stdout, 'utf8'), Buffer.from(payloadB.toString('utf8'), 'utf8'))
  const roadRef = result.branches!.find((b) => b.startsWith('road-'))!
  const roadBlob = await runGit(subprocess, ['git', '-C', target, 'cat-file', 'blob', `${roadRef}:session-export-test/session.jsonl.zstd`], target)
  assert.deepEqual(Buffer.from(roadBlob.stdout, 'utf8'), Buffer.from(payloadX.toString('utf8'), 'utf8'))
  const mainTipHead = await runGit(subprocess, ['git', '-C', target, 'cat-file', '-t', 'HEAD'], target)
  assert.equal(mainTipHead.stdout.trim(), 'commit')

  // ---- refusals ----
  const nonEmpty = await exportShadowRepo(subprocess, historyRoot, sessionId, target)
  assert.equal(nonEmpty.ok, false)
  assert.equal(nonEmpty.reason, 'target-not-empty')

  const insideRoot = await exportShadowRepo(subprocess, historyRoot, sessionId, join(historyRoot, 'nested'))
  assert.equal(insideRoot.ok, false)
  assert.equal(insideRoot.reason, 'target-inside-history-root')

  const noRepo = await exportShadowRepo(subprocess, historyRoot, 'does-not-exist', join(root, 'nowhere'))
  assert.equal(noRepo.ok, false)
  assert.equal(noRepo.reason, 'no-session-repo')

  await rm(root, { recursive: true, force: true })
})
