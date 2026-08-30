/**
 * Browser-side channels: the package-owned loopback routes that snapshot,
 * list the timeline and rewind a session.
 */

import { ROUTE_PREFIX } from '../constants.ts'
import type { WorkspaceChange } from '../messages.ts'

/** One timeline row as served by the Host (owned JSON). */
export interface TimelineRow {
  sha: string
  parents: string[]
  subject: string
  ct: number
  /** A/M/D paths embedded by the session snapshot. */
  files?: WorkspaceChange[]
  meta: {
    kind: 'turn-start' | 'turn-end' | 'manual' | 'rewind' | 'refine'
    turn?: number
    phase?: 'start' | 'end'
    seq?: number
    session?: string
    snap?: string
    base?: string
    ws?: string
    target?: string
    message?: string
    userMessage?: string
    asstMessage?: string
    maskedTurns?: number[]
    changes?: WorkspaceChange[]
  } | null
}

/** Timeline answer from the Host. */
export interface TimelineResult {
  ok: boolean
  reason?: string
  rows?: TimelineRow[]
}

/** Rewind result from the Host. */
export interface RewindResult {
  ok: boolean
  reason?: string
  /** The commit the session now contains (the jump target). */
  target?: string
  /** True when this call only restored the workspace (session untouched). */
  workspaceOnly?: boolean
  detached?: boolean
  error?: string
  /** Retained pre-rewind copies. A successful rewind drops its own, so this is
   *  present only when something was deliberately kept or could not be removed. */
  backup?: { session?: string; workspace?: string }
  noWorkspaceSnapshot?: boolean
  workspaceRestored?: boolean
  /** Session resumed but its agent preset could not be re-mounted (cache degraded). */
  compositionWarning?: string
  /** Post-success cleanup could not remove one or more of this call's backups. */
  backupCleanupFailed?: boolean
}

/** Manual snapshot result. */
export interface SnapshotResult {
  ok: boolean
  reason?: string
  commit?: string
  base?: string
  unchanged?: boolean
  ref?: string
  fork?: boolean
  wsCommit?: string
  snap?: string
  turn?: number
}

/** Purge result. */
export interface PurgeResult {
  ok: boolean
  reason?: string
  sessionRefs?: number
  sessionPruned?: boolean
  workspaceRefs?: number
  workspacePruned?: boolean
  backupsDeleted?: number
}

/** Context Curation result. */
export interface RefineResult {
  ok: boolean
  reason?: string
  /** Source-Session TURN ids omitted from the derived seed. */
  maskedTurns?: number[]
  /** Requested turns absent from the artifact (nothing removed for them). */
  unmapped?: number[]
  /** Source-Session TURN ids retained in the derived seed. */
  remainingTurns?: number[]
  /** Newly published independent ordinary Session. */
  newSessionId?: string
  /** Initial Context Curation commit in the new Session's own shadow repo. */
  curationCommit?: string
  /** Whether DSH attached the new Session to the inherited Workspace. */
  workspaceAttached?: boolean
  workspaceId?: string
  workspaceAttachmentFailure?: { code: string; workspaceId: string; message: string }
  error?: string
  /** Success with a non-fatal publication/snapshot warning. */
  warning?: string
}

/** Create an independent Session with the selected TURNs omitted. */
export async function refineSession(sessionId: string, turns: number[]): Promise<RefineResult> {
  const data = await post(`${ROUTE_PREFIX}/refine`, { sessionId, turns }, 120000)
  if (data === null) return { ok: false, reason: 'transport' }
  return {
    ok: data.ok === true,
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    ...(Array.isArray(data.maskedTurns) ? { maskedTurns: data.maskedTurns as number[] } : {}),
    ...(Array.isArray(data.unmapped) ? { unmapped: data.unmapped as number[] } : {}),
    ...(Array.isArray(data.remainingTurns) ? { remainingTurns: data.remainingTurns as number[] } : {}),
    ...(typeof data.newSessionId === 'string' ? { newSessionId: data.newSessionId } : {}),
    ...(typeof data.curationCommit === 'string' ? { curationCommit: data.curationCommit } : {}),
    ...(typeof data.workspaceAttached === 'boolean' ? { workspaceAttached: data.workspaceAttached } : {}),
    ...(typeof data.workspaceId === 'string' ? { workspaceId: data.workspaceId } : {}),
    ...(data.workspaceAttachmentFailure !== null && typeof data.workspaceAttachmentFailure === 'object'
      ? { workspaceAttachmentFailure: data.workspaceAttachmentFailure as { code: string; workspaceId: string; message: string } }
      : {}),
    ...(typeof data.error === 'string' ? { error: data.error } : {}),
    ...(typeof data.warning === 'string' ? { warning: data.warning } : {}),
  }
}

/** Shadow-repo export result (debug clone). */
export interface ExportResult {
  ok: boolean
  reason?: string
  /** Extra diagnostic (e.g. last clone stderr lines). */
  detail?: string
  /** Absolute cloned path. */
  target?: string
  /** Materialized local branches. */
  branches?: string[]
  /** Total commits across all refs. */
  commits?: number
}

/** Clone the session shadow repo into `target` (debug with VS Code / Git Graph). */
export async function exportRepo(sessionId: string, target: string): Promise<ExportResult> {
  const data = await post(`${ROUTE_PREFIX}/export`, { sessionId, target }, 60000)
  if (data === null) return { ok: false, reason: 'transport' }
  return {
    ok: data.ok === true,
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    ...(typeof data.detail === 'string' ? { detail: data.detail } : {}),
    ...(typeof data.target === 'string' ? { target: data.target } : {}),
    ...(Array.isArray(data.branches) ? { branches: data.branches as string[] } : {}),
    ...(typeof data.commits === 'number' ? { commits: data.commits } : {}),
  }
}

/** Permanently purge road branches + rotate backups. Irreversible. */
export async function purge(sessionId: string): Promise<PurgeResult> {
  const data = await post(`${ROUTE_PREFIX}/purge`, { sessionId, confirm: true })
  if (data === null) return { ok: false, reason: 'transport' }
  return {
    ok: data.ok === true,
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    ...(typeof data.sessionRefs === 'number' ? { sessionRefs: data.sessionRefs } : {}),
    ...(data.sessionPruned === true ? { sessionPruned: true } : {}),
    ...(typeof data.workspaceRefs === 'number' ? { workspaceRefs: data.workspaceRefs } : {}),
    ...(data.workspacePruned === true ? { workspacePruned: true } : {}),
    ...(typeof data.backupsDeleted === 'number' ? { backupsDeleted: data.backupsDeleted } : {}),
  }
}

/** POST helper returning parsed JSON, or null on transport failure/timeout. */
export async function post(path: string, body: unknown, timeoutMs = 30000): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const data = await response.json() as unknown
    return data !== null && typeof data === 'object' ? data as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** GET helper returning parsed JSON, or null on transport failure/timeout. */
export async function get(path: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(path, { signal: AbortSignal.timeout(30000) })
    if (!response.ok) return null
    const data = await response.json() as unknown
    return data !== null && typeof data === 'object' ? data as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Fetch the git-graph timeline for one session. */
export async function fetchTimeline(sessionId: string): Promise<TimelineResult> {
  const data = await get(`${ROUTE_PREFIX}/timeline?sessionId=${encodeURIComponent(sessionId)}`)
  if (data === null) return { ok: false, reason: 'transport' }
  const rows = Array.isArray(data.rows)
    ? (data.rows as unknown[]).filter((row) => row !== null && typeof row === 'object')
        .map((row) => row as TimelineRow)
    : undefined
  return {
    ok: data.ok === true,
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    ...(rows !== undefined ? { rows } : {}),
  }
}

export interface RewindStatusResult {
  ok: boolean
  running: boolean
  status?: string | null
  reason?: string
}

/** Check whether a session is currently running before opening rewind UI. */
export async function getRewindStatus(sessionId: string): Promise<RewindStatusResult> {
  const data = await get(`${ROUTE_PREFIX}/rewind-status?sessionId=${encodeURIComponent(sessionId)}`)
  if (data === null) return { ok: false, running: false, reason: 'transport' }
  return {
    ok: data.ok === true,
    running: data.running === true,
    ...(typeof data.status === 'string' || data.status === null ? { status: data.status as string | null } : {}),
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
  }
}

/** Rewind one session to a timeline commit (session + optional workspace). */
export async function rewind(
  sessionId: string,
  commit: string,
  restoreWorkspace: boolean,
  workspaceOnly = false,
): Promise<RewindResult> {
  const data = await post(`${ROUTE_PREFIX}/rewind`, { sessionId, commit, restoreWorkspace, workspaceOnly })
  if (data === null) return { ok: false, reason: 'transport' }
  return {
    ok: data.ok === true,
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    ...(typeof data.target === 'string' ? { target: data.target } : {}),
    ...(data.workspaceOnly === true ? { workspaceOnly: true } : {}),
    ...(data.detached === true ? { detached: true } : {}),
    ...(typeof data.error === 'string' ? { error: data.error } : {}),
    ...(data.backup !== null && typeof data.backup === 'object'
      ? { backup: data.backup as { session?: string; workspace?: string } }
      : {}),
    ...(data.noWorkspaceSnapshot === true ? { noWorkspaceSnapshot: true } : {}),
    ...(data.workspaceRestored === true ? { workspaceRestored: true } : {}),
    ...(data.backupCleanupFailed === true ? { backupCleanupFailed: true } : {}),
  }
}

/** Take a manual snapshot now. */
export async function manualSnapshot(sessionId: string): Promise<SnapshotResult> {
  const data = await post(`${ROUTE_PREFIX}/snapshot`, { sessionId })
  if (data === null) return { ok: false, reason: 'transport' }
  return {
    ok: data.ok === true,
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
    ...(typeof data.commit === 'string' ? { commit: data.commit } : {}),
    ...(typeof data.wsCommit === 'string' ? { wsCommit: data.wsCommit } : {}),
    ...(typeof data.snap === 'string' ? { snap: data.snap } : {}),
    ...(typeof data.turn === 'number' ? { turn: data.turn } : {}),
  }
}

/** Host git availability (plugin config card). */
export interface GitStatusResult {
  ok: boolean
  available: boolean
  version?: string
  message?: string
}

/** Query whether git is available on the host. */
export async function gitStatus(): Promise<GitStatusResult> {
  const data = await get(`${ROUTE_PREFIX}/git-status`)
  if (data === null) return { ok: false, available: false }
  return {
    ok: data.ok === true,
    available: data.available === true,
    ...(typeof data.version === 'string' ? { version: data.version } : {}),
    ...(typeof data.message === 'string' ? { message: data.message } : {}),
  }
}

/** Install-git attempt result (plugin config card). */
export interface InstallGitResult {
  ok: boolean
  installed?: boolean
  detail?: string
  message?: string
}

/** Ask the host to attempt a silent git install. */
export async function installGit(): Promise<InstallGitResult> {
  const data = await post(`${ROUTE_PREFIX}/install-git`, {})
  if (data === null) return { ok: false, message: 'transport' }
  return {
    ok: data.ok === true,
    ...(data.installed === true ? { installed: true } : {}),
    ...(typeof data.detail === 'string' ? { detail: data.detail } : {}),
    ...(typeof data.message === 'string' ? { message: data.message } : {}),
  }
}

/** Global plugin config (settings page). */
export interface ConfigResult {
  ok: boolean
  gitignoreTemplate?: string
  /** Advisory shadow-store budget in GB (never enforced automatically). */
  cacheCapacityGb?: number
}

/** Read the current global config. */
export async function getConfig(): Promise<ConfigResult> {
  const data = await get(`${ROUTE_PREFIX}/config`)
  if (data === null) return { ok: false }
  return {
    ok: data.ok === true,
    ...(typeof data.gitignoreTemplate === 'string' ? { gitignoreTemplate: data.gitignoreTemplate } : {}),
    ...(typeof data.cacheCapacityGb === 'number' ? { cacheCapacityGb: data.cacheCapacityGb } : {}),
  }
}

/**
 * Save the global default `.gitignore` template. This only seeds a
 * workspace's `.gitignore` the FIRST time that workspace is snapshotted and
 * has none yet — it never touches an existing `.gitignore`, including one
 * this same template seeded earlier.
 */
export async function setConfig(gitignoreTemplate: string): Promise<{ ok: boolean; reason?: string }> {
  const data = await post(`${ROUTE_PREFIX}/config`, { gitignoreTemplate })
  if (data === null) return { ok: false, reason: 'transport' }
  return {
    ok: data.ok === true,
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
  }
}

/** Save the advisory cache capacity, in GB. */
export async function setCacheCapacity(cacheCapacityGb: number): Promise<{ ok: boolean; reason?: string }> {
  const data = await post(`${ROUTE_PREFIX}/config`, { cacheCapacityGb })
  if (data === null) return { ok: false, reason: 'transport' }
  return {
    ok: data.ok === true,
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
  }
}

/** Shadow-store usage against the advisory capacity. */
export interface CacheUsageResult {
  ok: boolean
  sessionBytes: number
  workspaceBytes: number
  backupsBytes: number
  totalBytes: number
  capacityBytes: number
}

/** Read current shadow-store usage. */
export async function getCacheUsage(): Promise<CacheUsageResult | null> {
  const data = await get(`${ROUTE_PREFIX}/cache`)
  if (data === null || data.ok !== true) return null
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    ok: true,
    sessionBytes: num(data.sessionBytes),
    workspaceBytes: num(data.workspaceBytes),
    backupsBytes: num(data.backupsBytes),
    totalBytes: num(data.totalBytes),
    capacityBytes: num(data.capacityBytes),
  }
}

/** What a clear request targets. */
export type CacheScope = 'session' | 'workspace' | 'both'

/** Stored session facts returned by GET /cache/sessions. */
export interface StoredSession {
  sessionId: string
  sessionBytes: number
  workspaceBytes: number
  backupsBytes: number
  totalBytes: number
  title?: string
  workspace?: string
  lastModified: number
  /** Active road tip (latest road, otherwise main). */
  commit?: string
  /** False while the per-session recursive size scan is still running. */
  usageLoaded?: boolean
  /** True when the per-session size request failed. */
  usageError?: boolean
}

/** Get one session's recursive cache usage after its list row is visible. */
export async function getCacheSessionUsage(sessionId: string): Promise<StoredSession | null> {
  const data = await get(`${ROUTE_PREFIX}/cache/session-usage?sessionId=${encodeURIComponent(sessionId)}`)
  if (data === null || data.ok !== true || data.session === null || typeof data.session !== 'object') return null
  return data.session as StoredSession
}

/** Get list of all sessions that have shadow store data. */
export async function getCacheSessions(): Promise<{ ok: boolean; sessions?: StoredSession[] }> {
  const data = await get(`${ROUTE_PREFIX}/cache/sessions`)
  if (data === null || data.ok !== true) return { ok: false }
  return {
    ok: true,
    sessions: Array.isArray(data.sessions) ? (data.sessions as StoredSession[]) : [],
  }
}

/**
 * Clear the shadow store for one or both areas, optionally scoped to specific sessions.
 * IRREVERSIBLE: this drops the rewind history itself, not just cached derivatives.
 */
export async function clearCache(
  scope: CacheScope,
  sessionIds?: string[],
): Promise<{ ok: boolean; freedBytes?: number; failed?: number; reason?: string }> {
  const data = await post(`${ROUTE_PREFIX}/cache/clear`, { scope, sessionIds })
  if (data === null) return { ok: false, reason: 'transport' }
  return {
    ok: data.ok === true,
    ...(typeof data.freedBytes === 'number' ? { freedBytes: data.freedBytes } : {}),
    ...(typeof data.failed === 'number' ? { failed: data.failed } : {}),
    ...(typeof data.reason === 'string' ? { reason: data.reason } : {}),
  }
}
