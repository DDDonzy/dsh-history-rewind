/**
 * Git-graph layout: lane assignment for fork-only histories.
 *
 * Each disconnected Git root owns an exclusive horizontal COMPONENT BLOCK.
 * Components are grouped vertically by root creation time, while their lane
 * blocks never overlap: a root and every descendant may use only lanes inside
 * that component's contiguous range. The active component is placed leftmost;
 * every other root receives the next whole block to the right.
 *
 * Within one component, commits are processed as a fork-only tree using local
 * lane ids starting at 0. At every fork the child on the current HEAD road
 * keeps the parent's local lane; every other direct child reserves a new local
 * lane before any child subtree is visited. Reserving siblings first prevents
 * nested forks from colliding inside the same block.
 *
 * Since this design has fork and never merge, %P always holds exactly one
 * parent (roots have none).
 */

import type { TimelineRow } from './api.ts'

/** One lane-assigned row. */
export type LaidRow = TimelineRow & { lane: number }

/** One lane assignment: which column each commit's node sits on. */
export interface Layouter {
  rows: LaidRow[]
  lanes: number
}

/** Ancestors of `headSha` within the given rows (the current/main road). */
export function roadSet(rows: TimelineRow[], headSha: string | null): Set<string> {
  const set = new Set<string>()
  if (headSha === null) return set
  const bySha = new Map(rows.map((row) => [row.sha, row]))
  const stack = [headSha]
  while (stack.length > 0) {
    const sha = stack.pop()!
    if (set.has(sha)) continue
    const row = bySha.get(sha)
    if (row === undefined) continue
    set.add(sha)
    for (const parent of row.parents) stack.push(parent)
  }
  return set
}

/**
 * Lane assignment (fork-only histories).
 * @param rows - timeline rows, newest first (as `git log` serves them).
 * @param headSha - optional main-tip commit; its road keeps the parent lane at forks.
 * @returns row + lane layout, oldest first.
 */
export function layoutGraph(rows: TimelineRow[], headSha: string | null = null): Layouter {
  const topoOrder = rows.slice().reverse() // oldest first (log is newest-first)
  if (topoOrder.length === 0) return { rows: [], lanes: 1 }

  const bySha = new Map<string, TimelineRow>()
  const topoIndex = new Map<string, number>()
  for (let index = 0; index < topoOrder.length; index += 1) {
    const row = topoOrder[index]!
    bySha.set(row.sha, row)
    topoIndex.set(row.sha, index)
  }
  const mainRoad = roadSet(rows, headSha)

  // Resolve the disconnected root that owns every commit. Grouping rows by
  // root guarantees that lane reuse cannot overlap vertically even if a future
  // Git version interleaves disconnected components in --topo-order output.
  const rootMemo = new Map<string, string>()
  const rootOf = (start: TimelineRow): string => {
    const cached = rootMemo.get(start.sha)
    if (cached !== undefined) return cached
    const path: string[] = []
    const seen = new Set<string>()
    let current = start
    let rootSha = current.sha
    for (;;) {
      const known = rootMemo.get(current.sha)
      if (known !== undefined) { rootSha = known; break }
      if (seen.has(current.sha)) { rootSha = current.sha; break }
      seen.add(current.sha)
      path.push(current.sha)
      const parentSha = current.parents[0]
      const parent = parentSha === undefined ? undefined : bySha.get(parentSha)
      if (parent === undefined) { rootSha = current.sha; break }
      current = parent
    }
    for (const sha of path) rootMemo.set(sha, rootSha)
    return rootSha
  }

  const componentRows = new Map<string, TimelineRow[]>()
  for (const row of topoOrder) {
    const rootSha = rootOf(row)
    const component = componentRows.get(rootSha)
    if (component === undefined) componentRows.set(rootSha, [row])
    else component.push(row)
  }
  // Independent histories read top-to-bottom by baseline creation time. A
  // component stays contiguous even when one of its later children was created
  // after a newer curation root.
  const roots = Array.from(componentRows.keys())
    .map((sha) => bySha.get(sha)!)
    .sort((a, b) => {
      const byTime = a.ct - b.ct
      if (byTime !== 0) return byTime
      return (topoIndex.get(a.sha) ?? 0) - (topoIndex.get(b.sha) ?? 0)
    })
  const order = roots.flatMap((root) => componentRows.get(root.sha) ?? [])
  const orderIndex = new Map<string, number>()
  for (let index = 0; index < order.length; index += 1) orderIndex.set(order[index]!.sha, index)

  const childrenOf = new Map<string, TimelineRow[]>()
  for (const row of order) {
    const parent = row.parents[0]
    if (parent === undefined || !bySha.has(parent)) continue
    const children = childrenOf.get(parent)
    if (children === undefined) childrenOf.set(parent, [row])
    else children.push(row)
  }

  /** Current-road child first; otherwise preserve component topo order. */
  const roadOrder = (a: TimelineRow, b: TimelineRow): number => {
    const aMain = mainRoad.has(a.sha) ? 0 : 1
    const bMain = mainRoad.has(b.sha) ? 0 : 1
    if (aMain !== bMain) return aMain - bMain
    return (orderIndex.get(a.sha) ?? 0) - (orderIndex.get(b.sha) ?? 0)
  }

  // First solve every component in LOCAL lane coordinates (root = local 0).
  const localLane = new Map<string, number>()
  const componentWidth = new Map<string, number>()
  for (const root of roots) {
    localLane.set(root.sha, 0)
    let nextLane = 1
    // Breadth-first traversal reserves every direct sibling lane before a
    // nested fork can request another lane inside THIS component.
    const queue = [root]
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const parent = queue[cursor]!
      const children = (childrenOf.get(parent.sha) ?? []).slice().sort(roadOrder)
      if (children.length === 0) continue
      const parentLane = localLane.get(parent.sha) ?? 0
      localLane.set(children[0]!.sha, parentLane)
      for (let index = 1; index < children.length; index += 1) {
        localLane.set(children[index]!.sha, nextLane)
        nextLane += 1
      }
      queue.push(...children)
    }
    componentWidth.set(root.sha, Math.max(1, nextLane))
  }

  // Defensive fallback for malformed cyclic input. Real Git DAGs always reach
  // every row from one of the roots above.
  for (const row of order) {
    if (localLane.has(row.sha)) continue
    const rootSha = rootOf(row)
    const nextLane = componentWidth.get(rootSha) ?? 1
    localLane.set(row.sha, nextLane)
    componentWidth.set(rootSha, nextLane + 1)
  }

  // Give each root an EXCLUSIVE contiguous horizontal block. Keep the active
  // component leftmost, then place the remaining roots in vertical/creation
  // order to the right. Children can never enter another root's lane range.
  const verticalRootIndex = new Map(roots.map((root, index) => [root.sha, index]))
  const horizontalRoots = roots.slice().sort((a, b) => {
    const aActive = mainRoad.has(a.sha) ? 0 : 1
    const bActive = mainRoad.has(b.sha) ? 0 : 1
    if (aActive !== bActive) return aActive - bActive
    return (verticalRootIndex.get(a.sha) ?? 0) - (verticalRootIndex.get(b.sha) ?? 0)
  })
  const componentOffset = new Map<string, number>()
  let totalLanes = 0
  for (const root of horizontalRoots) {
    componentOffset.set(root.sha, totalLanes)
    totalLanes += componentWidth.get(root.sha) ?? 1
  }

  return {
    rows: order.map((row) => {
      const rootSha = rootOf(row)
      const lane = (componentOffset.get(rootSha) ?? 0) + (localLane.get(row.sha) ?? 0)
      return { ...row, lane }
    }),
    lanes: Math.max(1, totalLanes),
  }
}

/**
 * One rail segment inside a row cell. A segment spans half the row height:
 * `top` segments run from the row's top edge to the node center, `bottom`
 * segments run from the node center to the row's bottom edge. `from`/`to` are
 * lane indices; when they differ the renderer draws a curve, otherwise a
 * straight vertical line. `lane` is the rail that owns the segment (drives its
 * color and keeps a rail's color stable as it curves).
 */
export interface RailEdge {
  from: number
  to: number
  lane: number
  /** Child (newer) commit this rail connects. Constant for the whole rail. */
  childSha: string
  /** Parent (older) commit this rail connects. Constant for the whole rail. */
  parentSha: string
}

/**
 * One fully laid-out graph row: node position + the rails drawn in its cell.
 * With rows oldest-first (newest at the bottom), `topEdges` carry rails toward
 * the parent (above) and `bottomEdges` toward children (below). A tip has no
 * `bottomEdges` on its lane and a root has no `topEdges` on its lane, so the
 * rail terminates at the dot instead of passing through it.
 */
export interface GraphRow extends TimelineRow {
  /** Lane the commit's node sits on. */
  lane: number
  /** Rails in the top half (row top → node center), toward the parent. */
  topEdges: RailEdge[]
  /** Rails in the bottom half (node center → row bottom), toward children. */
  bottomEdges: RailEdge[]
  /** True when this commit is on the current (HEAD) road, i.e. an ancestor of
   *  the active tip. Fork/abandoned road commits are false and rendered grey. */
  isHeadRoad: boolean
}

/** A connected graph model: laid-out rows (oldest first, newest last) + lanes. */
export interface Graph {
  rows: GraphRow[]
  lanes: number
  /** Global lane ids touched by the current road. Kept for layout diagnostics;
   *  rendering still uses `GraphRow.isHeadRoad` / commit ancestry so color is
   *  never inferred from geometry alone. */
  headLanes: number[]
}

/**
 * Build a connected git-graph model from a timeline. Rails carried between
 * rows are tracked so each row cell knows which lanes pass straight through,
 * which converge into the commit node (fork/merge point), and which single
 * rail leaves the node toward its parent.
 *
 * Rows are emitted oldest first (newest at the bottom): parents sit above their
 * children, so a commit's rail runs upward to its parent. Terminal nodes carry
 * no rail beyond them — a tip (newest on its road) has nothing below it and a
 * root has nothing above it — so lines start and stop cleanly at the dot.
 *
 * Lane assignment is reused from {@link layoutGraph} so the two views stay
 * consistent; this function only derives the inter-row rail geometry.
 *
 * @param rows - timeline rows, newest first (as `git log` serves them).
 * @param headSha - optional main-tip commit; its road keeps the parent lane.
 * @returns per-row rail geometry, oldest first.
 */
export function buildGraph(rows: TimelineRow[], headSha: string | null = null): Graph {
  const laid = layoutGraph(rows, headSha) // oldest first
  const laneOf = new Map<string, number>()
  for (const row of laid.rows) laneOf.set(row.sha, row.lane)

  // Current (HEAD) road = ancestors of the active tip; everything else is a
  // fork/abandoned road rendered grey.
  const headRoad = roadSet(rows, headSha)

  // Walk newest→oldest first (rail bookkeeping is natural in that direction:
  // `open` maps a lane index to the sha of the commit that rail is heading to).
  // `nearEdges` are rails toward newer commits (children), `farEdges` toward the
  // parent. We reverse and remap to oldest-first at the end.
  const display = laid.rows.slice().reverse()
  // lane -> (parent sha it is heading to, child sha it came from).
  const open = new Map<number, { parent: string; child: string }>()
  const built: { row: TimelineRow; lane: number; near: RailEdge[]; far: RailEdge[] }[] = []

  for (const row of display) {
    const nodeLane = laneOf.get(row.sha) ?? 0

    // Rails arriving from newer commits: any open lane whose target is this
    // commit converges into the node lane; every other open lane passes through.
    // A tip has no arriving rail and gets none forced — its node is a terminal.
    const near: RailEdge[] = []
    for (const [lane, owner] of open) {
      if (owner.parent === row.sha) {
        near.push({ from: lane, to: nodeLane, lane, childSha: owner.child, parentSha: row.sha })
      } else {
        near.push({ from: lane, to: lane, lane, childSha: owner.child, parentSha: owner.parent })
      }
    }

    // Consume every rail that converged here, then route the node's own lane
    // to its (single) parent.
    for (const [lane, owner] of [...open]) {
      if (owner.parent === row.sha) open.delete(lane)
    }
    const parent = row.parents[0]
    if (parent !== undefined) open.set(nodeLane, { parent, child: row.sha })
    else open.delete(nodeLane)

    // Rails continuing toward parents = whatever remains open.
    const far: RailEdge[] = []
    for (const [lane, owner] of open) far.push({ from: lane, to: lane, lane, childSha: owner.child, parentSha: owner.parent })

    built.push({ row, lane: nodeLane, near, far })
  }

  // Emit oldest first (newest at the bottom). In that orientation the parent is
  // above, so `far` (toward-parent) rails belong to the TOP half and `near`
  // (toward-children) rails belong to the BOTTOM half. `far` rails are always
  // straight (open lanes only diverge at their target row, encoded as `near`).
  // `near` was computed with the node-center endpoint as `to`; a bottom-half
  // segment expects the node-center endpoint as `from`, so swap it.
  const out: GraphRow[] = built
    .slice()
    .reverse()
    .map((entry) => ({
      ...entry.row,
      lane: entry.lane,
      topEdges: entry.far,
      bottomEdges: entry.near.map((edge) => ({ ...edge, from: edge.to, to: edge.from })),
      isHeadRoad: headRoad.has(entry.row.sha),
    }))

  // Global lane ids touched by the current road (diagnostic only; UI coloring
  // remains ancestry-based rather than assuming geometry implies ownership).
  const headLanes: number[] = []
  for (const row of out) {
    if (row.isHeadRoad && !headLanes.includes(row.lane)) headLanes.push(row.lane)
  }

  return { rows: out, lanes: laid.lanes, headLanes }
}
