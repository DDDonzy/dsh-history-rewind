/**
 * Cache accounting and scoped clearing.
 *
 * The capacity is advisory only, so the contract under test is narrow but
 * strict:
 *   - usage sums repos/ + repos-ws/ + backups/ and reports the configured
 *     capacity alongside it;
 *   - clearing a scope removes that area's repos AND only the backups whose
 *     naming convention belongs to it, leaving the other area untouched;
 *   - the area directories themselves survive, so later git calls that use
 *     them as cwd cannot hit ENOENT;
 *   - a bad capacity value in config.json falls back to the default rather
 *     than producing a NaN bar.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensureHistoryRoot, cacheUsage, clearCache, readConfig, writeConfig, listStoredSessions, storedSessionUsage,
} from '../src/store.ts'
import { HISTORY_REWIND_DEFAULTS } from '../src/constants.ts'

/** Build a history root with known byte counts in each area. */
async function seeded(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cache-'))
  await ensureHistoryRoot(root)

  // repos/: 300 bytes across two "session repos".
  await mkdir(join(root, 'repos', 'session-a.git', 'objects'), { recursive: true })
  await writeFile(join(root, 'repos', 'session-a.git', 'objects', 'blob'), 'x'.repeat(200))
  await mkdir(join(root, 'repos', 'session-b.git'), { recursive: true })
  await writeFile(join(root, 'repos', 'session-b.git', 'HEAD'), 'x'.repeat(100))

  // repos-ws/: 50 bytes.
  await mkdir(join(root, 'repos-ws', 'session-a.git'), { recursive: true })
  await writeFile(join(root, 'repos-ws', 'session-a.git', 'HEAD'), 'x'.repeat(50))

  // backups/: 30 bytes session-scoped + 70 bytes workspace-scoped.
  await mkdir(join(root, 'backups', 'session-a'), { recursive: true })
  await writeFile(join(root, 'backups', 'session-a', 'pre-rewind-1.zstd'), 'x'.repeat(30))
  await mkdir(join(root, 'backups', 'ws-session-a', 'pre-rewind-2'), { recursive: true })
  await writeFile(join(root, 'backups', 'ws-session-a', 'pre-rewind-2', 'f.txt'), 'x'.repeat(70))

  return { root, cleanup: async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined) } }
}

test('cacheUsage sums each area and reports the configured capacity', async () => {
  const { root, cleanup } = await seeded()

  const usage = await cacheUsage(root)
  assert.equal(usage.sessionBytes, 300)
  assert.equal(usage.workspaceBytes, 50)
  assert.equal(usage.backupsBytes, 100)
  assert.equal(usage.totalBytes, 450)
  // Default 100 GB, expressed in bytes.
  assert.equal(usage.capacityBytes, 100 * 1024 ** 3)

  await cleanup()
})

test('capacity setting is reflected in the measured capacity', async () => {
  const { root, cleanup } = await seeded()

  await writeConfig(root, { cacheCapacityGb: 2 })
  const usage = await cacheUsage(root)
  assert.equal(usage.capacityBytes, 2 * 1024 ** 3)
  // The unrelated field must survive the merge-write.
  const config = await readConfig(root)
  assert.equal(config.gitignoreTemplate, HISTORY_REWIND_DEFAULTS.gitignoreTemplate)

  await cleanup()
})

test('a non-numeric or non-positive capacity falls back to the default', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cache-'))
  await mkdir(root, { recursive: true })

  for (const bad of ['"abc"', '0', '-5', 'null']) {
    await writeFile(join(root, 'config.json'), `{ "cacheCapacityGb": ${bad} }`, 'utf8')
    const config = await readConfig(root)
    assert.equal(
      config.cacheCapacityGb,
      HISTORY_REWIND_DEFAULTS.cacheCapacityGb,
      `capacity ${bad} should fall back`,
    )
  }

  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

test('clearing the session scope leaves workspace repos and ws backups intact', async () => {
  const { root, cleanup } = await seeded()

  const result = await clearCache(root, 'session')
  assert.equal(result.ok, true)
  // 300 (repos) + 30 (session-scoped backup) freed; ws bytes untouched.
  assert.equal(result.freedBytes, 330)

  const after = await cacheUsage(root)
  assert.equal(after.sessionBytes, 0)
  assert.equal(after.workspaceBytes, 50, 'workspace repos survive')
  assert.equal(after.backupsBytes, 70, 'only ws-session-* backups remain')

  // The area directory itself must still exist.
  assert.equal(existsSync(join(root, 'repos')), true)
  assert.deepEqual(await readdir(join(root, 'repos')), [])
  assert.deepEqual(await readdir(join(root, 'backups')), ['ws-session-a'])

  await cleanup()
})

test('clearing the workspace scope leaves session repos and session backups intact', async () => {
  const { root, cleanup } = await seeded()

  const result = await clearCache(root, 'workspace')
  assert.equal(result.ok, true)
  // 50 (repos-ws) + 70 (ws-scoped backup).
  assert.equal(result.freedBytes, 120)

  const after = await cacheUsage(root)
  assert.equal(after.sessionBytes, 300, 'session repos survive')
  assert.equal(after.workspaceBytes, 0)
  assert.equal(after.backupsBytes, 30, 'only session-* backups remain')

  assert.equal(existsSync(join(root, 'repos-ws')), true)
  assert.deepEqual(await readdir(join(root, 'backups')), ['session-a'])

  await cleanup()
})

test('clearing both scopes empties every area but keeps the directories', async () => {
  const { root, cleanup } = await seeded()

  const result = await clearCache(root, 'both')
  assert.equal(result.ok, true)
  assert.equal(result.freedBytes, 450)

  const after = await cacheUsage(root)
  assert.equal(after.totalBytes, 0)

  for (const area of ['repos', 'repos-ws', 'backups']) {
    assert.equal(existsSync(join(root, area)), true, `${area} directory kept`)
    assert.deepEqual(await readdir(join(root, area)), [], `${area} emptied`)
  }

  await cleanup()
})

test('clearing an empty store is a no-op that still reports success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cache-'))
  await ensureHistoryRoot(root)

  const result = await clearCache(root, 'both')
  assert.equal(result.ok, true)
  assert.equal(result.freedBytes, 0)
  assert.equal(result.removed, 0)
  assert.equal(result.failed, 0)

  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

test('usage tolerates a missing history root instead of throwing', async () => {
  const root = join(tmpdir(), `dsh-cache-absent-${Date.now()}`)
  const usage = await cacheUsage(root)
  assert.equal(usage.totalBytes, 0)
  assert.equal(usage.capacityBytes, 100 * 1024 ** 3)
})

test('listStoredSessions aggregates sizes and timestamps for each session', async () => {
  const { root, cleanup } = await seeded()

  const list = await listStoredSessions(root)
  assert.equal(list.length, 2)
  const sessionA = list.find((s) => s.sessionId === 'a')
  const sessionB = list.find((s) => s.sessionId === 'b')
  assert.ok(sessionA !== undefined)
  assert.ok(sessionB !== undefined)

  // session 'a': repos (200) + repos-ws (50) + backups (30 + 70 = 100) = 350
  assert.equal(sessionA.sessionBytes, 200)
  assert.equal(sessionA.workspaceBytes, 50)
  assert.equal(sessionA.backupsBytes, 100)
  assert.equal(sessionA.totalBytes, 350)

  // session 'b': repos (100) = 100
  assert.equal(sessionB.sessionBytes, 100)
  assert.equal(sessionB.workspaceBytes, 0)
  assert.equal(sessionB.totalBytes, 100)

  await cleanup()
})

test('metadata-only session list is fast and per-session usage loads separately', async () => {
  const { root, cleanup } = await seeded()

  const summaries = await listStoredSessions(root, false)
  const summaryA = summaries.find((s) => s.sessionId === 'a')
  assert.ok(summaryA !== undefined)
  assert.equal(summaryA.totalBytes, 0)
  assert.equal(summaryA.usageLoaded, false)

  const detailA = await storedSessionUsage(root, 'a')
  assert.equal(detailA.totalBytes, 350)
  assert.equal(detailA.usageLoaded, true)

  await cleanup()
})

test('session list exposes visible title, workspace and latest road commit without spawning git', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cache-'))
  const root = join(home, '.dsh-history-rewind')
  await ensureHistoryRoot(root)
  const repo = join(root, 'repos', 'session-ref-test.git')
  const heads = join(repo, 'refs', 'heads')
  await mkdir(heads, { recursive: true })
  await writeFile(join(repo, 'packed-refs'), `${'1'.repeat(40)} refs/heads/main\n`, 'utf8')
  await writeFile(join(heads, 'road-100'), `${'2'.repeat(40)}\n`, 'utf8')
  await writeFile(join(heads, 'road-200'), `${'3'.repeat(40)}\n`, 'utf8')
  const projections = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(projections, { recursive: true })
  await writeFile(join(projections, 'ref-test.json'), JSON.stringify({
    record: {
      identity: { cwd: 'E:\\workspace-one' },
      rows: { title: { val: '用户看到的会话名' } },
    },
  }), 'utf8')

  const item = (await listStoredSessions(root, false)).find((entry) => entry.sessionId === 'ref-test')
  assert.equal(item?.commit, '3'.repeat(40))
  assert.equal(item?.workspace, 'workspace-one')
  assert.equal(item?.title, '用户看到的会话名')
  await rm(home, { recursive: true, force: true })
})

test('clearing specific sessions only removes selected session repositories and backups', async () => {
  const { root, cleanup } = await seeded()

  // Clear only session 'a'
  const result = await clearCache(root, 'both', ['a'])
  assert.equal(result.ok, true)
  assert.equal(result.freedBytes, 350)

  const list = await listStoredSessions(root)
  assert.equal(list.length, 1)
  assert.equal(list[0]!.sessionId, 'b')

  const after = await cacheUsage(root)
  assert.equal(after.sessionBytes, 100)
  assert.equal(after.workspaceBytes, 0)
  assert.equal(after.backupsBytes, 0)
  assert.equal(after.totalBytes, 100)

  await cleanup()
})
