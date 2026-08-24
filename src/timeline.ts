/**
 * Timeline data source: `git log --all --topo-order --pretty=format:%H|%P|%s|%ct`
 * over the session repo. `--all` keeps road branches visible; %P supplies
 * parent hashes for lane assignment. Subjects are parsed with the commit
 * message contract into owned JSON rows for the browser.
 *
 * CHECK POINT / TURN rows are enriched with the file list of their paired
 * workspace snapshot (`ws=`). File lists for ALL snapshots come from a SINGLE
 * `git log --name-only` over the workspace shadow repo (its main is linear),
 * keyed by ws commit sha — one git spawn total instead of one per row.
 */

import type { SubprocessLike } from './git-runner.ts'
import { runGit } from './git-runner.ts'
import { argvLogAll, type ShadowRepo } from './git-commands.ts'
import { parseMessage, type SnapMeta } from './messages.ts'
import { workspaceRepoDir } from './store.ts'

/** One timeline row (owned JSON, leaf scalars only). */
export interface TimelineRow {
  sha: string
  parents: string[]
  subject: string
  ct: number
  meta: SnapMeta | null
  /** Basenames changed by the paired workspace snapshot (turn-start/turn-end). */
  files?: string[]
}

/** Build a ws-commit -> basenames map from ONE `git log --name-only` stream. */
function wsFilesByCommit(stdout: string): Map<string, string[]> {
  const map = new Map<string, string[]>()
  let current: string | null = null
  for (const line of stdout.split('\n')) {
    if (line.startsWith('commit ')) {
      const sha = line.slice('commit '.length).trim()
      current = sha
      if (!map.has(sha)) map.set(sha, [])
      continue
    }
    const name = line.trim()
    if (current === null || name.length === 0) continue
    const basename = name.split(/[/\\]/).pop()!
    if (basename.length === 0) continue
    map.get(current)!.push(basename)
  }
  return map
}

/** Resolve a session repo's timeline, or null when git fails. */
export async function timelineRows(
  subprocess: SubprocessLike,
  repoDir: string,
  root: string,
  workspaceCwd?: string | null,
): Promise<TimelineRow[] | null> {
  const repo: ShadowRepo = { gitDir: repoDir }
  const res = await runGit(subprocess, argvLogAll(repo), root)
  if (res.exitCode !== 0) return null
  const rows: TimelineRow[] = []
  for (const line of res.stdout.split('\n')) {
    const text = line.trim()
    if (text.length === 0) continue
    const parts = text.split('|')
    if (parts.length < 4) continue
    const sha = parts[0]!
    const parents = parts[1]!.split(' ').filter((parent) => parent.length > 0)
    const subject = parts.slice(2, -1).join('|')
    const ct = Number(parts[parts.length - 1])
    if (!Number.isFinite(ct)) continue
    rows.push({ sha, parents, subject, ct, meta: parseMessage(subject) })
  }

  // Enrich turn-start / turn-end rows with changed-file basenames from the
  // paired workspace snapshot. ONE spawn: `git log --name-only` walks main
  // (linear) and prints every commit's file list; we key by ws commit sha.
  if (workspaceCwd !== undefined && workspaceCwd !== null && workspaceCwd.length > 0) {
    const wsRepo: ShadowRepo = { gitDir: workspaceRepoDir(root, workspaceCwd) }
    const log = await runGit(
      subprocess,
      ['git', `--git-dir=${wsRepo.gitDir}`, 'log', '--root', '--name-only', '--format=commit %H', 'refs/heads/main'],
      root,
    )
    if (log.exitCode === 0) {
      const byCommit = wsFilesByCommit(log.stdout)
      for (const row of rows) {
        const meta = row.meta
        if (meta === null || (meta.kind !== 'turn-start' && meta.kind !== 'turn-end')) continue
        const ws = meta.ws
        if (ws === undefined || ws.length === 0) continue
        const files = byCommit.get(ws)
        if (files !== undefined && files.length > 0) row.files = files
      }
    }
  }

  return rows
}
