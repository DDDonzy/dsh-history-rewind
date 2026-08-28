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
import { workspaceRepoDir, legacyWorkspaceRepoDir } from './store.ts'
import { existsSync } from 'node:fs'

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
  sessionId: string,
  root: string,
  workspaceCwd?: string | null,
): Promise<TimelineRow[] | null> {
  const repo: ShadowRepo = { gitDir: repoDir }
  const res = await runGit(subprocess, argvLogAll(repo), root)
  if (res.exitCode !== 0) {
    const err = (res.stderr || '').toLowerCase()
    if (
      err.includes('does not have any commits')
      || err.includes('bad default revision')
      || err.includes('unknown revision')
      || (res.stdout.trim().length === 0 && res.stderr.trim().length === 0)
    ) {
      return []
    }
    return null
  }
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
    // 会话级 ws 仓库优先；旧的项目级仓库（老快照的 ws commit 所在）合并进来，
    // 保证旧时间线仍能解析文件列表。
    const byCommit = new Map<string, string[]>()
    const mergeFiles = (part: Map<string, string[]>): void => {
      for (const [sha, files] of part) if (!byCommit.has(sha)) byCommit.set(sha, files)
    }
    const newRepo = workspaceRepoDir(root, sessionId)
    const logNew = await runGit(
      subprocess,
      ['git', `--git-dir=${newRepo}`, 'log', '--root', '--name-only', '--format=commit %H', 'refs/heads/main'],
      root,
    )
    if (logNew.exitCode === 0) mergeFiles(wsFilesByCommit(logNew.stdout))
    const legacyRepo = legacyWorkspaceRepoDir(root, workspaceCwd)
    if (legacyRepo !== newRepo && existsSync(legacyRepo)) {
      const logOld = await runGit(
        subprocess,
        ['git', `--git-dir=${legacyRepo}`, 'log', '--root', '--name-only', '--format=commit %H', 'refs/heads/main'],
        root,
      )
      if (logOld.exitCode === 0) mergeFiles(wsFilesByCommit(logOld.stdout))
    }
    if (byCommit.size > 0) {
      // rows 来自 `git log --all --topo-order`（newest-first）。一个 ws
      // commit 可能被多个连续快照复用（工作区未变化时 dedup 复用），它们
      // 相对 parent 的变更集是同一份。只有"首次到达该工作区状态"的快照才
      // 真正修改了文件：按旧→新遍历，用 seen 集合只对首次出现的 ws commit
      // 挂文件列表，其余保持无文件，避免连续无变动快照重复显示同一批文件。
      const seenWs = new Set<string>()
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i]!
        const meta = row.meta
        if (meta === null || (meta.kind !== 'turn-start' && meta.kind !== 'turn-end')) continue
        const ws = meta.ws
        if (ws === undefined || ws.length === 0) continue
        if (seenWs.has(ws)) continue
        const files = byCommit.get(ws)
        if (files !== undefined && files.length > 0) {
          row.files = files
          seenWs.add(ws)
        }
      }
    }
  }

  return rows
}
