/**
 * Unit tests for the git-graph lane assignment (fork-only histories).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutGraph, buildGraph } from '../src/client/layout.ts'
import type { TimelineRow } from '../src/client/api.ts'

function row(sha: string, parents: string[]): TimelineRow {
  return { sha, parents, subject: 'dsh-history: turn 1 start (seq 1) session-s snap=x', ct: 1, meta: null }
}

test('linear history keeps a single lane', () => {
  const rows = [row('C', ['B']), row('B', ['A']), row('A', [])] // newest-first as git log serves
  const layout = layoutGraph(rows)
  assert.equal(layout.lanes, 1)
  assert.deepEqual(layout.rows.map((r) => [r.sha, r.lane]), [['A', 0], ['B', 0], ['C', 0]])
})

test('fork: second child of a parent takes a new lane', () => {
  // A -> B -> C (abandoned road) and A -> D (main road after a rewind).
  // git log --all order (newest first) keeps D before B (main road first).
  const rows = [row('D', ['A']), row('C', ['B']), row('B', ['A']), row('A', [])]
  const layout = layoutGraph(rows)
  // A in lane 0; B (first child of A in this order) lane 0; C lane 0; D (fork) lane 1.
  assert.equal(layout.lanes, 2)
  assert.deepEqual(layout.rows.map((r) => [r.sha, r.lane]), [['A', 0], ['B', 0], ['C', 0], ['D', 1]])
})

test('fork at the rewind marker: A -> M -> D and A -> B', () => {
  // The exact shape produced by rewind-to-A then continue: A, M(rewind, parent A),
  // D(parent M), B(parent A). With the HEAD known (D), the current road keeps
  // lane 0 and the abandoned road shifts right.
  const rows = [
    row('D', ['M']),
    row('M', ['A']),
    row('B', ['A']),
    row('A', []),
  ]
  const layout = layoutGraph(rows, 'D')
  assert.equal(layout.lanes, 2)
  const lanes = new Map(layout.rows.map((r) => [r.sha, r.lane]))
  assert.equal(lanes.get('A'), 0)
  assert.equal(lanes.get('M'), 0)
  assert.equal(lanes.get('D'), 0)
  assert.equal(lanes.get('B'), 1)
})

test('without HEAD the first-listed road keeps lane 0', () => {
  const rows = [
    row('D', ['M']),
    row('M', ['A']),
    row('B', ['A']),
    row('A', []),
  ]
  const layout = layoutGraph(rows)
  assert.equal(layout.lanes, 2)
  const lanes = new Map(layout.rows.map((r) => [r.sha, r.lane]))
  // B is first among A's children in this order -> lane 0.
  assert.equal(lanes.get('B'), 0)
  assert.equal(lanes.get('M'), 1)
  assert.equal(lanes.get('D'), 1)
})

test('empty / single-row histories', () => {
  assert.equal(layoutGraph([]).lanes, 1)
  const single = layoutGraph([row('A', [])])
  assert.equal(single.lanes, 1)
  assert.equal(single.rows[0]!.lane, 0)
})

test('buildGraph: linear history draws a single straight rail, oldest first', () => {
  const rows = [row('C', ['B']), row('B', ['A']), row('A', [])] // git-log newest first
  const graph = buildGraph(rows)
  assert.equal(graph.lanes, 1)
  // Emitted oldest first: A at top, C (newest) at the bottom.
  assert.deepEqual(graph.rows.map((r) => r.sha), ['A', 'B', 'C'])
  // Root (A, top): rail leaves downward toward its child, nothing above it.
  const a = graph.rows[0]!
  assert.deepEqual(a.topEdges, [])
  assert.deepEqual(a.bottomEdges, [{ from: 0, to: 0, lane: 0, childSha: 'B', parentSha: 'A' }])
  // Middle (B): rail through both halves.
  const b = graph.rows[1]!
  assert.deepEqual(b.topEdges, [{ from: 0, to: 0, lane: 0, childSha: 'B', parentSha: 'A' }])
  assert.deepEqual(b.bottomEdges, [{ from: 0, to: 0, lane: 0, childSha: 'C', parentSha: 'B' }])
  // Tip (C, bottom): rail arrives from above, nothing below the node.
  const c = graph.rows[2]!
  assert.deepEqual(c.topEdges, [{ from: 0, to: 0, lane: 0, childSha: 'C', parentSha: 'B' }])
  assert.deepEqual(c.bottomEdges, [])
})

test('buildGraph: fork opens a second lane and converges back at the parent', () => {
  // A -> M -> D (main, HEAD) and A -> B (abandoned). git-log order newest-first.
  const rows = [row('D', ['M']), row('M', ['A']), row('B', ['A']), row('A', [])]
  const graph = buildGraph(rows, 'D')
  assert.equal(graph.lanes, 2)
  // Oldest first: A at top, D (HEAD tip) at the bottom.
  assert.equal(graph.rows[0]!.sha, 'A')
  assert.equal(graph.rows[graph.rows.length - 1]!.sha, 'D')
  const byId = new Map(graph.rows.map((r) => [r.sha, r]))
  const headRoad = graph.rows.filter((r) => r.isHeadRoad).map((r) => r.sha)
  assert.deepEqual(headRoad, ['A', 'M', 'D'], 'HEAD road = ancestors of the tip')
  assert.equal(byId.get('B')!.isHeadRoad, false, 'abandoned fork is off-road (grey)')
  assert.deepEqual(graph.headLanes, [0], 'only the HEAD-road lane keeps color')
  // A is the fork point (parent above): two rails leave downward toward children.
  const a = byId.get('A')!
  assert.equal(a.lane, 0)
  assert.deepEqual(a.topEdges, []) // root, nothing above
  assert.ok(a.bottomEdges.some((e) => e.from === 0 && e.to === 1), 'lane 1 diverges from node lane 0 going down')
  assert.ok(a.bottomEdges.some((e) => e.from === 0 && e.to === 0), 'lane 0 continues straight down')
  // B sits on the abandoned lane (1); its rail runs upward to A.
  const b = byId.get('B')!
  assert.equal(b.lane, 1)
  assert.ok(b.topEdges.some((e) => e.lane === 1), 'lane-1 rail goes up toward A')
  // D is the tip: nothing below it.
  const d = byId.get('D')!
  assert.deepEqual(d.bottomEdges, [])
})
