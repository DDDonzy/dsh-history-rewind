/**
 * Integration: Context Curation publishes an independent derived Session.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { fakeSubprocess } from './fake-subprocess.ts'
import { takeSnapshot, type PersistenceLike, type SessionLike } from '../src/snapshot.ts'
import {
  curateSessionEvents,
  refineSession,
  type CuratableSessionEvent,
  type SessionControllerLike,
} from '../src/refine.ts'
import { runGit } from '../src/git-runner.ts'
import { parseMessage } from '../src/messages.ts'
import { sessionRepoDir } from '../src/store.ts'

function sourceEvents(): CuratableSessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Q1' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'step/start', seq: 2, time: 3, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 3, time: 4, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'A1' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, sourceEventSeqs: [1], surfaceOp: 'append' },
    { type: 'step/end', seq: 4, time: 5, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, time: 6, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
    { type: 'user/message', seq: 7, time: 8, data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'Q2' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'step/start', seq: 8, time: 9, data: { turn: 2, step: 1 } },
    { type: 'assistant/message', seq: 9, time: 10, data: { turn: 2, step: 1, message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: 'A2' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, sourceEventSeqs: [7], surfaceOp: 'append' },
    { type: 'step/end', seq: 10, time: 11, data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: 11, time: 12, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
}

function encodeArtifact(sessionId: string, events: readonly CuratableSessionEvent[], cwd?: string): Buffer {
  const header = {
    type: 'session', version: 0, id: sessionId, createdAt: 1000, delegationDepth: 0,
    ...(cwd === undefined ? {} : { cwd }),
  }
  return Buffer.concat([header, ...events].map((value) =>
    zstdCompressSync(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'))))
}

async function refsOf(subprocess: ReturnType<typeof fakeSubprocess>, repoDir: string, cwd: string): Promise<string> {
  const result = await runGit(subprocess, [
    'git', `--git-dir=${repoDir}`, 'for-each-ref', '--sort=refname', '--format=%(refname)|%(objectname)', 'refs/heads',
  ], cwd)
  return result.stdout.trim()
}

test('curateSessionEvents removes whole turns and translates native event references', () => {
  const events = sourceEvents()
  events.push({ type: 'session/end-seed', seq: 12, time: 13, data: {} })
  events.push({
    type: 'session/title', seq: 13, time: 14,
    data: { title: 'from Q2', messageSeqs: [7], source: { kind: 'fallback' } },
  })
  events.push({
    type: 'session/title', seq: 14, time: 15,
    data: { title: 'explicit name', messageSeqs: [], source: { kind: 'user' } },
  })
  const curated = curateSessionEvents(events, new Set([2]))
  assert.deepEqual(curated.maskedTurns, [2])
  assert.deepEqual(curated.remainingTurns, [1])
  curated.events.forEach((event, index) => assert.equal(event.seq, index))
  assert.ok(!curated.events.some((event) => event.type === 'user/message'
    && JSON.stringify(event.data).includes('Q2')))
  assert.ok(!curated.events.some((event) => event.type === 'session/end-seed'), 'derived constructor owns the new seed marker')
  assert.ok(!curated.events.some((event) => event.type === 'session/title'
    && event.data.title === 'from Q2'))
  assert.ok(curated.events.some((event) => event.type === 'session/title'
    && event.data.title === 'explicit name'))
  const assistant = curated.events.find((event) => event.type === 'assistant/message')
  assert.deepEqual(assistant?.sourceEventSeqs, [1])
})

test('curateSessionEvents reconstructs the exact final inbox instead of resurrecting sent messages', () => {
  const sent = { id: 'sent', role: 'user', content: [{ type: 'text', text: 'already sent' }], source: { kind: 'user' } }
  const draft = { id: 'draft', role: 'user', content: [{ type: 'text', text: 'still pending' }], source: { kind: 'user' } }
  const events: CuratableSessionEvent[] = [
    { type: 'agent/inbox/spliced', seq: 0, time: 1, data: { target: 'next-turn', start: 0, inserted: [sent] } },
    { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
    { type: 'agent/inbox/spliced', seq: 2, time: 3, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'agent/inbox/spliced', seq: 4, time: 5, data: { target: 'next-turn', start: 0, inserted: [draft] } },
  ]
  const curated = curateSessionEvents(events, new Set([1]))
  const splices = curated.events.filter((event) => event.type === 'agent/inbox/spliced')
  assert.equal(splices.length, 1)
  assert.deepEqual(splices[0]!.data.inserted, [draft])
  assert.ok(!JSON.stringify(curated.events).includes('already sent'))
})

test('curateSessionEvents leaves an all-masked derived Session genuinely blank', () => {
  const curated = curateSessionEvents(sourceEvents(), new Set([1, 2]))
  assert.deepEqual(curated.remainingTurns, [])
  assert.equal(curated.baselineTurn, 0)
  assert.ok(!curated.events.some((event) => event.type === 'turn/start' || event.type === 'turn/end'))
})

test('curateSessionEvents renumbers retained source TURN ids into a contiguous derived Session', () => {
  const events = sourceEvents()
  const base = events.length
  events.push(
    { type: 'turn/start', seq: base, time: 20, data: { turn: 3 } },
    { type: 'user/message', seq: base + 1, time: 21, data: { id: 'u3', role: 'user', content: [{ type: 'text', text: 'Q3' }], source: { kind: 'user' } }, surfaceOp: 'append' },
    { type: 'step/start', seq: base + 2, time: 22, data: { turn: 3, step: 1 } },
    { type: 'assistant/message', seq: base + 3, time: 23, data: { turn: 3, step: 1, message: { id: 'a3', role: 'assistant', content: [{ type: 'text', text: 'A3' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, sourceEventSeqs: [base + 1], surfaceOp: 'append' },
    { type: 'step/end', seq: base + 4, time: 24, data: { turn: 3, step: 1 } },
    { type: 'turn/end', seq: base + 5, time: 25, data: { turn: 3, reason: { kind: 'completed' } } },
  )
  const curated = curateSessionEvents(events, new Set([2]))
  assert.deepEqual(curated.remainingTurns, [1, 3], 'wire metadata preserves source TURN ids')
  assert.equal(curated.baselineTurn, 2)
  assert.deepEqual(
    curated.events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn),
    [1, 2],
    'new Session relation uses contiguous local TURN ids',
  )
  const thirdAssistant = curated.events.find((event) => event.type === 'assistant/message'
    && JSON.stringify(event.data).includes('A3'))
  assert.equal(thirdAssistant?.data.turn, 2)
  assert.deepEqual(thirdAssistant?.sourceEventSeqs, [7])
})

test('refineSession creates a new Session and leaves source artifact, refs, and workspace untouched', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-curate-derived-'))
  const historyRoot = join(root, 'history')
  const sessionsRoot = join(root, 'sessions')
  const workspace = join(root, 'workspace')
  const sourceId = 'source-session'
  const derivedId = 'derived-session'
  const sourcePath = join(sessionsRoot, sourceId, 'session.jsonl.zstd')
  const derivedPath = join(sessionsRoot, derivedId, 'session.jsonl.zstd')
  await mkdir(join(sessionsRoot, sourceId), { recursive: true })
  await mkdir(join(sessionsRoot, derivedId), { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'owned.txt'), 'workspace remains in place\n')

  const originalEvents = sourceEvents()
  originalEvents.push({
    type: 'session/title', seq: originalEvents.length, time: 13,
    data: { title: 'Original Session', messageSeqs: [], source: { kind: 'user' } },
  })
  const originalBytes = encodeArtifact(sourceId, originalEvents, workspace)
  await writeFile(sourcePath, originalBytes)
  const source: SessionLike = { id: sourceId, header: { id: sourceId, cwd: workspace } }
  const derived: SessionLike = { id: derivedId, header: { id: derivedId, cwd: workspace } }
  const live = new Map<string, SessionLike>([[sourceId, source]])
  const paths = new Map<string, string>([[sourceId, sourcePath], [derivedId, derivedPath]])
  const persistence: PersistenceLike = {
    locate: (meta) => {
      const path = paths.get(meta.id)
      return path === undefined ? undefined : { kind: 'jsonl', path }
    },
  }
  const flushed: string[] = []
  const sessions = {
    get: (id: string) => live.get(id),
    flush: async (sessionToFlush: SessionLike) => { flushed.push(sessionToFlush.id); return true },
  }

  const sourceSnap = await takeSnapshot(subprocess, historyRoot, sessions, persistence, {
    session: source, kind: 'turn-end', seq: 11,
  })
  assert.equal(sourceSnap.ok, true)
  flushed.length = 0
  const sourceRepo = sessionRepoDir(historyRoot, sourceId)
  const sourceRefsBefore = await refsOf(subprocess, sourceRepo, root)
  const sourceBytesBefore = await readFile(sourcePath)
  const workspaceBefore = await readFile(join(workspace, 'owned.txt'), 'utf8')
  const workspaceEntriesBefore = await readdir(workspace)

  let publishedSeed: readonly CuratableSessionEvent[] | undefined
  let compositionSource: string | undefined
  let renamed: { sessionId: string; title: string } | undefined
  const controller: SessionControllerLike = {
    inspect: async (id) => {
      assert.equal(id, sourceId)
      return { meta: { id: sourceId, cwd: workspace }, events: structuredClone(originalEvents) }
    },
    createDerivedSession: async (request) => {
      publishedSeed = request.seed
      compositionSource = request.compositionSourceSessionId
      await writeFile(derivedPath, encodeArtifact(derivedId, request.seed, workspace))
      live.set(derivedId, derived)
      return { sessionId: derivedId, workspaceId: 'workspace-1', workspaceAttached: true }
    },
    rename: async (request) => {
      renamed = request
      return { title: request.title, seq: 0 }
    },
  }

  const result = await refineSession(
    subprocess, historyRoot, sessions, persistence,
    { get: () => ({ status: 'idle' }) }, controller, sourceId, [2],
  )
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.newSessionId, derivedId)
  assert.equal(result.workspaceAttached, true)
  assert.equal(result.workspaceId, 'workspace-1')
  assert.deepEqual(result.maskedTurns, [2])
  assert.equal(compositionSource, sourceId)
  assert.deepEqual(renamed, { sessionId: derivedId, title: 'CTX-Original Session' })
  assert.ok(publishedSeed !== undefined)
  publishedSeed!.forEach((event, index) => assert.equal(event.seq, index))
  assert.ok(JSON.stringify(publishedSeed).includes('Q1'))
  assert.ok(!JSON.stringify(publishedSeed).includes('Q2'))
  assert.deepEqual(flushed, [derivedId], 'curation never flushes or mutates the source Session')

  assert.deepEqual(await readFile(sourcePath), sourceBytesBefore)
  assert.equal(await refsOf(subprocess, sourceRepo, root), sourceRefsBefore)
  assert.equal(await readFile(join(workspace, 'owned.txt'), 'utf8'), workspaceBefore)
  assert.deepEqual(await readdir(workspace), workspaceEntriesBefore, 'curation bootstrap does not add or remove workspace files')

  const derivedRepo = sessionRepoDir(historyRoot, derivedId)
  const show = await runGit(subprocess, [
    'git', `--git-dir=${derivedRepo}`, 'show', '-s', '--format=%H|%P|%s', 'refs/heads/main',
  ], root)
  assert.equal(show.exitCode, 0)
  const [curationSha, parent, subject] = show.stdout.trim().split('|')
  assert.equal(parent, '')
  const meta = parseMessage(subject!)
  assert.equal(meta?.kind, 'refine')
  assert.equal(meta?.turn, 1)
  assert.deepEqual(meta?.maskedTurns, [2])
  assert.equal(meta?.ws, undefined, 'bootstrap snapshot is session-only and read-only to the workspace')
  assert.equal(result.curationCommit, curationSha)

  const nextSeq = publishedSeed!.length
  const next = [
    ...publishedSeed!,
    { type: 'turn/start', seq: nextSeq, time: 20, data: { turn: 2 } },
    { type: 'user/message', seq: nextSeq + 1, time: 21, data: { id: 'u-new', role: 'user', content: [{ type: 'text', text: 'Q-new' }], source: { kind: 'user' } }, surfaceOp: 'append' as const },
    { type: 'step/start', seq: nextSeq + 2, time: 22, data: { turn: 2, step: 1 } },
    { type: 'assistant/message', seq: nextSeq + 3, time: 23, data: { turn: 2, step: 1, message: { id: 'a-new', role: 'assistant', content: [{ type: 'text', text: 'A-new' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, sourceEventSeqs: [nextSeq + 1], surfaceOp: 'append' as const },
    { type: 'step/end', seq: nextSeq + 4, time: 24, data: { turn: 2, step: 1 } },
    { type: 'turn/end', seq: nextSeq + 5, time: 25, data: { turn: 2, reason: { kind: 'completed' } } },
  ] satisfies CuratableSessionEvent[]
  await writeFile(derivedPath, encodeArtifact(derivedId, next, workspace))
  const continued = await takeSnapshot(subprocess, historyRoot, sessions, persistence, {
    session: derived, kind: 'turn-end', seq: next.length - 1,
  })
  assert.equal(continued.ok, true)
  const continuedShow = await runGit(subprocess, [
    'git', `--git-dir=${derivedRepo}`, 'show', '-s', '--format=%P|%s', continued.commit!,
  ], root)
  const [continuedParent, continuedSubject] = continuedShow.stdout.trim().split('|')
  assert.equal(continuedParent, curationSha)
  assert.ok(continuedSubject!.startsWith('[TURN 0002][USER] Q-new[ASST] A-new'))
  assert.equal(await refsOf(subprocess, sourceRepo, root), sourceRefsBefore)

  await rm(root, { recursive: true, force: true })
})

test('refineSession rejects running sources and unknown TURN ids before publication', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-curate-guard-'))
  const sessionId = 'source'
  const session: SessionLike = { id: sessionId, header: { id: sessionId } }
  const sessions = { get: (id: string) => id === sessionId ? session : undefined, flush: async () => true }
  const persistence: PersistenceLike = { locate: () => ({ kind: 'jsonl', path: join(root, 'unused') }) }
  let creates = 0
  const controller: SessionControllerLike = {
    inspect: async () => ({ meta: { id: sessionId }, events: sourceEvents() }),
    createDerivedSession: async () => {
      creates += 1
      return { sessionId: 'new', workspaceAttached: false }
    },
    rename: async (request) => ({ title: request.title, seq: 0 }),
  }

  const running = await refineSession(
    subprocess, root, sessions, persistence, { get: () => ({ status: 'running' }) },
    controller, sessionId, [2],
  )
  assert.equal(running.reason, 'session-running')
  assert.equal(creates, 0)

  const unknown = await refineSession(
    subprocess, root, sessions, persistence, { get: () => ({ status: 'idle' }) },
    controller, sessionId, [99],
  )
  assert.equal(unknown.reason, 'nothing-masked')
  assert.deepEqual(unknown.unmapped, [99])
  assert.equal(creates, 0)

  await rm(root, { recursive: true, force: true })
})
