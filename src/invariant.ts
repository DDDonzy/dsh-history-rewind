/**
 * Package-owned invariant companion for @deepseek-ai/dsh-history.
 * Canonical companion shape: { name, inject: ['invariants'], apply }.
 * Optional to mount: add a row
 *   - id: dsh-history-invariant / name: '@deepseek-ai/dsh-history/invariant' / inject: [invariants]
 * to a profile patch when package-level startup checks are wanted.
 *
 * NOTE: keep this file import-free — a shared import between the two lib
 * entries makes the bundler emit a third chunk that package.json `files`
 * would not ship.
 * @module @deepseek-ai/dsh-history/invariant
 */

const PACKAGE_NAME = '@deepseek-ai/dsh-history'

/** Keep in sync with src/constants.ts ROUTE_PREFIX. */
const ROUTE_PREFIX = '/dsh-history/api'

/** Cordis companion plugin name. */
const name = 'dsh-history-invariant'

/** Service required before the companion can reserve package ownership. */
const inject = ['invariants']

/** One startup check; a throw fails the invariant install. */
const install = (ctx: unknown, fail: (message: string) => never): void => {
  void ctx
  if (!ROUTE_PREFIX.startsWith('/dsh-history/')) fail(`ROUTE_PREFIX must stay under /dsh-history/`)
  if (ROUTE_PREFIX !== '/dsh-history/api') fail(`ROUTE_PREFIX drifted from /dsh-history/api`)
}

/** Apply the invariant installer. */
const apply = (ctx: { invariants: { register: (packageName: string, installer: typeof install) => unknown } }) =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install as never))

export { apply, inject, name, install, PACKAGE_NAME, ROUTE_PREFIX }
