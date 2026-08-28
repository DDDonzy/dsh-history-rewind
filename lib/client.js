window.__ModuleLoader__.load({ id: "dsh-history-rewind", factory: (require) => {
"use strict";
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
const react = __toESM(require("react"));
const react_dom = __toESM(require("react-dom"));
const react_dom_client = __toESM(require("react-dom/client"));

//#region src/constants.ts
/**

* Shared constants and plain data types for dsh-history-rewind.

*/
/** HTTP route prefix served by the Host half for the browser channel. */
const ROUTE_PREFIX = "/dsh-history-rewind/api";
/**

* Seed content for a workspace's `.gitignore` when a fresh workspace has none

* yet. This is ONLY a starting point written once per workspace — after that

* the workspace's own `.gitignore` is the sole source of truth for what a

* snapshot excludes; nothing here is merged into the walk at snapshot time.

*/
const DEFAULT_GITIGNORE_TEMPLATE = [".git"];
/** Settings namespace owned by this plugin (lowercase kebab-case per the seam). */
const SETTINGS_NAMESPACE = "history-rewind";
/** Schema defaults. */
const HISTORY_REWIND_DEFAULTS = {
	enabled: true,
	gitignoreTemplate: `${DEFAULT_GITIGNORE_TEMPLATE.join("\n")}\n`,
	cacheCapacityGb: 100
};
/** Usage ratio at which the capacity bar turns amber (healthy below this). */
const CACHE_WARN_RATIO = .75;
/** Usage ratio at which the capacity bar turns red. */
const CACHE_FULL_RATIO = .9;

//#endregion
//#region src/client/api.ts
/** POST helper returning parsed JSON, or null on transport failure/timeout. */
async function post(path, body, timeoutMs = 3e4) {
	try {
		const response = await fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs)
		});
		if (!response.ok) return null;
		const data = await response.json();
		return data !== null && typeof data === "object" ? data : null;
	} catch {
		return null;
	}
}
/** GET helper returning parsed JSON, or null on transport failure/timeout. */
async function get(path) {
	try {
		const response = await fetch(path, { signal: AbortSignal.timeout(3e4) });
		if (!response.ok) return null;
		const data = await response.json();
		return data !== null && typeof data === "object" ? data : null;
	} catch {
		return null;
	}
}
/** Fetch the git-graph timeline for one session. */
async function fetchTimeline(sessionId) {
	const data = await get(`${ROUTE_PREFIX}/timeline?sessionId=${encodeURIComponent(sessionId)}`);
	if (data === null) return {
		ok: false,
		reason: "transport"
	};
	const rows = Array.isArray(data.rows) ? data.rows.filter((row) => row !== null && typeof row === "object").map((row) => row) : void 0;
	return {
		ok: data.ok === true,
		...typeof data.reason === "string" ? { reason: data.reason } : {},
		...rows !== void 0 ? { rows } : {}
	};
}
/** Rewind one session to a timeline commit (session + optional workspace). */
async function rewind(sessionId, commit, restoreWorkspace, workspaceOnly = false) {
	const data = await post(`${ROUTE_PREFIX}/rewind`, {
		sessionId,
		commit,
		restoreWorkspace,
		workspaceOnly
	});
	if (data === null) return {
		ok: false,
		reason: "transport"
	};
	return {
		ok: data.ok === true,
		...typeof data.reason === "string" ? { reason: data.reason } : {},
		...typeof data.target === "string" ? { target: data.target } : {},
		...data.workspaceOnly === true ? { workspaceOnly: true } : {},
		...data.detached === true ? { detached: true } : {},
		...typeof data.error === "string" ? { error: data.error } : {},
		...data.backup !== null && typeof data.backup === "object" ? { backup: data.backup } : {},
		...data.noWorkspaceSnapshot === true ? { noWorkspaceSnapshot: true } : {},
		...data.workspaceRestored === true ? { workspaceRestored: true } : {},
		...data.backupCleanupFailed === true ? { backupCleanupFailed: true } : {}
	};
}
/** Take a manual snapshot now. */
async function manualSnapshot(sessionId) {
	const data = await post(`${ROUTE_PREFIX}/snapshot`, { sessionId });
	if (data === null) return {
		ok: false,
		reason: "transport"
	};
	return {
		ok: data.ok === true,
		...typeof data.reason === "string" ? { reason: data.reason } : {},
		...typeof data.commit === "string" ? { commit: data.commit } : {},
		...typeof data.wsCommit === "string" ? { wsCommit: data.wsCommit } : {},
		...typeof data.snap === "string" ? { snap: data.snap } : {},
		...typeof data.turn === "number" ? { turn: data.turn } : {}
	};
}
/** Query whether git is available on the host. */
async function gitStatus() {
	const data = await get(`${ROUTE_PREFIX}/git-status`);
	if (data === null) return {
		ok: false,
		available: false
	};
	return {
		ok: data.ok === true,
		available: data.available === true,
		...typeof data.version === "string" ? { version: data.version } : {},
		...typeof data.message === "string" ? { message: data.message } : {}
	};
}
/** Ask the host to attempt a silent git install. */
async function installGit() {
	const data = await post(`${ROUTE_PREFIX}/install-git`, {});
	if (data === null) return {
		ok: false,
		message: "transport"
	};
	return {
		ok: data.ok === true,
		...data.installed === true ? { installed: true } : {},
		...typeof data.detail === "string" ? { detail: data.detail } : {},
		...typeof data.message === "string" ? { message: data.message } : {}
	};
}
/** Read the current global config. */
async function getConfig() {
	const data = await get(`${ROUTE_PREFIX}/config`);
	if (data === null) return { ok: false };
	return {
		ok: data.ok === true,
		...typeof data.gitignoreTemplate === "string" ? { gitignoreTemplate: data.gitignoreTemplate } : {},
		...typeof data.cacheCapacityGb === "number" ? { cacheCapacityGb: data.cacheCapacityGb } : {}
	};
}
/**

* Save the global default `.gitignore` template. This only seeds a

* workspace's `.gitignore` the FIRST time that workspace is snapshotted and

* has none yet — it never touches an existing `.gitignore`, including one

* this same template seeded earlier.

*/
async function setConfig(gitignoreTemplate) {
	const data = await post(`${ROUTE_PREFIX}/config`, { gitignoreTemplate });
	if (data === null) return {
		ok: false,
		reason: "transport"
	};
	return {
		ok: data.ok === true,
		...typeof data.reason === "string" ? { reason: data.reason } : {}
	};
}
/** Save the advisory cache capacity, in GB. */
async function setCacheCapacity(cacheCapacityGb) {
	const data = await post(`${ROUTE_PREFIX}/config`, { cacheCapacityGb });
	if (data === null) return {
		ok: false,
		reason: "transport"
	};
	return {
		ok: data.ok === true,
		...typeof data.reason === "string" ? { reason: data.reason } : {}
	};
}
/** Read current shadow-store usage. */
async function getCacheUsage() {
	const data = await get(`${ROUTE_PREFIX}/cache`);
	if (data === null || data.ok !== true) return null;
	const num = (v) => typeof v === "number" && Number.isFinite(v) ? v : 0;
	return {
		ok: true,
		sessionBytes: num(data.sessionBytes),
		workspaceBytes: num(data.workspaceBytes),
		backupsBytes: num(data.backupsBytes),
		totalBytes: num(data.totalBytes),
		capacityBytes: num(data.capacityBytes)
	};
}
/** Get list of all sessions that have shadow store data. */
async function getCacheSessions() {
	const data = await get(`${ROUTE_PREFIX}/cache/sessions`);
	if (data === null || data.ok !== true) return { ok: false };
	return {
		ok: true,
		sessions: Array.isArray(data.sessions) ? data.sessions : []
	};
}
/**

* Clear the shadow store for one or both areas, optionally scoped to specific sessions.

* IRREVERSIBLE: this drops the rewind history itself, not just cached derivatives.

*/
async function clearCache(scope, sessionIds) {
	const data = await post(`${ROUTE_PREFIX}/cache/clear`, {
		scope,
		sessionIds
	});
	if (data === null) return {
		ok: false,
		reason: "transport"
	};
	return {
		ok: data.ok === true,
		...typeof data.freedBytes === "number" ? { freedBytes: data.freedBytes } : {},
		...typeof data.failed === "number" ? { failed: data.failed } : {},
		...typeof data.reason === "string" ? { reason: data.reason } : {}
	};
}

//#endregion
//#region src/client/layout.ts
/** Ancestors of `headSha` within the given rows (the current/main road). */
function roadSet(rows, headSha) {
	const set = new Set();
	if (headSha === null) return set;
	const bySha = new Map(rows.map((row) => [row.sha, row]));
	const stack = [headSha];
	while (stack.length > 0) {
		const sha = stack.pop();
		if (set.has(sha)) continue;
		const row = bySha.get(sha);
		if (row === void 0) continue;
		set.add(sha);
		for (const parent of row.parents) stack.push(parent);
	}
	return set;
}
/**

* Lane assignment (fork-only histories).

* @param rows - timeline rows, newest first (as `git log` serves them).

* @param headSha - optional main-tip commit; its road keeps the parent lane at forks.

* @returns row + lane layout, oldest first.

*/
function layoutGraph(rows, headSha = null) {
	const order = rows.slice().reverse();
	const shaToRow = new Map();
	for (const row of order) shaToRow.set(row.sha, row);
	const mainRoad = roadSet(rows, headSha);
	const lane = new Map();
	const process = (row) => {
		if (lane.has(row.sha)) return;
		if (row.parents.length === 0) {
			lane.set(row.sha, 0);
			return;
		}
		const parent = row.parents[0];
		process(shaToRow.get(parent));
		const parentLane = lane.get(parent);
		const siblings = order.filter((r) => r.parents.includes(parent));
		const sorted = siblings.slice().sort((a, b) => {
			const aMain = mainRoad.has(a.sha) ? 0 : 1;
			const bMain = mainRoad.has(b.sha) ? 0 : 1;
			if (aMain !== bMain) return aMain - bMain;
			return order.indexOf(a) - order.indexOf(b);
		});
		lane.set(row.sha, parentLane + Math.max(0, sorted.findIndex((r) => r.sha === row.sha)));
	};
	for (const row of order) process(row);
	const lanes = Math.max(0, ...order.map((row) => lane.get(row.sha) ?? 0)) + 1;
	return {
		rows: order.map((row) => ({
			...row,
			lane: lane.get(row.sha) ?? 0
		})),
		lanes
	};
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
function buildGraph(rows, headSha = null) {
	const laid = layoutGraph(rows, headSha);
	const laneOf = new Map();
	for (const row of laid.rows) laneOf.set(row.sha, row.lane);
	const headRoad = roadSet(rows, headSha);
	const display = laid.rows.slice().reverse();
	const open = new Map();
	const built = [];
	for (const row of display) {
		const nodeLane = laneOf.get(row.sha) ?? 0;
		const near = [];
		for (const [lane, owner] of open) if (owner.parent === row.sha) near.push({
			from: lane,
			to: nodeLane,
			lane,
			childSha: owner.child,
			parentSha: row.sha
		});
		else near.push({
			from: lane,
			to: lane,
			lane,
			childSha: owner.child,
			parentSha: owner.parent
		});
		for (const [lane, owner] of [...open]) if (owner.parent === row.sha) open.delete(lane);
		const parent = row.parents[0];
		if (parent !== void 0) open.set(nodeLane, {
			parent,
			child: row.sha
		});
		else open.delete(nodeLane);
		const far = [];
		for (const [lane, owner] of open) far.push({
			from: lane,
			to: lane,
			lane,
			childSha: owner.child,
			parentSha: owner.parent
		});
		built.push({
			row,
			lane: nodeLane,
			near,
			far
		});
	}
	const out = built.slice().reverse().map((entry) => ({
		...entry.row,
		lane: entry.lane,
		topEdges: entry.far,
		bottomEdges: entry.near.map((edge) => ({
			...edge,
			from: edge.to,
			to: edge.from
		})),
		isHeadRoad: headRoad.has(entry.row.sha)
	}));
	const headLanes = [];
	for (const row of out) if (row.isHeadRoad && !headLanes.includes(row.lane)) headLanes.push(row.lane);
	return {
		rows: out,
		lanes: laid.lanes,
		headLanes
	};
}

//#endregion
//#region src/client/styles.ts
/**

* Injected styles for the dsh-history timeline panel.

* Clean, flat list-table style strictly adhering to DSH Trajectory & DevTools aesthetics.

* Left: CHECK POINT / USER+ASST message lines.

* Right: Two-line stack (Top: TURN N + highlighted commit id code badge + HEAD; Bottom: relative time).

*/
const STYLES = [
	"/* Floating Trigger Button (DSH capsule) */",
	".dsh-history-trigger {",
	"  position: fixed;",
	"  right: 20px;",
	"  bottom: 20px;",
	"  z-index: 9999;",
	"  display: inline-flex;",
	"  align-items: center;",
	"  gap: 6px;",
	"  height: 36px;",
	"  padding: 0 14px;",
	"  background: var(--dsw-alias-button-tool-bar-fill, var(--dsw-alias-bg-layer-2, #2d2d2e));",
	"  color: var(--dsw-alias-label-primary, #e6e6e6);",
	"  border: none;",
	"  border-radius: 18px;",
	"  font-family: inherit;",
	"  font-size: 14px;",
	"  font-weight: 500;",
	"  cursor: pointer;",
	"  box-shadow: var(--dsw-shadow-lv3, 0 2px 10px rgba(0, 0, 0, 0.35));",
	"  transition: background 0.1s ease, color 0.1s ease;",
	"  user-select: none;",
	"}",
	".dsh-history-trigger:hover {",
	"  background: var(--dsw-alias-button-tool-bar-hover, #3a3a3b);",
	"  color: #ffffff;",
	"}",
	".dsh-history-trigger:active {",
	"  background: var(--dsw-alias-interactive-bg-active, rgba(255, 255, 255, 0.08));",
	"}",
	"/* Session-header HISTORY action (DSH header action row geometry). */",
	".dsh-history-header-action {",
	"  min-height: 28px;",
	"  display: inline-flex;",
	"  align-items: center;",
	"  gap: 5px;",
	"  padding: 3px 8px;",
	"  border: 0;",
	"  border-radius: 6px;",
	"  background: transparent;",
	"  color: var(--dsw-alias-label-tertiary, #9a9aa0);",
	"  font-family: inherit;",
	"  font-size: 12px;",
	"  line-height: 18px;",
	"  font-weight: 500;",
	"  letter-spacing: 0.06em;",
	"  cursor: pointer;",
	"  user-select: none;",
	"  transform-origin: center;",
	"  transition: color 0.12s ease, transform 0.12s ease;",
	"}",
	".dsh-history-header-action:hover,",
	".dsh-history-header-action:focus-visible {",
	"  color: var(--dsw-alias-label-primary, #f5f5f7);",
	"  transform: scale(1.1);",
	"}",
	".dsh-history-header-action svg {",
	"  flex: none;",
	"}",
	".dsh-history-header-action:hover svg {",
	"  transform: none;",
	"}",
	"[class*=\"sessionLogButton\"] {",
	"  min-height: 28px;",
	"  height: auto;",
	"  min-width: 0;",
	"  border: 0;",
	"  border-radius: 6px;",
	"  background: transparent !important;",
	"  color: var(--dsw-alias-label-tertiary, #9a9aa0);",
	"  padding: 3px 8px;",
	"  font-size: 12px;",
	"  line-height: 18px;",
	"  font-weight: 500;",
	"  letter-spacing: 0.06em;",
	"  gap: 5px;",
	"  flex-direction: row-reverse;",
	"  text-transform: uppercase;",
	"  transform-origin: center;",
	"  transition: color 0.12s ease, transform 0.12s ease;",
	"}",
	"[class*=\"sessionLogButton\"]:hover:not(:disabled) {",
	"  background: transparent !important;",
	"  color: var(--dsw-alias-label-primary, #f5f5f7);",
	"  transform: scale(1.1);",
	"}",
	".dsh-history-modal-backdrop {",
	"  position: fixed;",
	"  inset: 0;",
	"  z-index: 10000;",
	"  background: transparent;",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: center;",
	"  padding: 24px 16px;",
	"  pointer-events: auto;",
	"  animation: dshFadeIn 0.2s ease-out;",
	"}",
	".dsh-history-modal-blur {",
	"  position: fixed;",
	"  z-index: 0;",
	"  pointer-events: none;",
	"  backdrop-filter: blur(8px);",
	"  -webkit-backdrop-filter: blur(8px);",
	"  backdrop-filter: blur(8px);",
	"  -webkit-backdrop-filter: blur(8px);",
	"  transition: backdrop-filter 0.5s cubic-bezier(0.16, 1, 0.3, 1), -webkit-backdrop-filter 0.5s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.5s ease-out;",
	"  will-change: backdrop-filter, opacity;",
	"  animation: dshBlurIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;",
	"}",
	"@keyframes dshBlurIn {",
	"  from {",
	"    backdrop-filter: blur(0px);",
	"    -webkit-backdrop-filter: blur(0px);",
	"    opacity: 0;",
	"  }",
	"  to {",
	"    backdrop-filter: blur(8px);",
	"    -webkit-backdrop-filter: blur(8px);",
	"    opacity: 1;",
	"  }",
	"}",
	"@keyframes dshFadeIn {",
	"  from { opacity: 0; }",
	"  to { opacity: 1; }",
	"}",
	"@keyframes dshSlideUp {",
	"  from { opacity: 0; transform: translateY(8px); }",
	"  to { opacity: 1; transform: translateY(0); }",
	"}",
	".dsh-history-modal-card {",
	"  position: relative;",
	"  z-index: 1;",
	"  width: min(900px, 94vw);",
	"  height: 85vh;",
	"  max-height: 85vh;",
	"  display: flex;",
	"  flex-direction: column;",
	"  background: transparent !important;",
	"  border: none !important;",
	"  box-shadow: none !important;",
	"  overflow: visible;",
	"  color: var(--dsw-alias-label-primary, #e6e6e6);",
	"  font-family: inherit;",
	"}",
	"/* Header floating controls */",
	".dsh-history-modal-head {",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: flex-end;",
	"  padding: 0 0 12px 0;",
	"  gap: 12px;",
	"}",
	".dsh-history-modal-head-title {",
	"  display: flex;",
	"  align-items: center;",
	"  gap: 8px;",
	"  font-size: 16px;",
	"  line-height: 24px;",
	"  font-weight: 500;",
	"  color: var(--dsw-alias-label-primary, #f3f3f3);",
	"}",
	".dsh-history-toolbar {",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: space-between;",
	"  padding: 6px 16px;",
	"  background: transparent;",
	"  gap: 12px;",
	"}",
	".dsh-history-toolbar-stats {",
	"  display: flex;",
	"  align-items: center;",
	"  gap: 6px;",
	"  font-size: 12px;",
	"  color: var(--dsw-alias-label-secondary, #888888);",
	"}",
	"/* Panel & Timeline Floating Cards Body */",
	".dsh-history-panel {",
	"  display: flex;",
	"  flex-direction: column;",
	"  flex: 1 1 auto;",
	"  height: 100%;",
	"  max-height: 100%;",
	"  min-height: 0;",
	"  position: relative;",
	"  background: transparent !important;",
	"}",
	".dsh-history-modal-body {",
	"  flex: 1;",
	"  min-height: 0;",
	"  overflow-y: auto;",
	"  overflow-x: hidden;",
	"  padding: 12px 10px 40px 10px;",
	"  display: flex;",
	"  flex-direction: column;",
	"  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 28px, #000 calc(100% - 28px), transparent 100%);",
	"  mask-image: linear-gradient(to bottom, transparent 0, #000 28px, #000 calc(100% - 28px), transparent 100%);",
	"}",
	".dsh-history-modal-body > :first-child {",
	"  margin-top: auto;",
	"}",
	".dsh-history-modal-body > :last-child {",
	"  margin-bottom: auto;",
	"}",
	".dsh-history-modal-body::-webkit-scrollbar {",
	"  width: 6px;",
	"}",
	".dsh-history-modal-body::-webkit-scrollbar-track {",
	"  background: transparent;",
	"}",
	".dsh-history-modal-body::-webkit-scrollbar-thumb {",
	"  background: transparent;",
	"  border-radius: 3px;",
	"}",
	".dsh-history-modal-body.is-scrolling::-webkit-scrollbar-thumb,",
	".dsh-history-modal-body.is-near-bar::-webkit-scrollbar-thumb {",
	"  background: rgba(255, 255, 255, 0.15);",
	"}",
	".dsh-history-modal-body.is-scrolling::-webkit-scrollbar-thumb:hover,",
	".dsh-history-modal-body.is-near-bar::-webkit-scrollbar-thumb:hover {",
	"  background: rgba(255, 255, 255, 0.28);",
	"}",
	"/* Firefox: no pseudo-element control, so use the standard properties. */",
	".dsh-history-modal-body {",
	"  scrollbar-width: thin;",
	"  scrollbar-color: transparent transparent;",
	"}",
	".dsh-history-modal-body.is-scrolling,",
	".dsh-history-modal-body.is-near-bar {",
	"  scrollbar-color: rgba(255, 255, 255, 0.22) transparent;",
	"}",
	"/* Floating Timeline Row & Card Styling */",
	".dsh-history-row {",
	"  display: flex;",
	"  align-items: stretch;",
	"  gap: 12px;",
	"  cursor: pointer;",
	"  padding: 0;",
	"  margin: 0;",
	"  border: none;",
	"  position: relative;",
	"  background: transparent !important;",
	"}",
	".dsh-history-list {",
	"  position: relative;",
	"  display: flex;",
	"  flex-direction: column;",
	"}",
	".dsh-history-graph-overlay {",
	"  position: absolute;",
	"  top: 0;",
	"  left: 0;",
	"  pointer-events: none;",
	"  overflow: visible;",
	"  background: transparent;",
	"  filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.4));",
	"}",
	"/* Reserved gutter each row leaves for the graph overlay. */",
	".dsh-history-gutter {",
	"  flex: none;",
	"  align-self: stretch;",
	"}",
	".dsh-history-node {",
	"  transition: r 0.12s ease;",
	"}",
	"/* Floating Card Component */",
	".dsh-history-row-content {",
	"  display: flex;",
	"  align-items: flex-end;",
	"  justify-content: space-between;",
	"  min-width: 0;",
	"  flex: 1;",
	"  gap: 14px;",
	"  padding: 10px 16px;",
	"  margin: 4px 0;",
	"  background: var(--dsw-alias-bg-layer-2, rgba(38, 38, 42, 0.94));",
	"  border: 1px solid var(--dsw-alias-border-inverted, rgba(255, 255, 255, 0.12));",
	"  border-radius: 14px;",
	"  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);",
	"  transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;",
	"}",
	".dsh-history-row:hover .dsh-history-row-content {",
	"  background: var(--dsw-alias-bg-layer-3, rgba(58, 58, 64, 0.97));",
	"  border-color: rgba(255, 255, 255, 0.25);",
	"  transform: translateY(-1px);",
	"  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);",
	"}",
	".dsh-history-row.is-selected .dsh-history-row-content {",
	"  background: rgba(46, 66, 112, 0.96) !important;",
	"  border-color: rgba(77, 136, 255, 0.6) !important;",
	"  box-shadow: 0 0 16px rgba(77, 136, 255, 0.35);",
	"}",
	".dsh-history-row-main {",
	"  display: flex;",
	"  flex-direction: column;",
	"  justify-content: center;",
	"  min-width: 0;",
	"  flex: 1;",
	"  gap: 4px;",
	"}",
	"/* Badges */",
	".dsh-badge {",
	"  display: inline-flex;",
	"  align-items: center;",
	"  padding: 0 4px;",
	"  border-radius: 2px;",
	"  font-size: 10px;",
	"  font-family: var(--ds-font-family-code, monospace);",
	"  font-weight: 600;",
	"  line-height: 14px;",
	"  letter-spacing: 0.02em;",
	"}",
	".dsh-badge-head {",
	"  background: var(--dsw-alias-brand-primary, #4d88ff);",
	"  color: #ffffff;",
	"}",
	".dsh-badge-turn {",
	"  background: rgba(255, 255, 255, 0.08);",
	"  color: var(--dsw-alias-label-secondary, #bbbbbb);",
	"  font-weight: 600;",
	"}",
	".dsh-badge-turn-start {",
	"  background: rgba(16, 185, 129, 0.15);",
	"  color: #34d399;",
	"  font-size: 10px;",
	"  line-height: 14px;",
	"}",
	".dsh-badge-turn-end {",
	"  background: rgba(77, 136, 255, 0.15);",
	"  color: #70a1ff;",
	"}",
	".dsh-badge-manual {",
	"  background: rgba(245, 158, 11, 0.15);",
	"  color: #fbbf24;",
	"}",
	".dsh-badge-rewind {",
	"  background: rgba(236, 72, 153, 0.15);",
	"  color: #f472b6;",
	"}",
	"/* Commit SHA Highlight Badge */",
	".dsh-history-sha-badge {",
	"  font-family: var(--ds-font-family-code, monospace);",
	"  font-size: 10px;",
	"  line-height: 14px;",
	"  color: var(--dsw-alias-label-primary, #e2e8f0);",
	"  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.08));",
	"  border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.12));",
	"  padding: 0 4px;",
	"  border-radius: 3px;",
	"  letter-spacing: 0.02em;",
	"}",
	"/* Message lines */",
	".dsh-history-msg-list {",
	"  display: flex;",
	"  flex-direction: column;",
	"  gap: 2px;",
	"  min-width: 0;",
	"}",
	".dsh-history-msg-item {",
	"  display: flex;",
	"  align-items: center;",
	"  gap: 6px;",
	"  min-width: 0;",
	"}",
	".dsh-history-msg-role {",
	"  flex: none;",
	"  font: 600 10px/14px var(--ds-font-family-code, monospace);",
	"  padding: 0 4px;",
	"  border-radius: 2px;",
	"  letter-spacing: 0.02em;",
	"}",
	".dsh-history-msg-role-user {",
	"  color: #70a1ff;",
	"  background: rgba(77, 136, 255, 0.15);",
	"}",
	".dsh-history-msg-role-asst {",
	"  color: #c084fc;",
	"  background: rgba(192, 132, 252, 0.15);",
	"}",
	".dsh-history-msg-text {",
	"  min-width: 0;",
	"  overflow: hidden;",
	"  text-overflow: ellipsis;",
	"  white-space: nowrap;",
	"  color: var(--dsw-alias-label-primary, #dddddd);",
	"  font: 11.5px/16px var(--ds-font-family-code, monospace);",
	"}",
	"/* Single-line checkpoint / manual text */",
	".dsh-history-single-line {",
	"  display: flex;",
	"  align-items: center;",
	"  flex-wrap: wrap;",
	"  gap: 6px;",
	"  min-width: 0;",
	"}",
	".dsh-history-single-text {",
	"  color: var(--dsw-alias-label-secondary, #999999);",
	"  font: 11.5px/16px var(--ds-font-family-code, monospace);",
	"  overflow: hidden;",
	"  text-overflow: ellipsis;",
	"  white-space: nowrap;",
	"}",
	"/* Changed-file chips on CHECK POINT / TURN rows: one highlighted block per file. */",
	".dsh-history-file-list {",
	"  display: flex;",
	"  flex-wrap: nowrap;",
	"  align-items: center;",
	"  gap: 4px;",
	"  min-width: 0;",
	"}",
	".dsh-history-file-chip {",
	"  flex: none;",
	"  display: inline-flex;",
	"  align-items: center;",
	"  padding: 0 7px;",
	"  border-radius: 3px;",
	"  font-size: 10px;",
	"  font-family: var(--ds-font-family-code, monospace);",
	"  font-weight: 600;",
	"  line-height: 15px;",
	"  letter-spacing: 0.02em;",
	"  color: #14141a;",
	"  background: #c8c8ce;",
	"  white-space: nowrap;",
	"}",
	"/* Overflow indicator (\"+N\"): same mark, dimmed so it reads as a count. */",
	".dsh-history-file-chip.is-more {",
	"  color: #2e2e36;",
	"  background: rgba(200, 200, 206, 0.58);",
	"}",
	"/* TURN rows: the changed-file line indents to the message TEXT column so it",
	"   aligns with the USER/ASST content (not with the role badges). The spacer",
	"   reuses the badge font so 4ch measures exactly the USER/ASST label width,",
	"   plus the badge padding (2x4px) and the 6px item gap. */",
	".dsh-history-file-indent {",
	"  flex: none;",
	"  width: calc(4ch + 14px);",
	"  font: 600 10px/14px var(--ds-font-family-code, monospace);",
	"}",
	".dsh-history-file-clip {",
	"  display: flex;",
	"  flex-wrap: nowrap;",
	"  align-items: center;",
	"  gap: 4px;",
	"  overflow: hidden;",
	"  min-width: 0;",
	"  flex: 1;",
	"}",
	".dsh-history-file-clip .dsh-history-file-chip {",
	"  flex: 0 1 auto;",
	"  min-width: 0;",
	"  overflow: hidden;",
	"  text-overflow: ellipsis;",
	"}",
	"/* Right Side Meta Info: `` id badge + relative time, one right-aligned line */",
	".dsh-history-row-side {",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: flex-end;",
	"  flex: none;",
	"  gap: 6px;",
	"}",
	".dsh-history-time {",
	"  color: var(--dsw-alias-label-secondary, #737373);",
	"  font-size: 9.5px;",
	"  line-height: 12px;",
	"  opacity: 0.85;",
	"}",
	"/* Buttons: DSH capsule geometry (figma Button 1:155 — r18, h36, pad 14). */",
	".dsh-history-button {",
	"  display: inline-flex;",
	"  align-items: center;",
	"  justify-content: center;",
	"  gap: 4px;",
	"  border: none;",
	"  border-radius: 18px;",
	"  height: 36px;",
	"  padding: 0 14px;",
	"  font-family: inherit;",
	"  font-size: 14px;",
	"  line-height: 22px;",
	"  color: var(--dsw-alias-label-primary, #e6e6e6);",
	"  background: transparent;",
	"  cursor: pointer;",
	"  transition: background 0.1s ease, color 0.1s ease;",
	"  user-select: none;",
	"}",
	".dsh-history-button:hover:not(:disabled) {",
	"  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06));",
	"}",
	".dsh-history-button:active:not(:disabled) {",
	"  background: var(--dsw-alias-interactive-bg-active, rgba(255, 255, 255, 0.08));",
	"}",
	".dsh-history-button:disabled {",
	"  cursor: not-allowed;",
	"  opacity: 0.4;",
	"}",
	".dsh-history-button.primary {",
	"  background: var(--dsw-alias-brand-primary, #4d88ff);",
	"  color: #ffffff;",
	"}",
	".dsh-history-button.primary:hover:not(:disabled) {",
	"  background: var(--dsw-alias-brand-primary-new-colorprimary-new-color, #3b74e6);",
	"}",
	".dsh-history-button.outline {",
	"  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.25));",
	"  background: transparent;",
	"}",
	".dsh-history-button.outline:hover:not(:disabled) {",
	"  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06));",
	"}",
	".dsh-history-button.sm {",
	"  height: 28px;",
	"  font-size: 12px;",
	"  line-height: 18px;",
	"  padding: 0 10px;",
	"  border-radius: 14px;",
	"}",
	"/* Bottom Dock / Rewind Action Strip */",
	".dsh-history-action-dock {",
	"  background: var(--dsw-alias-bg-layer-1, #232324);",
	"  border-top: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12));",
	"  padding: 8px 14px;",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: space-between;",
	"  gap: 12px;",
	"  animation: dshFadeIn 0.1s ease-out;",
	"}",
	".dsh-history-action-info {",
	"  display: flex;",
	"  align-items: center;",
	"  gap: 12px;",
	"  min-width: 0;",
	"  flex: 1;",
	"}",
	".dsh-history-action-title {",
	"  font-size: 12px;",
	"  font-weight: 600;",
	"  color: var(--dsw-alias-label-primary, #ffffff);",
	"  white-space: nowrap;",
	"}",
	".dsh-history-check {",
	"  display: inline-flex;",
	"  align-items: center;",
	"  gap: 5px;",
	"  cursor: pointer;",
	"  color: var(--dsw-alias-label-primary, #cccccc);",
	"  font-size: 11.5px;",
	"  user-select: none;",
	"  white-space: nowrap;",
	"}",
	".dsh-history-check input[type=\"checkbox\"] {",
	"  cursor: pointer;",
	"  accent-color: var(--dsw-alias-brand-primary, #4d88ff);",
	"  margin: 0;",
	"}",
	".dsh-history-actions {",
	"  display: flex;",
	"  gap: 6px;",
	"  align-items: center;",
	"  flex: none;",
	"}",
	"/* Modal Footer */",
	".dsh-history-modal-foot {",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: space-between;",
	"  padding: 6px 14px;",
	"  background: var(--dsw-specific-sidebar-fill, #181818);",
	"  border-top: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));",
	"  font-size: 11px;",
	"}",
	".dsh-history-hint {",
	"  color: var(--dsw-alias-label-secondary, #888888);",
	"  font-size: 11px;",
	"  line-height: 1.4;",
	"  white-space: pre-wrap;",
	"}",
	"/* Dialog (figma 451:18655): r24, shadow-lv3, layer-2 fill, inverted border. */",
	".dsh-history-dialog {",
	"  display: flex;",
	"  flex-direction: column;",
	"  gap: 20px;",
	"  width: min(400px, 100%);",
	"  padding: 0 0 24px;",
	"  overflow: hidden;",
	"  border: 1px solid var(--dsw-alias-border-inverted, rgba(255, 255, 255, 0.18));",
	"  border-radius: 24px;",
	"  background: var(--dsw-alias-bg-layer-2, #252526);",
	"  box-shadow: var(--dsw-shadow-lv3, 0 8px 24px rgba(0, 0, 0, 0.5));",
	"}",
	".dsh-history-dialog-head {",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: space-between;",
	"  gap: 8px;",
	"  padding: 22px 14px 0 24px;",
	"}",
	".dsh-history-dialog-title {",
	"  margin: 0;",
	"  font-size: 16px;",
	"  line-height: 24px;",
	"  font-weight: 500;",
	"  color: var(--dsw-alias-label-primary, #f3f3f3);",
	"}",
	".dsh-history-dialog-close {",
	"  flex: none;",
	"  display: inline-flex;",
	"  align-items: center;",
	"  justify-content: center;",
	"  width: 28px;",
	"  height: 28px;",
	"  border: none;",
	"  border-radius: 8px;",
	"  background: transparent;",
	"  cursor: pointer;",
	"  color: var(--dsw-alias-label-secondary, #999999);",
	"  transform-origin: center;",
	"  transition: color 0.12s ease, transform 0.12s ease, background 0.12s ease;",
	"}",
	".dsh-history-dialog-close:hover {",
	"  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.1));",
	"  color: var(--dsw-alias-label-primary, #f5f5f7);",
	"  transform: scale(1.1);",
	"}",
	".dsh-history-dialog-body {",
	"  display: flex;",
	"  flex-direction: column;",
	"  gap: 8px;",
	"  padding: 0 24px;",
	"}",
	".dsh-history-dialog-description {",
	"  margin: 0;",
	"  padding: 0 24px;",
	"  font-size: 14px;",
	"  line-height: 22px;",
	"  color: var(--dsw-alias-label-primary, #e6e6e6);",
	"}",
	".dsh-history-dialog-foot {",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: flex-end;",
	"  gap: 8px;",
	"  padding: 0 24px;",
	"}",
	".dsh-history-input {",
	"  background: var(--dsw-alias-bg-base, #1e1e1e);",
	"  color: var(--dsw-alias-label-primary, #e6e6e6);",
	"  border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.15));",
	"  border-radius: 3px;",
	"  padding: 3px 6px;",
	"  font-size: 11px;",
	"  font-family: var(--ds-font-family-code, monospace);",
	"  width: 100%;",
	"  box-sizing: border-box;",
	"  outline: none;",
	"}",
	".dsh-history-input:focus {",
	"  border-color: var(--dsw-alias-brand-primary, #4d88ff);",
	"}",
	".dsh-history-label {",
	"  color: var(--dsw-alias-label-secondary, #999999);",
	"  font-size: 11px;",
	"}",
	".dsh-history-progress-mask {",
	"  position: fixed;",
	"  inset: 0;",
	"  z-index: 10001;",
	"  background: rgba(0, 0, 0, 0.45);",
	"  backdrop-filter: blur(8px);",
	"  -webkit-backdrop-filter: blur(8px);",
	"  opacity: 1;",
	"  animation: dshMaskFadeIn 0.2s ease-out;",
	"  transition: opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1), backdrop-filter 0.4s cubic-bezier(0.16, 1, 0.3, 1);",
	"}",
	"@keyframes dshMaskFadeIn {",
	"  from { opacity: 0; }",
	"  to { opacity: 1; }",
	"}",
	"/* Rewind progress card: centered DSH-style status card, spinner + text */",
	".dsh-history-progress-card {",
	"  position: fixed;",
	"  top: 50%;",
	"  left: 50%;",
	"  transform: translate(-50%, -50%) scale(1);",
	"  z-index: 10002;",
	"  display: flex;",
	"  align-items: center;",
	"  gap: 16px;",
	"  min-width: 260px;",
	"  max-width: 400px;",
	"  padding: 22px 28px;",
	"  border-radius: 20px;",
	"  background: var(--dsw-alias-bg-layer-2, #252526);",
	"  border: 1px solid var(--dsw-alias-border-inverted, rgba(255, 255, 255, 0.18));",
	"  box-shadow: var(--dsw-shadow-lv3, 0 16px 48px rgba(0, 0, 0, 0.55));",
	"  opacity: 1;",
	"  animation: dshCardPopIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);",
	"  transition: opacity 0.35s cubic-bezier(0.16, 1, 0.3, 1), transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);",
	"}",
	"@keyframes dshCardPopIn {",
	"  from {",
	"    opacity: 0;",
	"    transform: translate(-50%, -46%) scale(0.96);",
	"  }",
	"  to {",
	"    opacity: 1;",
	"    transform: translate(-50%, -50%) scale(1);",
	"  }",
	"}",
	".dsh-history-progress-spin {",
	"  width: 22px;",
	"  height: 22px;",
	"  flex: none;",
	"  border-radius: 50%;",
	"  border: 2.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.18));",
	"  border-top-color: var(--dsw-alias-brand-primary, #4d88ff);",
	"  animation: dshHistorySpin 0.85s linear infinite;",
	"}",
	"@keyframes dshHistorySpin {",
	"  to { transform: rotate(360deg); }",
	"}",
	".dsh-history-progress-done {",
	"  width: 22px;",
	"  height: 22px;",
	"  flex: none;",
	"  display: inline-flex;",
	"  align-items: center;",
	"  justify-content: center;",
	"  border-radius: 50%;",
	"  background: var(--dsw-alias-state-success-primary, #34d399);",
	"  color: #0a0a0a;",
	"  font-size: 13px;",
	"  font-weight: 700;",
	"}",
	".dsh-history-progress-text {",
	"  display: flex;",
	"  flex-direction: column;",
	"  gap: 5px;",
	"}",
	".dsh-history-progress-title {",
	"  color: var(--dsw-alias-label-primary, #e6e6e6);",
	"  font-size: 14px;",
	"  font-weight: 600;",
	"  line-height: 1.2;",
	"}",
	".dsh-history-progress-sha {",
	"  font-family: var(--ds-font-family-code, monospace);",
	"  font-size: 12px;",
	"  color: var(--dsw-alias-label-secondary, #999999);",
	"}",
	"/* State Card (Loading / Empty / Error) */",
	".dsh-history-state-container {",
	"  flex: 1;",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: center;",
	"  padding: 24px;",
	"  min-height: 280px;",
	"  width: 100%;",
	"}",
	".dsh-history-state-card {",
	"  position: relative;",
	"  width: min(440px, 92vw);",
	"  padding: 32px 28px 24px;",
	"  border-radius: 16px;",
	"  display: flex;",
	"  flex-direction: column;",
	"  align-items: center;",
	"  text-align: center;",
	"  background: rgba(22, 22, 26, 0.88);",
	"  backdrop-filter: blur(24px);",
	"  -webkit-backdrop-filter: blur(24px);",
	"  border: 1px solid rgba(255, 255, 255, 0.1);",
	"  box-shadow: 0 24px 48px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.05);",
	"  animation: dshSlideUp 0.2s cubic-bezier(0.16, 1, 0.3, 1);",
	"}",
	".dsh-history-state-close {",
	"  position: absolute;",
	"  top: 12px;",
	"  right: 12px;",
	"  width: 28px;",
	"  height: 28px;",
	"  border-radius: 50%;",
	"  border: none;",
	"  background: rgba(255, 255, 255, 0.06);",
	"  color: #888;",
	"  cursor: pointer;",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: center;",
	"  font-size: 13px;",
	"  transition: background 0.15s, color 0.15s;",
	"}",
	".dsh-history-state-close:hover {",
	"  background: rgba(255, 255, 255, 0.15);",
	"  color: #fff;",
	"}",
	".dsh-history-state-icon {",
	"  width: 52px;",
	"  height: 52px;",
	"  border-radius: 50%;",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: center;",
	"  margin-bottom: 16px;",
	"}",
	".dsh-history-state-icon.is-empty {",
	"  background: radial-gradient(circle, rgba(99, 102, 241, 0.22) 0%, rgba(99, 102, 241, 0.06) 70%);",
	"  border: 1px solid rgba(99, 102, 241, 0.3);",
	"  color: #818cf8;",
	"}",
	".dsh-history-state-icon.is-error {",
	"  background: radial-gradient(circle, rgba(239, 68, 68, 0.22) 0%, rgba(239, 68, 68, 0.06) 70%);",
	"  border: 1px solid rgba(239, 68, 68, 0.3);",
	"  color: #f87171;",
	"}",
	".dsh-history-state-icon.is-loading {",
	"  background: transparent;",
	"  border: none;",
	"}",
	".dsh-history-state-spin {",
	"  width: 38px;",
	"  height: 38px;",
	"  border-radius: 50%;",
	"  border: 3px solid rgba(255, 255, 255, 0.1);",
	"  border-top-color: var(--dsw-alias-brand-primary, #4d88ff);",
	"  animation: dshSpin 0.8s linear infinite;",
	"}",
	".dsh-history-state-title {",
	"  font-size: 16px;",
	"  font-weight: 600;",
	"  line-height: 1.4;",
	"  color: var(--dsw-alias-label-primary, #f5f5f7);",
	"  margin-bottom: 8px;",
	"}",
	".dsh-history-state-desc {",
	"  font-size: 13px;",
	"  line-height: 1.6;",
	"  color: var(--dsw-alias-label-secondary, #94949e);",
	"  margin-bottom: 20px;",
	"  max-width: 360px;",
	"}",
	".dsh-history-state-error-tag {",
	"  display: inline-block;",
	"  padding: 3px 8px;",
	"  font-size: 11px;",
	"  border-radius: 4px;",
	"  font-family: var(--ds-font-family-code, monospace);",
	"  background: rgba(239, 68, 68, 0.12);",
	"  color: #fca5a5;",
	"  border: 1px solid rgba(239, 68, 68, 0.2);",
	"  margin-bottom: 16px;",
	"  word-break: break-all;",
	"}",
	".dsh-history-state-actions {",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: center;",
	"  gap: 10px;",
	"  flex-wrap: wrap;",
	"  width: 100%;",
	"}",
	".dsh-history-state-notice {",
	"  margin-top: 14px;",
	"  padding: 7px 12px;",
	"  font-size: 12px;",
	"  line-height: 1.4;",
	"  border-radius: 6px;",
	"  width: 100%;",
	"  text-align: center;",
	"  background: rgba(255, 255, 255, 0.06);",
	"  color: #e2e8f0;",
	"  border: 1px solid rgba(255, 255, 255, 0.08);",
	"}",
	".dsh-history-state-notice.is-error {",
	"  background: rgba(239, 68, 68, 0.12);",
	"  color: #fca5a5;",
	"  border-color: rgba(239, 68, 68, 0.25);",
	"}",
	".dsh-history-state-notice.is-success {",
	"  background: rgba(34, 197, 94, 0.12);",
	"  color: #86efac;",
	"  border-color: rgba(34, 197, 94, 0.25);",
	"}"
].join("\n");
const STYLE_ELEMENT_ID = "dsh-history-styles";
function injectStyles() {
	const existing = document.getElementById(STYLE_ELEMENT_ID);
	if (existing !== null) {
		existing.textContent = STYLES;
		return;
	}
	const style = document.createElement("style");
	style.id = STYLE_ELEMENT_ID;
	style.textContent = STYLES;
	document.head.appendChild(style);
}
const PANEL = "dsh-history-panel";
const ROW = "dsh-history-row";
const ROW_CONTENT = "dsh-history-row-content";
const ROW_MAIN = "dsh-history-row-main";
const ROW_SIDE = "dsh-history-row-side";
const SHA_BADGE = "dsh-history-sha-badge";
const MSG_LIST = "dsh-history-msg-list";
const MSG_ITEM = "dsh-history-msg-item";
const MSG_ROLE = "dsh-history-msg-role";
const MSG_ROLE_USER = "dsh-history-msg-role-user";
const MSG_ROLE_ASST = "dsh-history-msg-role-asst";
const MSG_TEXT = "dsh-history-msg-text";
const SINGLE_LINE = "dsh-history-single-line";
const SINGLE_TEXT = "dsh-history-single-text";
const FILE_LIST = "dsh-history-file-list";
const FILE_CHIP = "dsh-history-file-chip";
const FILE_CLIP = "dsh-history-file-clip";
const FILE_INDENT = "dsh-history-file-indent";
const BUTTON = "dsh-history-button";
const DIALOG = "dsh-history-dialog";
const DIALOG_HEAD = "dsh-history-dialog-head";
const DIALOG_TITLE = "dsh-history-dialog-title";
const DIALOG_CLOSE = "dsh-history-dialog-close";
const DIALOG_DESCRIPTION = "dsh-history-dialog-description";
const DIALOG_FOOT = "dsh-history-dialog-foot";
const HINT = "dsh-history-hint";
const MODAL_BACKDROP = "dsh-history-modal-backdrop";
const MODAL_BLUR = "dsh-history-modal-blur";
const MODAL_CARD = "dsh-history-modal-card";
const MODAL_BODY = "dsh-history-modal-body";
const GRAPH_OVERLAY = "dsh-history-graph-overlay";
const GRAPH_GUTTER = "dsh-history-gutter";
const LIST_WRAP = "dsh-history-list";
const PROGRESS_MASK = "dsh-history-progress-mask";
const PROGRESS_CARD = "dsh-history-progress-card";
const STATE_CONTAINER = "dsh-history-state-container";
const STATE_CARD = "dsh-history-state-card";
const STATE_CLOSE = "dsh-history-state-close";
const STATE_ICON = "dsh-history-state-icon";
const STATE_SPIN = "dsh-history-state-spin";
const STATE_TITLE = "dsh-history-state-title";
const STATE_DESC = "dsh-history-state-desc";
const STATE_ERROR_TAG = "dsh-history-state-error-tag";
const STATE_ACTIONS = "dsh-history-state-actions";
const STATE_NOTICE = "dsh-history-state-notice";

//#endregion
//#region src/client/index.tsx
/** Services the browser half requires before it can contribute. */
const inject = ["sessions", "slots"];
/** Small delay helper. */
const wait = (ms) => new Promise((resolve) => {
	setTimeout(resolve, ms);
});
/** Rebind session view after a rewind — in place when the runtime allows it.

*

*  The client Session instance survives the host detach/resume (the runtime's

*  resident-instance rule: `host/session-removed` only flags it), so the

*  conversation window can be re-pulled WITHOUT tearing down the scope, without

*  clearing the selection and without bouncing through the no-session hero.

*  `session.resync()` is the runtime's own reconnect rebuild: it resets the

*  window and reruns `open()`, and — because the chat assembler is untouched

*  until the fresh window installs — the old conversation stays painted while

*  the fetch runs, then swaps instantly to the rewind target. No flash.

*

*  Falls back to the legacy rebuild (scope teardown → clear → reopen, or a

*  full page reload) only when the runtime exposes neither `resync` nor the

*  scope primitives (older shells, or the instance was really lost).

*/
async function rebindView(sessions, sessionId) {
	const record = sessions.scopes?.get(sessionId);
	const session = record?.binding?.session;
	if (session !== void 0 && typeof session.resync === "function") try {
		if (session.removed === true) session.removed = false;
		await session.resync();
		return "会话视图已原位刷新";
	} catch {}
	await wait(250);
	const record2 = sessions.scopes?.get(sessionId);
	const dropScope = sessions.dropScope;
	const clearSelection = sessions.clear;
	const openSession = sessions.open;
	if (record2 === void 0 || dropScope === void 0 || clearSelection === void 0 || openSession === void 0) {
		setTimeout(() => {
			window.location.reload();
		}, 400);
		return "原语缺失，已自动刷新页面";
	}
	try {
		sessions.deferredRemovals?.delete(sessionId);
		sessions.scopes?.delete(sessionId);
		dropScope(sessionId, record2);
	} catch {
		setTimeout(() => {
			window.location.reload();
		}, 400);
		return "dropScope 失败，已自动刷新页面";
	}
	const facade = sessions;
	let stageMoved = false;
	if ("watched" in facade) try {
		facade.watched = void 0;
		stageMoved = true;
	} catch {
		stageMoved = false;
	}
	if (!stageMoved) {
		const other = sessions.list.getSnapshot().ids?.find((id) => id !== sessionId);
		if (other !== void 0) {
			openSession(other);
			setTimeout(() => {
				openSession(sessionId);
			}, 250);
			return "已自动切走再切回（stage 复位不可用）";
		}
	}
	clearSelection();
	const attempt = (tries) => {
		openSession(sessionId);
		if (tries <= 0) return;
		setTimeout(() => {
			if (sessions.scopes?.has(sessionId) === true) return;
			attempt(tries - 1);
		}, 250);
	};
	setTimeout(() => {
		attempt(3);
	}, 100);
	return stageMoved ? "scope 重建 + stage 复位" : "scope 重建（stage 复位不可用）";
}
/** Clean rail colors */
const RAIL_COLORS = [
	"#4d88ff",
	"#ec4899",
	"#10b981",
	"#f59e0b",
	"#8b5cf6",
	"#06b6d4"
];
/** Relative time formatter */
function timeOf(ct) {
	const delta = Date.now() / 1e3 - ct;
	if (delta < 5) return "刚刚";
	if (delta < 60) return `${Math.floor(delta)} 秒前`;
	if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
	if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
	return `${Math.floor(delta / 86400)} 天前`;
}
/** Chip metrics used to decide how many file names fit on one line. The chip

*  font is the 10px code face, so a character advance is ~0.6em; each chip adds

*  its horizontal padding, plus the flex gap between chips. */
const CHIP_CHAR_W = 6.05;
const CHIP_PAD_W = 14;
const CHIP_GAP_W = 4;
/** Painted width of one chip holding `text`. */
const chipWidth = (text) => text.length * CHIP_CHAR_W + CHIP_PAD_W;
/**

* Decide how many changed-file chips fit within `budget` pixels.

*

* There is no fixed cap: long file names simply mean fewer chips. Whatever does

* not fit collapses into a trailing "+N" chip, and that chip's own width is

* reserved before committing to a count — so the "+N" can never be the thing

* that overflows the line. At least one chip is always shown (truncated by CSS

* if a single name is wider than the whole row) so the line is never empty.

*

* @param files - changed file paths for the row.

* @param budget - horizontal space available to the chip line, in px.

* @returns the chips to render plus how many were dropped.

*/
function fitFileChips(files, budget) {
	if (files.length === 0) return {
		shown: [],
		hidden: 0
	};
	let used = 0;
	let count = 0;
	for (let i = 0; i < files.length; i++) {
		const next = chipWidth(files[i]) + (count > 0 ? CHIP_GAP_W : 0);
		const rest = files.length - (i + 1);
		const reserve = rest > 0 ? CHIP_GAP_W + chipWidth(`+${rest}`) : 0;
		if (count > 0 && used + next + reserve > budget) break;
		used += next;
		count++;
	}
	if (count === 0) count = 1;
	return {
		shown: files.slice(0, count),
		hidden: files.length - count
	};
}
/** Render a changed-file chip line: as many names as fit on one line, then a

*  trailing "+N". With `indent` (TURN rows) a leading spacer shifts the chips to

*  the message TEXT column — the line aligns with the USER/ASST content, not

*  the badges. */
function FileChips(props) {
	const { files, indent = false, budget } = props;
	if (files.length === 0) return null;
	const { shown, hidden } = fitFileChips(files, budget);
	return (0, react.createElement)("div", { className: FILE_LIST }, ...indent ? [(0, react.createElement)("span", { className: FILE_INDENT }, null)] : [], (0, react.createElement)("div", { className: FILE_CLIP }, shown.map((file) => (0, react.createElement)("code", {
		className: FILE_CHIP,
		title: file,
		key: file
	}, file)), hidden > 0 ? (0, react.createElement)("code", {
		className: `${FILE_CHIP} is-more`,
		title: files.slice(shown.length).join("\n")
	}, `+${hidden}`) : null));
}
function RowContentNode(props) {
	const { row, isHead, chipBudget } = props;
	const meta = row.meta;
	const kind = meta?.kind ?? "turn-start";
	const turn = meta?.turn;
	const fullDate = new Date(row.ct * 1e3).toLocaleString();
	const sideElements = (0, react.createElement)("div", { className: ROW_SIDE }, (0, react.createElement)("span", {
		className: "dsh-history-time",
		title: fullDate
	}, timeOf(row.ct)), (0, react.createElement)("code", { className: SHA_BADGE }, row.sha.slice(0, 7)));
	const files = row.files ?? [];
	if (kind === "turn-start") {
		const { shown, hidden } = fitFileChips(files, Math.max(0, chipBudget - 82));
		return (0, react.createElement)("div", { className: ROW_CONTENT }, (0, react.createElement)("div", { className: ROW_MAIN }, (0, react.createElement)("div", { className: `${SINGLE_LINE} ${FILE_LIST}` }, (0, react.createElement)("span", { className: "dsh-badge dsh-badge-turn-start" }, "WORKSPACE"), (0, react.createElement)("div", { className: FILE_CLIP }, shown.map((file) => (0, react.createElement)("code", {
			className: FILE_CHIP,
			title: file,
			key: file
		}, file)), hidden > 0 ? (0, react.createElement)("code", {
			className: `${FILE_CHIP} is-more`,
			title: files.slice(shown.length).join("\n")
		}, `+${hidden}`) : null))), sideElements);
	}
	if (kind === "manual" || kind === "rewind") {
		const badge = kind === "manual" ? (0, react.createElement)("span", { className: "dsh-badge dsh-badge-manual" }, "手动快照") : (0, react.createElement)("span", { className: "dsh-badge dsh-badge-rewind" }, `回退 → ${(meta?.target ?? "").slice(0, 7)}`);
		return (0, react.createElement)("div", { className: ROW_CONTENT }, (0, react.createElement)("div", { className: ROW_MAIN }, (0, react.createElement)("div", { className: SINGLE_LINE }, badge, meta?.message ? (0, react.createElement)("span", {
			className: SINGLE_TEXT,
			title: meta.message
		}, meta.message) : null)), sideElements);
	}
	return (0, react.createElement)("div", { className: ROW_CONTENT }, (0, react.createElement)(
		"div",
		{ className: ROW_MAIN },
		(0, react.createElement)("div", { className: MSG_LIST }, meta?.userMessage ? (0, react.createElement)("div", { className: MSG_ITEM }, (0, react.createElement)("span", { className: `${MSG_ROLE} ${MSG_ROLE_USER}` }, "USER"), (0, react.createElement)("span", {
			className: MSG_TEXT,
			title: meta.userMessage
		}, meta.userMessage)) : null, (0, react.createElement)("div", { className: MSG_ITEM }, (0, react.createElement)("span", { className: `${MSG_ROLE} ${MSG_ROLE_ASST}` }, "ASST"), (0, react.createElement)("span", {
			className: MSG_TEXT,
			title: meta?.asstMessage ?? meta?.message ?? ""
		}, meta?.asstMessage ?? meta?.message ?? "—"))),
		// Indented chips: align with the message TEXT column (under USER's
		// reply text) rather than with the USER/ASST role badges.
		(0, react.createElement)(FileChips, {
			files,
			indent: true,
			budget: Math.max(0, chipBudget - 46)
		})
), sideElements);
}
/** Geometry for Git Graph. Node radius and rail width are both 20% up from the

*  original 4 / 2 for a more present graph. */
const LANE_W = 16;
/** Base node radius and rail width, both scaled up 20% from 4.8 / 2.4. */
const NODE_R = 5.76;
const RAIL_W = 2.88;
/** Clear space between a node's edge and where its rails stop, at 1x scale. */
const NODE_GAP = 2.4;
/**

* Per-state node scale. Rails must stop clear of the node they touch, so the

* gap has to scale WITH the node — a fixed stop distance gets swallowed the

* moment a node grows on hover, which is what made the gap disappear exactly

* when the node became most prominent.

*

* Each factor is the previous stage's ratio times 1.2 (the requested hover

* bump), measured against the base radius:

*   head / hovered   was 5.8/4.8 = 1.208  ->  1.45

*   on-path          was 6.8/4.8 = 1.417  ->  1.70

*   on-path + ring   was 7.8/4.8 = 1.625  ->  1.95

*/
const NODE_SCALE_HEAD = 1.45;
const NODE_SCALE_ON_PATH = 1.7;
const NODE_SCALE_ON_PATH_RING = 1.95;
/** Rendered scale of a node, from the same state inputs the renderer uses. */
const nodeScaleOf = (onPath, ring) => {
	if (onPath) return ring ? NODE_SCALE_ON_PATH_RING : NODE_SCALE_ON_PATH;
	return ring ? NODE_SCALE_HEAD : 1;
};
/** Card height is driven by how many text lines the card actually carries.

*  One line of card text (message row / chip row) plus its inter-line gap. */
const CARD_LINE_H = 20;
/** Vertical padding inside a card (top + bottom combined). */
const CARD_PAD_V = 20;
/** Vertical margin the card reserves inside its row (top + bottom combined). */
const CARD_MARGIN_V = 8;
/**

* How many text lines a row's card renders.

*  - WORKSPACE / manual / rewind: 1 (badge and chips share the line)

*  - TURN: USER + ASST, plus one more line when it carries changed files

*/
function lineCountOf(row) {
	const kind = row.meta?.kind ?? "turn-start";
	if (kind !== "turn-end") return 1;
	let lines = 1;
	if (row.meta?.userMessage) lines++;
	if ((row.files ?? []).length > 0) lines++;
	return lines;
}
/** Estimated row height: card text lines + card padding + row margins. The real

*  height is measured from the DOM afterwards; this is the pre-paint estimate

*  that keeps the list from jumping. */
function rowHeightOf(row) {
	return lineCountOf(row) * CARD_LINE_H + CARD_PAD_V + CARD_MARGIN_V;
}
const laneX = (lane) => 12 + lane * LANE_W;
/** Graph column width for a given lane count. +10 right margin + 12 left inset

*  (laneX base): keeps even the largest ring (on-path + hovered, ~12.8px outer

*  radius including its stroke) fully inside the column. */
const graphWidth = (lanes) => Math.max(1, lanes) * LANE_W + 10;
/** Build the overlay's topology index from laid-out rows. O(N) once per graph. */
function buildGraphIndex(rows) {
	const laneOf = new Map();
	const childrenOf = new Map();
	for (const row of rows) laneOf.set(row.sha, row.lane);
	for (const row of rows) {
		const parent = row.parents[0];
		if (parent === void 0) continue;
		const list = childrenOf.get(parent);
		if (list === void 0) childrenOf.set(parent, [{
			sha: row.sha,
			lane: row.lane
		}]);
		else list.push({
			sha: row.sha,
			lane: row.lane
		});
	}
	return {
		laneOf,
		childrenOf
	};
}
/**

* The whole git graph as ONE continuous SVG layered over the card list.

*

* Every rail is a single unbroken path running from a child commit's node

* centre to its parent's node centre, derived from the measured Y positions of

* the painted rows. This replaces the previous per-row SVG cells, where each

* row drew its own half-segments and the segments had to meet exactly at every

* row boundary — row margins, sub-pixel rounding and per-cell drop-shadows all

* made those joins visible as seams. With one path per rail there are no joins

* left to misalign, at any zoom level or card height.

*

* Colour rules are unchanged and stay endpoint-driven: a rail keeps ONE colour

* along its whole length, decided by its (child, parent) pair and its lane.

*/
function GraphOverlay(props) {
	const { index, visibleRows, lanes, colors, headLanes, headSha, hoverSha, futureSet, hoverPath, geom, height } = props;
	const width = graphWidth(lanes);
	if (height <= 0) return null;
	const grey = "#6b6b6d";
	const HOVER = "#4d88ff";
	const AFTER_HEAD = "#7086ab";
	const onHead = (lane) => headLanes.includes(lane);
	const hovering = hoverPath !== null;
	/** Node centre Y of a row, or null when it is not painted. */
	const centreOf = (sha) => {
		const g = geom[sha];
		if (g === void 0) return null;
		return g.top + g.height / 2;
	};
	/**
	
	* How far a rail must stop short of a given node's centre.
	
	*
	
	* Derived from that node's OWN rendered scale, not a constant: a hovered or
	
	* on-path node grows, and a fixed stop distance would then fall inside the
	
	* enlarged dot, so the rail would appear to touch (or pierce) it — the gap
	
	* vanished precisely on hover. Scaling the whole stop distance keeps the
	
	* visual clearance proportional at every size.
	
	*/
	const stopFor = (sha) => {
		const ring = sha === headSha || sha === hoverSha;
		const onPath = hovering && hoverPath.has(sha);
		return (NODE_R + NODE_GAP) * nodeScaleOf(onPath, ring);
	};
	/**
	
	* P3 for a fork: the vertical height of the TOPMOST child of a parent.
	
	*
	
	* Every branch leaving the same parent turns at this one height, so a fan of
	
	* forks reads as a fan — the curves share a common turn line instead of each
	
	* bending at its own depth (which flattened them into near-vertical lines
	
	* that were indistinguishable from the trunk).
	
	*
	
	* Cached per render: a parent with N children is resolved once, not N times.
	
	*/
	const forkTopCache = new Map();
	const forkTopY = (parentSha) => {
		const cached = forkTopCache.get(parentSha);
		if (cached !== void 0) return cached;
		let top = null;
		for (const kid of index.childrenOf.get(parentSha) ?? []) {
			const y = centreOf(kid.sha);
			if (y === null) continue;
			if (top === null || y < top) top = y;
		}
		forkTopCache.set(parentSha, top);
		return top;
	};
	const rails = [];
	const pushEdge = (childSha, childLane, parentSha) => {
		const parentLane = index.laneOf.get(parentSha);
		if (parentLane === void 0) return;
		const childY = centreOf(childSha);
		const parentY = centreOf(parentSha);
		if (childY === null && parentY === null) return;
		const y0 = childY ?? height;
		const y1 = parentY ?? 0;
		const x0 = laneX(childLane);
		const x1 = laneX(parentLane);
		const startY = childY === null ? y0 : y0 - stopFor(childSha);
		const endY = parentY === null ? y1 : y1 + stopFor(parentSha);
		const onPathEdge = hovering && hoverPath.has(childSha) && hoverPath.has(parentSha);
		const stroke = onPathEdge ? HOVER : hovering ? grey : futureSet.has(childSha) ? AFTER_HEAD : onHead(childLane) ? colors[childLane % colors.length] : grey;
		const opacity = onPathEdge ? 1 : hovering ? .45 : onHead(childLane) ? .85 : .6;
		let d;
		if (x0 === x1) d = `M ${x0} ${startY} L ${x1} ${endY}`;
		else {
			const p1x = x1;
			const p1y = endY;
			const p2x = x0;
			const p2y = forkTopY(parentSha) ?? y0;
			const turnY = Math.max(p1y, Math.min(p2y, startY));
			const midY = (turnY + p1y) / 2;
			const c1x = p2x;
			const c1y = midY;
			const c2x = p1x;
			const c2y = midY;
			d = startY > turnY ? `M ${p2x} ${startY} L ${p2x} ${turnY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p1x} ${p1y}` : `M ${p2x} ${startY} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p1x} ${p1y}`;
		}
		rails.push((0, react.createElement)("path", {
			key: `r-${childSha}`,
			d,
			fill: "none",
			stroke,
			strokeWidth: onPathEdge ? (RAIL_W + 1.5) * 1.2 : RAIL_W,
			strokeLinecap: "round",
			opacity
		}));
	};
	for (const row of visibleRows) {
		const parentSha = row.parents[0];
		if (parentSha !== void 0) pushEdge(row.sha, row.lane, parentSha);
		for (const kid of index.childrenOf.get(row.sha) ?? []) if (geom[kid.sha] === void 0) pushEdge(kid.sha, kid.lane, row.sha);
	}
	const nodes = [];
	for (const row of visibleRows) {
		const cy = centreOf(row.sha);
		if (cy === null) continue;
		const isHead = row.sha === headSha;
		const isHovered = row.sha === hoverSha;
		const onPath = hovering && hoverPath.has(row.sha);
		const nodeColor = onPath ? HOVER : hovering ? grey : isHead ? colors[row.lane % colors.length] : futureSet.has(row.sha) ? AFTER_HEAD : onHead(row.lane) ? colors[row.lane % colors.length] : grey;
		const cx = laneX(row.lane);
		const ring = isHead || isHovered;
		const r = NODE_R * nodeScaleOf(onPath, ring);
		nodes.push(ring ? (0, react.createElement)("circle", {
			key: `n-${row.sha}`,
			className: "dsh-history-node",
			cx,
			cy,
			r,
			fill: "var(--dsw-alias-bg-base, #1e1e1e)",
			strokeWidth: (onPath ? 2.6 : isHead ? 2.4 : 2) * 1.2,
			stroke: nodeColor
		}) : (0, react.createElement)("circle", {
			key: `n-${row.sha}`,
			className: "dsh-history-node",
			cx,
			cy,
			r,
			fill: nodeColor
		}));
	}
	return (0, react.createElement)("svg", {
		className: GRAPH_OVERLAY,
		width,
		height,
		viewBox: `0 0 ${width} ${height}`,
		style: {
			width,
			height
		}
	}, ...rails, ...nodes);
}
/** Timeline Row component: the card plus the gutter the shared graph overlay

*  draws into. The row itself no longer renders any SVG — the graph is one

*  continuous layer owned by the panel, so rails cannot show row-boundary

*  seams. */
function HistoryRow(props) {
	const { row, lanes, isHead, isSelected, onHover, onSelect, anchor, chipBudget } = props;
	const estimatedHeight = rowHeightOf(row);
	return (0, react.createElement)("div", {
		className: `${ROW} ${isSelected ? "is-selected" : ""}`,
		style: { minHeight: estimatedHeight },
		"data-sha": row.sha,
		...anchor ? { "data-anchor": row.sha } : {},
		onMouseEnter: () => onHover(row.sha),
		onMouseLeave: () => onHover(null),
		onClick: () => onSelect(row)
	}, (0, react.createElement)("div", {
		className: GRAPH_GUTTER,
		style: {
			width: graphWidth(lanes),
			minWidth: graphWidth(lanes)
		}
	}), (0, react.createElement)(RowContentNode, {
		row,
		isHead,
		chipBudget
	}));
}
/** Session id currently in the middle of a rewind: while set, client-side

*  `host/session-removed` frames are intercepted so the session is never

*  dropped from the list store, preventing `current` from becoming undefined

*  and stopping the chat view from jumping to the initial blank hero page. */
let suppressingSessionId = null;
/** State card for Loading / Empty / Error views with actions and visual clarity */
function HistoryStateCard(props) {
	const { type, errorReason, notice, busy, onSnapshot, onReload, onClose } = props;
	let iconNode;
	let title;
	let desc;
	let actionsNode = null;
	if (type === "loading") {
		iconNode = (0, react.createElement)("div", { className: STATE_SPIN });
		title = "正在读取会话历史…";
		desc = "正在解析 Git 影子快照与时间线拓扑";
	} else if (type === "empty") {
		iconNode = (0, react.createElement)("svg", {
			width: 24,
			height: 24,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			strokeLinejoin: "round"
		}, (0, react.createElement)("circle", {
			cx: 12,
			cy: 12,
			r: 3
		}), (0, react.createElement)("path", { d: "M3 12h6m6 0h6" }), (0, react.createElement)("path", { d: "M12 3a9 9 0 1 0 9 9" }));
		title = "当前会话暂无快照记录";
		desc = "发送消息后，TURN 开始与结束将自动记录代码与对话快照。你也可以随时点击下方按钮立即创建首个快照。";
		actionsNode = (0, react.createElement)("button", {
			className: `${BUTTON} primary`,
			disabled: busy === true,
			onClick: onSnapshot,
			style: {
				minWidth: 150,
				height: 36,
				fontWeight: 500
			}
		}, busy === true ? "正在创建快照…" : "📸 立即创建首个快照");
	} else {
		iconNode = (0, react.createElement)("svg", {
			width: 24,
			height: 24,
			viewBox: "0 0 24 24",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 2,
			strokeLinecap: "round",
			strokeLinejoin: "round"
		}, (0, react.createElement)("path", { d: "M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" }), (0, react.createElement)("line", {
			x1: 12,
			y1: 9,
			x2: 12,
			y2: 13
		}), (0, react.createElement)("line", {
			x1: 12,
			y1: 17,
			x2: 12.01,
			y2: 17
		}));
		title = "时间线数据读取异常";
		desc = errorReason === "git-unavailable" ? "检测到 Git 环境异常或未安装，请在设置中检查 Git 状态。" : "无法读取当前会话的 Git 影子仓库历史，可能是影子仓库尚未初始化或状态受损。";
		actionsNode = (0, react.createElement)("div", { className: STATE_ACTIONS }, (0, react.createElement)("button", {
			className: `${BUTTON} outline`,
			disabled: busy === true,
			onClick: onReload,
			style: {
				minWidth: 100,
				height: 36
			}
		}, "🔄 重新加载"), (0, react.createElement)("button", {
			className: `${BUTTON} primary`,
			disabled: busy === true,
			onClick: onSnapshot,
			style: {
				minWidth: 140,
				height: 36,
				fontWeight: 500
			}
		}, busy === true ? "正在创建…" : "⚡ 创建 / 修复快照"));
	}
	const isNoticeSuccess = notice?.includes("✓") ?? false;
	const isNoticeError = (notice?.includes("失败") || notice?.includes("异常")) ?? false;
	return (0, react.createElement)("div", { className: STATE_CONTAINER }, (0, react.createElement)("div", { className: STATE_CARD }, onClose !== void 0 ? (0, react.createElement)("button", {
		className: STATE_CLOSE,
		title: "关闭 (Esc)",
		onClick: onClose
	}, "✕") : null, (0, react.createElement)("div", { className: `${STATE_ICON} is-${type}` }, iconNode), (0, react.createElement)("div", { className: STATE_TITLE }, title), errorReason !== null && errorReason !== void 0 && type === "error" ? (0, react.createElement)("div", { className: STATE_ERROR_TAG }, `错误代码: ${errorReason}`) : null, (0, react.createElement)("div", { className: STATE_DESC }, desc), actionsNode, notice !== void 0 && notice !== "" ? (0, react.createElement)("div", { className: `${STATE_NOTICE}${isNoticeSuccess ? " is-success" : isNoticeError ? " is-error" : ""}` }, notice) : null));
}
/** History Panel */
function HistoryPanel(props) {
	const { sessionId, rebind, onRewound, onRewindFailed, onProgress, portalTo, onDialogOpen, onLanesChange, initialNotice, onInitialNoticeConsumed } = props;
	const [rows, setRows] = (0, react.useState)(void 0);
	const [errorReason, setErrorReason] = (0, react.useState)(null);
	const [head, setHead] = (0, react.useState)(null);
	const [busy, setBusy] = (0, react.useState)(false);
	const [selected, setSelected] = (0, react.useState)(null);
	const [notice, setNotice] = (0, react.useState)(initialNotice ?? "");
	(0, react.useEffect)(() => {
		if (initialNotice === void 0) return;
		setNotice(initialNotice);
		onInitialNoticeConsumed?.();
	}, [initialNotice, onInitialNoticeConsumed]);
	const dialogOpen = selected !== null;
	(0, react.useEffect)(() => {
		onDialogOpen(dialogOpen);
	}, [dialogOpen, onDialogOpen]);
	(0, react.useEffect)(() => {
		if (!dialogOpen) return;
		const onKeyDown = (event) => {
			if (event.key === "Escape") setSelected(null);
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [dialogOpen]);
	/** Row currently hovered (sha), for ancestor-path highlight. */
	const [hoverSha, setHoverSha] = (0, react.useState)(null);
	/** Live geometry of the painted rows, feeding the single graph overlay: each
	
	*  row's top offset + height inside the list wrapper, plus the wrapper's own
	
	*  height. Measured from the real DOM so the rails follow whatever the cards
	
	*  actually paint (wrapped content, different card units, zoom). */
	const listWrapRef = (0, react.useRef)(null);
	const [graphGeom, setGraphGeom] = (0, react.useState)({
		rows: {},
		height: 0
	});
	/** Painted width of the list, so the chip line knows how many file names it
	
	*  can fit before collapsing the rest into "+N". Zero reads are ignored for
	
	*  the same reason as the row geometry: a hidden panel measures 0. */
	const [listWidth, setListWidth] = (0, react.useState)(0);
	/** 500ms hover-delay timer: the graph only switches to the hovered path
	
	*  after the pointer rests on a row; leaving restores the current style
	
	*  immediately (the graph stays on HEAD unless the user wants to switch). */
	const hoverTimer = (0, react.useRef)(null);
	const onHover = (sha) => {
		if (hoverTimer.current !== null) {
			clearTimeout(hoverTimer.current);
			hoverTimer.current = null;
		}
		if (sha === null) {
			setHoverSha(null);
			return;
		}
		hoverTimer.current = setTimeout(() => {
			hoverTimer.current = null;
			setHoverSha(sha);
		}, 500);
	};
	const load = async () => {
		setBusy(true);
		try {
			const [result, status] = await Promise.all([fetchTimeline(sessionId), get(`${ROUTE_PREFIX}/status?sessionId=${encodeURIComponent(sessionId)}`)]);
			if (result.ok && result.rows !== void 0) {
				setRows(result.rows);
				setErrorReason(null);
			} else {
				setRows(null);
				setErrorReason(result.reason ?? "unknown");
			}
			if (status !== null && typeof status.activeTip === "string") setHead(status.activeTip);
		} finally {
			setBusy(false);
		}
	};
	(0, react.useEffect)(() => {
		load();
	}, [sessionId]);
	(0, react.useEffect)(() => () => {
		if (hoverTimer.current !== null) {
			clearTimeout(hoverTimer.current);
			hoverTimer.current = null;
		}
	}, []);
	const graph = (0, react.useMemo)(() => rows === void 0 || rows === null ? null : buildGraph(rows, head), [rows, head]);
	const headSha = head;
	(0, react.useEffect)(() => {
		if (graph !== null && graph.rows.length > 0) onLanesChange?.(graph.lanes);
		else onLanesChange?.(0);
	}, [graph, onLanesChange]);
	/** Topology index for the graph overlay: rebuilt only when the graph itself
	
	*  changes, so hover/scroll re-renders never re-walk the commit list. */
	const graphIndex = (0, react.useMemo)(() => graph === null ? null : buildGraphIndex(graph.rows), [graph]);
	const headIndex = headSha !== null && graph !== null ? graph.rows.findIndex((r) => r.sha === headSha) : -1;
	const futureSet = (0, react.useMemo)(() => {
		const set = new Set();
		if (headIndex < 0 || graph === null) return set;
		for (let i = headIndex + 1; i < graph.rows.length; i++) set.add(graph.rows[i].sha);
		return set;
	}, [graph, headIndex]);
	const PAGE = 20;
	const [winStart, setWinStart] = (0, react.useState)(null);
	const listRef = (0, react.useRef)(null);
	/** Pending "center on HEAD" requests: set when the window re-anchors; the
	
	*  layout effect below consumes it once the new slice is painted. */
	const pendingCenter = (0, react.useRef)(null);
	(0, react.useEffect)(() => {
		if (graph === null) return;
		const len = graph.rows.length;
		if (len === 0) return;
		const headIdx = headSha === null ? len - 1 : Math.max(0, graph.rows.findIndex((r) => r.sha === headSha));
		const start = Math.max(0, headIdx - PAGE);
		const end = Math.min(len, headIdx + PAGE + 1);
		pendingCenter.current = graph.rows[Math.min(headIdx, len - 1)].sha;
		setWinStart({
			rows: len,
			start,
			end
		});
	}, [graph, headSha]);
	(0, react.useLayoutEffect)(() => {
		const el = listRef.current;
		if (el === null) return;
		const sha = pendingCenter.current;
		if (sha === null) return;
		const target = el.querySelector(`[data-sha="${sha}"]`);
		if (target === null) return;
		const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
		silentScrollUntil.current = Date.now() + 200;
		el.scrollTop = Math.max(0, el.scrollTop + delta - el.clientHeight / 2 + target.clientHeight / 2);
		pendingCenter.current = null;
	}, [winStart, headSha]);
	/** Read the painted rows and publish the geometry the graph overlay draws from.
	
	*
	
	*  Bails out when the wrapper measures zero height: while the rewind confirm
	
	*  dialog is open the shell hides the panel card (`display: none`), and every
	
	*  size read on a hidden subtree returns 0. Writing those zeros would blank
	
	*  the graph — and it would STAY blank, because by the time the panel is shown
	
	*  again nothing in the dependency list has changed to trigger a re-measure. */
	const measureRows = (0, react.useCallback)(() => {
		const wrap = listWrapRef.current;
		if (wrap === null) return;
		const height = wrap.offsetHeight;
		if (height <= 0) return;
		const width = wrap.clientWidth;
		if (width > 0) setListWidth((prev) => prev === width ? prev : width);
		const next = {};
		for (const node of Array.from(wrap.children)) {
			const el = node;
			const sha = el.dataset.sha;
			if (sha === void 0) continue;
			next[sha] = {
				top: el.offsetTop,
				height: el.offsetHeight
			};
		}
		setGraphGeom((prev) => {
			if (prev.height !== height) return {
				rows: next,
				height
			};
			const prevKeys = Object.keys(prev.rows);
			if (prevKeys.length !== Object.keys(next).length) return {
				rows: next,
				height
			};
			for (const key of prevKeys) {
				const a = prev.rows[key];
				const b = next[key];
				if (b === void 0 || a.top !== b.top || a.height !== b.height) return {
					rows: next,
					height
				};
			}
			return prev;
		});
	}, []);
	(0, react.useLayoutEffect)(() => {
		measureRows();
	}, [
		winStart,
		graph,
		notice,
		measureRows
	]);
	(0, react.useEffect)(() => {
		const wrap = listWrapRef.current;
		if (wrap === null || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			measureRows();
		});
		observer.observe(wrap);
		return () => {
			observer.disconnect();
		};
	}, [rows, measureRows]);
	const anchor = (0, react.useRef)({
		sha: "",
		top: 0
	});
	/** True for a moment after each USER scroll: reveals the scrollbar while the
	
	*  list is actually being moved, then hides it again. */
	const [scrolling, setScrolling] = (0, react.useState)(false);
	const scrollHideTimer = (0, react.useRef)(null);
	/** Pointer is in the narrow strip along the right edge, i.e. reaching for the
	
	*  scrollbar. Hovering the cards must not reveal it. */
	const [nearBar, setNearBar] = (0, react.useState)(false);
	/** Programmatic scrolls (opening the panel centers on HEAD; prepends restore
	
	*  the anchor) must not flash the scrollbar. Scroll events landing before this
	
	*  timestamp are treated as ours, not the user's. */
	const silentScrollUntil = (0, react.useRef)(0);
	(0, react.useEffect)(() => () => {
		if (scrollHideTimer.current !== null) clearTimeout(scrollHideTimer.current);
	}, []);
	/** Reveal the scrollbar when the pointer comes within reach of it. */
	const onPointerMove = (event) => {
		const el = listRef.current;
		if (el === null) return;
		const rect = el.getBoundingClientRect();
		const near = event.clientX >= rect.right - 22;
		setNearBar((prev) => prev === near ? prev : near);
	};
	const onPointerLeave = () => {
		setNearBar((prev) => prev ? false : prev);
	};
	const onScroll = () => {
		if (Date.now() >= silentScrollUntil.current) {
			setScrolling((prev) => prev ? prev : true);
			if (scrollHideTimer.current !== null) clearTimeout(scrollHideTimer.current);
			scrollHideTimer.current = setTimeout(() => {
				scrollHideTimer.current = null;
				setScrolling(false);
			}, 700);
		}
		const el = listRef.current;
		const win = winStart;
		if (el === null || win === null) return;
		const nearTop = el.scrollTop < 48;
		const nearBottom = el.scrollTop + el.clientHeight > el.scrollHeight - 48;
		if (nearTop && win.start > 0) {
			const anchorEl = el.querySelector("[data-anchor]");
			anchor.current = {
				sha: anchorEl?.dataset.anchor ?? "",
				top: anchorEl !== null ? anchorEl.getBoundingClientRect().top - el.getBoundingClientRect().top : 0
			};
			setWinStart({
				rows: win.rows,
				start: Math.max(0, win.start - PAGE),
				end: win.end
			});
		} else if (nearBottom && win.end < win.rows) setWinStart({
			rows: win.rows,
			start: win.start,
			end: Math.min(win.rows, win.end + PAGE)
		});
	};
	(0, react.useEffect)(() => {
		if (anchor.current.sha === "") return;
		const el = listRef.current;
		if (el === null) return;
		const target = el.querySelector(`[data-sha="${anchor.current.sha}"]`);
		if (target !== null) {
			const now = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
			silentScrollUntil.current = Date.now() + 200;
			el.scrollTop += now - anchor.current.top;
		}
		anchor.current = {
			sha: "",
			top: 0
		};
	}, [winStart]);
	const hoverPath = (0, react.useMemo)(() => {
		if (hoverSha === null || rows === void 0 || rows === null) return null;
		return roadSet(rows, hoverSha);
	}, [hoverSha, rows]);
	const doRewind = async (withWorkspace) => {
		if (selected === null) return;
		onRewound();
		const target = selected;
		setSelected(null);
		const sha = target.sha.slice(0, 7);
		onProgress("working", sha);
		try {
			suppressingSessionId = sessionId;
			const result = await rewind(sessionId, target.sha, withWorkspace);
			if (!result.ok) {
				onProgress("idle", "");
				onRewindFailed(`回档失败：${result.reason ?? "unknown"}${result.error !== void 0 ? `（${result.error}）` : ""}`);
				return;
			}
			if (result.detached === true) {
				onProgress("idle", "");
				setTimeout(() => {
					window.location.reload();
				}, 400);
				return;
			}
			onProgress("refreshing", sha);
			await rebind(sessionId);
			onProgress("done", sha);
		} finally {
			setTimeout(() => {
				if (suppressingSessionId === sessionId) suppressingSessionId = null;
			}, 500);
		}
	};
	/** Restore only the paired workspace tree; the live session is untouched. */
	const doWorkspaceOnly = async () => {
		if (selected === null) return;
		setBusy(true);
		setNotice("");
		const result = await rewind(sessionId, selected.sha, false, true);
		setSelected(null);
		setBusy(false);
		if (!result.ok) {
			setNotice(`仅工作区恢复失败：${result.reason ?? "unknown"}${result.error !== void 0 ? `（${result.error}）` : ""}`);
			return;
		}
		setNotice(`已恢复工作区 ✓ ${selected.sha.slice(0, 7)} 的配对快照`);
	};
	const doSnapshot = async () => {
		setBusy(true);
		setNotice("");
		const result = await manualSnapshot(sessionId);
		setBusy(false);
		if (result.ok) {
			setNotice(`已快照 ✓ ${result.snap ?? ""}`);
			await load();
		} else setNotice(`快照失败：${result.reason ?? "unknown"}`);
	};
	if (rows === void 0) return (0, react.createElement)("div", { className: PANEL }, (0, react.createElement)(HistoryStateCard, {
		type: "loading",
		onClose: onRewound
	}));
	if (rows === null) return (0, react.createElement)("div", { className: PANEL }, (0, react.createElement)(HistoryStateCard, {
		type: "error",
		errorReason,
		notice,
		busy,
		onSnapshot: () => void doSnapshot(),
		onReload: () => void load(),
		onClose: onRewound
	}));
	if (rows.length === 0) return (0, react.createElement)("div", { className: PANEL }, (0, react.createElement)(HistoryStateCard, {
		type: "empty",
		notice,
		busy,
		onSnapshot: () => void doSnapshot(),
		onClose: onRewound
	}));
	const laid = graph !== null && winStart !== null && winStart.rows === graph.rows.length ? graph.rows.slice(winStart.start, winStart.end) : graph !== null ? graph.rows.slice(Math.max(0, graph.rows.length - PAGE * 2)) : null;
	return (0, react.createElement)(
		"div",
		{ className: PANEL },
		// Scrollable Flat Timeline List (Trajectory style), windowed ±20 around HEAD
		(0, react.createElement)(
			"div",
			{
				className: `${MODAL_BODY}${scrolling ? " is-scrolling" : ""}${nearBar ? " is-near-bar" : ""}`,
				ref: (node) => {
					listRef.current = node;
				},
				onScroll,
				onMouseMove: onPointerMove,
				onMouseLeave: onPointerLeave
			},
			// The cards, plus ONE continuous graph SVG layered over the whole list.
			(0, react.createElement)("div", {
				className: LIST_WRAP,
				ref: (node) => {
					listWrapRef.current = node;
				}
			}, laid !== null && laid.map((row) => (0, react.createElement)(HistoryRow, {
				key: row.sha,
				row,
				lanes: graph.lanes,
				isHead: row.sha === headSha,
				isSelected: selected?.sha === row.sha,
				chipBudget: Math.max(120, (listWidth > 0 ? listWidth : 820) - graph.lanes * LANE_W - 8 - 32 - 150),
				onHover,
				onSelect: (target) => {
					if (selected?.sha === target.sha) setSelected(null);
					else setSelected(target);
				},
				anchor: row.sha === headSha
			})), graph !== null && laid !== null && graphIndex !== null ? (0, react.createElement)(GraphOverlay, {
				index: graphIndex,
				visibleRows: laid,
				lanes: graph.lanes,
				colors: RAIL_COLORS,
				headLanes: graph.headLanes,
				headSha,
				hoverSha,
				futureSet,
				hoverPath,
				geom: graphGeom.rows,
				height: graphGeom.height
			}) : null)
),
		// Selected Row Rewind Dialog — portaled into the plugin's own root so the
		// panel card can be hidden while it is open (the dialog floats over the
		// page; cancel returns the timeline exactly as it was).
		selected !== null ? (0, react_dom.createPortal)((0, react.createElement)("div", {
			className: MODAL_BACKDROP,
			style: {
				position: "fixed",
				inset: 0,
				zIndex: 10001,
				padding: 16,
				background: "transparent",
				backdropFilter: "none"
			},
			onClick: () => setSelected(null)
		}, (0, react.createElement)(
			"div",
			{
				className: DIALOG,
				style: {
					margin: 0,
					animation: "dshSlideUp 0.15s ease-out"
				},
				onClick: (event) => event.stopPropagation()
			},
			(0, react.createElement)("div", { className: DIALOG_HEAD }, (0, react.createElement)("h2", { className: DIALOG_TITLE }, "回档"), (0, react.createElement)("button", {
				className: DIALOG_CLOSE,
				title: "关闭",
				onClick: () => setSelected(null)
			}, "✕")),
			// Question line: short commit id, bold. No time element.
			(0, react.createElement)("p", { className: DIALOG_DESCRIPTION }, "要把当前会话退回到版本 ", (0, react.createElement)("code", { style: {
				fontFamily: "var(--ds-font-family-code, monospace)",
				fontSize: "0.92em",
				fontWeight: 700,
				color: "var(--dsw-alias-label-primary, #e8e8e8)"
			} }, selected.sha.slice(0, 7)), " 吗？"),
			(0, react.createElement)("div", { className: DIALOG_FOOT }, (0, react.createElement)("button", {
				className: `${BUTTON} outline`,
				disabled: busy,
				title: "仅回退会话消息，不动工作区文件",
				onClick: () => void doRewind(false)
			}, "仅会话"), (0, react.createElement)("button", {
				className: `${BUTTON} outline`,
				disabled: busy,
				title: "仅将工作区文件恢复到该版本，不动会话",
				onClick: () => void doWorkspaceOnly()
			}, "仅工作区"), (0, react.createElement)("button", {
				className: `${BUTTON} outline`,
				disabled: busy,
				title: "回退会话消息并同步恢复配对的工作区文件",
				onClick: () => void doRewind(true)
			}, busy ? "处理中…" : "会话和工作区"))
)), portalTo) : null,
		// Transient notice only (no permanent footer bar): rendered on top of the
		// list when there is something to say, and gone otherwise.
		notice !== "" ? (0, react.createElement)("div", {
			className: HINT,
			style: {
				padding: "6px 14px",
				borderTop: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))",
				background: "var(--dsw-specific-sidebar-fill, #181818)"
			}
		}, notice) : null
);
}
/** Plugin config card (设置/插件/插件配置 → history-rewind): reports whether

*  git is available on the host and offers a one-click install when it is not. */
function GitPluginCard() {
	const [available, setAvailable] = (0, react.useState)(null);
	const [version, setVersion] = (0, react.useState)("");
	const [installing, setInstalling] = (0, react.useState)(false);
	const [notice, setNotice] = (0, react.useState)("");
	const [detail, setDetail] = (0, react.useState)("");
	const refresh = async () => {
		const r = await gitStatus();
		setAvailable(r.available);
		setVersion(r.version ?? "");
		if (r.message !== void 0 && r.message.length > 0) setNotice(r.message);
	};
	(0, react.useEffect)(() => {
		refresh();
	}, []);
	const doInstall = async () => {
		setInstalling(true);
		setNotice("");
		setDetail("");
		const r = await installGit();
		setInstalling(false);
		if (r.installed === true) setNotice("已触发安装 Git。安装完成后请重启 DSH，让宿主进程识别新装的 git。");
		else {
			setNotice(r.message ?? "安装失败。");
			if (r.detail !== void 0 && r.detail.length > 0) setDetail(r.detail);
		}
		refresh();
	};
	const status = available === null ? (0, react.createElement)("span", { style: { color: "var(--dsw-alias-label-secondary, #999)" } }, "检测中…") : available ? (0, react.createElement)("span", { style: { color: "var(--dsw-alias-state-success-primary, #34d399)" } }, "可用") : (0, react.createElement)("span", { style: { color: "var(--dsw-alias-state-error-primary, #f87171)" } }, "不可用");
	return (0, react.createElement)("div", { style: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		width: "100%"
	} }, (0, react.createElement)("div", { style: {
		display: "flex",
		alignItems: "center",
		gap: 8
	} }, (0, react.createElement)("span", { style: {
		fontWeight: 600,
		fontSize: 13
	} }, "Git"), status, available === true && version.length > 0 ? (0, react.createElement)("code", { style: {
		fontFamily: "var(--ds-font-family-code, monospace)",
		fontSize: 12,
		color: "var(--dsw-alias-label-secondary, #999)"
	} }, version) : null), available === false ? (0, react.createElement)("div", { style: {
		display: "flex",
		flexDirection: "column",
		gap: 8
	} }, (0, react.createElement)("span", { style: {
		fontSize: 12,
		color: "var(--dsw-alias-label-secondary, #999)",
		lineHeight: 1.5
	} }, "本插件依赖 Git。检测到 Git 未安装，快照与回退功能将无法使用。"), (0, react.createElement)("button", {
		type: "button",
		disabled: installing,
		onClick: () => void doInstall(),
		style: {
			alignSelf: "flex-start",
			padding: "6px 14px",
			borderRadius: 6,
			border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
			background: "var(--dsw-alias-button-tool-bar-fill, #2d2d2e)",
			color: "var(--dsw-alias-label-primary, #e6e6e6)",
			fontSize: 12,
			cursor: installing ? "default" : "pointer"
		}
	}, installing ? "正在安装…" : "安装 Git")) : null, notice.length > 0 ? (0, react.createElement)("span", { style: {
		fontSize: 12,
		color: "var(--dsw-alias-label-secondary, #999)",
		lineHeight: 1.5,
		whiteSpace: "pre-wrap"
	} }, notice) : null, detail.length > 0 ? (0, react.createElement)("pre", { style: {
		fontSize: 11,
		color: "var(--dsw-alias-label-tertiary, #888)",
		maxHeight: 120,
		overflow: "auto",
		whiteSpace: "pre-wrap",
		margin: 0
	} }, detail) : null);
}
/** Global default `.gitignore` template card (设置/Rewind): edits the

*  text seeded into a workspace's `.gitignore` the first time that workspace

*  is snapshotted and has no `.gitignore` yet. Explicit Save button (no

*  autosave-on-keystroke) so an in-progress edit is never written half-typed. */
function GitignoreTemplateCard() {
	const [text, setText] = (0, react.useState)("");
	const [loaded, setLoaded] = (0, react.useState)(false);
	const [saving, setSaving] = (0, react.useState)(false);
	const [notice, setNotice] = (0, react.useState)("");
	const load = async () => {
		const r = await getConfig();
		if (r.ok && typeof r.gitignoreTemplate === "string") setText(r.gitignoreTemplate);
		setLoaded(true);
	};
	(0, react.useEffect)(() => {
		load();
	}, []);
	const doSave = async () => {
		setSaving(true);
		setNotice("");
		const r = await setConfig(text);
		setSaving(false);
		setNotice(r.ok ? "已保存 ✓" : `保存失败${r.reason !== void 0 ? `：${r.reason}` : ""}`);
	};
	return (0, react.createElement)("div", { style: {
		display: "flex",
		flexDirection: "column",
		gap: 8,
		width: "100%",
		flex: 1,
		minHeight: 0
	} }, (0, react.createElement)("div", { style: {
		height: 1,
		width: "100%",
		background: "var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08))",
		margin: "6px 0 8px",
		flex: "none"
	} }), (0, react.createElement)("span", { style: {
		fontWeight: 600,
		fontSize: 13,
		flex: "none"
	} }, "默认 .gitignore 模板"), (0, react.createElement)("div", { style: {
		fontSize: 12,
		color: "var(--dsw-alias-label-secondary, #999)",
		lineHeight: 1.5,
		flex: "none",
		display: "flex",
		flexDirection: "column",
		gap: 2
	} }, (0, react.createElement)("span", null, "用于新项目首次快照时自动生成 .gitignore（已有文件不覆盖）。"), (0, react.createElement)("span", null, "快照排除规则完全以项目本地 .gitignore 为准。")), (0, react.createElement)("textarea", {
		value: text,
		disabled: !loaded,
		onChange: (event) => setText(event.target.value),
		placeholder: "node_modules/\ndist/\n*.log",
		style: {
			width: "100%",
			flex: 1,
			minHeight: 120,
			boxSizing: "border-box",
			resize: "none",
			fontFamily: "var(--ds-font-family-code, monospace)",
			fontSize: 12,
			lineHeight: 1.5,
			padding: "10px 12px",
			borderRadius: 8,
			border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
			background: "var(--dsw-alias-markdown-code-block, #1c1c1e)",
			color: "var(--dsw-alias-label-primary, #e6e6e6)"
		}
	}), (0, react.createElement)("div", { style: {
		display: "flex",
		alignItems: "center",
		justifyContent: "flex-end",
		gap: 12,
		flex: "none",
		marginTop: 4
	} }, notice.length > 0 ? (0, react.createElement)("span", { style: {
		fontSize: 12,
		color: "var(--dsw-alias-label-secondary, #999)"
	} }, notice) : null, (0, react.createElement)("button", {
		type: "button",
		disabled: saving || !loaded,
		onClick: () => void doSave(),
		style: {
			padding: "6px 18px",
			borderRadius: 6,
			border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
			background: "var(--dsw-alias-button-tool-bar-fill, #2d2d2e)",
			color: "var(--dsw-alias-label-primary, #e6e6e6)",
			fontSize: 12,
			fontWeight: 500,
			cursor: saving ? "default" : "pointer"
		}
	}, saving ? "保存中…" : "保存")));
}
/** Human-readable byte size (binary units, 1 decimal from MB up). */
function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	const units = [
		"KB",
		"MB",
		"GB",
		"TB"
	];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value < 10 && unit >= 1 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
/**

* Cache capacity + usage card (设置/HISTORY-REWIND).

*

* The capacity is ADVISORY: crossing it never deletes anything and never

* blocks a snapshot — the bar just escalates green → amber → red. Automatic

* eviction is deliberately absent, because the only thing available to evict

* is rewind history the user may still want; the decision stays theirs.

*/
function CacheCard() {
	const [usage, setUsage] = (0, react.useState)(null);
	const [capacityText, setCapacityText] = (0, react.useState)("100");
	const [loaded, setLoaded] = (0, react.useState)(false);
	const [notice, setNotice] = (0, react.useState)("");
	const [dialogStep, setDialogStep] = (0, react.useState)("closed");
	const [sessionsList, setSessionsList] = (0, react.useState)([]);
	const [selectedSessionIds, setSelectedSessionIds] = (0, react.useState)(new Set());
	const [loadingSessions, setLoadingSessions] = (0, react.useState)(false);
	const [clearing, setClearing] = (0, react.useState)(false);
	const autoSaveTimer = (0, react.useRef)(null);
	const load = async () => {
		const [config, measured] = await Promise.all([getConfig(), getCacheUsage()]);
		if (config.ok && typeof config.cacheCapacityGb === "number") setCapacityText(String(config.cacheCapacityGb));
		setUsage(measured);
		setLoaded(true);
	};
	(0, react.useEffect)(() => {
		load();
	}, []);
	const onCapacityChange = (valStr) => {
		const cleaned = valStr.replace(/\D/g, "");
		setCapacityText(cleaned);
		if (autoSaveTimer.current !== null) clearTimeout(autoSaveTimer.current);
		const gb = Number(cleaned);
		if (Number.isFinite(gb) && gb > 0) {
			setUsage((prev) => prev !== null ? {
				...prev,
				capacityBytes: Math.round(gb * 1024 ** 3)
			} : null);
			autoSaveTimer.current = setTimeout(async () => {
				await setCacheCapacity(gb);
			}, 350);
		}
	};
	const openClearFlow = async () => {
		setLoadingSessions(true);
		setDialogStep("sessions");
		const r = await getCacheSessions();
		setLoadingSessions(false);
		if (r.ok && r.sessions !== void 0) {
			setSessionsList(r.sessions);
			setSelectedSessionIds(new Set(r.sessions.map((s) => s.sessionId)));
		} else {
			setSessionsList([]);
			setSelectedSessionIds(new Set());
		}
	};
	const doClear = async (scope) => {
		setClearing(true);
		setNotice("");
		const targetIds = selectedSessionIds.size === sessionsList.length ? void 0 : Array.from(selectedSessionIds);
		const result = await clearCache(scope, targetIds);
		setClearing(false);
		setDialogStep("closed");
		setNotice(result.ok ? `已清理 ✓ 释放 ${formatBytes(result.freedBytes ?? 0)}` : `清理未完成：${result.failed ?? 0} 项无法删除${result.reason !== void 0 ? `（${result.reason}）` : ""}`);
		await load();
	};
	const total = usage?.totalBytes ?? 0;
	const capacity = usage?.capacityBytes ?? 0;
	const ratio = capacity > 0 ? total / capacity : 0;
	const pct = Math.min(100, ratio * 100);
	const barColor = ratio >= CACHE_FULL_RATIO ? "#e5534b" : ratio >= CACHE_WARN_RATIO ? "#d29922" : "#3fb950";
	const health = ratio >= CACHE_FULL_RATIO ? "已接近或超出容量，建议清理（插件不会自动删除任何历史）" : ratio >= CACHE_WARN_RATIO ? "占用偏高，可考虑清理" : "容量健康";
	const labelStyle = {
		fontSize: 12,
		color: "var(--dsw-alias-label-secondary, #999)"
	};
	const selectedBytes = sessionsList.filter((s) => selectedSessionIds.has(s.sessionId)).reduce((acc, s) => acc + s.totalBytes, 0);
	return (0, react.createElement)(
		"div",
		{ style: {
			display: "flex",
			flexDirection: "column",
			gap: 8,
			width: "100%",
			flex: "none"
		} },
		(0, react.createElement)("div", { style: {
			height: 1,
			width: "100%",
			background: "var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08))",
			margin: "6px 0 8px",
			flex: "none"
		} }),
		(0, react.createElement)("span", { style: {
			fontWeight: 600,
			fontSize: 13
		} }, "快照缓存"),
		// Row 1: capacity setting, numeric text input only, right-aligned, normal clear text color.
		(0, react.createElement)("div", { style: {
			display: "flex",
			alignItems: "center",
			gap: 12,
			justifyContent: "space-between"
		} }, (0, react.createElement)("span", { style: labelStyle }, "缓存容量上限"), (0, react.createElement)("div", { style: {
			display: "flex",
			alignItems: "center",
			gap: 6
		} }, (0, react.createElement)("input", {
			type: "text",
			inputMode: "numeric",
			pattern: "[0-9]*",
			value: capacityText,
			disabled: !loaded,
			placeholder: "100",
			onChange: (event) => onCapacityChange(event.target.value),
			style: {
				width: 80,
				textAlign: "right",
				padding: "5px 8px",
				borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.22))",
				background: "var(--dsw-alias-markdown-code-block, #1c1c1e)",
				color: "var(--dsw-alias-label-primary, #f5f5f7)",
				fontWeight: 500,
				fontSize: 12,
				fontFamily: "var(--ds-font-family-code, monospace)"
			}
		}), (0, react.createElement)("span", { style: labelStyle }, "GB"))),
		// Row 2: usage progress bar + health details.
		(0, react.createElement)("div", { style: {
			display: "flex",
			flexDirection: "column",
			gap: 4,
			width: "100%"
		} }, (0, react.createElement)("div", { style: {
			height: 8,
			width: "100%",
			borderRadius: 999,
			background: "var(--dsw-alias-border-l1, rgba(255,255,255,0.10))",
			overflow: "hidden"
		} }, (0, react.createElement)("div", { style: {
			height: "100%",
			width: `${pct}%`,
			background: barColor,
			borderRadius: 999,
			transition: "width 0.3s ease, background 0.3s ease"
		} })), (0, react.createElement)("div", { style: {
			...labelStyle,
			display: "flex",
			gap: 8,
			flexWrap: "wrap",
			justifyContent: "space-between"
		} }, (0, react.createElement)("span", null, usage === null ? "统计中…" : `${formatBytes(total)} / ${formatBytes(capacity)}（${pct.toFixed(1)}%）`), (0, react.createElement)("span", { style: { color: barColor } }, health)), usage !== null ? (0, react.createElement)("div", { style: {
			...labelStyle,
			fontSize: 11
		} }, `会话 ${formatBytes(usage.sessionBytes)} · 工作区 ${formatBytes(usage.workspaceBytes)} · 备份 ${formatBytes(usage.backupsBytes)}`) : null),
		// Row 3: clear action button below the bar + status notice.
		(0, react.createElement)("div", { style: {
			display: "flex",
			alignItems: "center",
			justifyContent: "space-between",
			gap: 12,
			marginTop: 2
		} }, notice.length > 0 ? (0, react.createElement)("span", { style: labelStyle }, notice) : (0, react.createElement)("span", null), (0, react.createElement)("button", {
			type: "button",
			disabled: !loaded || clearing,
			onClick: () => void openClearFlow(),
			style: {
				padding: "5px 16px",
				borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
				background: "var(--dsw-alias-button-tool-bar-fill, #2d2d2e)",
				color: "var(--dsw-alias-label-primary, #e6e6e6)",
				fontSize: 12,
				fontWeight: 500,
				cursor: clearing ? "default" : "pointer"
			}
		}, clearing ? "清理中…" : "清理缓存")),
		// Dialog flow: Step 1 = select sessions; Step 2 = select scope
		dialogStep !== "closed" ? (0, react.createElement)("div", {
			style: {
				position: "fixed",
				inset: 0,
				zIndex: 10001,
				background: "rgba(0,0,0,0.45)",
				display: "flex",
				alignItems: "center",
				justifyContent: "center"
			},
			onClick: () => {
				if (!clearing) setDialogStep("closed");
			}
		}, dialogStep === "sessions" ? (0, react.createElement)(
			"div",
			{
				onClick: (event) => event.stopPropagation(),
				style: {
					width: "min(480px, 94vw)",
					display: "flex",
					flexDirection: "column",
					gap: 12,
					padding: 20,
					borderRadius: 14,
					border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
					background: "var(--dsw-specific-sidebar-fill, #202021)",
					boxShadow: "0 12px 40px rgba(0,0,0,0.5)"
				}
			},
			(0, react.createElement)("div", { style: {
				fontSize: 14,
				fontWeight: 600,
				color: "var(--dsw-alias-label-primary, #e6e6e6)"
			} }, "选择要清理的会话"),
			(0, react.createElement)("div", { style: {
				...labelStyle,
				lineHeight: 1.5
			} }, "请勾选需要清理快照历史的会话记录。"),
			// Selection toolbar: Select All checkbox + stats
			(0, react.createElement)("div", { style: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				padding: "6px 10px",
				background: "rgba(255,255,255,0.04)",
				borderRadius: 8,
				border: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.06))"
			} }, (0, react.createElement)("label", { style: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				cursor: "pointer",
				fontSize: 12,
				color: "var(--dsw-alias-label-primary, #e6e6e6)",
				userSelect: "none"
			} }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: sessionsList.length > 0 && selectedSessionIds.size === sessionsList.length,
				onChange: (e) => {
					if (e.target.checked) setSelectedSessionIds(new Set(sessionsList.map((s) => s.sessionId)));
					else setSelectedSessionIds(new Set());
				}
			}), "全选"), (0, react.createElement)("span", { style: {
				fontSize: 11,
				color: "var(--dsw-alias-label-secondary, #999)"
			} }, `已选 ${selectedSessionIds.size} / ${sessionsList.length} 个（共 ${formatBytes(selectedBytes)}）`)),
			// Session list container (scrollable)
			(0, react.createElement)("div", { style: {
				display: "flex",
				flexDirection: "column",
				gap: 4,
				maxHeight: 240,
				minHeight: 80,
				overflowY: "auto",
				border: "1px solid var(--dsw-alias-border-l1, rgba(255,255,255,0.08))",
				borderRadius: 8,
				padding: "6px",
				background: "var(--dsw-alias-markdown-code-block, #18181a)"
			} }, loadingSessions ? (0, react.createElement)("div", { style: {
				padding: 24,
				textAlign: "center",
				color: "#999",
				fontSize: 12
			} }, "正在读取会话列表中…") : sessionsList.length === 0 ? (0, react.createElement)("div", { style: {
				padding: 24,
				textAlign: "center",
				color: "#999",
				fontSize: 12
			} }, "当前没有存储任何会话快照") : sessionsList.map((s) => {
				const checked = selectedSessionIds.has(s.sessionId);
				return (0, react.createElement)("label", {
					key: s.sessionId,
					style: {
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
						gap: 10,
						padding: "6px 8px",
						borderRadius: 6,
						cursor: "pointer",
						background: checked ? "rgba(255,255,255,0.06)" : "transparent",
						userSelect: "none",
						transition: "background 0.12s ease"
					}
				}, (0, react.createElement)("div", { style: {
					display: "flex",
					alignItems: "center",
					gap: 8,
					minWidth: 0,
					flex: 1
				} }, (0, react.createElement)("input", {
					type: "checkbox",
					checked,
					onChange: (e) => {
						const next = new Set(selectedSessionIds);
						if (e.target.checked) next.add(s.sessionId);
						else next.delete(s.sessionId);
						setSelectedSessionIds(next);
					}
				}), (0, react.createElement)("div", { style: {
					display: "flex",
					flexDirection: "column",
					minWidth: 0
				} }, (0, react.createElement)("span", {
					style: {
						fontSize: 12,
						color: "var(--dsw-alias-label-primary, #e6e6e6)",
						fontWeight: 500,
						whiteSpace: "nowrap",
						overflow: "hidden",
						textOverflow: "ellipsis"
					},
					title: s.title || s.sessionId
				}, s.title || s.sessionId), (0, react.createElement)("span", { style: {
					fontSize: 10,
					color: "var(--dsw-alias-label-tertiary, #777)",
					fontFamily: "var(--ds-font-family-code, monospace)"
				} }, `${s.sessionId.slice(0, 8)} · ${s.lastModified > 0 ? new Date(s.lastModified).toLocaleDateString() : ""}`))), (0, react.createElement)("span", { style: {
					fontSize: 11,
					fontFamily: "var(--ds-font-family-code, monospace)",
					color: "var(--dsw-alias-label-secondary, #aaa)",
					flex: "none"
				} }, formatBytes(s.totalBytes)));
			})),
			// Footer: Cancel + Next / Confirm
			(0, react.createElement)("div", { style: {
				display: "flex",
				justifyContent: "flex-end",
				gap: 10,
				marginTop: 4
			} }, (0, react.createElement)("button", {
				type: "button",
				onClick: () => setDialogStep("closed"),
				style: {
					padding: "6px 16px",
					borderRadius: 6,
					border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
					background: "transparent",
					color: "var(--dsw-alias-label-secondary, #999)",
					fontSize: 12,
					cursor: "pointer"
				}
			}, "取消"), (0, react.createElement)("button", {
				type: "button",
				disabled: selectedSessionIds.size === 0,
				onClick: () => setDialogStep("scope"),
				style: {
					padding: "6px 18px",
					borderRadius: 6,
					border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
					background: "var(--dsw-alias-button-tool-bar-fill, #2d2d2e)",
					color: "var(--dsw-alias-label-primary, #e6e6e6)",
					fontSize: 12,
					fontWeight: 500,
					cursor: selectedSessionIds.size === 0 ? "default" : "pointer",
					opacity: selectedSessionIds.size === 0 ? .5 : 1
				}
			}, "确定"))
) : (0, react.createElement)("div", {
			onClick: (event) => event.stopPropagation(),
			style: {
				width: "min(460px, 92vw)",
				display: "flex",
				flexDirection: "column",
				gap: 14,
				padding: 20,
				borderRadius: 14,
				border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
				background: "var(--dsw-specific-sidebar-fill, #202021)",
				boxShadow: "0 12px 40px rgba(0,0,0,0.5)"
			}
		}, (0, react.createElement)("div", { style: {
			fontSize: 14,
			fontWeight: 600,
			color: "var(--dsw-alias-label-primary, #e6e6e6)"
		} }, "清理快照缓存"), (0, react.createElement)("div", { style: {
			...labelStyle,
			lineHeight: 1.6
		} }, `已选择 ${selectedSessionIds.size} 个会话。此操作将删除对应会话的快照历史，`, (0, react.createElement)("strong", { style: { color: "#e5534b" } }, "不可恢复"), "。你的项目代码本身不受影响。"), (0, react.createElement)("div", { style: {
			display: "flex",
			flexDirection: "column",
			gap: 8
		} }, (0, react.createElement)("button", {
			type: "button",
			disabled: clearing,
			onClick: () => void doClear("session"),
			style: {
				display: "flex",
				flexDirection: "column",
				alignItems: "flex-start",
				gap: 2,
				padding: "8px 12px",
				borderRadius: 8,
				border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
				background: "transparent",
				color: "var(--dsw-alias-label-primary, #e6e6e6)",
				cursor: clearing ? "default" : "pointer",
				textAlign: "left"
			}
		}, (0, react.createElement)("span", { style: {
			fontSize: 12,
			fontWeight: 500
		} }, "仅会话"), (0, react.createElement)("span", { style: {
			...labelStyle,
			fontSize: 11
		} }, "删除所选会话的对话历史快照（repos/）")), (0, react.createElement)("button", {
			type: "button",
			disabled: clearing,
			onClick: () => void doClear("workspace"),
			style: {
				display: "flex",
				flexDirection: "column",
				alignItems: "flex-start",
				gap: 2,
				padding: "8px 12px",
				borderRadius: 8,
				border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
				background: "transparent",
				color: "var(--dsw-alias-label-primary, #e6e6e6)",
				cursor: clearing ? "default" : "pointer",
				textAlign: "left"
			}
		}, (0, react.createElement)("span", { style: {
			fontSize: 12,
			fontWeight: 500
		} }, "仅工作区"), (0, react.createElement)("span", { style: {
			...labelStyle,
			fontSize: 11
		} }, "删除所选会话的代码快照（repos-ws/）")), (0, react.createElement)("button", {
			type: "button",
			disabled: clearing,
			onClick: () => void doClear("both"),
			style: {
				display: "flex",
				alignItems: "center",
				padding: "10px 12px",
				borderRadius: 8,
				border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
				background: "transparent",
				color: "var(--dsw-alias-label-primary, #e6e6e6)",
				cursor: clearing ? "default" : "pointer",
				textAlign: "left"
			}
		}, (0, react.createElement)("span", { style: {
			fontSize: 12,
			fontWeight: 500
		} }, "会话+工作区"))), (0, react.createElement)("div", { style: {
			display: "flex",
			justifyContent: "space-between",
			alignItems: "center"
		} }, (0, react.createElement)("button", {
			type: "button",
			disabled: clearing,
			onClick: () => setDialogStep("sessions"),
			style: {
				padding: "6px 12px",
				borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary, #999)",
				fontSize: 12,
				cursor: clearing ? "default" : "pointer"
			}
		}, "← 上一步"), (0, react.createElement)("button", {
			type: "button",
			disabled: clearing,
			onClick: () => setDialogStep("closed"),
			style: {
				padding: "6px 16px",
				borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.16))",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary, #999)",
				fontSize: 12,
				cursor: clearing ? "default" : "pointer"
			}
		}, "取消")))) : null
);
}
/** Full settings page (设置 → Rewind): wraps the git status/install

*  card in a page layout. The shell supplies { close, useSessions,

*  useWorkspaces }; this card only needs the git check, so extra props are

*  ignored. */
function HistoryRewindSettingsPage() {
	return (0, react.createElement)("div", { style: {
		display: "flex",
		flexDirection: "column",
		gap: 12,
		width: "100%",
		height: "100%",
		boxSizing: "border-box",
		minHeight: 0,
		padding: "4px 0",
		flex: 1
	} }, (0, react.createElement)("div", { style: {
		fontSize: 14,
		fontWeight: 600,
		color: "var(--dsw-alias-label-primary, #e6e6e6)",
		flex: "none"
	} }, "HISTORY-REWIND"), (0, react.createElement)("div", { style: {
		fontSize: 12,
		color: "var(--dsw-alias-label-secondary, #999)",
		lineHeight: 1.5,
		maxWidth: 520,
		flex: "none"
	} }, "本插件用 git 影子仓库实现会话快照与回退，因此依赖 Git。"), (0, react.createElement)(GitPluginCard), (0, react.createElement)(CacheCard), (0, react.createElement)(GitignoreTemplateCard));
}
/** Mount floating widget */
function apply(ctx) {
	const svc = ctx.get("sessions");
	if (svc === void 0) return;
	injectStyles();
	if (typeof svc.handleHostEnvelope === "function") {
		const origHandle = svc.handleHostEnvelope.bind(svc);
		svc.handleHostEnvelope = (envelope) => {
			const frame = envelope?.payload;
			if (frame?.type === "host/session-removed" && frame?.sessionId === suppressingSessionId) return;
			origHandle(envelope);
		};
	}
	if (svc.manager && typeof svc.manager.handleHostEnvelope === "function") {
		const origManagerHandle = svc.manager.handleHostEnvelope.bind(svc.manager);
		svc.manager.handleHostEnvelope = (envelope) => {
			const frame = envelope?.payload;
			if (frame?.type === "host/session-removed" && frame?.sessionId === suppressingSessionId) return;
			origManagerHandle(envelope);
		};
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	const root = (0, react_dom_client.createRoot)(host);
	const listeners = new Set();
	let open = false;
	const setOpen = (value) => {
		if (open === value) return;
		open = value;
		for (const listener of listeners) listener();
	};
	/** Failure notice from a rewind that failed while the panel was closed
	
	*  (it closes immediately on confirm); delivered to the next panel mount. */
	let pendingRewindNotice = null;
	const HistoryPanelShell = () => {
		const current = svc.list.getSnapshot().current;
		const lastId = (0, react.useRef)(void 0);
		(0, react.useEffect)(() => {
			if (current !== void 0) lastId.current = current;
		}, [current]);
		const sessionId = current ?? lastId.current;
		const [, force] = (0, react.useState)(0);
		(0, react.useEffect)(() => {
			const listener = () => force((v) => v + 1);
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}, []);
		(0, react.useEffect)(() => svc.list.subscribe(() => force((v) => v + 1)), []);
		const [dialogOpen, setDialogOpen] = (0, react.useState)(false);
		const [progress, setProgress] = (0, react.useState)({
			phase: "idle",
			sha: "",
			fading: false
		});
		(0, react.useEffect)(() => {
			if (progress.phase !== "done") return;
			const fadeTimer = setTimeout(() => {
				setProgress((prev) => prev.phase === "done" ? {
					...prev,
					fading: true
				} : prev);
			}, 600);
			const doneTimer = setTimeout(() => {
				setProgress((prev) => prev.phase === "done" ? {
					phase: "idle",
					sha: "",
					fading: false
				} : prev);
			}, 1050);
			return () => {
				clearTimeout(fadeTimer);
				clearTimeout(doneTimer);
			};
		}, [progress.phase]);
		const cardRef = { current: null };
		(0, react.useEffect)(() => {
			if (!open) return;
			const card = cardRef.current;
			card?.focus();
			const onKeyDown = (event) => {
				if (event.key === "Escape" && !dialogOpen) setOpen(false);
			};
			window.addEventListener("keydown", onKeyDown);
			return () => window.removeEventListener("keydown", onKeyDown);
		}, [open, dialogOpen]);
		/** Full rect of the conversation viewport: centers the card horizontally AND
		
		*  confines the blur to the chat area so the sidebar stays crisp. */
		const [sessionBounds, setSessionBounds] = (0, react.useState)(null);
		/** Active lanes count in the graph, used to compute exact graph gutter width
		
		*  and offset the history container so the card body (excluding git graph)
		
		*  is centered on the conversation center. */
		const [activeLanes, setActiveLanes] = (0, react.useState)(1);
		(0, react.useLayoutEffect)(() => {
			if (!open) return;
			const findConversationEl = () => {
				const center = document.querySelector("[class*=\"centerCol\"]");
				if (center !== null && center.getBoundingClientRect().width > 200) return center;
				const convScroll = document.querySelector("[data-conversation-scroll]");
				if (convScroll !== null && convScroll.getBoundingClientRect().width > 200) return convScroll;
				const candidates = document.querySelectorAll("[class*=\"ConversationRoot\"], [class*=\"conversation\"], [class*=\"sessionView\"], [class*=\"chatView\"], main");
				for (let i = 0; i < candidates.length; i++) {
					const el = candidates[i];
					const rect = el.getBoundingClientRect();
					if (rect.width > 200 && rect.height > 200) return el;
				}
				return null;
			};
			const updateBounds = () => {
				const chatEl$1 = findConversationEl();
				if (chatEl$1 !== null) {
					const rect = chatEl$1.getBoundingClientRect();
					if (rect.width > 200) {
						setSessionBounds((prev) => prev !== null && prev.left === rect.left && prev.top === rect.top && prev.width === rect.width && prev.height === rect.height ? prev : {
							left: rect.left,
							top: rect.top,
							width: rect.width,
							height: rect.height
						});
						return;
					}
				}
				setSessionBounds(null);
			};
			updateBounds();
			window.addEventListener("resize", updateBounds);
			let observer;
			const chatEl = findConversationEl();
			if (chatEl !== null && typeof ResizeObserver !== "undefined") {
				observer = new ResizeObserver(() => {
					updateBounds();
				});
				observer.observe(chatEl);
			}
			return () => {
				window.removeEventListener("resize", updateBounds);
				observer?.disconnect();
			};
		}, [open]);
		const panel = open && sessionId !== void 0 ? (0, react.createElement)(
			"div",
			{
				className: MODAL_BACKDROP,
				onClick: () => setOpen(false)
			},
			// Blur layer, confined to the conversation viewport so the sidebar and
			// the window chrome stay perfectly sharp. Kept separate from the
			// backdrop because the backdrop must still span the whole viewport to
			// catch clicks anywhere outside the cards. pointer-events:none lets
			// those clicks fall through to it. Falls back to full-viewport blur
			// when the chat container cannot be located.
			// Rendered only once the conversation rect is known. Skipping it while
			// unmeasured is deliberate: a full-viewport fallback would tint the
			// sidebar for a frame — the very flash this layer is meant to avoid.
			// The layout effect above measures before paint, so in practice the
			// blur is present on the first painted frame.
			sessionBounds !== null ? (0, react.createElement)("div", {
				className: MODAL_BLUR,
				style: {
					left: `${sessionBounds.left}px`,
					top: `${sessionBounds.top}px`,
					width: `${sessionBounds.width}px`,
					height: `${sessionBounds.height}px`
				}
			}) : null,
			(0, react.createElement)("div", {
				className: MODAL_CARD,
				tabIndex: -1,
				ref: (node) => {
					cardRef.current = node;
				},
				style: {
					outline: "none",
					...sessionBounds !== null ? {
						position: "fixed",
						left: `${sessionBounds.left + sessionBounds.width / 2}px`,
						transform: `translateX(calc(-50% - ${activeLanes > 0 ? (graphWidth(activeLanes) + 12) / 2 : 0}px))`,
						width: `min(860px, ${Math.max(300, sessionBounds.width - 48)}px)`
					} : {},
					...dialogOpen ? { display: "none" } : {}
				},
				onClick: (event) => event.stopPropagation()
			}, (0, react.createElement)(HistoryPanel, {
				sessionId,
				rebind: (id) => rebindView(svc, id),
				onRewound: () => setOpen(false),
				onRewindFailed: (text) => {
					pendingRewindNotice = text;
					setOpen(true);
				},
				onProgress: (phase, sha) => setProgress({
					phase,
					sha,
					fading: false
				}),
				portalTo: host,
				onDialogOpen: setDialogOpen,
				onLanesChange: setActiveLanes,
				initialNotice: pendingRewindNotice ?? void 0,
				onInitialNoticeConsumed: () => {
					pendingRewindNotice = null;
				}
			}))
) : null;
		const progressUi = progress.phase === "idle" ? null : (0, react.createElement)(react.Fragment, null, (0, react.createElement)("div", {
			className: PROGRESS_MASK,
			style: { opacity: progress.fading ? 0 : 1 }
		}), (0, react.createElement)("div", {
			className: PROGRESS_CARD,
			style: { opacity: progress.fading ? 0 : 1 }
		}, progress.phase === "done" ? (0, react.createElement)("span", { className: "dsh-history-progress-done" }, "✓") : (0, react.createElement)("div", { className: "dsh-history-progress-spin" }), (0, react.createElement)("div", { className: "dsh-history-progress-text" }, (0, react.createElement)("div", { className: "dsh-history-progress-title" }, progress.phase === "working" ? "正在回退…" : progress.phase === "refreshing" ? "正在刷新会话…" : "已回退"), (0, react.createElement)("code", { className: "dsh-history-progress-sha" }, progress.sha))));
		return (0, react.createElement)(react.Fragment, null, panel, progressUi);
	};
	root.render((0, react.createElement)(HistoryPanelShell));
	const slots = ctx.get("slots");
	if (slots !== void 0) slots.inject("conversation.session.header.utilities", () => slots.register({
		name: "conversation.session.header.utilities",
		id: "history",
		order: 10
	}, HistoryHeaderAction));
	if (slots !== void 0) slots.inject("settings.section", () => slots.register({
		name: "settings.section",
		id: SETTINGS_NAMESPACE,
		order: 30,
		label: "HISTORY-REWIND"
	}, HistoryRewindSettingsPage));
	function HistoryCommandRow(props) {
		(0, react.useEffect)(() => {
			setOpen(true);
		}, []);
		const done = props.node?.state?.outcome !== void 0;
		return (0, react.createElement)("div", { style: {
			display: "flex",
			alignItems: "center",
			gap: 8,
			padding: "4px 12px",
			fontSize: 12,
			color: "var(--dsw-alias-label-secondary, #999)"
		} }, (0, react.createElement)("code", { style: {
			fontFamily: "var(--ds-font-family-code, monospace)",
			fontWeight: 600
		} }, "/history"), (0, react.createElement)("span", null, done ? "History panel opened." : "Opening history panel…"));
	}
	if (slots !== void 0) try {
		slots.inject("conversation.chat.commandview", () => slots.register({
			name: "conversation.chat.commandview",
			key: "history"
		}, HistoryCommandRow));
	} catch {}
	function HistoryHeaderAction() {
		return (0, react.createElement)("button", {
			type: "button",
			className: "dsh-history-header-action",
			title: "查看会话版本历史（回档）",
			"aria-label": "HISTORY",
			onClick: () => setOpen(!open)
		}, (0, react.createElement)("svg", {
			width: 14,
			height: 14,
			viewBox: "0 0 16 16",
			fill: "none",
			stroke: "currentColor",
			strokeWidth: 1.6,
			strokeLinecap: "round",
			strokeLinejoin: "round"
		}, (0, react.createElement)("path", { d: "M2.5 8 A 5.5 5.5 0 1 0 8 2.5" }), (0, react.createElement)("path", { d: "M8 0.8 L 5 3.2 L 8 5.6" })), (0, react.createElement)("span", null, "HISTORY"));
	}
	ctx.effect(() => () => {
		root.unmount();
		host.remove();
	}, "dsh-history-rewind: floating history panel");
}

//#endregion
exports.apply = apply
exports.inject = inject
return module.exports; } });
//# sourceMappingURL=client.js.map