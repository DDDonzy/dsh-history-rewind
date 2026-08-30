/**
 * Regression for bug1: a same-id rewind replaces the Session artifact with a
 * lower/equal-seq history. DSH projection stores are monotone, so they must be
 * rebased before resync or model/reasoning UI keeps the pre-rewind selection.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { refreshRewoundSession } from '../src/client/session-refresh.ts'

interface Selection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** Tiny higher-seq-wins projection cell matching DSH's client store contract. */
class ProjectionCell {
  row: { seq: number; value: Selection } | undefined
  readonly calls: string[] = []

  constructor(seq: number, value: Selection) {
    this.row = { seq, value }
  }

  truncate(lastSeq: number): void {
    this.calls.push(`truncate:${lastSeq}`)
    if (this.row !== undefined && this.row.seq > lastSeq) this.row = undefined
  }

  seed(seq: number, value: Selection): void {
    this.calls.push(`seed:${seq}`)
    if (this.row !== undefined && seq <= this.row.seq) return
    this.row = { seq, value }
  }
}

for (const targetSeq of [12, 90]) {
  test(`rewind projection rebase accepts a ${targetSeq === 12 ? 'lower' : 'equal'}-seq model baseline`, async () => {
    const oldSelection: Selection = {
      provider: 'old-provider',
      model: 'old-model',
      reasoningEffort: 'max',
    }
    const targetSelection: Selection = {
      provider: 'target-provider',
      model: 'target-model',
      reasoningEffort: 'high',
    }
    const projections = new ProjectionCell(90, oldSelection)
    const order: string[] = []
    const session = {
      removed: true,
      projections: {
        truncate: (seq: number) => {
          order.push('truncate')
          projections.truncate(seq)
        },
      },
      resync: async () => {
        order.push('resync')
        // This is the fresh Host baseline installed by Session.resync().
        projections.seed(targetSeq, targetSelection)
      },
    }

    assert.equal(await refreshRewoundSession(session), true)
    assert.equal(session.removed, false)
    assert.deepEqual(order, ['truncate', 'resync'])
    assert.deepEqual(projections.calls, ['truncate:-1', `seed:${targetSeq}`])
    assert.deepEqual(projections.row, { seq: targetSeq, value: targetSelection })
  })
}

test('client with resync but no projection reset refuses an incomplete refresh', async () => {
  let resynced = false
  const session = {
    removed: true,
    resync: async () => { resynced = true },
  }
  assert.equal(await refreshRewoundSession(session), false)
  assert.equal(session.removed, true)
  assert.equal(resynced, false)
})

test('older client without resync stays untouched for the caller fallback', async () => {
  let truncated = false
  const session = {
    removed: true,
    projections: { truncate: () => { truncated = true } },
  }
  assert.equal(await refreshRewoundSession(session), false)
  assert.equal(session.removed, true)
  assert.equal(truncated, false)
})
