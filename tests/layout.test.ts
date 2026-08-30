/**
 * Unit tests for the git-graph lane assignment (fork-only histories).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutGraph, buildGraph, roadSet } from '../src/client/layout.ts'
import type { TimelineRow } from '../src/client/api.ts'

function row(sha: string, parents: string[], ct = 1): TimelineRow {
  return { sha, parents, subject: 'dsh-history: turn 1 start (seq 1) session-s snap=x', ct, meta: null }
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

test('nested fork reserves a lane after every direct sibling (real collision regression)', () => {
  // Real failing shape from session-f45e...:
  //
  //                  ┌ 0817782 (main ref)
  // R -> A ──────────┼ 96b7342 ─┬ b8e1caa
  //                  │          └ a97b038
  //                  ├ fde9b72
  //                  └ fad8ecf -> b9956c1 (active tip)
  //
  // A's four children reserve lanes 0..3 first. The nested fork below
  // 96b7342 (lane 2) must therefore open lane 4, not parentLane+1 (= lane 3,
  // already owned by fde9b72).
  const rows = [
    row('b9956c1', ['fad8ecf']),
    row('fad8ecf', ['eeedebc']),
    row('a97b038', ['96b7342']),
    row('fde9b72', ['eeedebc']),
    row('b8e1caa', ['96b7342']),
    row('96b7342', ['eeedebc']),
    row('0817782', ['eeedebc']),
    row('eeedebc', ['02ddd4d']),
    row('02ddd4d', []),
  ]
  const layout = layoutGraph(rows, 'b9956c1')
  assert.equal(layout.lanes, 5)
  const lanes = new Map(layout.rows.map((r) => [r.sha, r.lane]))
  assert.equal(lanes.get('02ddd4d'), 0)
  assert.equal(lanes.get('eeedebc'), 0)
  assert.equal(lanes.get('fad8ecf'), 0, 'active road keeps the parent lane')
  assert.equal(lanes.get('b9956c1'), 0)
  assert.equal(lanes.get('0817782'), 1)
  assert.equal(lanes.get('96b7342'), 2)
  assert.equal(lanes.get('b8e1caa'), 2, 'first nested child continues straight')
  assert.equal(lanes.get('fde9b72'), 3)
  assert.equal(lanes.get('a97b038'), 4, 'nested fork receives the next globally free lane')
  assert.notEqual(lanes.get('a97b038'), lanes.get('fde9b72'))

  // Every tip owns a distinct lane while its road is visible.
  const tipLanes = ['b9956c1', '0817782', 'b8e1caa', 'a97b038', 'fde9b72']
    .map((sha) => lanes.get(sha))
  assert.equal(new Set(tipLanes).size, tipLanes.length)

  const graph = buildGraph(rows, 'b9956c1')
  assert.deepEqual(graph.headLanes, [0])
  const byId = new Map(graph.rows.map((r) => [r.sha, r]))
  assert.ok(
    byId.get('96b7342')!.bottomEdges.some((edge) =>
      edge.childSha === 'a97b038' && edge.from === 2 && edge.to === 4),
    'nested fork rail leaves lane 2 and bends into globally reserved lane 4',
  )

  // Context Curation selection mode filters to the active tip's ancestor road.
  const currentRoad = roadSet(rows, 'b9956c1')
  const currentRows = rows.filter((candidate) => currentRoad.has(candidate.sha))
  assert.deepEqual(
    currentRows.map((candidate) => candidate.sha),
    ['b9956c1', 'fad8ecf', 'eeedebc', '02ddd4d'],
  )
  const selectionGraph = buildGraph(currentRows, 'b9956c1')
  assert.equal(selectionGraph.lanes, 1, 'selection-mode graph draws only one current-road lane')
  assert.deepEqual(selectionGraph.rows.map((candidate) => candidate.lane), [0, 0, 0, 0])
})

test('parentless curation road stays disconnected from the original root', () => {
  // Original history A -> B and independent curated baseline O -> C.
  const rows = [row('C', ['O']), row('O', []), row('B', ['A']), row('A', [])]
  const graph = buildGraph(rows, 'C')
  assert.equal(graph.lanes, 2, 'each root owns an exclusive one-lane block')
  const byId = new Map(graph.rows.map((candidate) => [candidate.sha, candidate]))
  assert.equal(byId.get('O')!.lane, 0, 'active curation root owns the left block')
  assert.equal(byId.get('C')!.lane, 0)
  assert.equal(byId.get('A')!.lane, 1, 'original root owns a separate right block')
  assert.equal(byId.get('B')!.lane, 1)
  assert.deepEqual(byId.get('O')!.topEdges, [], 'curation root has no parent rail')
  assert.deepEqual(byId.get('A')!.topEdges, [], 'original root has no parent rail')
  assert.ok(!graph.rows.flatMap((candidate) => [...candidate.topEdges, ...candidate.bottomEdges])
    .some((edge) => (edge.childSha === 'O' && edge.parentSha === 'B')
      || (edge.childSha === 'B' && edge.parentSha === 'O')))
  assert.deepEqual(graph.headLanes, [0])
})

test('multiple curation roots own exclusive horizontal blocks and remain vertically grouped', () => {
  // Real screenshot topology (newest first). 50fb was created after the second
  // root, but belongs to c011's component and must remain grouped with it.
  const rows = [
    row('525e3e1', ['c278f7d'], 4580),
    row('0197f3c', ['a7a69c8'], 4559),
    row('a7a69c8', ['c278f7d'], 4470),
    row('c278f7d', [], 4451),
    row('50fb0c4', ['c011bd4'], 4531),
    row('fc46750', ['c011bd4'], 4409),
    row('c011bd4', [], 4370),
    row('95251d3', ['9aee56b'], 4275),
    row('9aee56b', [], 3018),
  ]
  const graph = buildGraph(rows, '525e3e1')
  assert.equal(graph.lanes, 5, 'component widths 2 + 1 + 2 occupy disjoint lane blocks')
  assert.deepEqual(
    graph.rows.map((candidate) => candidate.sha),
    ['9aee56b', '95251d3', 'c011bd4', 'fc46750', '50fb0c4', 'c278f7d', 'a7a69c8', '0197f3c', '525e3e1'],
    'components stay contiguous and are ordered by root creation time',
  )
  const byId = new Map(graph.rows.map((candidate) => [candidate.sha, candidate]))
  // Active c278 component is the left block [0,1].
  assert.equal(byId.get('c278f7d')!.lane, 0)
  assert.equal(byId.get('525e3e1')!.lane, 0)
  assert.equal(byId.get('a7a69c8')!.lane, 1)
  assert.equal(byId.get('0197f3c')!.lane, 1)
  // Original linear history owns middle block [2].
  assert.equal(byId.get('9aee56b')!.lane, 2)
  assert.equal(byId.get('95251d3')!.lane, 2)
  // Earlier c011 component owns right block [3,4].
  assert.equal(byId.get('c011bd4')!.lane, 3)
  assert.equal(byId.get('fc46750')!.lane, 3)
  assert.equal(byId.get('50fb0c4')!.lane, 4)
  const ranges = [new Set([0, 1]), new Set([2]), new Set([3, 4])]
  for (let left = 0; left < ranges.length; left += 1) {
    for (let right = left + 1; right < ranges.length; right += 1) {
      assert.ok([...ranges[left]!].every((lane) => !ranges[right]!.has(lane)))
    }
  }
  // Styling is ancestry-based; only the active component is the HEAD road.
  assert.equal(byId.get('9aee56b')!.isHeadRoad, false)
  assert.equal(byId.get('c011bd4')!.isHeadRoad, false)
  assert.equal(byId.get('c278f7d')!.isHeadRoad, true)
  assert.equal(byId.get('525e3e1')!.isHeadRoad, true)
  assert.deepEqual(graph.headLanes, [0])
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
