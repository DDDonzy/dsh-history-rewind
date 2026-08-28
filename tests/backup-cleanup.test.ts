/**
 * Backup lifecycle: a rewind's own pre-rewind copies are removed once that
 * rewind is fully committed, and kept whenever anything about it went wrong.
 *
 * The copies exist for exactly one purpose — recovering state that never
 * reached the shadow repos — so the rules under test are:
 *   - full success (file replaced AND resume confirmed) → this call's copies go;
 *   - resume failed → copies stay (the documented manual-undo path);
 *   - workspace restore failed → that copy stays (the tree is half-written);
 *   - workspace-only success → its copy goes;
 *   - workspace-only restore failure → its copy stays;
 *   - older backups from previous rewinds are NEVER touched.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeSubprocess } from './fake-subprocess.ts'
import { takeSnapshot, type PersistenceLike, type SessionLike } from '../src/snapshot.ts'
import { rewindSession } from '../src/rewind.ts'
import { runGit } from '../src/git-runner.ts'
import { sessionBackupDir, workspaceBackupDir } from '../src/store.ts'

/** Minimal live-runtime doubles the rewind chain needs. */
function runtime(sessionId: string, session: SessionLike, opts: { resumeThrows?: boolean } = {}) {
  const agents = {
    get: () => ({ status: 'idle' }),
    detachEntered: () => undefined,
    resume: async () => {
      if (opts.resumeThrows === true) throw new Error('simulated resume failure')
      return undefined
    },
    store: new Map<string, { id: string }>(),
  }
  agents.store.set(sessionId, { id: sessionId })
  const sessions = {
    get: (id: string) => (id === sessionId ? session : undefined),
    flush: async () => true,
    liveEntryFor: () => ({ id: sessionId }),
    detachEntered: () => undefined,
  }
  return { agents, sessions }
}

/** Entries a backup dir currently holds (missing dir reads as empty). */
async function backupEntries(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort()
  } catch {
    return []
  }
}

/** Build a two-snapshot session with a workspace, ready to rewind to snapshot A. */
async function fixture(name: string) {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), `dsh-bk-${name}-`))
  const cwd = join(root, 'ws')
  const historyRoot = join(root, 'history')
  const sessionId = `bk-${name}`
  const officialDir = join(root, 'sessions', '--E-test--', `session-${sessionId}`)
  const official = join(officialDir, 'session.jsonl.zstd')
  await mkdir(officialDir, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeFile(official, Buffer.from('AAAAAAAA'))
  await writeFile(join(cwd, 'state.txt'), 'v1')

  const session: SessionLike = { id: sessionId, header: { cwd } }
  const persistence: PersistenceLike = { locate: () => ({ kind: 'jsonl', path: official }) }
  const snapA = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-start', seq: 3 })
  assert.equal(snapA.ok, true)
  await writeFile(official, Buffer.from('BBBBBBBB'))
  await writeFile(join(cwd, 'state.txt'), 'v2')
  const snapB = await takeSnapshot(subprocess, historyRoot, undefined, persistence, { session, kind: 'turn-end', seq: 9 })
  assert.equal(snapB.ok, true)

  return {
    subprocess, root, cwd, historyRoot, sessionId, official, session, persistence,
    snapA, snapB,
    sessionBackups: sessionBackupDir(historyRoot, sessionId),
    wsBackups: workspaceBackupDir(historyRoot, sessionId),
    cleanup: () => rm(root, { recursive: true, force: true }).catch(() => undefined),
  }
}

test('successful session+workspace rewind removes its own backups', async () => {
  const f = await fixture('success')
  const { agents, sessions } = runtime(f.sessionId, f.session)

  const result = await rewindSession(
    f.subprocess, f.historyRoot, sessions, f.persistence, agents,
    f.sessionId, f.snapA.commit!, true,
  )

  assert.equal(result.ok, true)
  assert.equal(result.workspaceRestored, true)
  // The rewind itself landed.
  assert.equal((await readFile(f.official)).toString('utf8'), 'AAAAAAAA')
  assert.equal(await readFile(join(f.cwd, 'state.txt'), 'utf8'), 'v1')
  // Both copies were dropped, and nothing was reported as un-removable.
  assert.equal(result.backup, undefined)
  assert.equal(result.backupCleanupFailed, undefined)
  assert.deepEqual(await backupEntries(f.sessionBackups), [])
  assert.deepEqual(await backupEntries(f.wsBackups), [])

  await f.cleanup()
})

test('failed resume keeps the pre-rewind backups', async () => {
  const f = await fixture('resume-fail')
  const { agents, sessions } = runtime(f.sessionId, f.session, { resumeThrows: true })

  const result = await rewindSession(
    f.subprocess, f.historyRoot, sessions, f.persistence, agents,
    f.sessionId, f.snapA.commit!, true,
  )

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'resume-failed')
  // The copy is the documented manual-undo path, so it must survive.
  assert.ok(result.backup?.session !== undefined, 'session backup path reported')
  assert.ok(existsSync(result.backup!.session!), 'session backup still on disk')
  assert.equal((await backupEntries(f.sessionBackups)).length, 1)

  await f.cleanup()
})

test('cleanup only removes THIS rewind\'s backups, never earlier ones', async () => {
  const f = await fixture('scoped')

  // An older backup from some previous rewind.
  await mkdir(f.sessionBackups, { recursive: true })
  const older = join(f.sessionBackups, 'pre-rewind-1700000000000.zstd')
  await writeFile(older, 'older-copy')

  const { agents, sessions } = runtime(f.sessionId, f.session)
  const result = await rewindSession(
    f.subprocess, f.historyRoot, sessions, f.persistence, agents,
    f.sessionId, f.snapA.commit!, false,
  )

  assert.equal(result.ok, true)
  assert.equal(result.backup, undefined)
  // Exactly the pre-existing backup remains, byte-intact.
  assert.deepEqual(await backupEntries(f.sessionBackups), ['pre-rewind-1700000000000.zstd'])
  assert.equal(await readFile(older, 'utf8'), 'older-copy')

  await f.cleanup()
})

test('workspace-only rewind removes its backup on success', async () => {
  const f = await fixture('ws-only')
  const { agents, sessions } = runtime(f.sessionId, f.session)

  const result = await rewindSession(
    f.subprocess, f.historyRoot, sessions, f.persistence, agents,
    f.sessionId, f.snapA.commit!, true, undefined, true,
  )

  assert.equal(result.ok, true)
  assert.equal(result.workspaceOnly, true)
  assert.equal(result.workspaceRestored, true)
  // Workspace went back; the session file was left alone.
  assert.equal(await readFile(join(f.cwd, 'state.txt'), 'utf8'), 'v1')
  assert.equal((await readFile(f.official)).toString('utf8'), 'BBBBBBBB')
  assert.equal(result.backup, undefined)
  assert.deepEqual(await backupEntries(f.wsBackups), [])

  await f.cleanup()
})

test('workspace-only rewind keeps its backup when the restore fails', async () => {
  const f = await fixture('ws-only-fail')
  const { agents, sessions } = runtime(f.sessionId, f.session)

  // Reach the restore stage and fail THERE — not earlier. The guard before it
  // (`wsRepoWithCommit`) only rev-parses the COMMIT object, while the restore
  // needs the tree + blobs. Keeping the commit object and dropping every other
  // object satisfies the guard, lets the backup be taken, then fails the
  // restore: exactly the half-written-tree case whose backup must survive.
  const wsRepo = join(f.historyRoot, 'repos-ws', `session-${f.sessionId}.git`)
  // The paired ws commit is the one recorded in the TARGET session commit's
  // message (`ws=<sha>`), not the ws repo's current tip.
  const subject = (await runGit(
    f.subprocess,
    ['git', `--git-dir=${join(f.historyRoot, 'repos', `session-${f.sessionId}.git`)}`,
      'log', '-1', '--format=%s', f.snapA.commit!],
    f.root,
  )).stdout
  const wsCommit = /\[([0-9a-f]{40})\]/.exec(subject)?.[1]
  assert.ok(wsCommit !== undefined, `target commit records a ws pairing: ${subject}`)
  const keepDir = wsCommit.slice(0, 2)
  const keepFile = wsCommit.slice(2)
  const objectsDir = join(wsRepo, 'objects')
  for (const entry of await readdir(objectsDir)) {
    if (entry === 'info' || entry === 'pack') continue
    if (entry !== keepDir) {
      await rm(join(objectsDir, entry), { recursive: true, force: true })
      continue
    }
    for (const obj of await readdir(join(objectsDir, entry))) {
      if (obj !== keepFile) await rm(join(objectsDir, entry, obj), { force: true })
    }
  }

  const result = await rewindSession(
    f.subprocess, f.historyRoot, sessions, f.persistence, agents,
    f.sessionId, f.snapA.commit!, true, undefined, true,
  )

  // The restore stage is the one that rejected it, so a backup was taken.
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'workspace-restore-failed')
  assert.equal(result.workspaceRestored, false)
  assert.ok(result.backup?.workspace !== undefined, 'workspace backup path reported')
  assert.ok(existsSync(result.backup!.workspace!), 'workspace backup still on disk')
  assert.equal((await backupEntries(f.wsBackups)).length, 1)

  await f.cleanup()
})
