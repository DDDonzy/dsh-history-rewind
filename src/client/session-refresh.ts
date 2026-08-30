/**
 * Client-side repair for a same-id Session whose persisted artifact was
 * replaced by History Rewind.
 *
 * DSH projection cells use a monotone "higher seq wins" rule. A rewind moves
 * the durable log backwards (or onto another branch with equal sequence
 * numbers), so the resident client's old projection rows would otherwise
 * reject the replacement history baseline as stale. Conversation events
 * refresh through `resync()`, but model/reasoning, preset, title, and every
 * other Host projection would remain painted from the pre-rewind artifact.
 */

/** Structural client Session surface used by the History plugin. */
export interface RebindableClientSession {
  /** Runtime flag set by host/session-removed while the resident object survives. */
  removed?: boolean
  /** Generic DSH projection store; `truncate(-1)` clears every non-negative seq row. */
  projections?: {
    truncate?(lastSeq: number): void
  }
  /** Reopen the Session history stream and install its fresh projection baseline. */
  resync?(): Promise<unknown>
}

/**
 * Rebase a resident client Session onto a physically replaced artifact.
 *
 * Projection rows are cleared before resync so the replacement baseline wins
 * even when its sequence is lower than — or equal to — the old branch. The
 * operation reports `false` unless both reset and resync primitives exist: a
 * conversation-only refresh would falsely claim success while projection UI
 * remains stale, so the caller must choose its hard-reload fallback instead.
 *
 * @param session - resident client Session for the rewound id.
 * @returns true when the in-place resync primitive was available and completed.
 */
export async function refreshRewoundSession(session: RebindableClientSession): Promise<boolean> {
  if (typeof session.resync !== 'function' || typeof session.projections?.truncate !== 'function') return false
  if (session.removed === true) session.removed = false
  session.projections.truncate(-1)
  await session.resync()
  return true
}
