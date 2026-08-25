window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-history-rewind", factory: (require) => {
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

* Shared constants and plain data types for @deepseek-ai/dsh-history-rewind.

*/
/** HTTP route prefix served by the Host half for the browser channel. */
const ROUTE_PREFIX = "/dsh-history-rewind/api";
/** Settings namespace owned by this plugin (lowercase kebab-case per the seam). */
const SETTINGS_NAMESPACE = "history-rewind";

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
		...data.workspaceRestored === true ? { workspaceRestored: true } : {}
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
	"/* Modal Backdrop & Window (DSH Modal: mask + r24 card) */",
	".dsh-history-modal-backdrop {",
	"  position: fixed;",
	"  inset: 0;",
	"  z-index: 10000;",
	"  background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.55));",
	"  backdrop-filter: var(--dsw-mask-blur, blur(2px));",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: center;",
	"  padding: 24px;",
	"  animation: dshFadeIn 0.15s ease-out;",
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
	"  width: min(860px, 94vw);",
	"  height: min(82vh, 760px);",
	"  display: flex;",
	"  flex-direction: column;",
	"  background: var(--dsw-alias-bg-layer-2, #252526);",
	"  border: 1px solid var(--dsw-alias-border-inverted, rgba(255, 255, 255, 0.18));",
	"  border-radius: 24px;",
	"  box-shadow: var(--dsw-shadow-lv3, 0 12px 40px rgba(0, 0, 0, 0.5));",
	"  overflow: hidden;",
	"  color: var(--dsw-alias-label-primary, #e6e6e6);",
	"  font-family: inherit;",
	"}",
	"/* Header (DSH Dialog header: title 16/24 wt500, close 28x28) */",
	".dsh-history-modal-head {",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: flex-end;",
	"  padding: 20px 14px 12px 24px;",
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
	"  padding: 6px 24px;",
	"  background: var(--dsw-alias-bg-layer-1, #222223);",
	"  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));",
	"  gap: 12px;",
	"}",
	".dsh-history-toolbar-stats {",
	"  display: flex;",
	"  align-items: center;",
	"  gap: 6px;",
	"  font-size: 12px;",
	"  color: var(--dsw-alias-label-secondary, #888888);",
	"}",
	"/* Panel & Timeline List Body */",
	".dsh-history-panel {",
	"  display: flex;",
	"  flex-direction: column;",
	"  height: 100%;",
	"  min-height: 0;",
	"  position: relative;",
	"  background: var(--dsw-alias-bg-base, #1e1e1f);",
	"}",
	".dsh-history-modal-body {",
	"  flex: 1;",
	"  min-height: 0;",
	"  overflow-y: auto;",
	"  overflow-x: hidden;",
	"  padding: 0;",
	"  display: flex;",
	"  flex-direction: column;",
	"}",
	".dsh-history-modal-body-center {",
	"  justify-content: center;",
	"}",
	".dsh-history-modal-body::-webkit-scrollbar {",
	"  width: 8px;",
	"}",
	".dsh-history-modal-body::-webkit-scrollbar-track {",
	"  background: transparent;",
	"}",
	".dsh-history-modal-body::-webkit-scrollbar-thumb {",
	"  background: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.12));",
	"  border-radius: 4px;",
	"}",
	".dsh-history-modal-body::-webkit-scrollbar-thumb:hover {",
	"  background: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.22));",
	"}",
	"/* Flat Timeline Row */",
	".dsh-history-row {",
	"  display: flex;",
	"  align-items: stretch;",
	"  gap: 10px;",
	"  cursor: pointer;",
	"  padding: 0 16px;",
	"  border-bottom: none;",
	"  transition: background 0.08s ease;",
	"  position: relative;",
	"  background: #1f1f20;",
	"}",
	".dsh-history-row:nth-child(even) {",
	"  background: #1c1c1d;",
	"}",
	".dsh-history-row:hover {",
	"  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.06));",
	"}",
	".dsh-history-row.is-selected {",
	"  background: rgba(77, 136, 255, 0.12) !important;",
	"  border-bottom-color: rgba(77, 136, 255, 0.3);",
	"}",
	".dsh-history-graph-cell {",
	"  flex: none;",
	"  display: block;",
	"}",
	".dsh-history-node {",
	"  transition: r 0.12s ease;",
	"}",
	".dsh-history-row-content {",
	"  display: flex;",
	"  align-items: center;",
	"  justify-content: space-between;",
	"  min-width: 0;",
	"  flex: 1;",
	"  gap: 14px;",
	"  padding: 1px 0;",
	"}",
	".dsh-history-row-main {",
	"  display: flex;",
	"  flex-direction: column;",
	"  justify-content: center;",
	"  min-width: 0;",
	"  flex: 1;",
	"  gap: 2px;",
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
	"  flex-wrap: wrap;",
	"  gap: 4px;",
	"  min-width: 0;",
	"  padding-top: 3px;",
	"}",
	".dsh-history-file-chip {",
	"  flex: none;",
	"  display: inline-flex;",
	"  align-items: center;",
	"  padding: 0 7px;",
	"  border-radius: 2px;",
	"  font-size: 10px;",
	"  font-family: var(--ds-font-family-code, monospace);",
	"  font-weight: 600;",
	"  line-height: 14px;",
	"  letter-spacing: 0.02em;",
	"  color: var(--dsw-alias-label-primary, #e2e8f0);",
	"  background: var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.08));",
	"  white-space: nowrap;",
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
	"/* Single-line file clip (BASELINE rows): clips any overflow instead of",
	"   wrapping, and lets each chip shrink+ellipsis so the trailing \"+N\" stays.",
	"   Keeps the whole row on exactly one line. */",
	".dsh-history-file-clip {",
	"  display: flex;",
	"  flex-wrap: nowrap;",
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
const MODAL_CARD = "dsh-history-modal-card";
const MODAL_BODY = "dsh-history-modal-body";
const MODAL_BODY_CENTER = "dsh-history-modal-body-center";
const GRAPH_CELL = "dsh-history-graph-cell";
const PROGRESS_MASK = "dsh-history-progress-mask";
const PROGRESS_CARD = "dsh-history-progress-card";

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
/** Render Node Content in Flat Trajectory Row */
/** Max changed-file chips shown per row; overflow collapses into "+N". */
const MAX_FILES = 12;
/** Render a changed-file chip line: at most MAX_FILES chips + "+N" indicator,

*  kept on a single line by clipping overflow (BASELINE & TURN rows).

*  With `indent` (TURN rows) a leading spacer shifts the chips to the message

*  TEXT column — the line aligns with the USER/ASST content, not the badges. */
function FileChips(props) {
	const { files, indent = false } = props;
	if (files.length === 0) return null;
	return (0, react.createElement)("div", { className: FILE_LIST }, ...indent ? [(0, react.createElement)("span", { className: FILE_INDENT }, null)] : [], (0, react.createElement)("div", { className: FILE_CLIP }, files.slice(0, MAX_FILES).map((file) => (0, react.createElement)("code", {
		className: FILE_CHIP,
		title: file,
		key: file
	}, file))), files.length > MAX_FILES ? (0, react.createElement)("code", {
		className: FILE_CHIP,
		style: { color: "var(--dsw-alias-label-secondary, #999)" }
	}, `… +${files.length - MAX_FILES}`) : null);
}
function RowContentNode(props) {
	const { row, isHead } = props;
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
		const shown = files.slice(0, MAX_FILES);
		return (0, react.createElement)("div", { className: ROW_CONTENT }, (0, react.createElement)("div", { className: ROW_MAIN }, (0, react.createElement)(
			"div",
			{ className: `${SINGLE_LINE} ${FILE_LIST}` },
			(0, react.createElement)("span", { className: "dsh-badge dsh-badge-turn-start" }, "BASELINE"),
			// Chip clip: single line only — overflow clips and each chip shrinks,
			// so the trailing "+N" always stays visible on the same line.
			(0, react.createElement)("div", { className: FILE_CLIP }, shown.map((file) => (0, react.createElement)("code", {
				className: FILE_CHIP,
				title: file,
				key: file
			}, file))),
			files.length > MAX_FILES ? (0, react.createElement)("code", {
				className: FILE_CHIP,
				style: { color: "var(--dsw-alias-label-secondary, #999)" }
			}, `… +${files.length - MAX_FILES}`) : null
)), sideElements);
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
			indent: true
		})
), sideElements);
}
/** Geometry for Git Graph */
const LANE_W = 16;
const NODE_R = 4;
const RAIL_W = 2;
const NODE_GAP = 2;
/** Row heights (compact flat list) */
const ROW_H_SINGLE = 22;
/** Turn-end rows show one message line per side (USER + ASST). */
const ROW_H_TURN = 46;
/** Turn-end row with files: extra line of chips (~16px incl. gap). */
const ROW_H_FILES = 16;
function rowHeightOf(row) {
	if (row.meta?.kind === "turn-end") return (row.files ?? []).length > 0 ? ROW_H_TURN + ROW_H_FILES : ROW_H_TURN;
	return ROW_H_SINGLE;
}
const laneX = (lane) => 12 + lane * LANE_W;
function railPath(edge, y0, y1) {
	const x0 = laneX(edge.from);
	const x1 = laneX(edge.to);
	if (x0 === x1) return `M ${x0} ${y0} L ${x1} ${y1}`;
	const my = (y0 + y1) / 2;
	return `M ${x0} ${y0} C ${x0} ${my}, ${x1} ${my}, ${x1} ${y1}`;
}
/** Graph SVG cell */
function GraphCell(props) {
	const { row, lanes, colors, headLanes, isHead, isHovered, futureSet, height, hoverPath } = props;
	const width = Math.max(1, lanes) * LANE_W + 8;
	const mid = height / 2;
	const nodeX = laneX(row.lane);
	const grey = "#6b6b6d";
	const HOVER = "#4d88ff";
	const AFTER_HEAD = "#7086ab";
	const onHead = (lane) => headLanes.includes(lane);
	const hovering = hoverPath !== null;
	const onPath = hovering && hoverPath.has(row.sha);
	const hoverEdge = (edge) => hoverPath !== null && hoverPath.has(edge.childSha) && hoverPath.has(edge.parentSha);
	const strokeOf = (edge) => {
		if (hoverEdge(edge)) return HOVER;
		if (hovering) return grey;
		if (futureSet.has(edge.childSha)) return AFTER_HEAD;
		return onHead(edge.lane) ? colors[edge.lane % colors.length] : grey;
	};
	const nodeColor = onPath ? HOVER : hovering ? grey : isHead ? colors[row.lane % colors.length] : futureSet.has(row.sha) ? AFTER_HEAD : onHead(row.lane) ? colors[row.lane % colors.length] : grey;
	const railOpacity = (edge) => {
		if (hoverEdge(edge)) return 1;
		if (hovering) return .45;
		return onHead(edge.lane) ? .85 : .6;
	};
	const nodeStop = NODE_R + NODE_GAP;
	const rails = [...row.topEdges.map((edge, i) => (0, react.createElement)("path", {
		key: `t${i}`,
		d: railPath(edge, 0, edge.to === row.lane ? mid - nodeStop : mid),
		fill: "none",
		stroke: strokeOf(edge),
		strokeWidth: hoverEdge(edge) ? RAIL_W + 1.5 : RAIL_W,
		opacity: railOpacity(edge)
	})), ...row.bottomEdges.map((edge, i) => (0, react.createElement)("path", {
		key: `b${i}`,
		d: railPath(edge, edge.from === row.lane ? mid + nodeStop : mid, height),
		fill: "none",
		stroke: strokeOf(edge),
		strokeWidth: hoverEdge(edge) ? RAIL_W + 1.5 : RAIL_W,
		opacity: railOpacity(edge)
	}))];
	const nodeClass = "dsh-history-node";
	const node = isHead || isHovered ? (0, react.createElement)("circle", {
		className: nodeClass,
		cx: nodeX,
		cy: mid,
		r: onPath ? NODE_R + 3 : NODE_R + 1,
		fill: "var(--dsw-alias-bg-base, #1e1e1e)",
		stroke: nodeColor,
		strokeWidth: onPath ? 2.6 : isHead ? 2.4 : 2
	}) : (0, react.createElement)("circle", {
		className: nodeClass,
		cx: nodeX,
		cy: mid,
		r: onPath ? NODE_R + 2 : NODE_R,
		fill: nodeColor
	});
	return (0, react.createElement)("svg", {
		className: GRAPH_CELL,
		width,
		height,
		viewBox: `0 0 ${width} ${height}`,
		style: {
			width,
			minWidth: width
		}
	}, ...rails, node);
}
/** Timeline Row component */
function HistoryRow(props) {
	const { row, lanes, colors, headLanes, isHead, isHovered, isSelected, hoverPath, onHover, onSelect, anchor, headSha, rowHeights, onMeasure, futureSet } = props;
	const estimatedHeight = rowHeightOf(row);
	const height = rowHeights[row.sha] ?? estimatedHeight;
	const setRowEl = (0, react.useCallback)((node) => {
		if (node !== null) onMeasure(row.sha, node.offsetHeight);
	}, [row.sha, onMeasure]);
	return (0, react.createElement)("div", {
		className: `${ROW} ${isSelected ? "is-selected" : ""}`,
		style: { minHeight: estimatedHeight },
		ref: setRowEl,
		"data-sha": row.sha,
		...anchor ? { "data-anchor": row.sha } : {},
		onMouseEnter: () => onHover(row.sha),
		onMouseLeave: () => onHover(null),
		onClick: () => onSelect(row)
	}, (0, react.createElement)(GraphCell, {
		row,
		lanes,
		colors,
		headLanes,
		isHead,
		isHovered,
		futureSet,
		height,
		hoverPath
	}), (0, react.createElement)(RowContentNode, {
		row,
		isHead
	}));
}
/** Session id currently in the middle of a rewind: while set, client-side

*  `host/session-removed` frames are intercepted so the session is never

*  dropped from the list store, preventing `current` from becoming undefined

*  and stopping the chat view from jumping to the initial blank hero page. */
let suppressingSessionId = null;
/** History Panel */
function HistoryPanel(props) {
	const { sessionId, rebind, onRewound, onRewindFailed, onProgress, portalTo, onDialogOpen, initialNotice, onInitialNoticeConsumed } = props;
	const [rows, setRows] = (0, react.useState)(void 0);
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
	/** Measured per-sha row heights (real DOM height), keyed by sha. Falling back
	
	*  to the estimate lets the graph stretch to wrapped/taller rows. */
	const [rowHeights, setRowHeights] = (0, react.useState)({});
	/** Store a row's measured height; no-op re-render when it already matches. */
	const measureRow = (0, react.useCallback)((sha, height) => {
		setRowHeights((prev) => prev[sha] === height ? prev : {
			...prev,
			[sha]: height
		});
	}, []);
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
		const [result, status] = await Promise.all([fetchTimeline(sessionId), get(`${ROUTE_PREFIX}/status?sessionId=${encodeURIComponent(sessionId)}`)]);
		if (result.ok && result.rows !== void 0) setRows(result.rows);
		else setRows(null);
		if (status !== null && typeof status.activeTip === "string") setHead(status.activeTip);
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
		el.scrollTop = Math.max(0, target.offsetTop - el.clientHeight / 2 + target.clientHeight / 2);
		pendingCenter.current = null;
	}, [winStart, headSha]);
	const anchor = (0, react.useRef)({
		sha: "",
		top: 0
	});
	const onScroll = () => {
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
			el.scrollTop += now - anchor.current.top;
		}
		anchor.current = {
			sha: "",
			top: 0
		};
	}, [winStart]);
	const [centered, setCentered] = (0, react.useState)(false);
	(0, react.useLayoutEffect)(() => {
		const el = listRef.current;
		if (el === null) return;
		const measure = () => {
			setCentered(el.scrollHeight <= el.clientHeight + 1);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [
		rows,
		winStart,
		rowHeights
	]);
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
		setNotice(result.ok ? `已快照 ✓ ${result.snap ?? ""}` : `快照失败：${result.reason ?? "unknown"}`);
		await load();
	};
	if (rows === void 0) return (0, react.createElement)("div", {
		className: PANEL,
		style: {
			padding: 24,
			alignItems: "center",
			justifyContent: "center",
			color: "var(--dsw-alias-label-secondary, #888)"
		}
	}, "正在读取会话历史…");
	if (rows === null) return (0, react.createElement)("div", {
		className: PANEL,
		style: {
			padding: 24,
			alignItems: "center",
			justifyContent: "center",
			gap: 10
		}
	}, (0, react.createElement)("span", { style: { color: "var(--dsw-alias-state-error-primary, #f87171)" } }, "时间线不可用（未初始化或数据异常）"), (0, react.createElement)("button", {
		className: `${BUTTON} primary`,
		onClick: () => void doSnapshot()
	}, "创建首个快照"));
	if (rows.length === 0) return (0, react.createElement)("div", {
		className: PANEL,
		style: {
			padding: 32,
			alignItems: "center",
			justifyContent: "center",
			gap: 12
		}
	}, (0, react.createElement)("div", { style: {
		color: "var(--dsw-alias-label-secondary, #888)",
		textAlign: "center",
		maxWidth: 360,
		lineHeight: 1.5,
		fontSize: 12
	} }, "当前会话尚未产生快照。发送消息后，TURN 开始与结束将自动记录。"));
	const laid = graph !== null && winStart !== null && winStart.rows === graph.rows.length ? graph.rows.slice(winStart.start, winStart.end) : graph !== null ? graph.rows.slice(Math.max(0, graph.rows.length - PAGE * 2)) : null;
	return (0, react.createElement)(
		"div",
		{ className: PANEL },
		// Scrollable Flat Timeline List (Trajectory style), windowed ±20 around HEAD
		(0, react.createElement)("div", {
			className: centered ? `${MODAL_BODY} ${MODAL_BODY_CENTER}` : MODAL_BODY,
			ref: (node) => {
				listRef.current = node;
			},
			onScroll
		}, laid !== null && laid.map((row, listIdx) => (0, react.createElement)(HistoryRow, {
			key: row.sha,
			row,
			lanes: graph.lanes,
			colors: RAIL_COLORS,
			headLanes: graph.headLanes,
			isHead: row.sha === headSha,
			isHovered: hoverSha === row.sha,
			isSelected: selected?.sha === row.sha,
			hoverPath,
			onHover,
			onSelect: (target) => {
				if (selected?.sha === target.sha) setSelected(null);
				else setSelected(target);
			},
			anchor: row.sha === headSha,
			headSha,
			rowHeights,
			onMeasure: measureRow,
			futureSet
		}))),
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
/** Full settings page (设置 → history-rewind): wraps the git status/install

*  card in a page layout. The shell supplies { close, useSessions,

*  useWorkspaces }; this card only needs the git check, so extra props are

*  ignored. */
function HistoryRewindSettingsPage() {
	return (0, react.createElement)("div", { style: {
		display: "flex",
		flexDirection: "column",
		gap: 12,
		width: "100%",
		padding: "4px 0"
	} }, (0, react.createElement)("div", { style: {
		fontSize: 14,
		fontWeight: 600,
		color: "var(--dsw-alias-label-primary, #e6e6e6)"
	} }, "history-rewind"), (0, react.createElement)("div", { style: {
		fontSize: 12,
		color: "var(--dsw-alias-label-secondary, #999)",
		lineHeight: 1.5,
		maxWidth: 520
	} }, "本插件用 git 影子仓库实现会话快照与回退，因此依赖 Git。"), (0, react.createElement)(GitPluginCard));
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
		const panel = open && sessionId !== void 0 ? (0, react.createElement)("div", {
			className: MODAL_BACKDROP,
			onClick: () => setOpen(false)
		}, (0, react.createElement)("div", {
			className: MODAL_CARD,
			tabIndex: -1,
			ref: (node) => {
				cardRef.current = node;
			},
			style: {
				outline: "none",
				...dialogOpen ? { display: "none" } : {}
			},
			onClick: (event) => event.stopPropagation()
		}, (0, react.createElement)("button", {
			className: "dsh-history-dialog-close",
			title: "关闭",
			style: {
				position: "absolute",
				top: 16,
				right: 20,
				zIndex: 60,
				background: "var(--dsw-alias-bg-layer-2, #2d2d2e)",
				border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))"
			},
			onClick: () => setOpen(false)
		}, "✕"), (0, react.createElement)(HistoryPanel, {
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
			initialNotice: pendingRewindNotice ?? void 0,
			onInitialNoticeConsumed: () => {
				pendingRewindNotice = null;
			}
		}))) : null;
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
		label: SETTINGS_NAMESPACE
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