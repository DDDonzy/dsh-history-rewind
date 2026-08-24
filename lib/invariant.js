//#region src/invariant.ts
/**

* Package-owned invariant companion for @deepseek-ai/dsh-history-rewind.

* Canonical companion shape: { name, inject: ['invariants'], apply }.

* Optional to mount: add a row

*   - id: dsh-history-rewind-invariant / name: '@deepseek-ai/dsh-history-rewind/invariant' / inject: [invariants]

* to a profile patch when package-level startup checks are wanted.

*

* NOTE: keep this file import-free — a shared import between the two lib

* entries makes the bundler emit a third chunk that package.json `files`

* would not ship.

* @module @deepseek-ai/dsh-history-rewind/invariant

*/
const PACKAGE_NAME = "@deepseek-ai/dsh-history-rewind";
/** Keep in sync with src/constants.ts ROUTE_PREFIX. */
const ROUTE_PREFIX = "/dsh-history-rewind/api";
/** Cordis companion plugin name. */
const name = "dsh-history-rewind-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/** One startup check; a throw fails the invariant install. */
const install = (ctx, fail) => {
	if (!ROUTE_PREFIX.startsWith("/dsh-history-rewind/")) fail(`ROUTE_PREFIX must stay under /dsh-history-rewind/`);
	if (ROUTE_PREFIX !== "/dsh-history-rewind/api") fail(`ROUTE_PREFIX drifted from /dsh-history-rewind/api`);
};
/** Apply the invariant installer. */
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));

//#endregion
export { PACKAGE_NAME, ROUTE_PREFIX, apply, inject, install, name };