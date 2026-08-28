/** Session-scoped one-shot gate for persisted /history command rows. */
const openedHistoryCommandKeys = new Set<string>()

/**
 * Claim one command for the auto-open action.
 *
 * Command rows are durable and remount when a session is revisited. A command
 * ID may open the panel once, but historical remounts must be inert.
 */
export function claimHistoryCommand(sessionId: string | undefined, commandId: string | undefined): boolean {
  if (commandId === undefined || commandId.length === 0) return false
  const key = `${sessionId ?? ''}:${commandId}`
  if (openedHistoryCommandKeys.has(key)) return false
  openedHistoryCommandKeys.add(key)
  return true
}
