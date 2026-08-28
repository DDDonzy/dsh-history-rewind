/**
 * Shadow-store paths and repo lifecycle: where repos, backups and locks live,
 * how a bare repo is ensured to exist, and the per-project exclusive lock used
 * by every snapshot/restore of a shared workspace repo.
 */

import { open, mkdir, stat, unlink, readFile, writeFile, readdir, rm, lstat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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
 *
 * Entries that vanish mid-walk (a concurrent snapshot's temp file, a `gc` run
 * repacking objects) are skipped rather than thrown: this powers a usage
 * readout, so an approximate-but-alive number beats an exact-or-crash one.
 * @param dir - directory to measure; a missing directory measures 0.
 * @returns total size in bytes (0 when the directory does not exist).
 */
async function dirSize(dir: string): Promise<number> {
  let total = 0
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => null)
    if (entries === null) return // absent or unreadable: contributes 0
    for (const entry of entries) {
      const child = join(current, entry.name)
      try {
        if (entry.isDirectory()) await walk(child)
        else if (entry.isFile()) total += (await lstat(child)).size
      } catch {
        // Vanished between readdir and stat: skip it.
      }
    }
  }
  await walk(dir)
  return total
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
 * pre-rewind backups.
 *
 * Irreversible by design and intentionally not selective: this is the "reclaim
 * the disk" action, so it drops whole histories rather than trying to guess
 * which commits are still wanted. The area directories themselves are kept so
 * later git calls that use them as cwd cannot hit ENOENT.
 *
 * Backups are scoped by their naming convention: workspace copies live in
 * `ws-session-*`, session copies in `session-*`. Clearing only the session area
 * therefore leaves workspace backups alone, and vice versa.
 * @param root - history root.
 * @param scope - which area(s) to clear.
 * @returns bytes freed and per-entry success counts.
 */
export async function clearCache(root: string, scope: CacheScope): Promise<ClearCacheResult> {
  const wantSession = scope === 'session' || scope === 'both'
  const wantWorkspace = scope === 'workspace' || scope === 'both'

  // Repo areas are measured up front (whole-area deletion); backups are summed
  // per entry inside the walk, since only the matching ones get dropped.
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
