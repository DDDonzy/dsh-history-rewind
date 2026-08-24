/**
 * Debug export: clone a session shadow repo into a user-chosen directory so
 * the whole git history can be inspected with VS Code / Git Graph.
 *
 * Shadow repos are PURE BARE repos (no work-tree); Git Graph and the SCM
 * panel cannot open those directly. The export clones once into the target
 * path — full history — then materializes every road / abandoned ref as a
 * LOCAL branch so each fork renders as its own lane. The clone is a normal
 * work-tree repo (session zstd blobs checked out), safe to open anywhere.
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import type { SubprocessLike } from './git-runner.ts'
import { runGit, firstLine } from './git-runner.ts'
import { sessionRepoDir } from './store.ts'

/** Result of one shadow-repo export. */
export interface ExportResult {
  ok: boolean
  reason?: string
  /** Extra diagnostic (e.g. last clone stderr lines). */
  detail?: string
  /** Absolute cloned path. */
  target?: string
  /** Materialized local branches (main + road-<ts>/abandoned-<ts>). */
  branches?: string[]
  /** Total commits across all refs. */
  commits?: number
}

/**
 * Clone one session shadow repo to `targetPath` as a work-tree repo.
 * @param subprocess - the subprocess service.
 * @param root - history root (resolves the source repo).
 * @param sessionId - session whose repo to export.
 * @param targetPath - absolute destination. Must be empty or missing; a
 *   non-empty dir is refused so the clone never merges into an existing repo.
 * @returns the export result (target = resolved absolute path).
 */
export async function exportShadowRepo(
  subprocess: SubprocessLike,
  root: string,
  sessionId: string,
  targetPath: string,
): Promise<ExportResult> {
  const cleanTarget = targetPath.trim()
  if (cleanTarget.length === 0) return { ok: false, reason: 'empty-target' }

  const srcRepo = sessionRepoDir(root, sessionId)
  if (!existsSync(srcRepo)) return { ok: false, reason: 'no-session-repo' }

  const target = resolve(cleanTarget)
  const rootAbs = resolve(root)
  // Never clone INTO the history root or any dir inside it: a shadow repo
  // inside the store would confuse the walk / purge logic (and recursively
  // snapshotted shadow repos are exactly the bug we just fixed).
  if (target === rootAbs || target.startsWith(`${rootAbs}${sep}`)) {
    return { ok: false, reason: 'target-inside-history-root' }
  }
  // Reject a path INSIDE the session repo itself.
  if (target.startsWith(`${resolve(srcRepo)}${sep}`)) {
    return { ok: false, reason: 'target-inside-session-repo' }
  }

  // Content rules: target must be empty or missing. A non-empty dir is likely
  // a real repo or has files — refuse rather than merge/clobber.
  if (existsSync(target)) {
    const entries = await readdir(target).catch(() => null)
    if (entries === null) return { ok: false, reason: 'target-unreadable' }
    if (entries.length > 0) return { ok: false, reason: 'target-not-empty' }
  } else {
    const made = await mkdir(target, { recursive: true }).then(() => true).catch(() => false)
    if (!made) return { ok: false, reason: 'target-unwritable' }
  }

  const cloned = await runGit(subprocess, ['git', 'clone', '--quiet', srcRepo, target], root)
  if (cloned.exitCode !== 0) {
    const detail = cloned.stderr.trim().split('\n').slice(-3).join(' ')
    return { ok: false, reason: 'clone-failed', detail }
  }

  // Older repos carry unset master HEAD; pin a local main so the clone has a
  // checked-out branch (VS Code needs one for the SCM panel).
  await runGit(subprocess, ['git', '-C', target, 'switch', '-c', 'main', 'origin/main'], target).catch(() => undefined)
  await runGit(subprocess, ['git', '-C', target, 'checkout', '-f', 'main'], target).catch(() => undefined)

  // Materialize roads as LOCAL branches (Git Graph default shows local
  // branches; remote-only refs would hide the fork lanes).
  const roads = await runGit(subprocess, ['git', '-C', target, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin/road-*', 'refs/remotes/origin/abandoned-*'], target)
  if (roads.exitCode === 0) {
    for (const line of roads.stdout.split('\n')) {
      const ref = line.trim()
      if (ref.length === 0) continue
      const local = ref.replace(/^origin\//, '')
      if (local === 'main' || local === 'HEAD') continue
      await runGit(subprocess, ['git', '-C', target, 'branch', local, ref], target).catch(() => undefined)
    }
  }

  const locals = await runGit(subprocess, ['git', '-C', target, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'], target)
  const branches = locals.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
  const countRes = await runGit(subprocess, ['git', '-C', target, 'rev-list', '--count', '--all'], target)
  const commits = countRes.exitCode === 0 ? Number.parseInt(firstLine(countRes.stdout), 10) || 0 : 0

  return { ok: true, target, branches: branches.length > 0 ? branches : ['main'], commits }
}
