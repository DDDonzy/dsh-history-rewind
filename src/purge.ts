/**
 * Purge: the documented safety-erasure path (开发文档.md §5, optional stage).
 *
 * After a purge the shadow history is irreversibly gone — post-jump road
 * branches (and legacy abandoned refs), reflogs and unreachable objects are
 * dropped, and backups are rotated to the newest few. `main` and the
 * session/workspace repos themselves are kept (the never-jumped original
 * road remains); only the roads that forked after jumps are erased. Callers
 * must pass `confirm: true`.
 */

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubprocessLike } from './git-runner.ts'
import { runGit } from './git-runner.ts'
import { sessionRepoDir, workspaceRepoDir, sessionBackupDir, workspaceBackupDir, ensureBareRepo } from './store.ts'
import { type ShadowRepo } from './git-commands.ts'

/** Result of one purge (owned JSON). */
export interface PurgeResult {
  ok: boolean
  reason?: string
  /** Fork refs deleted (road-* now; abandoned-* legacy) from the session repo. */
  sessionRefs?: number
  /** Session reflogs expired + unreachable objects pruned. */
  sessionPruned?: boolean
  /** Fork refs deleted from the workspace repo. */
  workspaceRefs?: number
  /** Workspace reflogs expired + unreachable objects pruned. */
  workspacePruned?: boolean
  /** Backup files rotated away (session + workspace). */
  backupsDeleted?: number
}

/** List one directory's entries sorted by name (timestamps are lexicographic). */
async function listEntries(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir)
    return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  } catch {
    return []
  }
}

/** Delete every fork ref (road-* now; abandoned-* legacy) in one bare repo. */
async function removeForkRefs(subprocess: SubprocessLike, gitDir: string, cwd: string): Promise<number> {
  const repo: ShadowRepo = { gitDir }
  const listed = await runGit(subprocess, ['git', `--git-dir=${gitDir}`, 'for-each-ref', '--format=%(refname)', 'refs/heads/'], cwd)
  if (listed.exitCode !== 0) return 0
  let count = 0
  for (const line of listed.stdout.split('\n')) {
    const ref = line.trim()
    if (!ref.startsWith('refs/heads/road-') && !ref.startsWith('refs/heads/abandoned-')) continue
    const removed = await runGit(subprocess, ['git', `--git-dir=${gitDir}`, 'update-ref', '-d', ref], cwd)
    if (removed.exitCode === 0) count += 1
  }
  return count
}

/** Expire reflogs and prune unreachable objects in one bare repo. */
async function pruneRepo(subprocess: SubprocessLike, gitDir: string, cwd: string): Promise<boolean> {
  const expired = await runGit(subprocess, ['git', `--git-dir=${gitDir}`, 'reflog', 'expire', '--expire=now', '--all'], cwd)
  if (expired.exitCode !== 0) return false
  const gc = await runGit(subprocess, ['git', `--git-dir=${gitDir}`, 'gc', '--prune=now', '--quiet'], cwd)
  return gc.exitCode === 0
}

/** Rotate backups: delete all but the newest `keep`. Returns deleted count. */
async function rotateBackups(dir: string, keep: number): Promise<number> {
  const entries = await listEntries(dir)
  const items = entries.filter((name) => name.startsWith('pre-rewind-') || name.startsWith('scratch-'))
  const toDelete = items.slice(0, Math.max(0, items.length - keep))
  let deleted = 0
  for (const name of toDelete) {
    try {
      await rm(join(dir, name), { recursive: true, force: true })
      deleted += 1
    } catch {
      // best-effort rotation
    }
  }
  return deleted
}

/**
 * Purge one session's shadow history (session repo + its workspace repo +
 * both backup trees). Irreversible; caller must have passed confirm.
 * @param subprocess - the subprocess service.
 * @param root - history root.
 * @param sessionId - the session whose shadow history to purge.
 * @param cwd - the workspace path (purges its repo + backups when present).
 * @param keepBackups - newest backup files to retain (default 3).
 * @returns the purge result.
 */
export async function purgeSession(
  subprocess: SubprocessLike,
  root: string,
  sessionId: string,
  cwd?: string,
  keepBackups = 3,
): Promise<PurgeResult> {
  const result: PurgeResult = { ok: false }
  const sessionGit = sessionRepoDir(root, sessionId)
  if (await ensureBareRepo(subprocess, sessionGit)) {
    result.sessionRefs = await removeForkRefs(subprocess, sessionGit, root)
    result.sessionPruned = await pruneRepo(subprocess, sessionGit, root)
  }
  if (cwd !== undefined && cwd.length > 0) {
    const wsGit = workspaceRepoDir(root, sessionId)
    if (await ensureBareRepo(subprocess, wsGit)) {
      result.workspaceRefs = await removeForkRefs(subprocess, wsGit, root)
      result.workspacePruned = await pruneRepo(subprocess, wsGit, root)
    }
  }
  const sessionDeleted = await rotateBackups(sessionBackupDir(root, sessionId), keepBackups)
  const wsDeleted = cwd !== undefined && cwd.length > 0 ? await rotateBackups(workspaceBackupDir(root, sessionId), keepBackups) : 0
  result.backupsDeleted = sessionDeleted + wsDeleted
  result.ok = true
  return result
}
