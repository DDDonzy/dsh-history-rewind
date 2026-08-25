/**
 * The rewind chain (checkout-only model, user-confirmed).
 *
 * 跳转 = 只把会话文件换成目标历史版本的内容；git 侧零新建：不产生标记提交、
 * 不移动 main、不建任何 ref。快照层负责后续：
 *   - 内容与跳转目标相同 → 什么都不产生（无提交、无分支）；
 *   - 内容变化 → 新建 road-<ts> 分支，提交（父 = 跳转目标），main 原路不动。
 *
 * Chain (order contract):
 *   materialize target bytes → flush → backup → workspace resolve/backup/restore
 *   → detach agent entry → detach session entry → atomic replace → resume.
 *
 * The workspace RESTORE runs while the session is still live (before any
 * detach): it is the slow part of a rewind, and the client shows one
 * no-session gap between `session/disposed` and `session/created` (the list
 * drops and re-adds the row). Running it first keeps that gap down to the
 * atomic rename + resume — the UI can never flash for the duration of a large
 * workspace walk.
 *
 * Crash semantics:
 *   - crash before resume → disk file = target content, git untouched (main
 *     stays where it was); cold load reads the target file; the in-memory
 *     jump target is lost, so the next snapshot falls back to committing on
 *     the git-active road (latest road or main) — self-consistent;
 *   - crash after resume → same state with the session live.
 * The pre-rewind backup always exists for manual undo.
 */

import { copyFile, mkdir, readFile, writeFile, rename, unlink, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SubprocessLike } from './git-runner.ts'
import { runGit, firstLine } from './git-runner.ts'
import {
  argvRevParseCommit, argvLogSubjects, commitEnv, type ShadowRepo,
} from './git-commands.ts'
import { parseMessage } from './messages.ts'
import { sessionRepoDir, workspaceRepoDir, legacyWorkspaceRepoDir, sessionBackupDir, ensureBareRepo, ensureHistoryRoot, readExcludes } from './store.ts'
import { materializeTree, materializeTreeExact, backupWorkspace } from './workspace.ts'
import { setJumpTarget } from './state.ts'
import { decodeTargetFacts, seedBlankSession } from './zstd-util.ts'
import type { SessionLike, PersistenceLike } from './snapshot.ts'

/** Minimal structural view of one live agent. */
interface AgentLike {
  status?: string
  cancel?(cause: { kind: string }): void
  whenIdle?(): Promise<unknown>
}

/** One agent-registry entry (internal store map value). */
interface AgentEntryLike {
  id: string
}

/** Minimal structural view of the agent registry. */
export interface AgentRegistryLike {
  get(id: string): AgentLike | undefined
  detachEntered?(entry: AgentEntryLike): void
  resume?(options: {
    resumeSessionId: string
    agentOptions?: { provider?: string; model?: string }
    setup?: (agentCtx: unknown) => Promise<void> | void
  }): Promise<unknown>
  store?: Map<string, AgentEntryLike>
}

/** Minimal structural view of the agent-presets roster (optional service). */
export interface AgentPresetsLike {
  mount?(agentCtx: unknown, id?: string): Promise<unknown>
}

/** Minimal structural view of the in-memory session store. */
export interface SessionsServiceLike {
  get(id: string): SessionLike | undefined
  flush?(session: SessionLike): Promise<boolean>
  liveEntryFor?(session: SessionLike): { id: string } | undefined
  detachEntered?(entry: { id: string }): void
}

/** Result of one rewind attempt (owned JSON for the wire). */
export interface RewindResult {
  ok: boolean
  reason?: string
  /** The commit the session now contains (equals the requested target). */
  target?: string
  /** True when this call only restored the workspace (session untouched). */
  workspaceOnly?: boolean
  /** Error text of a failed stage, for diagnostics. */
  error?: string
  /** Session was detached; resume failed (needs a reload/restart fallback). */
  detached?: boolean
  /** Backup paths taken (session file, workspace). */
  backup?: { session?: string; workspace?: string }
  /** Workspace restore was requested but no paired ws snapshot was found. */
  noWorkspaceSnapshot?: boolean
  /** Workspace restore ran and succeeded. */
  workspaceRestored?: boolean
  /** Session resumed but its agent preset could not be re-mounted (cache degraded). */
  compositionWarning?: string
}

/** Work-tree gating used for the detach wait. */
const IDLE_WAIT_MS = 5000

/** Bound a promise wait (loop-idle), resolving on timeout. */
async function boundedWait(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, ms) })
  await Promise.race([promise.then(() => undefined, () => undefined), timeout])
  if (timer !== undefined) clearTimeout(timer)
}

/**
 * Resolve the workspace commit paired with a session snapshot by walking the
 * target's ancestors (first-parent chain) until a subject with ws= shows up.
 * @param subprocess - the subprocess service.
 * @param repo - the session repo.
 * @param startCommit - the rewind target (or its road).
 * @param cwd - a neutral cwd for git calls.
 * @returns the ws commit SHA, or null.
 */
async function resolveWorkspaceCommit(
  subprocess: SubprocessLike,
  repo: ShadowRepo,
  startCommit: string,
  cwd: string,
): Promise<string | null> {
  const log = await runGit(subprocess, argvLogSubjects(repo, startCommit), cwd, commitEnv())
  if (log.exitCode !== 0) return null
  for (const line of log.stdout.split('\n')) {
    const meta = parseMessage(line.trim())
    if (meta !== null && meta.ws !== undefined && meta.ws.length > 0) return meta.ws
  }
  return null
}

/**
 * Resolve the workspace repo that actually contains `wsCommit`: the session's
 * own repo first, then the legacy per-project repo (old snapshots whose ws
 * commits live there). Returns the git dir, or null when neither carries it.
 */
async function wsRepoWithCommit(
  subprocess: SubprocessLike,
  root: string,
  sessionId: string,
  wsCommit: string,
  cwd: string,
  env: Record<string, string>,
): Promise<string | null> {
  const primary = workspaceRepoDir(root, sessionId)
  const first = await runGit(subprocess, argvRevParseCommit({ gitDir: primary }, wsCommit), root, env)
  if (first.exitCode === 0 && firstLine(first.stdout).length > 0) return primary
  const legacy = legacyWorkspaceRepoDir(root, cwd)
  if (legacy === primary || !existsSync(legacy)) return null
  const second = await runGit(subprocess, argvRevParseCommit({ gitDir: legacy }, wsCommit), root, env)
  if (second.exitCode === 0 && firstLine(second.stdout).length > 0) return legacy
  return null
}

/**
 * Perform one rewind (checkout-only). Single-flight per session (callers gate it).
 * @param subprocess - the subprocess service.
 * @param root - history root.
 * @param sessions - the in-memory session store.
 * @param persistence - locating the official artifact.
 * @param agents - the agent registry (running gate + detach/resume).
 * @param sessionId - the session to rewind.
 * @param commit - the timeline commit to rewind to.
 * @param restoreWorkspace - also restore the workspace paired with the target.
 * @param agentPresets - optional preset roster; when present and the target
 *   records one, the resumed agent is re-composed from it (cache contract).
 * @returns the wire-facing result.
 */
export async function rewindSession(
  subprocess: SubprocessLike,
  root: string,
  sessions: SessionsServiceLike | undefined,
  persistence: PersistenceLike | undefined,
  agents: AgentRegistryLike | undefined,
  sessionId: string,
  commit: string,
  restoreWorkspace: boolean,
  agentPresets?: AgentPresetsLike | undefined,
  workspaceOnly = false,
): Promise<RewindResult> {
  const session = sessions?.get(sessionId)
  if (session === undefined || session.header === undefined) return { ok: false, reason: 'no-session' }
  const location = persistence?.locate({ ...session.header, id: sessionId })
  if (location === undefined || location.path.length === 0) return { ok: false, reason: 'no-artifact' }
  const agent = agents?.get(sessionId)
  if (agent?.status === 'running') return { ok: false, reason: 'session-running' }
  await ensureHistoryRoot(root)

  const sessionRepo: ShadowRepo = { gitDir: sessionRepoDir(root, sessionId) }
  const env = commitEnv()
  if (!(await ensureBareRepo(subprocess, sessionRepo.gitDir))) return { ok: false, reason: 'git-unavailable' }
  const targetRes = await runGit(subprocess, argvRevParseCommit(sessionRepo, commit), root, env)
  if (targetRes.exitCode !== 0 || firstLine(targetRes.stdout).length === 0) return { ok: false, reason: 'unknown-commit' }
  const target = firstLine(targetRes.stdout)

  // ---- Workspace-only mode: restore the paired workspace tree WITHOUT
  // touching the live session (no detach, no replace, no resume). Useful as a
  // "bring the code back" shortcut while staying on the current conversation.
  if (workspaceOnly) {
    const cwdWs = session.header.cwd
    if (cwdWs === undefined || cwdWs.length === 0) return { ok: false, reason: 'no-workspace' }
    const wsCommit = await resolveWorkspaceCommit(subprocess, sessionRepo, target, root)
    if (wsCommit === null) return { ok: false, reason: 'no-workspace-snapshot', target }
    const wsGit = await wsRepoWithCommit(subprocess, root, sessionId, wsCommit, cwdWs, env)
    if (wsGit === null) {
      return { ok: false, reason: 'no-workspace-snapshot', target }
    }
    const backed = await backupWorkspace(root, sessionId, cwdWs)
    if (backed === null) return { ok: false, reason: 'workspace-backup-failed' }
    // Exact restore: same exclude rules as the snapshot walk, so the workspace
    // ends up byte-identical to the snapshot — extra files are removed too.
    const excludes = await readExcludes(root, cwdWs)
    const restored = await materializeTreeExact(subprocess, wsGit, wsCommit, cwdWs, excludes)
    return {
      ok: restored !== null,
      target,
      workspaceOnly: true,
      backup: { workspace: backed },
      workspaceRestored: restored !== null,
      ...(restored === null ? { reason: 'workspace-restore-failed' } : {}),
    }
  }

  const backup: RewindResult['backup'] = {}

  // 1. Materialize the target bytes into a scratch dir (binary-safe; git
  //    writes the file itself). Mirrors the official layout under the tree.
  const scratch = join(root, 'backups', `scratch-${sessionId}-${Date.now()}`)
  let targetFile: string | null = null
  try {
    await mkdir(scratch, { recursive: true })
    const count = await materializeTree(subprocess, sessionRepo.gitDir, target, scratch)
    if (count === null || count === 0) return { ok: false, reason: 'materialize-failed' }
    const basename = location.path.split(/[/\\]/).pop() ?? 'session.jsonl.zstd'
    targetFile = join(scratch, `session-${sessionId}`, basename)
    if (!existsSync(targetFile)) return { ok: false, reason: 'materialize-empty' }
  } catch (error) {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, reason: 'materialize-error', error: error instanceof Error ? error.message : String(error) }
  }

  // 2. Durability barrier, then backup the current session file.
  if (sessions?.flush !== undefined) {
    try {
      await sessions.flush(session)
    } catch {
      // Best-effort: an idle session may reject the flush call.
    }
  }
  try {
    const backupDir = sessionBackupDir(root, sessionId)
    await mkdir(backupDir, { recursive: true })
    const backupPath = join(backupDir, `pre-rewind-${Date.now()}.zstd`)
    await copyFile(location.path, backupPath)
    backup.session = backupPath
  } catch {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, reason: 'backup-failed' }
  }

  // 3. Workspace chain — RESOLVE + BACKUP + RESTORE before anything detaches
  //    (hard guard: no backup, no destructive move; and the restore is slow,
  //    so it must not sit inside the session's dispose → resume gap where the
  //    browser shows the no-session state).
  let wsCommit: string | null = null
  const cwd = session.header.cwd
  let noWorkspaceSnapshot = false
  let workspaceRestored = false
  if (restoreWorkspace && cwd !== undefined && cwd.length > 0) {
    wsCommit = await resolveWorkspaceCommit(subprocess, sessionRepo, target, root)
    if (wsCommit === null) {
      noWorkspaceSnapshot = true
    } else {
      const wsGit = await wsRepoWithCommit(subprocess, root, sessionId, wsCommit, cwd, env)
      if (wsGit !== null) {
        const backed = await backupWorkspace(root, sessionId, cwd)
        if (backed === null) {
          await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
          return { ok: false, reason: 'workspace-backup-failed' }
        }
        backup.workspace = backed
        // Restore now (session still live): only the atomic session-file
        // rename and the resume remain inside the dispose → resume gap.
        // Exact restore: same exclude rules as the snapshot walk, so the
        // workspace becomes byte-identical to the snapshot (extra files that
        // did not exist at that snapshot are removed too — nothing more, nothing less).
        const excludes = await readExcludes(root, cwd)
        const restored = await materializeTreeExact(subprocess, wsGit, wsCommit, cwd, excludes)
        workspaceRestored = restored !== null
      } else {
        wsCommit = null
      }
    }
  }

  // 4. Detach (flush already done): agent entry, then session entry —
  //    session/disposed retires the persistence write cursor.
  //    IMPORTANT: call the methods THROUGH the service proxy (never through a
  //    pre-detached reference) — Cordis traceables rebind `this` in the apply
  //    trap, and a bare method call loses the receiver.
  if (sessions === undefined || sessions.liveEntryFor === undefined || sessions.detachEntered === undefined
    || agents === undefined || agents.detachEntered === undefined || !(agents.store instanceof Map)) {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    return { ok: false, reason: 'no-detach-primitives', ...(backup.session !== undefined ? { backup } : {}) }
  }
  const liveAgent = agents.get(sessionId)
  if (liveAgent !== undefined) {
    if (liveAgent.status === 'running' && liveAgent.cancel !== undefined) liveAgent.cancel({ kind: 'disposed' })
    if (liveAgent.whenIdle !== undefined) await boundedWait(liveAgent.whenIdle(), IDLE_WAIT_MS)
    const entry = agents.store!.get(sessionId)
    if (entry !== undefined) agents.detachEntered!(entry)
  }
  const sessionEntry = sessions.liveEntryFor!(session)
  if (sessionEntry !== undefined) sessions.detachEntered!(sessionEntry)

  // 5. Atomic replace of the official file (temp in the same dir + rename;
  //    node:fs, never subprocess stdout). main untouched, no new objects.
  //    The target bytes are kept for the composition read in step 6.
  const dir = dirname(location.path)
  const tempPath = join(dir, `session.jsonl.zstd.tmp-${Date.now()}`)
  let targetBytes: Buffer | null = null
  try {
    targetBytes = await readFile(targetFile!)
    // Empty-session repair: a target with no turn/start would render as a
    // brand-new hero window (DSH `sessionBlank`). Seed a bare empty turn pair
    // so the window stays a live session while the model sees no content.
    targetBytes = seedBlankSession(targetBytes)
    await writeFile(tempPath, targetBytes)
    await rename(tempPath, location.path)
  } catch (error) {
    await unlink(tempPath).catch(() => undefined)
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    return {
      ok: false,
      reason: 'replace-failed',
      error: error instanceof Error ? error.message : String(error),
      ...(backup.session !== undefined ? { backup } : {}),
      ...(workspaceRestored ? { workspaceRestored: true } : {}),
    }
  }

  // 6. Official loader: prepare + publish a new live session from disk.
  //    Cache contract: the resumed loop rebuilds its request prefix from the
  //    CURRENT envelope, so the resume must re-compose the agent the same way
  //    the deployment's cold resume does — mount the agent preset the target
  //    history was produced under, and declare the provider/model route that
  //    target's last request/header recorded. A bare resume (no preset mount,
  //    default route) yields a request prefix that diverges from the cached
  //    one at the first message, so the provider prefix cache can never hit
  //    after a jump. A preset that no longer mounts falls back to the bare
  //    resume and reports the regression.
  const facts: { agentPreset?: string; route?: { provider?: string; model?: string } } = {}
  if (targetBytes !== null) {
    try {
      Object.assign(facts, decodeTargetFacts(targetBytes))
    } catch {
      // Decode is advisory: a corrupt artifact resumes bare rather than failing.
    }
  }
  let reloaded = false
  let resumeError: string | undefined
  let compositionWarning: string | undefined
  if (agents?.resume !== undefined) {
    const baseOptions: { resumeSessionId: string; agentOptions?: { provider?: string; model?: string } } = {
      resumeSessionId: sessionId,
    }
    if (facts.route !== undefined
      && (facts.route.provider !== undefined || facts.route.model !== undefined)) {
      baseOptions.agentOptions = { ...facts.route }
    }
    const tries: Array<{ options: typeof baseOptions & { setup?: (agentCtx: unknown) => Promise<void> | void } }> = [
      { options: baseOptions },
    ]
    if (agentPresets?.mount !== undefined && facts.agentPreset !== undefined) {
      tries.unshift({
        options: {
          ...baseOptions,
          setup: async (agentCtx: unknown) => {
            await agentPresets.mount!(agentCtx, facts.agentPreset)
          },
        },
      })
    }
    let resumeFailure: string | undefined
    let succeededIndex = -1
    for (let index = 0; index < tries.length; index += 1) {
      const { options } = tries[index]!
      try {
        await agents.resume(options)
        succeededIndex = index
        break
      } catch (error) {
        // Keep the last failure; a composed attempt that fails falls through
        // to the bare attempt, and only a bare failure fails the rewind.
        resumeFailure = error instanceof Error ? error.message : String(error)
      }
    }
    reloaded = succeededIndex >= 0
    if (reloaded) {
      resumeError = undefined
      if (succeededIndex > 0) {
        // The composed attempt failed but the bare one succeeded: flag the
        // degraded composition so the UI/dev can act on it.
        compositionWarning = `preset "${facts.agentPreset}" could not be mounted (${resumeFailure ?? 'unknown'})`
      }
    } else {
      resumeError = resumeFailure
    }
  } else {
    resumeError = 'runtime exposes no agents.resume'
  }

  const outcome: RewindResult = {
    ok: reloaded,
    target,
    ...(backup.session !== undefined ? { backup } : {}),
    ...(noWorkspaceSnapshot ? { noWorkspaceSnapshot: true } : {}),
    ...(workspaceRestored ? { workspaceRestored: true } : {}),
    ...(compositionWarning !== undefined ? { compositionWarning } : {}),
  }
  if (!reloaded) {
    outcome.reason = 'resume-failed'
    outcome.detached = true
    outcome.error = resumeError
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    return outcome
  }

  // 7. Checkout semantics: the jump target is remembered (in-process) so the
  //    NEXT snapshot diffs against it — identical content produces nothing,
  //    changed content forks a road with parent = this target.
  setJumpTarget(sessionId, target)
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  return outcome
}
