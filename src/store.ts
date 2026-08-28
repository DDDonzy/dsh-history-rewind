/**
 * Shadow-store paths and repo lifecycle: where repos, backups and locks live,
 * how a bare repo is ensured to exist, and the per-project exclusive lock used
 * by every snapshot/restore of a shared workspace repo.
 */

import { open, mkdir, stat, unlink, readFile, writeFile, readdir, rm, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  HISTORY_ROOT_DIRNAME, REPOS_DIRNAME, REPOS_WS_DIRNAME,
  BACKUPS_DIRNAME, LOCKS_DIRNAME, LOCK_STALE_MS,
  CONFIG_FILENAME, HISTORY_REWIND_DEFAULTS,
  type HistoryRewindConfig, type CacheScope,
} from './constants.ts'
import type { SubprocessLike } from './git-runner.ts'
import { runGit, firstLine } from './git-runner.ts'
import { argvInitBare, argvRevParseGitDir, commitEnv, type ShadowRepo } from './git-commands.ts'

/** Resolve $DSH_HOME the same way the deployment does. */
export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  return join(homedir(), '.dsh')
}

/** Root of every dsh-history artifact: $DSH_HOME/.dsh-history. */
export function historyRoot(home: string = dshHome()): string {
  return join(home, HISTORY_ROOT_DIRNAME)
}

/**
 * Ensure the history root (and its repos/ backups/ locks/ children) exist so
 * git calls that use it as cwd never hit ENOENT on a fresh install.
 * @param root - history root.
 */
export async function ensureHistoryRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  await mkdir(join(root, REPOS_DIRNAME), { recursive: true })
  await mkdir(join(root, REPOS_WS_DIRNAME), { recursive: true })
  await mkdir(join(root, BACKUPS_DIRNAME), { recursive: true })
  await mkdir(join(root, LOCKS_DIRNAME), { recursive: true })
}

/** Per-session bare repo: $DSH_HOME/.dsh-history/repos/session-<id>.git. */
export function sessionRepoDir(root: string, sessionId: string): string {
  return join(root, REPOS_DIRNAME, `session-${sessionId}.git`)
}

/** Filesystem-safe directory segment for a session id (keep \w / . / -). */
function sessionSegment(sessionId: string): string {
  return sessionId.replace(/[^\w.-]/g, '_')
}

/**
 * Per-session workspace bare repo: $DSH_HOME/.dsh-history/repos-ws/session-<id>.git.
 * Each session owns its workspace history, so two sessions sharing one
 * workspace directory each get their own WORKSPACE anchors and file-version chain.
 */
export function workspaceRepoDir(root: string, sessionId: string): string {
  return join(root, REPOS_WS_DIRNAME, `session-${sessionSegment(sessionId)}.git`)
}

/**
 * Legacy per-project workspace bare repo (pre session-scoped storage): kept
 * for reading old snapshots whose ws commits live there. Timeline enrichment
 * and rewind fall back to it when the per-session repo lacks a commit.
 */
export function legacyWorkspaceRepoDir(root: string, cwd: string): string {
  return join(root, REPOS_WS_DIRNAME, `${projectSegment(cwd)}.git`)
}

/** Pre-rewind backup root for one session: backups/session-<id>/. */
export function sessionBackupDir(root: string, sessionId: string): string {
  return join(root, BACKUPS_DIRNAME, `session-${sessionId}`)
}

/** Pre-rewind backup root for one session's workspace: backups/ws-session-<id>/. */
export function workspaceBackupDir(root: string, sessionId: string): string {
  return join(root, BACKUPS_DIRNAME, `ws-session-${sessionSegment(sessionId)}`)
}

/**
 * Sanitize an arbitrary filesystem path into a single safe directory segment.
 * Non-alphanumeric runs collapse to '-'; a short hash keeps distinct paths
 * distinct after sanitization.
 * @param cwd - the workspace absolute path.
 * @returns a filesystem-safe, collision-resistant directory segment.
 */
export function projectSegment(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 48)
  // Small deterministic hash (djb2) so /foo/bar and /foo-bar never collide.
  let h = 5381
  for (let i = 0; i < cwd.length; i++) h = (((h << 5) + h) ^ cwd.charCodeAt(i)) >>> 0
  return `${slug || 'ws'}-${h.toString(16).padStart(8, '0')}`
}

/**
 * In-process probe cache: once a bare repo has been initialized, probed and
 * its HEAD pointed at main, there is nothing left to verify — every later
 * snapshot would otherwise pay two extra git spawns (symbolic-ref +
 * rev-parse) for no information. The cache re-checks HEAD existence (cheap
 * fs stat) so an externally purged repo is re-initialized on demand.
 */
const ensuredRepos = new Map<string, boolean>()

/**
 * Ensure a bare repo exists at gitDir (idempotent). Also confirms git is
 * usable.
 * @param subprocess - the subprocess service.
 * @param gitDir - the bare repo directory.
 * @returns true when the repo is ready.
 */
export async function ensureBareRepo(subprocess: SubprocessLike, gitDir: string): Promise<boolean> {
  if (ensuredRepos.get(gitDir) === true) {
    if (existsSync(join(gitDir, 'HEAD'))) return true
    ensuredRepos.delete(gitDir)
  }
  if (!existsSync(join(gitDir, 'HEAD'))) {
    try {
      await mkdir(gitDir, { recursive: true })
    } catch {
      return false
    }
    const init = await runGit(subprocess, argvInitBare(gitDir), gitDir, commitEnv())
    if (init.exitCode !== 0) return false
  }
  // Cosmetic but useful: point the bare repo's HEAD at main so plain `git log`
  // (no explicit ref) walks the shadow history instead of the unset master.
  await runGit(subprocess, ['git', `--git-dir=${gitDir}`, 'symbolic-ref', 'HEAD', 'refs/heads/main'], gitDir)
  const probe = await runGit(subprocess, argvRevParseGitDir({ gitDir }), gitDir)
  const ready = probe.exitCode === 0 && firstLine(probe.stdout).length > 0
  if (ready) ensuredRepos.set(gitDir, true)
  return ready
}

/** One held exclusive lock; call release() when done. */
export interface HeldLock {
  release(): Promise<void>
}

/**
 * Acquire an exclusive lock for one key (per-project workspace repos). Waits
 * up to waitMs for a stale-free lock; a lockfile older than LOCK_STALE_MS is
 * stolen (crashed writer). Returns null when the lock cannot be acquired in
 * time — callers treat that as a failed snapshot/restore, never as success.
 * @param root - history root (locks live under locks/).
 * @param key - lock key (project segment or session id).
 * @param waitMs - total wait budget.
 * @returns the held lock, or null.
 */
export async function acquireLock(root: string, key: string, waitMs = 8000): Promise<HeldLock | null> {
  const dir = join(root, LOCKS_DIRNAME)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${key}.lock`)
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      const handle = await open(path, 'wx')
      try {
        await handle.writeFile(`${process.pid}\n${Date.now()}\n`)
      } finally {
        await handle.close()
      }
      return {
        release: async () => {
          try { await unlink(path) } catch { /* already removed */ }
        },
      }
    } catch {
      // Lock exists: steal when stale, else wait and retry.
      try {
        const info = await stat(path)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(path)
          continue
        }
      } catch {
        continue // vanished between open and stat: retry immediately
      }
      if (Date.now() >= deadline) return null
      await new Promise((resolve) => setTimeout(resolve, 120))
    }
  }
}

/**
 * Read the snapshot exclude patterns for one workspace: its OWN `.gitignore`,
 * and nothing else. There is no merged default list any more — an empty or
 * missing `.gitignore` excludes nothing (besides the `.git` directory, which
 * `walkFiles` always skips regardless of any exclude list).
 *
 * A line starting with `!` (gitignore negation) is dropped rather than
 * mis-parsed: `compileExcludes` has no negation semantics, so treating `!foo`
 * as a literal pattern would exclude a file this project actually wants
 * tracked. Dropping it just means that one line has no effect, which is the
 * safe direction to fail in (a snapshot that includes one extra file is
 * recoverable; one that silently drops a wanted file is not).
 * @param cwd - the workspace root whose `.gitignore` to read.
 * @returns exclude basename/glob patterns (empty when there is no `.gitignore`).
 */
export async function readExcludes(cwd: string): Promise<string[]> {
  let text: string
  try {
    text = await readFile(join(cwd, '.gitignore'), 'utf-8')
  } catch {
    return []
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'))
}

/**
 * Seed a workspace's `.gitignore` from the global default template, but ONLY
 * when that workspace has no `.gitignore` at all yet. An existing file —
 * whether it pre-dated this plugin or the user edited a previously-seeded one
 * — is never touched: this is a one-time bootstrap, not an ongoing sync.
 * @param root - history root (resolves the global config).
 * @param cwd - the workspace root to seed.
 */
export async function ensureWorkspaceGitignore(root: string, cwd: string): Promise<void> {
  const path = join(cwd, '.gitignore')
  if (existsSync(path)) return
  try {
    const config = await readConfig(root)
    await writeFile(path, config.gitignoreTemplate, 'utf-8')
  } catch {
    // Best-effort: a workspace that cannot get a seeded .gitignore simply
    // excludes nothing until the user adds one themselves.
  }
}

/** Absolute path of the global config file: $DSH_HOME/.dsh-history-rewind/config.json. */
function configPath(root: string): string {
  return join(root, CONFIG_FILENAME)
}

/**
 * Read the global plugin config, filling in any missing/invalid field from
 * defaults. A corrupt or absent file resolves to the full default object
 * rather than throwing — settings are a convenience layer, never a hard
 * dependency of the snapshot/rewind path.
 * @param root - history root.
 * @returns the resolved config (every field always present).
 */
export async function readConfig(root: string): Promise<HistoryRewindConfig> {
  try {
    const text = await readFile(configPath(root), 'utf-8')
    const parsed = JSON.parse(text) as Partial<HistoryRewindConfig>
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : HISTORY_REWIND_DEFAULTS.enabled,
      gitignoreTemplate: typeof parsed.gitignoreTemplate === 'string'
        ? parsed.gitignoreTemplate
        : HISTORY_REWIND_DEFAULTS.gitignoreTemplate,
      // Guard the numeric field hard: a NaN/negative/absurd capacity would make
      // the usage bar meaningless, and this value is user-typed.
      cacheCapacityGb: typeof parsed.cacheCapacityGb === 'number'
        && Number.isFinite(parsed.cacheCapacityGb)
        && parsed.cacheCapacityGb > 0
        ? parsed.cacheCapacityGb
        : HISTORY_REWIND_DEFAULTS.cacheCapacityGb,
    }
  } catch {
    return HISTORY_REWIND_DEFAULTS
  }
}

/**
 * Merge-write the global plugin config (read-modify-write; unspecified fields
 * keep their current value).
 * @param root - history root.
 * @param patch - fields to update.
 * @returns the resolved config after the write.
 */
export async function writeConfig(root: string, patch: Partial<HistoryRewindConfig>): Promise<HistoryRewindConfig> {
  const current = await readConfig(root)
  const next: HistoryRewindConfig = { ...current, ...patch }
  await mkdir(root, { recursive: true })
  await writeFile(configPath(root), JSON.stringify(next, null, 2), 'utf-8')
  return next
}

/**
 * Total bytes under one directory, following no symlinks and tolerating races.
 * Sibling entries are measured in bounded parallel batches to reduce latency.
 * @param dir - directory to measure; a missing directory measures 0.
 */
const SIZE_BATCH = 32

async function dirSize(dir: string): Promise<number> {
  const walk = async (current: string): Promise<number> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null)
    if (entries === null) return 0 // absent or unreadable: contributes 0

    let total = 0
    // Process siblings in bounded parallel batches: Git object directories can
    // contain thousands of files, while unbounded Promise.all would overload
    // the host with handles.
    for (let start = 0; start < entries.length; start += SIZE_BATCH) {
      const batch = entries.slice(start, start + SIZE_BATCH)
      const sizes = await Promise.all(batch.map(async (entry) => {
        const child = join(current, entry.name)
        try {
          if (entry.isDirectory()) return await walk(child)
          if (entry.isFile()) return (await lstat(child)).size
        } catch {
          // Vanished between readdir and stat: skip it.
        }
        return 0
      }))
      total += sizes.reduce((sum, size) => sum + size, 0)
    }
    return total
  }
  return walk(dir)
}

/** Shadow-store usage broken down by area, against the advisory capacity. */
export interface CacheUsage {
  /** Bytes under repos/ (conversation history). */
  sessionBytes: number
  /** Bytes under repos-ws/ (workspace snapshots). */
  workspaceBytes: number
  /** Bytes under backups/ (retained pre-rewind copies). */
  backupsBytes: number
  /** sessionBytes + workspaceBytes + backupsBytes. */
  totalBytes: number
  /** The configured advisory budget, in bytes. */
  capacityBytes: number
}

/**
 * Measure the shadow store against the configured advisory capacity.
 * @param root - history root.
 * @returns per-area byte totals plus the capacity they are judged against.
 */
export async function cacheUsage(root: string): Promise<CacheUsage> {
  const config = await readConfig(root)
  const [sessionBytes, workspaceBytes, backupsBytes] = await Promise.all([
    dirSize(join(root, REPOS_DIRNAME)),
    dirSize(join(root, REPOS_WS_DIRNAME)),
    dirSize(join(root, BACKUPS_DIRNAME)),
  ])
  return {
    sessionBytes,
    workspaceBytes,
    backupsBytes,
    totalBytes: sessionBytes + workspaceBytes + backupsBytes,
    capacityBytes: Math.round(config.cacheCapacityGb * 1024 ** 3),
  }
}

/** Stored session usage summary for the session list picker. */
export interface StoredSessionItem {
  sessionId: string
  sessionBytes: number
  workspaceBytes: number
  backupsBytes: number
  totalBytes: number
  lastModified: number
  /** Visible session title from DSH's projection cache. */
  title?: string
  /** Workspace directory name shown beside the session title. */
  workspace?: string
  /** Active road tip (latest road ref, otherwise main), when resolvable. */
  commit?: string
  /** False for the fast metadata-only list; true once sizes were measured. */
  usageLoaded?: boolean
}

/** Read branch tips directly from loose/packed refs without spawning Git. */
async function storedSessionCommit(repoDir: string): Promise<string | undefined> {
  const refs = new Map<string, string>()
  const headsDir = join(repoDir, 'refs', 'heads')
  const looseNames = await readdir(headsDir).catch(() => [] as string[])
  await Promise.all(looseNames.map(async (name) => {
    const value = await readFile(join(headsDir, name), 'utf8').catch(() => '')
    const sha = value.trim().split(/\s+/)[0] ?? ''
    if (/^[0-9a-f]{40}$/i.test(sha)) refs.set(name, sha)
  }))

  const packed = await readFile(join(repoDir, 'packed-refs'), 'utf8').catch(() => '')
  for (const line of packed.split('\n')) {
    if (line.length === 0 || line.startsWith('#') || line.startsWith('^')) continue
    const match = /^([0-9a-f]{40}) refs\/heads\/(.+)$/i.exec(line.trim())
    if (match !== null && !refs.has(match[2]!)) refs.set(match[2]!, match[1]!)
  }

  let latestRoad: { timestamp: number; sha: string } | undefined
  for (const [name, sha] of refs) {
    if (!name.startsWith('road-')) continue
    const timestamp = Number(name.slice('road-'.length))
    if (Number.isFinite(timestamp) && (latestRoad === undefined || timestamp > latestRoad.timestamp)) {
      latestRoad = { timestamp, sha }
    }
  }
  return latestRoad?.sha ?? refs.get('main')
}

/** Read the same persisted title/cwd projection that backs DSH's session list. */
async function storedSessionPresentation(
  root: string,
  sessionId: string,
): Promise<{ title?: string; workspace?: string }> {
  const path = join(dirname(root), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  const text = await readFile(path, 'utf8').catch(() => '')
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text) as {
      record?: {
        identity?: { cwd?: unknown }
        rows?: { title?: { val?: unknown } }
      }
    }
    const rawTitle = parsed.record?.rows?.title?.val
    const rawCwd = parsed.record?.identity?.cwd
    const title = typeof rawTitle === 'string' && rawTitle.trim().length > 0 ? rawTitle.trim() : undefined
    const workspace = typeof rawCwd === 'string' && rawCwd.length > 0 ? basename(rawCwd) : undefined
    return {
      ...(title === undefined ? {} : { title }),
      ...(workspace === undefined || workspace.length === 0 ? {} : { workspace }),
    }
  } catch {
    return {}
  }
}

/** Measure one stored session without scanning unrelated sessions. */
async function measureStoredSession(root: string, sessionId: string, withUsage: boolean): Promise<StoredSessionItem> {
  const sRepo = sessionRepoDir(root, sessionId)
  const wsRepo = workspaceRepoDir(root, sessionId)
  const sBackup = sessionBackupDir(root, sessionId)
  const wsBackup = workspaceBackupDir(root, sessionId)
  const commitPromise = storedSessionCommit(sRepo)
  const presentationPromise = storedSessionPresentation(root, sessionId)

  let sessionBytes = 0
  let workspaceBytes = 0
  let sBackupBytes = 0
  let wsBackupBytes = 0
  if (withUsage) {
    [sessionBytes, workspaceBytes, sBackupBytes, wsBackupBytes] = await Promise.all([
      dirSize(sRepo),
      dirSize(wsRepo),
      dirSize(sBackup),
      dirSize(wsBackup),
    ])
  }

  // Directory stats are cheap and provide a useful sort order for the fast list.
  let lastModified = 0
  for (const dir of [sRepo, wsRepo, sBackup, wsBackup]) {
    try {
      const info = await stat(dir)
      if (info.mtimeMs > lastModified) lastModified = info.mtimeMs
    } catch {
      // Not present, skip.
    }
  }

  const backupsBytes = sBackupBytes + wsBackupBytes
  const [commit, presentation] = await Promise.all([commitPromise, presentationPromise])
  return {
    sessionId,
    sessionBytes,
    workspaceBytes,
    backupsBytes,
    totalBytes: sessionBytes + workspaceBytes + backupsBytes,
    lastModified,
    ...presentation,
    ...(commit === undefined ? {} : { commit }),
    ...(withUsage ? { usageLoaded: true } : { usageLoaded: false }),
  }
}

/**
 * List all sessions currently holding data in the shadow store.
 *
 * The default remains the complete list for library compatibility. Pass false
 * for the settings picker: it only scans top-level names and directory mtimes,
 * leaving expensive recursive byte counts to per-session requests.
 * @param root - history root.
 * @param withUsage - whether to recursively measure every session.
 * @returns sorted list of session items (newest first).
 */
export async function listStoredSessions(root: string, withUsage = true): Promise<StoredSessionItem[]> {
  const ids = new Set<string>()

  // Scan the three shallow index directories in parallel. No object files are
  // touched in metadata-only mode.
  const [reposEntries, wsEntries, backupEntries] = await Promise.all([
    readdir(join(root, REPOS_DIRNAME)).catch(() => [] as string[]),
    readdir(join(root, REPOS_WS_DIRNAME)).catch(() => [] as string[]),
    readdir(join(root, BACKUPS_DIRNAME)).catch(() => [] as string[]),
  ])
  for (const name of reposEntries) {
    if (name.startsWith('session-') && name.endsWith('.git')) ids.add(name.slice('session-'.length, -'.git'.length))
  }
  for (const name of wsEntries) {
    if (name.startsWith('session-') && name.endsWith('.git')) ids.add(name.slice('session-'.length, -'.git'.length))
  }
  for (const name of backupEntries) {
    if (name.startsWith('ws-session-')) ids.add(name.slice('ws-session-'.length))
    else if (name.startsWith('session-')) ids.add(name.slice('session-'.length))
  }

  // Measure sessions concurrently so one large repository cannot block every
  // later row. The picker uses withUsage=false and therefore stays lightweight.
  const items = await Promise.all(Array.from(ids, (sessionId) => measureStoredSession(root, sessionId, withUsage)))
  return items.sort((a, b) => b.lastModified - a.lastModified)
}

/** Measure one session after its fast metadata row has already been shown. */
export async function storedSessionUsage(root: string, sessionId: string): Promise<StoredSessionItem> {
  return measureStoredSession(root, sessionId, true)
}

/** Outcome of one cache-clear request. */
export interface ClearCacheResult {
  ok: boolean
  /** Bytes released (measured before deletion). */
  freedBytes: number
  /** Top-level entries removed. */
  removed: number
  /** Entries that could not be removed (in use, permissions). */
  failed: number
}

/**
 * Delete the CONTENTS of one or both shadow-repo areas, plus the matching
 * pre-rewind backups, optionally filtered to specific session IDs.
 *
 * Irreversible by design: drops histories for the chosen scope and sessions.
 * The area directories themselves are kept so later git calls that use them as
 * cwd cannot hit ENOENT.
 *
 * @param root - history root.
 * @param scope - which area(s) to clear ('session' | 'workspace' | 'both').
 * @param sessionIds - optional list of specific session IDs to clear; if omitted, clears all.
 * @returns bytes freed and per-entry success counts.
 */
export async function clearCache(
  root: string,
  scope: CacheScope,
  sessionIds?: string[],
): Promise<ClearCacheResult> {
  const wantSession = scope === 'session' || scope === 'both'
  const wantWorkspace = scope === 'workspace' || scope === 'both'

  // Selective clear for specific session IDs
  if (sessionIds !== undefined && sessionIds.length > 0) {
    let freedBytes = 0
    let removed = 0
    let failed = 0
    const idSet = new Set(sessionIds)

    for (const id of idSet) {
      if (wantSession) {
        const sRepo = sessionRepoDir(root, id)
        try {
          if (existsSync(sRepo)) {
            freedBytes += await dirSize(sRepo)
            await rm(sRepo, { recursive: true, force: true })
            removed += 1
          }
        } catch {
          failed += 1
        }
        const sBackup = sessionBackupDir(root, id)
        try {
          if (existsSync(sBackup)) {
            freedBytes += await dirSize(sBackup)
            await rm(sBackup, { recursive: true, force: true })
            removed += 1
          }
        } catch {
          failed += 1
        }
      }

      if (wantWorkspace) {
        const wsRepo = workspaceRepoDir(root, id)
        try {
          if (existsSync(wsRepo)) {
            freedBytes += await dirSize(wsRepo)
            await rm(wsRepo, { recursive: true, force: true })
            removed += 1
          }
        } catch {
          failed += 1
        }
        const wsBackup = workspaceBackupDir(root, id)
        try {
          if (existsSync(wsBackup)) {
            freedBytes += await dirSize(wsBackup)
            await rm(wsBackup, { recursive: true, force: true })
            removed += 1
          }
        } catch {
          failed += 1
        }
      }
    }

    return { ok: failed === 0, freedBytes, removed, failed }
  }

  // Whole-store clear (all sessions)
  const before = await cacheUsage(root)
  const repoFreed = (wantSession ? before.sessionBytes : 0)
    + (wantWorkspace ? before.workspaceBytes : 0)

  let removed = 0
  let failed = 0
  let backupsFreed = 0

  /** Remove every child of `dir`, keeping `dir` itself. */
  const clearChildren = async (dir: string, keep?: (name: string) => boolean): Promise<void> => {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return // absent area: nothing to clear
    }
    for (const name of entries) {
      if (keep !== undefined && keep(name)) continue
      const target = join(dir, name)
      try {
        if (dir.endsWith(BACKUPS_DIRNAME)) backupsFreed += await dirSize(target)
        await rm(target, { recursive: true, force: true })
        removed += 1
      } catch {
        failed += 1
      }
    }
  }

  if (wantSession) await clearChildren(join(root, REPOS_DIRNAME))
  if (wantWorkspace) await clearChildren(join(root, REPOS_WS_DIRNAME))
  // Backups: keep the ones belonging to the area that was NOT cleared.
  await clearChildren(
    join(root, BACKUPS_DIRNAME),
    scope === 'both'
      ? undefined
      : (name) => (scope === 'workspace' ? !name.startsWith('ws-session-') : name.startsWith('ws-session-')),
  )

  return { ok: failed === 0, freedBytes: repoFreed + backupsFreed, removed, failed }
}
