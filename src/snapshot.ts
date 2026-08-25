/**
 * Session-side snapshotting (checkout model, user-confirmed): capture the
 * session artifact at EVENT time, then workspace commit, then the session
 * commit that references the pre-captured blob.
 *
 * Capture-first ordering matters: the workspace snapshot of a large
 * workspace takes long enough that a later turn's events land in the
 * session file DURING it. Capturing (flush + read + hash-object) at event
 * time pins each turn's boundary content exactly; the subsequent slow
 * workspace walk can no longer pull later turns into the commit.
 *
 * Base resolution (git as the single source of truth):
 *   1. an in-process jump target (set by rewind) => the diff base is that
 *      commit; NOTE: turning it into a commit ONLY happens when the content
 *      actually changed (identical content produces nothing at all);
 *   2. else the LATEST road (refs/heads/road-<ts>) tip => normal continuation
 *      on that post-jump branch;
 *   3. else main tip => the never-jumped original road.
 *
 * Session commit:
 *   - identical to the base blob => NO commit, NO ref move (dedup skip);
 *   - different => commit with parent = base:
 *       base is a jump target (no road yet) => create refs/heads/road-<ts>
 *         and pin the commit there (main stays untouched);
 *       base is a road/main tip        => advance that ref (linear commits).
 */

import type { SubprocessLike } from './git-runner.ts'
import { runGit, firstLine } from './git-runner.ts'
import {
  argvHashObjectFile, argvMktree, argvCommitTree, argvUpdateRef,
  argvLogSubjects, commitEnv,
  type ShadowRepo,
} from './git-commands.ts'
import {
  buildSessionMessage, buildWorkspaceMessage, parseMessage, type SnapMeta,
} from './messages.ts'
import { ensureBareRepo, ensureHistoryRoot, sessionRepoDir } from './store.ts'
import { snapshotWorkspace, materializeTree, type WorkspaceSnapshotResult } from './workspace.ts'
import { getJumpTarget, clearJumpTarget, ROAD_REF_PREFIX, roadTimestamp } from './state.ts'
import { decodeSessionEventsFromBytes, semanticallyEqual, extractMessagePreviews, preTurnPrefixLength, appendEmptyTurn } from './zstd-util.ts'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Minimal structural view of one live session. */
export interface SessionLike {
  id: string
  header?: { cwd?: string; [key: string]: unknown }
}

/** Minimal structural view of the session persistence service. */
export interface PersistenceLike {
  locate(meta: { id: string; cwd?: string; [key: string]: unknown }): { kind: string; path: string } | undefined
}

/** One turn-boundary snapshot request. */
export interface SnapshotRequest {
  session: SessionLike
  kind: 'turn-start' | 'turn-end' | 'manual'
  /** Event seq (turn snapshots only). */
  seq?: number
  /**
   * Event-time capture promise (listener supplies it). When absent the
   * snapshot captures at the start of the task — acceptable for manual
   * snapshots, WRONG for turn boundaries where the gate may be busy with a
   * slow workspace walk and the file has already advanced.
   */
  captured?: Promise<CapturedArtifact | null> | null
}

/** The session artifact captured at EVENT time (flush + hash done early). */
export interface CapturedArtifact {
  /** Blob SHA written by `hash-object -w` (git read the file itself). */
  blobSha: string
  /** Official artifact path (fallback re-read for the semantic compare). */
  path: string
  /** Event-time bytes, present when a jump target was set (semantic compare). */
  bytes?: Buffer
  /** Newest genuine user message text (for the USER commit preview). */
  userPreview?: string
  /** Newest assistant message text (for the ASST commit preview). */
  asstPreview?: string
}

/**
 * Capture the official session artifact at event time: durability flush,
 * then hash-object (git reads the file itself, zero bytes through us).
 * The bytes are also kept when a jump target is set, for the later
 * byte-different-but-semantically-equal compare.
 * @returns null when the artifact is missing or git is unusable.
 */
export async function captureSessionArtifact(
  subprocess: SubprocessLike,
  root: string,
  sessions: { flush?(session: SessionLike): Promise<boolean> } | undefined,
  persistence: PersistenceLike | undefined,
  session: SessionLike,
  kind: 'turn-start' | 'turn-end' | 'manual' = 'turn-end',
): Promise<CapturedArtifact | null> {
  const location = persistence?.locate({ ...session.header, id: session.id })
  if (location === undefined || location.path.length === 0) return null
  await ensureHistoryRoot(root)
  const sessionRepo: ShadowRepo = { gitDir: sessionRepoDir(root, session.id) }
  if (!(await ensureBareRepo(subprocess, sessionRepo.gitDir))) return null
  if (sessions?.flush !== undefined) {
    try {
      await sessions.flush(session)
    } catch {
      // Best-effort: an idle session may reject the flush call.
    }
  }

  // Read the artifact once. Previews (commit subject) come from the FULL bytes
  // (the user text lives in the frame we may trim away). A turn-start (USER)
  // snapshot pins the "message NOT yet sent" state: truncate at the start of
  // the frame that opens this turn, so a rewind lands on the empty input box
  // rather than the just-sent message.
  const { readFile, writeFile, unlink } = await import('node:fs/promises')
  let full: Buffer | undefined
  try {
    full = await readFile(location.path)
  } catch {
    full = undefined
  }
  let userPreview: string | undefined
  let asstPreview: string | undefined
  if (full !== undefined) {
    try {
      const previews = extractMessagePreviews(full)
      userPreview = previews.user
      asstPreview = previews.assistant
    } catch {
      // Best-effort previews.
    }
  }

  // Choose the bytes to hash: full file, except a turn-start pins the pre-send
  // prefix (falls back to the full file if the artifact can't be scanned).
  let hashPath = location.path
  let tempPath: string | undefined
  let contentBytes = full
  if (kind === 'turn-start' && full !== undefined) {
    try {
      const cut = preTurnPrefixLength(full)
      // Every BASELINE (turn-start) snapshot appends one bare EMPTY turn pair
      // (turn/start → turn/end, no messages): the snapshot itself always
      // carries a turn/start, so DSH's sessionBlank check passes for ANY
      // backup point — rewinding onto it yields a live empty session, never
      // the brand-new hero page. No "is this the first message" special case.
      const prefix = appendEmptyTurn(full.subarray(0, cut))
      if (prefix.length !== full.length) {
        tempPath = join(root, `capture-${session.id.replace(/[^\w.-]/g, '_')}-${Date.now()}.tmp`)
        await writeFile(tempPath, prefix)
        hashPath = tempPath
        contentBytes = prefix
      }
    } catch {
      // Scan/write failure: hash the full file unchanged.
    }
  }

  let blobSha: string
  try {
    const hashed = await runGit(subprocess, argvHashObjectFile(sessionRepo, hashPath), root, commitEnv())
    if (hashed.exitCode !== 0) return null
    blobSha = firstLine(hashed.stdout)
  } finally {
    if (tempPath !== undefined) await unlink(tempPath).catch(() => undefined)
  }
  if (blobSha.length === 0) return null

  // Keep the hashed bytes only when a jump target is set (semantic compare).
  const bytes = getJumpTarget(session.id) !== undefined ? contentBytes : undefined
  return {
    blobSha,
    path: location.path,
    ...(bytes !== undefined ? { bytes } : {}),
    ...(userPreview !== undefined ? { userPreview } : {}),
    ...(asstPreview !== undefined ? { asstPreview } : {}),
  }
}

/** Outcome of taking one snapshot. */
export interface SnapshotResult {
  ok: boolean
  reason?: string
  /** Session commit pinned on the active ref (absent when unchanged). */
  commit?: string
  /** Base (parent) commit the snapshot was chained onto. */
  base?: string
  /** True when the content matched the base blob: nothing was produced. */
  unchanged?: boolean
  /** The ref the commit was pinned under (main or road-<ts>). */
  ref?: string
  /** True when a new road branch was created for this commit. */
  fork?: boolean
  /** Workspace commit of the same pairing (absent when the workspace failed). */
  wsCommit?: string
  /** The pairing key (snap=). */
  snap?: string
  /** TURN number the snapshot was attributed to. */
  turn?: number
}

/**
 * Derive the TURN counter from the base road's history: scan newest-first for
 * the first turn-bearing line (manual lines keep the last turn).
 * @param subjects - commit subjects of the base road, newest first.
 * @param kind - 'start' (next turn) or 'end' (the turn being ended).
 * @returns the turn number to attribute.
 */
export function deriveTurn(subjects: readonly string[], kind: 'start' | 'end'): number {
  let turn = 0
  let phase: 'start' | 'end' = 'end'
  for (const subject of subjects) {
    const meta = parseMessage(subject)
    if (meta === null || meta.kind === 'manual' || meta.kind === 'rewind') continue
    if (meta.turn !== undefined) {
      turn = meta.turn
      phase = meta.phase ?? 'end'
      break
    }
  }
  if (kind === 'start') return turn + 1
  return phase === 'start' ? turn : turn + 1
}

/** One snapshot cycle (capture, workspace, session commit). */
export async function takeSnapshot(
  subprocess: SubprocessLike,
  root: string,
  sessions: { flush?(session: SessionLike): Promise<boolean> } | undefined,
  persistence: PersistenceLike | undefined,
  request: SnapshotRequest,
): Promise<SnapshotResult> {
  const session = request.session
  const sessionId = session.id
  const cwd = session.header?.cwd

  const sessionRepo: ShadowRepo = { gitDir: sessionRepoDir(root, sessionId) }
  const env = commitEnv()

  // 1. Capture the session artifact: flush + hash at EVENT time (listener
  //    path) or at task start (manual path). This is the boundary pin —
  //    everything after may take a minute on a big workspace, and the file
  //    must NOT be hashed again after that.
  const captured = await (request.captured ?? captureSessionArtifact(subprocess, root, sessions, persistence, session, request.kind))
  if (captured === null) return { ok: false, reason: 'no-artifact' }
  const blobSha = captured.blobSha

  // 2. Resolve the base in ONE spawn: main tip + every road tip (for-each-ref
  //    with both patterns). Replaces for-each-ref + rev-parse road + rev-parse
  //    main (3 spawns) — the fixed ~27ms/git-spawn floor makes this matter.
  const refsRes = await runGit(subprocess, ['git', `--git-dir=${sessionRepo.gitDir}`, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/main', `${ROAD_REF_PREFIX}*`], root, env)
  let mainTip: string | undefined
  let road: string | null = null
  let roadTip: string | undefined
  let bestRoadTs = -1
  if (refsRes.exitCode === 0) {
    for (const line of refsRes.stdout.split('\n')) {
      const parts = line.trim().split(' ')
      if (parts.length < 2) continue
      const [refname, sha] = parts
      if (sha === undefined) continue
      if (refname === 'refs/heads/main') {
        mainTip = sha
      } else if (refname.startsWith(ROAD_REF_PREFIX)) {
        const ts = roadTimestamp(refname)
        if (ts > bestRoadTs) { bestRoadTs = ts; road = refname; roadTip = sha }
      }
    }
  }

  let base: string | undefined
  let activeRef: string | null = null
  let fromJump = false
  const jumpTarget = getJumpTarget(sessionId)
  if (jumpTarget !== undefined) {
    base = jumpTarget
    fromJump = true
  } else if (road !== null && roadTip !== undefined) {
    base = roadTip
    activeRef = road
  } else {
    base = mainTip
    activeRef = 'refs/heads/main'
  }

  // 2. TURN derivation from the BASE road's history (after a jump to C2 the
  //    next turn continues from C2's number, not from the original road's tip).
  const subjects: string[] = []
  if (base !== undefined) {
    const log = await runGit(subprocess, argvLogSubjects(sessionRepo, base), root, env)
    if (log.exitCode === 0) {
      for (const line of log.stdout.split('\n')) {
        const text = line.trim()
        if (text.length > 0) subjects.push(text)
      }
    }
  }

  const kind = request.kind
  const seq = request.seq
  const derived = deriveTurn(subjects, kind === 'turn-start' ? 'start' : 'end')
  const snap = kind === 'manual' ? `manual-${Date.now()}` : `turn-${derived}-${kind === 'turn-start' ? 'start' : 'end'}-${seq ?? 0}`
  // turn-start is a CHECK POINT (pre-send state, no conversation preview).
  // turn-end carries BOTH this turn's user message and the assistant reply.
  const meta: SnapMeta = {
    kind,
    ...(kind === 'turn-start' || kind === 'turn-end'
      ? { turn: derived, phase: kind === 'turn-start' ? 'start' as const : 'end' as const, seq }
      : {}),
    session: sessionId,
    snap,
    ...(kind === 'turn-end' && captured.userPreview !== undefined && captured.userPreview.length > 0
      ? { userMessage: captured.userPreview }
      : {}),
    ...(kind === 'turn-end' && captured.asstPreview !== undefined && captured.asstPreview.length > 0
      ? { asstMessage: captured.asstPreview, message: captured.asstPreview }
      : {}),
  }

  // 3. Parallel phase — everything needed for the commit is independent:
  //    (a) workspace snapshot into its own repo (the slow part: walk +
  //        hash + tree build, each git spawn on the ~27ms floor);
  //    (b) the base blob lookup for the dedup compare;
  //    (c) the session tree build (mktree of the fixed two-level path).
  //    The ws commit must EXIST before the session commit carries ws=
  //    (one-way reference), so the session commit-tree waits below, but
  //    the ws walk itself no longer serializes against (b)+(c).
  const dirName = `session-${sessionId}`
  const dirTreePromise = runGit(
    subprocess,
    argvMktree(sessionRepo, true),
    root,
    env,
    `100644 blob ${blobSha}\tsession.jsonl.zstd\x00`,
  )
  const rootTreePromise = dirTreePromise.then(async (dirTree) => {
    if (dirTree.exitCode !== 0) return null
    const dirTreeSha = firstLine(dirTree.stdout)
    if (dirTreeSha.length === 0) return null
    const rootTree = await runGit(
      subprocess,
      argvMktree(sessionRepo, true),
      root,
      env,
      `040000 tree ${dirTreeSha}\t${dirName}\x00`,
    )
    if (rootTree.exitCode !== 0) return null
    const rootTreeSha = firstLine(rootTree.stdout)
    if (rootTreeSha.length === 0) return null
    return rootTreeSha
  })
  const baseBlobPromise = base !== undefined
    ? runGit(subprocess, ['git', `--git-dir=${sessionRepo.gitDir}`, 'rev-parse', '--verify', '--quiet', `${base}:session-${sessionId}/session.jsonl.zstd`], root, env)
    : Promise.resolve(null)
  const wsPromise = cwd !== undefined && cwd.length > 0
    ? snapshotWorkspace(subprocess, root, sessionId, cwd, buildWorkspaceMessage(meta))
    : Promise.resolve({ ok: true } as WorkspaceSnapshotResult)

  const [ws, baseBlob, rootTreeSha] = await Promise.all([wsPromise, baseBlobPromise, rootTreePromise])
  if (rootTreeSha === null) return { ok: false, reason: 'mktree-failed' }
  const wsCommit: string | undefined = ws.ok && ws.commit !== undefined ? ws.commit : undefined
  // Workspace failure never blocks the session snapshot: an orphan snap
  // renders in the timeline and the next snapshot re-pairs.

  // CHECK POINT (turn-start, pre-send) gating:
  //   Only create a node when the workspace actually CHANGED since the last
  //   workspace snapshot (ws.reused !== true). The session shadow repo is
  //   1:1 per session id, so a brand-new session always has an empty repo —
  //   using that as the "first binding" signal would wrongly create a
  //   checkpoint for every conversation even with zero code edits. The
  //   workspace repo is shared per project and is the true "did the user
  //   touch the code" signal; the repo itself is created by
  //   captureSessionArtifact (ensureBareRepo) regardless. An unchanged
  //   workspace means the user did not modify anything between turns — the
  //   pre-send checkpoint is noise, so skip it. turn-end is unaffected.
  // `ws.reused` is the workspace "no change" signal: snapshotWorkspace reuses
  // the parent commit when the walked tree is byte-identical.
  if (kind === 'turn-start' && ws.ok === true && ws.reused === true) {
    return { ok: true, unchanged: true, base, snap, turn: derived }
  }

  // 4. Session commit: compare the CAPTURED blob against the base blob —
  //    identical content produces NOTHING. The file is NOT re-read here:
  //    later turns may already be in it (the workspace walk above took
  //    long), and the boundary pin must stay the event-time content.
  if (baseBlob !== null && baseBlob.exitCode === 0) {
    // A USER (turn-start) node pins the PRE-SEND state. In a continuous
    // conversation that prefix is byte-identical to the previous turn's ASST
    // blob (nothing is written between turn-N end and turn-(N+1) start except
    // the turn/start frame we trim off). It is still a distinct timeline
    // anchor — "before you sent turn N+1" — so it must NOT be deduped away by
    // byte-equality on the linear path. (The fromJump semantic compare below
    // still runs, so a rewind never spawns a spurious duplicate node.)
    if (firstLine(baseBlob.stdout) === blobSha && !(kind === 'turn-start' && !fromJump)) {
      // 内容与 base 相同（字节级）：什么都不产生。
      // 例外：普通续聊的 USER(turn-start) 节点即使与上一条 ASST 字节相同，
      // 也是一个独立的时间线锚点（"发送本回合消息之前"），必须提交；
      // 但跳转后（fromJump）落在目标上的字节相同仍应去重，避免多余重复节点。
      return { ok: true, unchanged: true, base, snap, turn: derived }
    }
    // 字节不同但可能是「跳转后仅追加了 resume 记账事件」：解码做语义比较。
    // 仅对跳转场景启用（普通续聊没有记账尾，字节不同即真变化）。
    if (fromJump && base !== undefined) {
      const scratchCmp = join(root, 'backups', `scratchcmp-${sessionId}-${Date.now()}`)
      try {
        await mkdir(scratchCmp, { recursive: true })
        const count = await materializeTree(subprocess, sessionRepo.gitDir, base, scratchCmp)
        if (count !== null && count > 0) {
          const basePath = join(scratchCmp, `session-${sessionId}`, 'session.jsonl.zstd')
          const { readFile } = await import('node:fs/promises')
          const baseBytes = await readFile(basePath)
          const currentBytes = captured.bytes ?? await readFile(captured.path)
          const currentEvents = decodeSessionEventsFromBytes(currentBytes)
          const baseEvents = decodeSessionEventsFromBytes(baseBytes)
          if (semanticallyEqual(currentEvents, baseEvents)) {
            // 只有记账事件追加：内容没变，什么都不产生（跳转目标保留，
            // 之后的真实变化仍会从它 fork）。
            await rm(scratchCmp, { recursive: true, force: true }).catch(() => undefined)
            return { ok: true, unchanged: true, base, snap, turn: derived }
          }
        }
      } catch {
        // 解码失败（格式漂移等）：保守视为变化，走提交路径。
      } finally {
        await rm(scratchCmp, { recursive: true, force: true }).catch(() => undefined)
      }
    }
  }

  const message = buildSessionMessage({ ...meta, base, ws: wsCommit })
  const committed = await runGit(subprocess, argvCommitTree(sessionRepo, rootTreeSha, message, base), root, env)
  if (committed.exitCode !== 0) return { ok: false, reason: 'commit-failed' }
  const commit = firstLine(committed.stdout)
  if (commit.length === 0) return { ok: false, reason: 'commit-empty' }

  // 6. Pin: jump-target base => NEW road (main stays untouched, per spec);
  //    road/main base => advance that ref.
  let targetRef: string
  let fork = false
  if (fromJump) {
    targetRef = `${ROAD_REF_PREFIX}${Date.now()}`
    fork = true
    clearJumpTarget(sessionId)
  } else if (activeRef !== null) {
    targetRef = activeRef
  } else {
    targetRef = 'refs/heads/main'
  }
  const updated = await runGit(subprocess, argvUpdateRef(sessionRepo, targetRef, commit), root, env)
  if (updated.exitCode !== 0) return { ok: false, reason: 'update-ref-failed' }

  return { ok: true, commit, base, ref: targetRef, fork, wsCommit, snap, turn: derived }
}
