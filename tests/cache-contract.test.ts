/**
 * Cache-contract tests for the rewind resume: jumping back must re-compose the
 * agent from the preset the target history was produced under and declare the
 * target's provider/model route, so the resumed request prefix stays
 * byte-identical to what the provider has cached (DeepSeek prefix-cache rule:
 * hit requires a fully matching cached prefix unit; a system/tools divergence
 * after resume silently forfeits every future hit).
 *
 * Mock-free at the git boundary: real git via the fake subprocess seam; the
 * session artifact is a REAL zstd JSONL so decodeTargetFacts sees the same
 * bytes the loader will (zstdCompressSync, Node ≥ 22.15).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { fakeSubprocess } from './fake-subprocess.ts'
import { takeSnapshot, type PersistenceLike, type SessionLike } from '../src/snapshot.ts'
import { rewindSession, type AgentRegistryLike, type AgentPresetsLike } from '../src/rewind.ts'

/** One zstd frame containing the given JSONL lines. */
function artifact(lines: Array<Record<string, unknown>>): Buffer {
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
  return zstdCompressSync(Buffer.from(text, 'utf8'))
}

function sessionHeader(preset: string | undefined, id: string): Record<string, unknown> {
  return {
    type: 'session', version: 0, id, createdAt: 1, cwd: 'C:\\ws',
    delegationDepth: 0, ...(preset === undefined ? {} : { agentPreset: preset }),
  }
}

function requestHeader(config: Record<string, unknown>): Record<string, unknown> {
  return { type: 'request/header', seq: 20, time: 2, data: { reason: 'initial', header: { config } } }
}

function makeEnv(sessionId: string): Promise<{
  subprocess: ReturnType<typeof fakeSubprocess>
  root: string
  cwd: string
  historyRoot: string
  sessionsRoot: string
  sessionId: string
  official: string
  session: SessionLike
  persistence: PersistenceLike
  cleanup: () => Promise<void>
}> {
  return (async () => {
    const subprocess = fakeSubprocess()
    const root = await mkdtemp(join(tmpdir(), 'dsh-history-cache-'))
    const cwd = join(root, 'ws')
    const historyRoot = join(root, 'history')
    const sessionsRoot = join(root, 'sessions')
    const officialDir = join(sessionsRoot, '--C-ws--', `session-${sessionId}`)
    const official = join(officialDir, 'session.jsonl.zstd')
    await mkdir(officialDir, { recursive: true })
    await mkdir(cwd, { recursive: true })
    return {
      subprocess, root, cwd, historyRoot, sessionsRoot, sessionId, official,
      session: { id: sessionId, header: { cwd } },
      persistence: { locate: () => ({ kind: 'jsonl', path: official }) },
      cleanup: () => rm(root, { recursive: true, force: true }),
    }
  })()
}

/** Standard agent/session mocks; resume records the options it was called with. */
function mocks(sessionId: string): {
  agents: AgentRegistryLike & { resumeCalls: Array<Record<string, unknown>> }
  sessions: Parameters<typeof rewindSession>[2] & object
} {
  const resumeCalls: Array<Record<string, unknown>> = []
  const agents: AgentRegistryLike & { resumeCalls: Array<Record<string, unknown>> } = {
    get: () => ({ status: 'idle' }),
    detachEntered: () => undefined,
    resume: async (options) => { resumeCalls.push(options as Record<string, unknown>) },
    store: new Map<string, { id: string }>(),
    resumeCalls,
  }
  return {
    agents,
    sessions: {
      get: (id: string) => (id === sessionId ? { id, header: { cwd: 'C:\\ws' } } : undefined),
      flush: async () => true,
      liveEntryFor: () => ({ id: sessionId }),
      detachEntered: () => undefined,
    },
  }
}

test('rewind resume re-mounts the target preset and route (cache contract)', async () => {
  const sessionId = 'cc-mount'
  const env = await makeEnv(sessionId)
  try {
    // Two snapshots: A (preset cordis, route gpt-codeyu) and B (changed content).
    await writeFile(env.official, artifact([
      sessionHeader('cordis', sessionId),
      { type: 'turn/start', seq: 5, time: 1, data: { turn: 1 } },
      requestHeader({ provider: 'gpt-codeyu', model: 'gpt-5.6-terra', maxTokens: 320000 }),
      { type: 'turn/end', seq: 30, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ]))
    const a = await takeSnapshot(env.subprocess, env.historyRoot, undefined, env.persistence, {
      session: env.session, kind: 'turn-start', seq: 5,
    })
    assert.equal(a.ok, true)
    await writeFile(env.official, artifact([
      sessionHeader('cordis', sessionId),
      { type: 'turn/start', seq: 5, time: 1, data: { turn: 1 } },
      requestHeader({ provider: 'gpt-codeyu', model: 'gpt-5.6-terra', maxTokens: 320000 }),
      { type: 'turn/end', seq: 30, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 31, time: 4, data: { turn: 2 } },
      { type: 'turn/end', seq: 40, time: 5, data: { turn: 2, reason: { kind: 'completed' } } },
    ]))
    const b = await takeSnapshot(env.subprocess, env.historyRoot, undefined, env.persistence, {
      session: env.session, kind: 'turn-end', seq: 40,
    })
    assert.equal(b.ok, true)

    const { agents, sessions } = mocks(sessionId)
    agents.store!.set(sessionId, { id: sessionId })
    await writeFile(env.official, artifact([
      sessionHeader('cordis', sessionId),
      { type: 'turn/start', seq: 5, time: 1, data: { turn: 1 } },
      requestHeader({ provider: 'gpt-codeyu', model: 'gpt-5.6-terra', maxTokens: 320000 }),
      { type: 'turn/end', seq: 30, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', seq: 31, time: 4, data: { turn: 2 } },
      { type: 'turn/end', seq: 40, time: 5, data: { turn: 2, reason: { kind: 'completed' } } },
    ]))
    const mountCalls: Array<Array<unknown>> = []
    const agentPresets: AgentPresetsLike = {
      mount: async (agentCtx, id) => { mountCalls.push([agentCtx, id]) },
    }

    // Rewind to the turn-END (ASST) node: continuing after a reply re-mounts
    // the preset + route. (A turn-START/USER node pins the pre-send state, whose
    // truncated prefix for turn 1 carries no established route yet.)
    const result = await rewindSession(
      env.subprocess, env.historyRoot, sessions, env.persistence, agents,
      sessionId, b.commit!, false, agentPresets,
    )
    assert.equal(result.ok, true)
    assert.equal(result.compositionWarning, undefined)

    // Resume was called with the target route + a setup that mounts the preset.
    assert.equal(agents.resumeCalls.length, 1)
    const call = agents.resumeCalls[0]!
    assert.deepEqual(call.agentOptions, { provider: 'gpt-codeyu', model: 'gpt-5.6-terra' })
    assert.equal(typeof call.setup, 'function')

    // Invoking the setup mounts the target's preset on the agent scope context.
    const scope = {}
    await (call.setup as (ctx: unknown) => Promise<void>)(scope)
    assert.equal(mountCalls.length, 1)
    assert.equal(mountCalls[0]![1], 'cordis')
    assert.equal(mountCalls[0]![0], scope)
  } finally {
    await env.cleanup()
  }
})

test('a later agent-preset/selected wins; last request/header config is the route', async () => {
  const sessionId = 'cc-selected'
  const env = await makeEnv(sessionId)
  try {
    await writeFile(env.official, artifact([
      sessionHeader('standard', sessionId),
      { type: 'agent-preset/selected', seq: 2, time: 1, data: { agentPreset: 'dsh-history-cache' } },
      requestHeader({ provider: 'chosen-provider', model: 'chosen-model' }),
    ]))
    const snap = await takeSnapshot(env.subprocess, env.historyRoot, undefined, env.persistence, {
      session: env.session, kind: 'turn-start', seq: 1,
    })
    assert.equal(snap.ok, true)

    const { agents, sessions } = mocks(sessionId)
    agents.store!.set(sessionId, { id: sessionId })
    await writeFile(env.official, artifact([
      sessionHeader('standard', sessionId),
      { type: 'agent-preset/selected', seq: 2, time: 1, data: { agentPreset: 'dsh-history-cache' } },
      requestHeader({ provider: 'chosen-provider', model: 'chosen-model' }),
    ]))
    const mounts: string[] = []
    const result = await rewindSession(
      env.subprocess, env.historyRoot, sessions, env.persistence, agents,
      sessionId, snap.commit!, false,
      { mount: async (_ctx, id) => { mounts.push(String(id)) } },
    )
    assert.equal(result.ok, true)
    // The mock registry records but never runs setup; invoke it to observe the mount.
    const call = agents.resumeCalls[0]!
    assert.equal(typeof call.setup, 'function')
    await (call.setup as (ctx: unknown) => Promise<void>)({})
    assert.deepEqual(mounts, ['dsh-history-cache'])
    assert.deepEqual(agents.resumeCalls[0]!.agentOptions, { provider: 'chosen-provider', model: 'chosen-model' })
  } finally {
    await env.cleanup()
  }
})

test('preset mount failure falls back to bare resume and reports the degradation', async () => {
  const sessionId = 'cc-fallback'
  const env = await makeEnv(sessionId)
  try {
    await writeFile(env.official, artifact([
      sessionHeader('cordis', sessionId),
      requestHeader({ provider: 'p', model: 'm' }),
    ]))
    const snap = await takeSnapshot(env.subprocess, env.historyRoot, undefined, env.persistence, {
      session: env.session, kind: 'turn-start', seq: 1,
    })
    assert.equal(snap.ok, true)

    const { agents, sessions } = mocks(sessionId)
    agents.store!.set(sessionId, { id: sessionId })
    // The mock registry never invokes setup, so simulate the factory rejecting
    // a composed resume whose mount throws (setup runs before publish).
    const attempts: Array<{ setup: unknown; agentOptions: unknown }> = []
    agents.resume = async (options) => {
      attempts.push({ setup: options.setup, agentOptions: options.agentOptions })
      if (options.setup !== undefined) throw new Error('preset deleted')
    }
    await writeFile(env.official, artifact([
      sessionHeader('cordis', sessionId),
      requestHeader({ provider: 'p', model: 'm' }),
    ]))
    const agentPresets: AgentPresetsLike = {
      mount: async () => { throw new Error('preset deleted') },
    }
    const result = await rewindSession(
      env.subprocess, env.historyRoot, sessions, env.persistence, agents,
      sessionId, snap.commit!, false, agentPresets,
    )
    assert.equal(result.ok, true)
    assert.match(result.compositionWarning ?? '', /could not be mounted/)
    // Two attempts: composed then bare; the bare one still declares the route.
    assert.equal(attempts.length, 2)
    assert.equal(typeof attempts[0]!.setup, 'function')
    assert.equal(attempts[1]!.setup, undefined)
    assert.deepEqual(attempts[1]!.agentOptions, { provider: 'p', model: 'm' })
  } finally {
    await env.cleanup()
  }
})

test('no preset roster: resume stays bare but still restores the route', async () => {
  const sessionId = 'cc-bare'
  const env = await makeEnv(sessionId)
  try {
    await writeFile(env.official, artifact([
      sessionHeader(undefined, sessionId),
      requestHeader({ provider: 'p', model: 'm' }),
    ]))
    const snap = await takeSnapshot(env.subprocess, env.historyRoot, undefined, env.persistence, {
      session: env.session, kind: 'turn-start', seq: 1,
    })
    assert.equal(snap.ok, true)

    const { agents, sessions } = mocks(sessionId)
    agents.store!.set(sessionId, { id: sessionId })
    await writeFile(env.official, artifact([
      sessionHeader(undefined, sessionId),
      requestHeader({ provider: 'p', model: 'm' }),
    ]))
    const result = await rewindSession(
      env.subprocess, env.historyRoot, sessions, env.persistence, agents,
      sessionId, snap.commit!, false,
    )
    assert.equal(result.ok, true)
    assert.equal(result.compositionWarning, undefined)
    assert.equal(agents.resumeCalls.length, 1)
    assert.equal(agents.resumeCalls[0]!.setup, undefined)
    assert.deepEqual(agents.resumeCalls[0]!.agentOptions, { provider: 'p', model: 'm' })
  } finally {
    await env.cleanup()
  }
})

test('corrupt target artifact resumes bare and does not fail the rewind', async () => {
  const sessionId = 'cc-corrupt'
  const env = await makeEnv(sessionId)
  try {
    await writeFile(env.official, Buffer.from('AAAAAAAA'))
    const snap = await takeSnapshot(env.subprocess, env.historyRoot, undefined, env.persistence, {
      session: env.session, kind: 'turn-start', seq: 1,
    })
    assert.equal(snap.ok, true)

    const { agents, sessions } = mocks(sessionId)
    agents.store!.set(sessionId, { id: sessionId })
    await writeFile(env.official, Buffer.from('AAAAAAAA'))
    const result = await rewindSession(
      env.subprocess, env.historyRoot, sessions, env.persistence, agents,
      sessionId, snap.commit!, false,
    )
    assert.equal(result.ok, true)
    assert.equal(agents.resumeCalls.length, 1)
    assert.equal(agents.resumeCalls[0]!.setup, undefined)
    assert.equal(agents.resumeCalls[0]!.agentOptions, undefined)
    assert.ok((await readFile(env.official)).equals(Buffer.from('AAAAAAAA')))
  } finally {
    await env.cleanup()
  }
})
