/**
 * Shared in-session state for the checkout-style history model.
 *
 * Design (user-confirmed):
 *  - 跳转 = 只把会话文件换成目标内容；main 不动，git 里零新建（无标记提交、
 *    无 abandoned ref、无任何提交）。
 *  - 快照 = 把当前内容与"跳转目标"比对：
 *      相同 → 什么都不产生（连提交都没有）；
 *      不同 → 新建一条 branch（refs/heads/road-<ts>），提交（父=跳转目标），
 *            main 原路保持不动；此后继续对话的快照都提交在这条 road 上。
 *  - 当前会话所在的路 = 最新 road-<ts>（无 road 时 = main）——纯 git 可推导；
 *    唯一需要内存的是"跳转目标"本身（进程内即可；进程重启后丢失则按 git
 *    现有路提交——git 仍是唯一事实源，退化为"沿当前路提交"）。
 */

import { ROAD_REF_PREFIX } from './constants.ts'

/** Per-session in-memory jump target (commit sha), process-lifetime only. */
const jumpTargets = new Map<string, string>()

export { ROAD_REF_PREFIX }

/** Record the jump target for one session (set at rewind). */
export function setJumpTarget(sessionId: string, commit: string): void {
  jumpTargets.set(sessionId, commit)
}

/** Read the in-memory jump target, if any. */
export function getJumpTarget(sessionId: string): string | undefined {
  return jumpTargets.get(sessionId)
}

/** Clear the jump target (first changed snapshot consumed it). */
export function clearJumpTarget(sessionId: string): void {
  jumpTargets.delete(sessionId)
}

/**
 * Extract the numeric timestamp from a road ref name so the LATEST road is
 * unambiguous. Returns -1 for non-road names.
 * @param ref - full ref name.
 * @returns the embedded timestamp, or -1.
 */
export function roadTimestamp(ref: string): number {
  if (!ref.startsWith(ROAD_REF_PREFIX)) return -1
  const ts = Number(ref.slice(ROAD_REF_PREFIX.length))
  return Number.isFinite(ts) ? ts : -1
}
