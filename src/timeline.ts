/**
 * Timeline data source: one `git log --all --topo-order` over the session repo.
 * New session snapshots embed their workspace A/M/D manifest in the subject, so
 * graph topology, message previews and file chips arrive in one response.
 */

import type { SubprocessLike } from './git-runner.ts'
import { runGit } from './git-runner.ts'
import { argvLogAll, type ShadowRepo } from './git-commands.ts'
import { parseMessage, type SnapMeta, type WorkspaceChange } from './messages.ts'

/** One timeline row (owned JSON, leaf scalars only). */
export interface TimelineRow {
  sha: string
  parents: string[]
  /** Base subject without the encoded file-manifest tail. */
  subject: string
  ct: number
  meta: SnapMeta | null
  /** A/M/D workspace changes embedded by this session snapshot. */
  files?: WorkspaceChange[]
}

/** Remove the encoded manifest from display/debug copies of the subject. */
function baseSubject(subject: string): string {
  return subject.replace(/\[F1:[A-Za-z0-9_-]+\]$/, '')
}

/** Resolve a session repo's timeline, or null when git fails. */
export async function timelineRows(
  subprocess: SubprocessLike,
  repoDir: string,
  _sessionId: string,
  root: string,
  _workspaceCwd?: string | null,
  _includeFiles = true,
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
    const encodedSubject = parts.slice(2, -1).join('|')
    const ct = Number(parts[parts.length - 1])
    if (!Number.isFinite(ct)) continue
    const parsedMeta = parseMessage(encodedSubject)
    const files = parsedMeta?.changes?.map((change) => ({ ...change }))
    const meta = parsedMeta === null ? null : { ...parsedMeta }
    if (meta !== null) delete meta.changes
    rows.push({
      sha,
      parents,
      subject: baseSubject(encodedSubject),
      ct,
      meta,
      ...(files === undefined ? {} : { files }),
    })
  }

  return rows
}
