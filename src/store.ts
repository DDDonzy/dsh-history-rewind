/**
 * Shadow-store paths and repo lifecycle: where repos, backups and locks live,
 * how a bare repo is ensured to exist, and the per-project exclusive lock used
 * by every snapshot/restore of a shared workspace repo.
 */

import { open, mkdir, stat, unlink, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  HISTORY_ROOT_DIRNAME, REPOS_DIRNAME, REPOS_WS_DIRNAME,
  BACKUPS_DIRNAME, LOCKS_DIRNAME, LOCK_STALE_MS,
  WORKSPACE_DEFAULT_EXCLUDES,
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

/** Per-project bare repo: $DSH_HOME/.dsh-history/repos-ws/<project>.git. */
export function workspaceRepoDir(root: string, cwd: string): string {
  return join(root, REPOS_WS_DIRNAME, `${projectSegment(cwd)}.git`)
}

/** Pre-rewind backup root for one session: backups/session-<id>/. */
export function sessionBackupDir(root: string, sessionId: string): string {
  return join(root, BACKUPS_DIRNAME, `session-${sessionId}`)
}

/** Pre-rewind backup root for one workspace: backups/ws-<project>/. */
export function workspaceBackupDir(root: string, cwd: string): string {
  return join(root, BACKUPS_DIRNAME, `ws-${projectSegment(cwd)}`)
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
 * Read the workspace exclude list of one repo: the bare repo's info/exclude
 * if present, else the shipped defaults. Snapshotting merges the shipped
 * defaults with the file so removing a default requires an explicit rule.
 * @param root - history root (resolves the repo dir).
 * @param cwd - the workspace path (resolves the repo).
 * @returns exclude basename patterns (".git" always first).
 */
export async function readExcludes(root: string, cwd: string): Promise<string[]> {
  const repoDir = workspaceRepoDir(root, cwd)
  const excludePath = join(repoDir, 'info', 'exclude')
  let lines: string[] = []
  try {
    const text = await readFile(excludePath, 'utf-8')
    lines = text.split(/\r?\n/)
  } catch {
    // No file yet: defaults apply.
  }
  const parsed = lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  return [...new Set([...WORKSPACE_DEFAULT_EXCLUDES, ...parsed])]
}

/**
 * Write the default exclude list into a fresh bare repo so the user can
 * adjust it (git's own info/exclude semantics, our file owns it).
 * @param root - history root.
 * @param cwd - the workspace path.
 */
export async function ensureExcludes(root: string, cwd: string): Promise<void> {
  const repoDir = workspaceRepoDir(root, cwd)
  const excludePath = join(repoDir, 'info', 'exclude')
  if (existsSync(excludePath)) return
  try {
    await mkdir(join(repoDir, 'info'), { recursive: true })
    await writeFile(
      excludePath,
      `# dsh-history workspace excludes (one basename or glob per line; '#' comments).\n${WORKSPACE_DEFAULT_EXCLUDES.join('\n')}\n`,
      'utf-8',
    )
  } catch {
    // Best-effort: readExcludes falls back to defaults.
  }
}
