/**
 * Integration tests: the production snapshot / rewind / timeline code against
 * a real git binary in a temp dir, via the fake subprocess seam.
 *
 * Model under test (user-confirmed checkout semantics):
 *  - 跳转 = 只替换会话文件，git 零新建（main 不动、无标记、无分支）；
 *  - 快照与跳转目标内容相同 → 什么都不产生；
 *  - 快照内容变了 → 新建 road-<ts> 分支提交（父=跳转目标），main 原路不动；
 *  - 普通连续对话 → 提交在 main 上（去重：内容未变不提交）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeSubprocess } from './fake-subprocess.ts'
import { snapshotWorkspace } from '../src/workspace.ts'
import { takeSnapshot, captureSessionArtifact, type PersistenceLike, type SessionLike } from '../src/snapshot.ts'
import { rewindSession } from '../src/rewind.ts'
import { runGit } from '../src/git-runner.ts'
import { argvLogAll } from '../src/git-commands.ts'
import { timelineRows } from '../src/timeline.ts'
import { clearJumpTarget } from '../src/state.ts'

test('workspace snapshot: plumbing walk skips .git and excluded dirs', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-history-test-'))
  const cwd = join(root, 'ws')
  const historyRoot = join(root, 'history')
  await mkdir(join(cwd, 'sub'), { recursive: true })
  await mkdir(join(cwd, 'node_modules'), { recursive: true })
  await mkdir(join(cwd, '.git'), { recursive: true })
  await mkdir(join(cwd, 'sub', '.git'), { recursive: true })
  await writeFile(join(cwd, 'a.txt'), 'hello')
  await writeFile(join(cwd, 'sub', 'b.txt'), 'world')
  await writeFile(join(cwd, 'node_modules', 'big.txt'), 'ignored')
  await writeFile(join(cwd, '.git', 'config'), 'ignored')
  await writeFile(join(cwd, 'sub', '.git', 'HEAD'), 'ignored')
  await writeFile(join(cwd, 'run.sh'), 'echo hi', { mode: 0o755 })

  const result = await snapshotWorkspace(subprocess, historyRoot, 's1', cwd, 'dsh-history: turn 1 start (seq 3) session-s1 snap=turn-1-start-3')
  assert.equal(result.ok, true)
  assert.ok(result.commit)

  const dirs = (await readdirRaw(join(historyRoot, 'repos-ws'))).filter((name) => name.endsWith('.git'))
  assert.equal(dirs.length, 1)
  const repoDir = join(historyRoot, 'repos-ws', dirs[0]!)
  const tree = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'ls-tree', '-r', '--name-only', 'main'], cwd)
  const files = tree.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  // node_modules is excluded via the .gitignore this first-ever snapshot
  // auto-seeds from the global default template (there is no hardcoded
  // exclude list at snapshot time any more); that seeded file is itself part
  // of the tree.
  assert.deepEqual(files.sort(), ['.gitignore', 'a.txt', 'run.sh', 'sub/b.txt'].sort())

  const cat = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'cat-file', 'blob', 'main:a.txt'], cwd)
  assert.equal(cat.stdout, 'hello')

  await rm(root, { recursive: true, force: true })
})

async function readdirRaw(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  return readdir(dir)
}

test('session snapshot: workspace first, session commit carries snap/base/ws, tree path fixed', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-history-test-'))
  const cwd = join(root, 'ws')
  const historyRoot = join(root, 'history')
  const sessionsRoot = join(root, 'sessions')
  const sessionId = '2f6b6f66-80da-444d-a91c-f53e045098d7'
  const officialDir = join(sessionsRoot, '--E-test--', `session-${sessionId}`)
  const official = join(officialDir, 'session.jsonl.zstd')
  await mkdir(officialDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  const payload = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x0a, 0xfe]) // binary survives
  await writeFile(official, payload)

  const session: SessionLike = { id: sessionId, header: { cwd } }
  const persistence: PersistenceLike = { locate: () => ({ kind: 'jsonl', path: official }) }
  const flushed: string[] = []
  const result = await takeSnapshot(subprocess, historyRoot, {
    flush: async () => { flushed.push(sessionId); return true },
  }, persistence, { session, kind: 'turn-start', seq: 3 })

  assert.equal(result.ok, true)
  assert.ok(result.commit)
  assert.ok(result.wsCommit)
  assert.equal(result.turn, 1)
  assert.equal(result.ref, 'refs/heads/main')
  assert.ok(flushed.includes(sessionId))

  const repoDir = join(historyRoot, 'repos', `session-${sessionId}.git`)
  const log = await runGit(subprocess, argvLogAll({ gitDir: repoDir }), root)
  // turn-start is a CHECK POINT: [TURN 0001][CHECK POINT][<ws-hash>]
  assert.ok(log.stdout.includes('[CHECK POINT]'))
  assert.ok(log.stdout.includes('[TURN 0001]'))
  assert.ok(log.stdout.includes(`[${result.wsCommit}]`))

  const blob = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'cat-file', 'blob', `main:session-${sessionId}/session.jsonl.zstd`], root)
  assert.deepEqual(Buffer.from(blob.stdout, 'utf8'), Buffer.from(payload.toString('utf8'), 'utf8'))

  const result2 = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 9 })
  assert.equal(result2.ok, true)
  assert.equal(result2.turn, 1)
  assert.equal(result2.base, result.commit)

  await rm(root, { recursive: true, force: true })
})

test('rewind (checkout): zero git changes; dedup when unchanged; road fork on change', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-history-test-'))
  const cwd = join(root, 'ws')
  const historyRoot = join(root, 'history')
  const sessionsRoot = join(root, 'sessions')
  const sessionId = '861844f6-b0c2-4448-b9e2-76d6996f2f3e'
  const officialDir = join(sessionsRoot, '--E-test--', `session-${sessionId}`)
  const official = join(officialDir, 'session.jsonl.zstd')
  const repoDir = join(historyRoot, 'repos', `session-${sessionId}.git`)
  await mkdir(officialDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(official, Buffer.from('AAAAAAAA'))
  await writeFile(join(cwd, 'state.txt'), 'v1')

  const session: SessionLike = { id: sessionId, header: { cwd } }
  const persistence: PersistenceLike = { locate: () => ({ kind: 'jsonl', path: official }) }
  const snapA = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-start', seq: 3 })
  assert.equal(snapA.ok, true)
  await writeFile(official, Buffer.from('BBBBBBBB'))
  const snapB = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 9 })
  assert.equal(snapB.ok, true)
  assert.equal(snapB.base, snapA.commit)
  const mainBefore = (await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'rev-parse', 'refs/heads/main'], root)).stdout.trim()

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

  // 1. REWIND = checkout only: file replaced, GIT UNTOUCHED (main, no refs, no commits).
  const result = await rewindSession(subprocess, historyRoot, sessions, persistence, agents, sessionId, snapA.commit!, true)
  assert.equal(result.ok, true)
  assert.equal(result.target, snapA.commit)
  assert.equal((await readFile(official)).toString('utf8'), 'AAAAAAAA')
  assert.equal((await readFile(join(cwd, 'state.txt'), 'utf8')), 'v1') // workspace restored
  const mainAfter = (await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'rev-parse', 'refs/heads/main'], root)).stdout.trim()
  assert.equal(mainAfter, mainBefore) // main untouched
  const refs = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'for-each-ref', '--format=%(refname)'], root)
  assert.ok(!refs.stdout.includes('road-'))
  const log = await runGit(subprocess, argvLogAll({ gitDir: repoDir }), root)
  assert.ok(!log.stdout.includes('rewind')) // no marker commit
  assert.ok(result.backup?.session !== undefined)

  // 2. SNAPSHOT with UNCHANGED content: nothing produced (no commit, no ref).
  const unchanged = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-start', seq: 11 })
  assert.equal(unchanged.ok, true)
  assert.equal(unchanged.unchanged, true)
  assert.equal(unchanged.commit, undefined)
  const refs2 = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'for-each-ref', '--format=%(refname)'], root)
  assert.ok(!refs2.stdout.includes('road-'))
  assert.equal((await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'rev-parse', 'refs/heads/main'], root)).stdout.trim(), mainBefore)

  // 3. SNAPSHOT with CHANGED content (user chatted at the old version):
  //    new road-<ts>, parent = jump target, main UNTOUCHED.
  await writeFile(official, Buffer.from('AAAA+X'))
  const fork = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 13 })
  assert.equal(fork.ok, true)
  assert.equal(fork.fork, true)
  assert.equal(fork.base, snapA.commit)
  assert.ok(fork.ref?.startsWith('refs/heads/road-'))
  assert.equal((await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'rev-parse', 'refs/heads/main'], root)).stdout.trim(), mainBefore)

  // 4. CONTINUATION on the road: next snapshot commits on the road, chains parent.
  await writeFile(official, Buffer.from('AAAA+XY'))
  const next = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 14 })
  assert.equal(next.ok, true)
  assert.equal(next.base, fork.commit)
  assert.equal(next.ref, fork.ref)
  const roadTip = (await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'rev-parse', fork.ref!], root)).stdout.trim()
  assert.equal(roadTip, next.commit)

  // 5. UNDO: jump back to B (the original road tip) — git untouched again;
  //    changed snapshot forks a SECOND road from B.
  const undo = await rewindSession(subprocess, historyRoot, sessions, persistence, agents, sessionId, snapB.commit!, false)
  assert.equal(undo.ok, true)
  assert.equal((await readFile(official)).toString('utf8'), 'BBBBBBBB')
  await writeFile(official, Buffer.from('BBBB+Y'))
  const fork2 = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-start', seq: 15 })
  assert.equal(fork2.ok, true)
  assert.equal(fork2.fork, true)
  assert.equal(fork2.base, snapB.commit)
  const refs3 = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'for-each-ref', '--format=%(refname)'], root)
  assert.equal(refs3.stdout.split('\n').filter((l) => l.includes('road-')).length, 2)

  await rm(root, { recursive: true, force: true })
})

test('normal continuation stays on main; identical content dedups', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-history-test-'))
  const cwd = join(root, 'ws')
  const historyRoot = join(root, 'history')
  const sessionsRoot = join(root, 'sessions')
  const sessionId = 'linear-test'
  const officialDir = join(sessionsRoot, '--E-test--', `session-${sessionId}`)
  const official = join(officialDir, 'session.jsonl.zstd')
  await mkdir(officialDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(official, Buffer.from('AAA'))
  const session: SessionLike = { id: sessionId, header: { cwd } }
  const persistence: PersistenceLike = { locate: () => ({ kind: 'jsonl', path: official }) }
  const a = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-start', seq: 1 })
  assert.equal(a.ok, true)
  clearJumpTarget(sessionId) // no jump happened; ensure no leaked target
  await writeFile(official, Buffer.from('AAB'))
  const again = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 5 })
  assert.equal(again.ok, true)
  assert.equal(again.base, a.commit) // normal continuation on main, no fork
  assert.equal(again.fork, false)
  assert.equal(again.ref, 'refs/heads/main')
  // Same content again -> unchanged (dedup vs main tip).
  const dup = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 9 })
  assert.equal(dup.unchanged, true)
  await rm(root, { recursive: true, force: true })
})

test('capture-first: event-time blob stays the boundary even when the file advances', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-history-test-'))
  const cwd = join(root, 'ws')
  const historyRoot = join(root, 'history')
  const sessionsRoot = join(root, 'sessions')
  const sessionId = 'capture-first'
  const officialDir = join(sessionsRoot, '--E-test--', `session-${sessionId}`)
  const official = join(officialDir, 'session.jsonl.zstd')
  const repoDir = join(historyRoot, 'repos', `session-${sessionId}.git`)
  await mkdir(officialDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(official, Buffer.from('boundary-A'))

  const session: SessionLike = { id: sessionId, header: { cwd } }
  const persistence: PersistenceLike = { locate: () => ({ kind: 'jsonl', path: official }) }

  // 1. Capture at event time (content A), then the file advances to B while
  //    the gate is busy elsewhere — exactly the slow-workspace scenario.
  const captured = captureSessionArtifact(subprocess, historyRoot, undefined, persistence, session)
  await new Promise((resolve) => setTimeout(resolve, 120)) // let flush+hash settle
  await writeFile(official, Buffer.from('boundary-A+next-turn'))
  const snapA = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 70, captured })
  assert.equal(snapA.ok, true)

  // The committed blob must be the EVENT-TIME content, not the advanced file.
  const blob = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'cat-file', 'blob', `main:session-${sessionId}/session.jsonl.zstd`], root)
  assert.equal(blob.stdout, 'boundary-A')

  // 2. The NEXT turn's snapshot then captures B (nothing is deduped away).
  const captured2 = captureSessionArtifact(subprocess, historyRoot, undefined, persistence, session)
  const snapB = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 80, captured: captured2 })
  assert.equal(snapB.ok, true)
  assert.equal(snapB.base, snapA.commit)
  const blob2 = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'cat-file', 'blob', `main:session-${sessionId}/session.jsonl.zstd`], root)
  assert.equal(blob2.stdout, 'boundary-A+next-turn')

  await rm(root, { recursive: true, force: true })
})

test('turn-start (USER) commits even when byte-identical to the prior ASST (linear path)', async () => {
  // Regression: a continuous conversation's pre-send USER prefix is byte-equal
  // to the previous turn's ASST blob. It is still a distinct timeline anchor
  // and must NOT be deduped away (only turn 1's USER survived before the fix).
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-history-test-'))
  const cwd = join(root, 'ws')
  const historyRoot = join(root, 'history')
  const sessionsRoot = join(root, 'sessions')
  const sessionId = 'user-anchor'
  const officialDir = join(sessionsRoot, '--E-test--', `session-${sessionId}`)
  const official = join(officialDir, 'session.jsonl.zstd')
  const repoDir = join(historyRoot, 'repos', `session-${sessionId}.git`)
  await mkdir(officialDir, { recursive: true })
  await mkdir(cwd, { recursive: true })

  const session: SessionLike = { id: sessionId, header: { cwd } }
  const persistence: PersistenceLike = { locate: () => ({ kind: 'jsonl', path: official }) }

  // ASST snapshot of turn N (full content C).
  await writeFile(official, Buffer.from('conversation-through-turn-N'))
  const asst = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 20 })
  assert.equal(asst.ok, true)
  assert.ok(asst.commit)

  // turn N+1 USER snapshot: SAME bytes (nothing written between the boundaries)
  // — must still produce a distinct commit, not dedup.
  const user = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-start', seq: 21 })
  assert.equal(user.ok, true)
  assert.equal(user.unchanged, undefined)
  assert.ok(user.commit)
  assert.notEqual(user.commit, asst.commit)
  assert.equal(user.base, asst.commit) // chained onto the ASST node

  await rm(root, { recursive: true, force: true })
})

test('timeline parse: road fork shape', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-history-test-'))
  const cwd = join(root, 'ws')
  const historyRoot = join(root, 'history')
  const sessionsRoot = join(root, 'sessions')
  const sessionId = 'timeline-test'
  const officialDir = join(sessionsRoot, '--E-test--', `session-${sessionId}`)
  const official = join(officialDir, 'session.jsonl.zstd')
  const repoDir = join(historyRoot, 'repos', `session-${sessionId}.git`)
  await mkdir(officialDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(official, Buffer.from('AAA'))
  const session: SessionLike = { id: sessionId, header: { cwd } }
  const persistence: PersistenceLike = { locate: () => ({ kind: 'jsonl', path: official }) }
  const a = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-start', seq: 1 })
  await writeFile(official, Buffer.from('BBB'))
  const b = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 5 })
  // Jump to A + changed content -> road fork.
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
  await rewindSession(subprocess, historyRoot, sessions, persistence, agents, sessionId, a.commit!, false)
  await writeFile(official, Buffer.from('AAAX'))
  const fork = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-start', seq: 6 })
  assert.equal(fork.fork, true)

  const rows = await timelineRows(subprocess, repoDir, sessionId, root)
  assert.ok(rows !== null)
  const bySha = new Map(rows.map((r) => [r.sha, r]))
  assert.equal(bySha.get(fork.commit!)?.parents[0], a.commit) // road forks from A
  assert.equal(bySha.get(b.commit!)?.parents[0], a.commit)   // main road continues A->B
  await rm(root, { recursive: true, force: true })
})
