/**
 * Node half of @deepseek-ai/dsh-history-rewind: the shadow-store engine plus a
 * loopback-gated HTTP channel the browser talks to.
 *
 *  - Snapshot: on every turn/start and turn/end (and on manual demand) the
 *    workspace is committed FIRST into its project shadow repo, the session
 *    is flushed, and the official session file is committed into the session
 *    bare repo with the anchor parent (main tip) — the git graph is the
 *    history.
 *  - Rewind: POST /dsh-history/api/rewind with a timeline commit; the same
 *    session id returns to that point by physical file replacement + hot
 *    reload (flush → detach → replace → resume) — a pure checkout: git is
 *    untouched; the next snapshot forks a road branch only when the content
 *    actually changed.
 *  - Timeline: git log --all --topo-order over the session repo; the browser
 *    renders the rail graph and lane assignment from the parent hashes.
 *
 * No new session is ever created; no event is hydrated; the process never
 * restarts; nothing but git carries state.
 * @module @deepseek-ai/dsh-history-rewind
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { ROUTE_PREFIX } from './constants.ts'
import { historyRoot, sessionRepoDir, ensureHistoryRoot } from './store.ts'
import type { SubprocessLike } from './git-runner.ts'
import { runGit, firstLine } from './git-runner.ts'
import { argvRevParseCommit } from './git-commands.ts'
import { takeSnapshot, captureSessionArtifact, type CapturedArtifact, type SessionLike, type PersistenceLike } from './snapshot.ts'
import { getJumpTarget } from './state.ts'
import {
  rewindSession, type AgentRegistryLike, type AgentPresetsLike, type SessionsServiceLike,
} from './rewind.ts'
import { timelineRows } from './timeline.ts'
import { purgeSession } from './purge.ts'
import { exportShadowRepo } from './export-repo.ts'

/** Minimal structural view of the webServer route registry. */
interface WebServerService {
  register(route: {
    kind: 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Minimal structural view of one appended session event. */
interface SessionEventLike {
  type: string
  seq: number
}

/** Whether the request came from the loopback face of this local tool. */
function isLoopbackHost(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? '').toLowerCase()
  return host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]')
}

/** Write one JSON response and end the exchange. */
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/** Read the request body as JSON, rejecting malformed payloads. */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/** One per-session single-flight gate: snapshot and rewind never interleave. */
class SessionGate {
  private chain = new Map<string, Promise<unknown>>()

  /** Run `task` for one session after every previous task for it settled. */
  run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chain.get(sessionId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.chain.set(sessionId, next.then(
      () => undefined,
      () => undefined,
    ))
    return next
  }
}

/** Host half services this plugin reads (optional member pattern). */
interface Engine {
  subprocess: SubprocessLike
  sessions: SessionsServiceLike | undefined
  persistence: PersistenceLike | undefined
  agents: AgentRegistryLike | undefined
  agentPresets?: AgentPresetsLike | undefined
  root: string
}

/**
 * Build the loopback-gated route handler.
 * @param engine - the resolved engine services.
 * @param gate - the per-session single-flight gate (shared with the snapshot listeners).
 * @returns a Node-style handler.
 */
function buildHandler(engine: Engine, gate: SessionGate): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      if (!isLoopbackHost(req)) {
        json(res, 403, { ok: false, reason: 'forbidden' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const pathname = url.pathname
      const method = req.method ?? ''

      // GET /timeline?sessionId= — the git graph data source.
      if (pathname === `${ROUTE_PREFIX}/timeline` && (method === 'GET' || method === 'POST')) {
        const sessionId = typeof url.searchParams.get('sessionId') === 'string'
          ? url.searchParams.get('sessionId')!
          : await bodySessionId(req)
        if (sessionId === null || sessionId.length === 0) {
          json(res, 400, { ok: false, reason: 'bad-args' })
          return
        }
        const repoDir = sessionRepoDir(engine.root, sessionId)
        if (!existsSync(repoDir)) {
          json(res, 200, { ok: true, rows: [] })
          return
        }
        // Workspace cwd drives the paired ws-snapshot diff for CHECK POINT rows.
        const session = engine.sessions?.get(sessionId)
        const workspaceCwd = session?.header?.cwd ?? null
        const rows = await timelineRows(engine.subprocess, repoDir, engine.root, workspaceCwd)
        if (rows === null) json(res, 200, { ok: false, reason: 'git-unavailable' })
        else json(res, 200, { ok: true, rows })
        return
      }

      // GET /status?sessionId= — minimal repo facts for the view header.
      if (pathname === `${ROUTE_PREFIX}/status`) {
        const sessionId = url.searchParams.get('sessionId')
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          json(res, 400, { ok: false, reason: 'bad-args' })
          return
        }
        const repoDir = sessionRepoDir(engine.root, sessionId)
        let mainTip: string | null = null
        let activeTip: string | null = null
        if (existsSync(repoDir)) {
          const res2 = await runGit(engine.subprocess, argvRevParseCommit({ gitDir: repoDir }, 'refs/heads/main'), engine.root)
          mainTip = res2.exitCode === 0 && firstLine(res2.stdout).length > 0 ? firstLine(res2.stdout) : null
          // Active road = latest road-<ts> tip; else main tip. A fresh jump has
          // not committed yet: its target (in-process) IS the current state.
          const jumpTarget = getJumpTarget(sessionId)
          if (jumpTarget !== undefined) {
            const jumpRes = await runGit(engine.subprocess, argvRevParseCommit({ gitDir: repoDir }, jumpTarget), engine.root)
            if (jumpRes.exitCode === 0) activeTip = firstLine(jumpRes.stdout)
          }
          if (activeTip === null) {
            const roads = await runGit(engine.subprocess, ['git', `--git-dir=${repoDir}`, 'for-each-ref', '--format=%(refname)', 'refs/heads/road-*'], engine.root)
            let best: string | null = null
            let bestTs = -1
            for (const line of roads.stdout.split('\n')) {
              const ref = line.trim()
              if (ref.length === 0) continue
              const ts = Number(ref.slice('refs/heads/road-'.length))
              if (Number.isFinite(ts) && ts > bestTs) { bestTs = ts; best = ref }
            }
            if (best !== null) {
              const active = await runGit(engine.subprocess, argvRevParseCommit({ gitDir: repoDir }, best), engine.root)
              if (active.exitCode === 0) activeTip = firstLine(active.stdout)
            } else {
              activeTip = mainTip
            }
          }
        }
        json(res, 200, { ok: true, repoExists: mainTip !== null, mainTip, activeTip })
        return
      }

      if (method !== 'POST') {
        json(res, 404, { ok: false, reason: 'not-found' })
        return
      }

      let body: unknown
      try {
        body = await readJson(req)
      } catch {
        json(res, 400, { ok: false, reason: 'bad-json' })
        return
      }
      const args = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
      if (sessionId.length === 0) {
        json(res, 400, { ok: false, reason: 'bad-args' })
        return
      }

      // POST /snapshot — manual snapshot (panel button).
      if (pathname === `${ROUTE_PREFIX}/snapshot`) {
        const session = engine.sessions?.get(sessionId)
        if (session === undefined) {
          json(res, 200, { ok: false, reason: 'no-session' })
          return
        }
        const result = await gate.run(sessionId, () => takeSnapshot(engine.subprocess, engine.root, engine.sessions, engine.persistence, {
          session,
          kind: 'manual',
        }))
        json(res, 200, result)
        return
      }

      // POST /rewind — { sessionId, commit, restoreWorkspace, workspaceOnly }.
      if (pathname === `${ROUTE_PREFIX}/rewind`) {
        const commit = typeof args.commit === 'string' ? args.commit : ''
        const restoreWorkspace = args.restoreWorkspace === true
        const workspaceOnly = args.workspaceOnly === true
        if (commit.length === 0) {
          json(res, 400, { ok: false, reason: 'bad-args' })
          return
        }
        const result = await gate.run(sessionId, () => rewindSession(
          engine.subprocess,
          engine.root,
          engine.sessions,
          engine.persistence,
          engine.agents,
          sessionId,
          commit,
          restoreWorkspace,
          engine.agentPresets,
          workspaceOnly,
        ))
        json(res, 200, result)
        return
      }

      // POST /purge — { sessionId, confirm: true } — permanent erasure of
      // abandoned shadow roads + backup rotation. Irreversible by design.
      if (pathname === `${ROUTE_PREFIX}/purge`) {
        if (args.confirm !== true) {
          json(res, 400, { ok: false, reason: 'confirm-required' })
          return
        }
        const session = engine.sessions?.get(sessionId)
        const cwd = session?.header?.cwd
        const result = await gate.run(sessionId, () => purgeSession(engine.subprocess, engine.root, sessionId, cwd))
        json(res, 200, result)
        return
      }

      // POST /export — { sessionId, target } — debug clone of the session
      // shadow repo into a user-chosen empty directory (work-tree repo with
      // local branch materialization, for VS Code / Git Graph).
      if (pathname === `${ROUTE_PREFIX}/export`) {
        const target = typeof args.target === 'string' ? args.target : ''
        const result = await gate.run(sessionId, () => exportShadowRepo(engine.subprocess, engine.root, sessionId, target))
        json(res, 200, result)
        return
      }

      json(res, 404, { ok: false, reason: 'not-found' })
    } catch (error) {
      json(res, 500, {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
      })
    }
  }
}

/** Read a sessionId from a POST body (timeline is GET-first, POST tolerant). */
async function bodySessionId(req: IncomingMessage): Promise<string | null> {
  try {
    const body = await readJson(req)
    const args = (body !== null && typeof body === 'object' ? body : {}) as Record<string, unknown>
    return typeof args.sessionId === 'string' ? args.sessionId : null
  } catch {
    return null
  }
}

/**
 * Register the snapshot listeners + routes.
 * @param ctx - Host context whose subprocess, sessions, sessionPersistence,
 *   agents and webServer services are consumed.
 */
export function apply(ctx: Context): void {
  const subprocess = ctx.get('subprocess') as SubprocessLike | undefined
  if (subprocess === undefined) return
  const sessions = ctx.get('sessions') as SessionsServiceLike | undefined
  if (sessions === undefined) return
  const persistence = ctx.get('sessionPersistence') as PersistenceLike | undefined
  if (persistence === undefined) return
  const agents = ctx.get('agents') as AgentRegistryLike | undefined
  const agentPresets = ctx.get('agentPresets') as AgentPresetsLike | undefined
  const root = historyRoot()
  // The root doubles as git cwd for repo-only commands: it must exist before
  // the first git call, or Node fails the spawn with ENOENT.
  mkdirSync(root, { recursive: true })
  void ensureHistoryRoot(root)

  const engine: Engine = { subprocess, sessions, persistence, agents, agentPresets, root }
  const gate = new SessionGate()

  // Snapshot on every turn boundary. The snapshot runs behind the firehose:
  // failures are contained and must never break the session's own append
  // path. Per-session serialization keeps start/end ordering deterministic.
  //
  // CRITICAL: the artifact is captured (flush + hash) at EVENT time, BEFORE
  // the per-session gate. The gate may be busy with a minute-long workspace
  // walk from the previous boundary; hashing after that would capture the
  // NEXT turn's content into THIS boundary's commit, and the next snapshot
  // would then dedup to nothing (the "missing snapshot" regression).
  // Capture chain: event-time captures for ONE session must run strictly in
  // event order. They are cheaper than the gate (flush + one hash-object)
  // but still interleavable; an unordered concurrent hash could read a
  // later turn's content into an earlier boundary's capture.
  const captureChains = new Map<string, Promise<unknown>>()
  const captureOrdered = (session: SessionLike, kind: 'turn-start' | 'turn-end'): Promise<CapturedArtifact | null> => {
    const previous = captureChains.get(session.id) ?? Promise.resolve()
    const next = previous.then(
      () => captureSessionArtifact(subprocess, root, sessions, persistence, session, kind),
      () => captureSessionArtifact(subprocess, root, sessions, persistence, session, kind),
    )
    captureChains.set(session.id, next.then(
      () => undefined,
      () => undefined,
    ))
    return next
  }

  const onSession = ctx.on as (
    event: 'session/event',
    listener: (session: SessionLike, event: SessionEventLike) => void,
  ) => void
  onSession('session/event', (session: SessionLike, event: SessionEventLike) => {
    if (event.type !== 'turn/start' && event.type !== 'turn/end') return
    const kind = event.type === 'turn/start' ? 'turn-start' : 'turn-end'
    const captured = captureOrdered(session, kind)
    void gate.run(session.id, () =>
      takeSnapshot(subprocess, root, sessions, persistence, { session, kind, seq: event.seq, captured })
        .then((result) => {
          if (!result.ok) console.warn(`[dsh-history] snapshot ${event.type} seq ${event.seq} of ${session.id} failed: ${result.reason ?? 'unknown'}`)
        })
        .catch((error) => {
          console.warn(`[dsh-history] snapshot ${event.type} seq ${event.seq} of ${session.id} threw:`, error)
        }),
    )
  })

  const webServer = ctx.get('webServer') as WebServerService | undefined
  if (webServer === undefined) return
  ctx.effect(
    () => webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: buildHandler(engine, gate) }),
    'dsh-history-rewind: snapshot + rewind + timeline routes',
  )

  // /history command: opens the history panel in the browser. The handler
  // only bumps the per-session open signal; the client polls /open-signal
  // (cheap GET) and opens the panel when the counter changes.
  const commands = ctx.get('commands') as {
    register(def: {
      name: string
      description: string
      handler(invocation: { agent?: unknown; rawInput?: string }): unknown
    }): () => void
  } | undefined
  if (commands !== undefined) {
    ctx.effect(() => commands.register({
      name: 'history',
      description: 'open the session history (git graph / rewind) panel',
      handler: () => {
        // The panel is opened by the client-side commandview row: the
        // command's `command/run` event travels the session projection stream
        // to the browser, where the /history row mounts and opens the panel.
        return { kind: 'success', text: 'History panel opened.' }
      },
    }), 'dsh-history-rewind: /history command')
  }
}
