/**
 * Git-graph layout: lane assignment for fork-only histories.
 *
 * Commits are processed in topo order (oldest first); a child takes its
 * single parent's lane unless that lane is already taken by an earlier child
 * of the same parent, which is exactly the fork case: after a rewind the
 * second road opens a new lane. When the caller knows the HEAD commit (main
 * tip), the road that reaches the HEAD keeps the parent's lane and fork
 * roads move right — the current road stays visually dominant.
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
  const order = rows.slice().reverse() // oldest first (log is newest-first)
  const shaToRow = new Map<string, TimelineRow>()
  for (const row of order) shaToRow.set(row.sha, row)
  const mainRoad = roadSet(rows, headSha)
  const lane = new Map<string, number>()
  const process = (row: TimelineRow): void => {
    if (lane.has(row.sha)) return
    if (row.parents.length === 0) {
      lane.set(row.sha, 0)
      return
    }
    const parent = row.parents[0]!
    process(shaToRow.get(parent)!)
    const parentLane = lane.get(parent)!
    const siblings = order.filter((r) => r.parents.includes(parent))
    // Sort so the current-road child (if any) keeps the parent lane; other
    // forks are ordered by their topo position.
    const sorted = siblings.slice().sort((a, b) => {
      const aMain = mainRoad.has(a.sha) ? 0 : 1
      const bMain = mainRoad.has(b.sha) ? 0 : 1
      if (aMain !== bMain) return aMain - bMain
      return order.indexOf(a) - order.indexOf(b)
    })
    lane.set(row.sha, parentLane + Math.max(0, sorted.findIndex((r) => r.sha === row.sha)))
  }
  for (const row of order) process(row)
  const lanes = Math.max(0, ...order.map((row) => lane.get(row.sha) ?? 0)) + 1
  return { rows: order.map((row) => ({ ...row, lane: lane.get(row.sha) ?? 0 })), lanes }
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
  /** Lane indices occupied by the current (HEAD) road. Rails belonging to
   *  these lanes keep their color; every other lane is an abandoned/fork road
   *  and renders grey. Lane-level, not row-level: a rail spans many rows, so
   *  its color must be decided by which road it belongs to, not by the row it
   *  happens to cross. */
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

  // Lanes occupied by HEAD-road commits. A rail (identified by its `lane`)
  // keeps its color iff this lane is one of them; abandoned fork lanes render
  // grey end-to-end, and the main rail keeps its color even while crossing
  // rows that belong to the abandoned road.
  const headLanes: number[] = []
  for (const row of out) {
    if (row.isHeadRoad && !headLanes.includes(row.lane)) headLanes.push(row.lane)
  }

  return { rows: out, lanes: laid.lanes, headLanes }
}
