import { existsSync, mkdirSync } from "node:fs";
import { copyFile, cp, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

//#region src/constants.ts
/**

* Shared constants and plain data types for dsh-history-rewind.

*/
/** HTTP route prefix served by the Host half for the browser channel. */
const ROUTE_PREFIX = "/dsh-history-rewind/api";
/** Root directory (under $DSH_HOME) holding every shadow-store artifact. */
const HISTORY_ROOT_DIRNAME = ".dsh-history-rewind";
/** Directory holding per-session bare repos (`repos/session-<id>.git`). */
const REPOS_DIRNAME = "repos";
/** Directory holding per-project workspace bare repos (`repos-ws/<project>.git`). */
const REPOS_WS_DIRNAME = "repos-ws";
/** Directory holding pre-rewind backups (session files + workspace trees). */
const BACKUPS_DIRNAME = "backups";
/** Directory holding per-project exclusive locks. */
const LOCKS_DIRNAME = "locks";
/** Branch name carrying the never-jumped original road of every session repo. */
const MAIN_BRANCH = "main";
/** Prefix of road branches (post-jump forks produced by content changes). */
const ROAD_REF_PREFIX = "refs/heads/road-";
/** Basename of the global config file, stored right under the history root. */
const CONFIG_FILENAME = "config.json";
/**

* Seed content for a workspace's `.gitignore` when a fresh workspace has none

* yet. This is ONLY a starting point written once per workspace — after that

* the workspace's own `.gitignore` is the sole source of truth for what a

* snapshot excludes; nothing here is merged into the walk at snapshot time.

*/
const DEFAULT_GITIGNORE_TEMPLATE = [".git"];
/** Fixed identity stamped on shadow commits (never the user's git identity). */
const COMMIT_AUTHOR_NAME = "dsh-history";
/** Fixed author email for shadow commits. */
const COMMIT_AUTHOR_EMAIL = "history@dsh.local";
/** Age after which an abandoned lockfile is considered stale and stealable. */
const LOCK_STALE_MS = 6e4;
/** Schema defaults. */
const HISTORY_REWIND_DEFAULTS = {
	enabled: true,
	gitignoreTemplate: `${DEFAULT_GITIGNORE_TEMPLATE.join("\n")}\n`
};

//#endregion
//#region src/git-runner.ts
const OUT_CAP = 4e6;
const GRACE_MS = 3e4;
/**

* Run one git argv through the subprocess seam.

* @param subprocess - the subprocess service.

* @param argv - full git argv (argv[0] === 'git').

* @param cwd - working directory for the child.

* @param env - optional extra environment (commit identity / transient index).

* @param stdin - optional bytes written to stdin then closed.

* @returns the exit code and captured stdout/stderr text.

*/
async function runGit(subprocess, argv, cwd, env, stdin) {
	const handle = subprocess.spawn({
		argv,
		cwd,
		stdio: {
			stdin: stdin !== void 0 ? { data: stdin } : "ignore",
			stdout: { maxBytes: OUT_CAP },
			stderr: { maxBytes: OUT_CAP }
		},
		graceMs: GRACE_MS,
		...env !== void 0 ? { env } : {}
	});
	const outcome = await handle.done;
	return {
		exitCode: outcome.exitCode,
		stdout: handle.collected.stdout?.readFrom(0).text ?? "",
		stderr: handle.collected.stderr?.readFrom(0).text ?? ""
	};
}
/** First non-empty line of trimmed stdout (git single-value output). */
function firstLine(stdout) {
	return stdout.trim().split("\n")[0]?.trim() ?? "";
}

//#endregion
//#region src/git-commands.ts
/** Tree-entry mode strings. */
const MODE_FILE = "100644";
/** Executable file mode string. */
const MODE_EXEC = "100755";
/**

* Common `git --git-dir=…` prefix for every shadow command.

* @param repo - the bare shadow repo.

* @returns the argv prefix.

*/
function base(repo) {
	return ["git", `--git-dir=${repo.gitDir}`];
}
/** argv: initialize a bare repo (parent dirs must already exist). */
function argvInitBare(gitDir) {
	return [
		"git",
		"init",
		"--bare",
		"--quiet",
		gitDir
	];
}
/** argv: probe the repo (works when HEAD exists). */
function argvRevParseGitDir(repo) {
	return [
		...base(repo),
		"rev-parse",
		"--git-dir"
	];
}
/**

* argv: hash one on-disk file into the object store; stdout is the blob SHA.

* Git reads the file itself, so binary bytes never cross our process boundary

* (the whole reason restore and snapshot avoid subprocess stdout).

* @param repo - the bare shadow repo.

* @param absPath - absolute path of the file to hash.

* @returns the hash-object argv.

*/
function argvHashObjectFile(repo, absPath) {
	return [
		...base(repo),
		"hash-object",
		"-w",
		"--",
		absPath
	];
}
/**

* argv: batch-hash files listed on stdin (one path per line or NUL-separated

* with -z) into the object store; stdout is one blob SHA per input file, in

* the same order.

* @param repo - the bare shadow repo.

* @returns the hash-object argv.

*/
function argvHashObjectStdinPaths(repo, zero) {
	return [
		...base(repo),
		"hash-object",
		"-w",
		"--stdin-paths",
		...zero ? ["-z"] : []
	];
}
/**

* argv: build a tree from stdin entries; stdout is the tree SHA. With `-z`

* the entries are NUL-terminated (<mode> <type> <sha>\t<name>\0) and paths

* are not quoted.

* @param repo - the bare shadow repo.

* @param zero - whether stdin is NUL-terminated.

* @returns the mktree argv.

*/
function argvMktree(repo, zero) {
	return [
		...base(repo),
		"mktree",
		...zero ? ["-z"] : []
	];
}
/**

* argv: load index-info records (mode sha\tpath, NUL-terminated with -z)

* into a transient index — all workspace entries in ONE git process.

* The caller points GIT_INDEX_FILE at a disposable file inside the repo

* dir so the bare repo's own state is never touched, and passes

* `core.bare=false` (git refuses index ops when core.bare is true).

* @param repo - the bare shadow repo.

* @returns the update-index argv.

*/
function argvUpdateIndexFromInfo(repo) {
	return [
		"git",
		"-c",
		"core.bare=false",
		`--git-dir=${repo.gitDir}`,
		"update-index",
		"--add",
		"-z",
		"--index-info"
	];
}
/**

* argv: write the transient index into a tree object; stdout is the tree

* SHA. One process for the whole tree, replacing one mktree spawn per

* directory.

* @param repo - the bare shadow repo.

* @returns the write-tree argv.

*/
function argvWriteTree(repo) {
	return [
		"git",
		"-c",
		"core.bare=false",
		`--git-dir=${repo.gitDir}`,
		"write-tree"
	];
}
/**

* argv: create a commit object from a tree, optionally with one parent;

* stdout is the commit SHA. The message travels as one argv element and is

* never shell-interpreted.

* @param repo - the bare shadow repo.

* @param treeSha - root tree SHA.

* @param message - commit message.

* @param parentSha - optional single parent (anchor).

* @returns the commit-tree argv.

*/
function argvCommitTree(repo, treeSha, message, parentSha) {
	const argv = [
		...base(repo),
		"commit-tree",
		treeSha,
		"-m",
		message
	];
	if (parentSha !== void 0 && parentSha.length > 0) argv.push("-p", parentSha);
	return argv;
}
/**

* argv: move a ref to `newSha` (optionally verifying it currently points at

* `oldSha`).

* @param repo - the bare shadow repo.

* @param ref - full ref name.

* @param newSha - target commit.

* @param oldSha - optional expected current value (compare-and-swap).

* @returns the update-ref argv.

*/
function argvUpdateRef(repo, ref, newSha, oldSha) {
	const argv = [
		...base(repo),
		"update-ref",
		ref,
		newSha
	];
	if (oldSha !== void 0 && oldSha.length > 0) argv.push(oldSha);
	return argv;
}
/** argv: resolve a commit-ish to its commit hash (nonzero exit when absent). */
function argvRevParseCommit(repo, refish) {
	return [
		...base(repo),
		"rev-parse",
		"--verify",
		"--quiet",
		`${refish}^{commit}`
	];
}
/**

* argv: topological commit walk across ALL refs (main + road branches);

* stdout lines are `<sha>|<parents>|<subject>|<unix>`.

* @param repo - the bare shadow repo.

* @returns the log argv.

*/
function argvLogAll(repo) {
	return [
		...base(repo),
		"log",
		"--all",
		"--topo-order",
		"--pretty=format:%H|%P|%s|%ct"
	];
}
/**

* argv: subjects of commits reachable from `refish` (newest first); used to

* derive the TURN counter from git alone.

* @param repo - the bare shadow repo.

* @param refish - ref or commit-ish (default main).

* @returns the log argv.

*/
function argvLogSubjects(repo, refish = `refs/heads/${MAIN_BRANCH}`) {
	return [
		...base(repo),
		"log",
		"--pretty=%s",
		refish
	];
}
/**

* argv: list every tree entry recursively; stdout lines are

* `<mode> <type> <sha>\t<path>`.

* @param repo - the bare shadow repo.

* @param treeish - commit or tree to list.

* @returns the ls-tree argv.

*/
function argvListTree(repo, treeish) {
	return [
		...base(repo),
		"ls-tree",
		"-r",
		"-z",
		treeish
	];
}
/**

* argv: load a commit's tree into the transient index (restore step 1). The

* caller passes a dedicated GIT_INDEX_FILE env so the bare repo's own state

* is never touched. `core.bare=false` + an explicit work-tree make the

* index commands accept the bare repo (git refuses index ops when core.bare

* is true and no work-tree is given).

* @param repo - the bare shadow repo.

* @param treeish - commit or tree to load.

* @returns the read-tree argv.

*/
function argvReadTree(repo, treeish) {
	return [
		"git",
		"-c",
		"core.bare=false",
		`--git-dir=${repo.gitDir}`,
		"read-tree",
		"--reset",
		treeish
	];
}
/**

* argv: materialize the whole index into `targetDir` (restore step 2).

* Git writes the files itself — binary-safe, no bytes through our process.

* @param repo - the bare shadow repo.

* @param targetDir - the directory to write into (the workspace cwd).

* @returns the checkout-index argv.

*/
function argvCheckoutIndex(repo, targetDir) {
	return [
		"git",
		"-c",
		"core.bare=false",
		`--git-dir=${repo.gitDir}`,
		`--work-tree=${targetDir}`,
		"checkout-index",
		"-a",
		"-f"
	];
}
/** Env entries that give shadow commits a fixed identity. */
function commitEnv() {
	return {
		GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
		GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
		GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
		GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL
	};
}

//#endregion
//#region src/store.ts
/** Resolve $DSH_HOME the same way the deployment does. */
function dshHome() {
	const fromEnv = process.env.DSH_HOME;
	if (fromEnv !== void 0 && fromEnv.length > 0) return fromEnv;
	return join(homedir(), ".dsh");
}
/** Root of every dsh-history artifact: $DSH_HOME/.dsh-history. */
function historyRoot(home = dshHome()) {
	return join(home, HISTORY_ROOT_DIRNAME);
}
/**

* Ensure the history root (and its repos/ backups/ locks/ children) exist so

* git calls that use it as cwd never hit ENOENT on a fresh install.

* @param root - history root.

*/
async function ensureHistoryRoot(root) {
	await mkdir(root, { recursive: true });
	await mkdir(join(root, REPOS_DIRNAME), { recursive: true });
	await mkdir(join(root, REPOS_WS_DIRNAME), { recursive: true });
	await mkdir(join(root, BACKUPS_DIRNAME), { recursive: true });
	await mkdir(join(root, LOCKS_DIRNAME), { recursive: true });
}
/** Per-session bare repo: $DSH_HOME/.dsh-history/repos/session-<id>.git. */
function sessionRepoDir(root, sessionId) {
	return join(root, REPOS_DIRNAME, `session-${sessionId}.git`);
}
/** Filesystem-safe directory segment for a session id (keep \w / . / -). */
function sessionSegment(sessionId) {
	return sessionId.replace(/[^\w.-]/g, "_");
}
/**

* Per-session workspace bare repo: $DSH_HOME/.dsh-history/repos-ws/session-<id>.git.

* Each session owns its workspace history, so two sessions sharing one

* workspace directory each get their own WORKSPACE anchors and file-version chain.

*/
function workspaceRepoDir(root, sessionId) {
	return join(root, REPOS_WS_DIRNAME, `session-${sessionSegment(sessionId)}.git`);
}
/**

* Legacy per-project workspace bare repo (pre session-scoped storage): kept

* for reading old snapshots whose ws commits live there. Timeline enrichment

* and rewind fall back to it when the per-session repo lacks a commit.

*/
function legacyWorkspaceRepoDir(root, cwd) {
	return join(root, REPOS_WS_DIRNAME, `${projectSegment(cwd)}.git`);
}
/** Pre-rewind backup root for one session: backups/session-<id>/. */
function sessionBackupDir(root, sessionId) {
	return join(root, BACKUPS_DIRNAME, `session-${sessionId}`);
}
/** Pre-rewind backup root for one session's workspace: backups/ws-session-<id>/. */
function workspaceBackupDir(root, sessionId) {
	return join(root, BACKUPS_DIRNAME, `ws-session-${sessionSegment(sessionId)}`);
}
/**

* Sanitize an arbitrary filesystem path into a single safe directory segment.

* Non-alphanumeric runs collapse to '-'; a short hash keeps distinct paths

* distinct after sanitization.

* @param cwd - the workspace absolute path.

* @returns a filesystem-safe, collision-resistant directory segment.

*/
function projectSegment(cwd) {
	const slug = cwd.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 48);
	let h = 5381;
	for (let i = 0; i < cwd.length; i++) h = ((h << 5) + h ^ cwd.charCodeAt(i)) >>> 0;
	return `${slug || "ws"}-${h.toString(16).padStart(8, "0")}`;
}
/**

* In-process probe cache: once a bare repo has been initialized, probed and

* its HEAD pointed at main, there is nothing left to verify — every later

* snapshot would otherwise pay two extra git spawns (symbolic-ref +

* rev-parse) for no information. The cache re-checks HEAD existence (cheap

* fs stat) so an externally purged repo is re-initialized on demand.

*/
const ensuredRepos = new Map();
/**

* Ensure a bare repo exists at gitDir (idempotent). Also confirms git is

* usable.

* @param subprocess - the subprocess service.

* @param gitDir - the bare repo directory.

* @returns true when the repo is ready.

*/
async function ensureBareRepo(subprocess, gitDir) {
	if (ensuredRepos.get(gitDir) === true) {
		if (existsSync(join(gitDir, "HEAD"))) return true;
		ensuredRepos.delete(gitDir);
	}
	if (!existsSync(join(gitDir, "HEAD"))) {
		try {
			await mkdir(gitDir, { recursive: true });
		} catch {
			return false;
		}
		const init = await runGit(subprocess, argvInitBare(gitDir), gitDir, commitEnv());
		if (init.exitCode !== 0) return false;
	}
	await runGit(subprocess, [
		"git",
		`--git-dir=${gitDir}`,
		"symbolic-ref",
		"HEAD",
		"refs/heads/main"
	], gitDir);
	const probe = await runGit(subprocess, argvRevParseGitDir({ gitDir }), gitDir);
	const ready = probe.exitCode === 0 && firstLine(probe.stdout).length > 0;
	if (ready) ensuredRepos.set(gitDir, true);
	return ready;
}
/**

* Acquire an exclusive lock for one key (per-project workspace repos). Waits

* up to waitMs for a stale-free lock; a lockfile older than LOCK_STALE_MS is

* stolen (crashed writer). Returns null when the lock cannot be acquired in

* time — callers treat that as a failed snapshot/restore, never as success.

* @param root - history root (locks live under locks/).

* @param key - lock key (project segment or session id).

* @param waitMs - total wait budget.

* @returns the held lock, or null.

*/
async function acquireLock(root, key, waitMs = 8e3) {
	const dir = join(root, LOCKS_DIRNAME);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${key}.lock`);
	const deadline = Date.now() + waitMs;
	for (;;) try {
		const handle = await open(path, "wx");
		try {
			await handle.writeFile(`${process.pid}\n${Date.now()}\n`);
		} finally {
			await handle.close();
		}
		return { release: async () => {
			try {
				await unlink(path);
			} catch {}
		} };
	} catch {
		try {
			const info = await stat(path);
			if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
				await unlink(path);
				continue;
			}
		} catch {
			continue;
		}
		if (Date.now() >= deadline) return null;
		await new Promise((resolve$1) => setTimeout(resolve$1, 120));
	}
}
/**

* Read the snapshot exclude patterns for one workspace: its OWN `.gitignore`,

* and nothing else. There is no merged default list any more — an empty or

* missing `.gitignore` excludes nothing (besides the `.git` directory, which

* `walkFiles` always skips regardless of any exclude list).

*

* A line starting with `!` (gitignore negation) is dropped rather than

* mis-parsed: `compileExcludes` has no negation semantics, so treating `!foo`

* as a literal pattern would exclude a file this project actually wants

* tracked. Dropping it just means that one line has no effect, which is the

* safe direction to fail in (a snapshot that includes one extra file is

* recoverable; one that silently drops a wanted file is not).

* @param cwd - the workspace root whose `.gitignore` to read.

* @returns exclude basename/glob patterns (empty when there is no `.gitignore`).

*/
async function readExcludes(cwd) {
	let text;
	try {
		text = await readFile(join(cwd, ".gitignore"), "utf-8");
	} catch {
		return [];
	}
	return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("!"));
}
/**

* Seed a workspace's `.gitignore` from the global default template, but ONLY

* when that workspace has no `.gitignore` at all yet. An existing file —

* whether it pre-dated this plugin or the user edited a previously-seeded one

* — is never touched: this is a one-time bootstrap, not an ongoing sync.

* @param root - history root (resolves the global config).

* @param cwd - the workspace root to seed.

*/
async function ensureWorkspaceGitignore(root, cwd) {
	const path = join(cwd, ".gitignore");
	if (existsSync(path)) return;
	try {
		const config = await readConfig(root);
		await writeFile(path, config.gitignoreTemplate, "utf-8");
	} catch {}
}
/** Absolute path of the global config file: $DSH_HOME/.dsh-history-rewind/config.json. */
function configPath(root) {
	return join(root, CONFIG_FILENAME);
}
/**

* Read the global plugin config, filling in any missing/invalid field from

* defaults. A corrupt or absent file resolves to the full default object

* rather than throwing — settings are a convenience layer, never a hard

* dependency of the snapshot/rewind path.

* @param root - history root.

* @returns the resolved config (every field always present).

*/
async function readConfig(root) {
	try {
		const text = await readFile(configPath(root), "utf-8");
		const parsed = JSON.parse(text);
		return {
			enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : HISTORY_REWIND_DEFAULTS.enabled,
			gitignoreTemplate: typeof parsed.gitignoreTemplate === "string" ? parsed.gitignoreTemplate : HISTORY_REWIND_DEFAULTS.gitignoreTemplate
		};
	} catch {
		return HISTORY_REWIND_DEFAULTS;
	}
}
/**

* Merge-write the global plugin config (read-modify-write; unspecified fields

* keep their current value).

* @param root - history root.

* @param patch - fields to update.

* @returns the resolved config after the write.

*/
async function writeConfig(root, patch) {
	const current = await readConfig(root);
	const next = {
		...current,
		...patch
	};
	await mkdir(root, { recursive: true });
	await writeFile(configPath(root), JSON.stringify(next, null, 2), "utf-8");
	return next;
}

//#endregion
//#region src/messages.ts
/** Max display width of a message preview (CJK counts 2, ASCII 1 → 100 CJK ≈ 200 ASCII). */
const PREVIEW_WIDTH = 200;
/** True for East-Asian wide / fullwidth code points (rendered as 2 columns). */
function isWide(codePoint) {
	return codePoint >= 4352 && codePoint <= 4447 || codePoint >= 11904 && codePoint <= 12350 || codePoint >= 12353 && codePoint <= 13311 || codePoint >= 13312 && codePoint <= 19903 || codePoint >= 19968 && codePoint <= 40959 || codePoint >= 40960 && codePoint <= 42191 || codePoint >= 44032 && codePoint <= 55203 || codePoint >= 63744 && codePoint <= 64255 || codePoint >= 65072 && codePoint <= 65103 || codePoint >= 65280 && codePoint <= 65376 || codePoint >= 65504 && codePoint <= 65510 || codePoint >= 127744 && codePoint <= 129791 || codePoint >= 131072 && codePoint <= 262141;
}
/**

* Sanitize + width-truncate a message preview for a single-line commit

* subject: strip newlines/controls and the bracket chars that frame the

* format, collapse whitespace, then cut at PREVIEW_WIDTH columns (append … ).

* @param raw - the raw message text.

* @returns a safe, bounded one-line preview.

*/
function previewOf(raw) {
	const cleaned = raw.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim();
	let width = 0;
	let out = "";
	for (const ch of cleaned) {
		const w = isWide(ch.codePointAt(0)) ? 2 : 1;
		if (width + w > PREVIEW_WIDTH) return `${out}…`;
		width += w;
		out += ch;
	}
	return out;
}
/** Format a TURN number as a zero-padded 4-digit field (wider when needed). */
function turnField(turn) {
	return `TURN ${String(turn ?? 0).padStart(4, "0")}`;
}
/** Prefer the turn-end user/assistant previews, falling back to `message`. */
function userPreviewOf(meta) {
	return previewOf(meta.userMessage ?? "");
}
function asstPreviewOf(meta) {
	return previewOf(meta.asstMessage ?? meta.message ?? "");
}
/**

* Build one session-side commit message (always single line — git subjects

* carry no newline; the Web UI splits turn-end into two display lines).

*

* turn-start is a CHECK POINT; turn-end carries the user and assistant

* previews plus the trailing [ws]. Manual and rewind are unchanged.

* @param meta - the snapshot's metadata.

* @returns the commit subject.

*/
function buildSessionMessage(meta) {
	if (meta.kind === "rewind") return `[REWIND → ${meta.target ?? ""}]`;
	const ws = meta.ws !== void 0 && meta.ws.length > 0 ? meta.ws : "";
	const head = `[${turnField(meta.turn)}]`;
	if (meta.kind === "manual") return `${head}[MANUAL][${ws}]`;
	if (meta.kind === "turn-start") return `${head}[CHECK POINT][${ws}]`;
	return `${head}[USER] ${userPreviewOf(meta)}[ASST] ${asstPreviewOf(meta)}[${ws}]`;
}
/**

* Build one workspace-side commit message (single-line attribution; no ws

* bracket — the workspace repo is never parsed for the timeline).

* @param meta - the snapshot's metadata.

* @returns the commit subject.

*/
function buildWorkspaceMessage(meta) {
	const head = `[${turnField(meta.turn)}]`;
	if (meta.kind === "manual") return `${head}[MANUAL]`;
	if (meta.kind === "turn-start") return `${head}[CHECK POINT]`;
	return `${head}[ASST] ${asstPreviewOf(meta)}`;
}
/**

* Parse one commit subject into metadata. Unrelated subjects yield null.

* Recognizes the new bracket format and the legacy `dsh-history:` format.

* @param subject - a full commit subject.

* @returns parsed metadata, or null when the subject carries no contract line.

*/
function parseMessage(subject) {
	const line = subject.trim();
	return parseBracket(line) ?? parseLegacy(line);
}
/** Parse the new bracket format. */
function parseBracket(line) {
	const rewind = /^\[REWIND → (\S*)\]$/.exec(line);
	if (rewind !== null) return {
		kind: "rewind",
		target: rewind[1]
	};
	const manual = /^\[TURN (\d+)\]\[MANUAL\](?:\[([^\]]*)\])?$/.exec(line);
	if (manual !== null) return {
		kind: "manual",
		turn: Number(manual[1]),
		...manual[2] !== void 0 && manual[2].length > 0 ? { ws: manual[2] } : {}
	};
	const check = /^\[TURN (\d+)\]\[CHECK POINT\](?:\[([^\]]*)\])?$/.exec(line);
	if (check !== null) return {
		kind: "turn-start",
		phase: "start",
		turn: Number(check[1]),
		...check[2] !== void 0 && check[2].length > 0 ? { ws: check[2] } : {}
	};
	const end = /^\[TURN (\d+)\]\[USER\] ([^[]*)\[ASST\] ([^[]*)(?:\[([^\]]*)\])?$/.exec(line);
	if (end !== null) {
		const user = end[2].trim();
		const asst = end[3].trim();
		return {
			kind: "turn-end",
			phase: "end",
			turn: Number(end[1]),
			...user.length > 0 ? { userMessage: user } : {},
			...asst.length > 0 ? {
				asstMessage: asst,
				message: asst
			} : {},
			...end[4] !== void 0 && end[4].length > 0 ? { ws: end[4] } : {}
		};
	}
	const wsAttr = /^\[TURN (\d+)\]\[ASST\] ([^[]*)$/.exec(line);
	if (wsAttr !== null) {
		const asst = wsAttr[2].trim();
		return {
			kind: "turn-end",
			phase: "end",
			turn: Number(wsAttr[1]),
			...asst.length > 0 ? {
				asstMessage: asst,
				message: asst
			} : {}
		};
	}
	const turn = /^\[TURN (\d+)\]\[(USER|ASST): ([^\]]*)\](?:\[([^\]]*)\])?$/.exec(line);
	if (turn !== null) {
		const role = turn[2];
		return {
			kind: role === "ASST" ? "turn-end" : "turn-start",
			phase: role === "ASST" ? "end" : "start",
			turn: Number(turn[1]),
			...turn[3].length > 0 ? { message: turn[3] } : {},
			...turn[4] !== void 0 && turn[4].length > 0 ? { ws: turn[4] } : {}
		};
	}
	return null;
}
/** Parse the legacy `dsh-history:` format (kept so old sessions still render). */
function parseLegacy(line) {
	const PREFIX = "dsh-history:";
	if (!line.startsWith(PREFIX)) return null;
	const rest = line.slice(PREFIX.length).trim();
	if (rest.startsWith("rewind")) {
		const meta = { kind: "rewind" };
		const target = /target=(\S+)/.exec(rest);
		if (target !== null) meta.target = target[1];
		const snap = /snap=(\S+)/.exec(rest);
		if (snap !== null) meta.snap = snap[1];
		return meta;
	}
	if (rest.startsWith("manual snapshot")) {
		const meta = { kind: "manual" };
		const session = /session-([\w-]+)/.exec(rest);
		if (session !== null) meta.session = session[1];
		const snap = /snap=(\S+)/.exec(rest);
		if (snap !== null) meta.snap = snap[1];
		const base$1 = /base=(\S+)/.exec(rest);
		if (base$1 !== null) meta.base = base$1[1];
		const ws = /ws=(\S+)/.exec(rest);
		if (ws !== null) meta.ws = ws[1];
		return meta;
	}
	const turnMatch = /^turn (\d+) (start|end) \(seq (\d+)\)(?: session-([\w-]+))?(?: snap=(\S*))?(?: base=(\S*))?(?: ws=(\S*))?$/.exec(rest);
	if (turnMatch === null) return null;
	return {
		kind: turnMatch[2] === "start" ? "turn-start" : "turn-end",
		turn: Number(turnMatch[1]),
		phase: turnMatch[2],
		seq: Number(turnMatch[3]),
		...turnMatch[4] !== void 0 && turnMatch[4].length > 0 ? { session: turnMatch[4] } : {},
		...turnMatch[5] !== void 0 && turnMatch[5].length > 0 ? { snap: turnMatch[5] } : {},
		...turnMatch[6] !== void 0 && turnMatch[6].length > 0 ? { base: turnMatch[6] } : {},
		...turnMatch[7] !== void 0 && turnMatch[7].length > 0 ? { ws: turnMatch[7] } : {}
	};
}

//#endregion
//#region src/workspace.ts
/**

* In-memory workspace-unchanged cache: (walk signature -> root tree +

* commit). The signature is the exact stat set of every walked file, so a

* hit means nothing on disk could have changed under the walk rules — the

* whole git pipeline (hash-object + update-index + write-tree + commit) is

* skipped and the cached commit is reused. On ANY difference the full path

* runs and re-pins the cache, so staleness is impossible under normal

* filesystem semantics (a rewrite always bumps mtime/size).

*/
const wsSignatureCache = new Map();
/** Build the one-string walk signature from a file list (hash-free, size-bounded). */
function signatureOf(files, excludes) {
	let sig = "";
	for (const file of files) {
		const stat$1 = file.stat;
		sig += `${file.rel}\u0000${stat$1.size}\u0000${stat$1.mtimeMs}\u0000${file.mode}\u0000`;
	}
	sig += `\u0000excludes:${excludes.join("")}`;
	return sig;
}
/** Default exclude patterns (never filtered out of the walk). */
const GIT_DIR_NAME = ".git";
/** Glob-to-regex for basename patterns (`*`, `?` supported). */
function globToRegex(pattern) {
	const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}
/**

* Compile exclude patterns into a matcher. Patterns without `/` match the

* basename at any depth; a leading `/` anchors to the root level; a trailing

* `/` matches directories only.

* @param patterns - raw patterns ("#..." comments and blanks pre-filtered).

* @returns a matcher over (rel, isDir).

*/
function compileExcludes(patterns) {
	const rules = [];
	for (const raw of patterns) {
		if (raw.length === 0) continue;
		let pattern = raw;
		let dirOnly = false;
		if (pattern.endsWith("/")) {
			dirOnly = true;
			pattern = pattern.slice(0, -1);
		}
		let anchored = false;
		if (pattern.startsWith("/")) {
			anchored = true;
			pattern = pattern.slice(1);
		}
		if (pattern.length === 0) continue;
		rules.push({
			regex: globToRegex(pattern),
			dirOnly,
			anchored
		});
	}
	return (rel, isDir) => {
		const name = basename(rel);
		const isRoot = !rel.includes("/");
		for (const rule of rules) {
			if (rule.dirOnly && !isDir) continue;
			if (rule.anchored && !isRoot) continue;
			if (rule.regex.test(name)) return true;
		}
		return false;
	};
}
/** Root-level `.gitignore` basename, forced into every snapshot regardless of

*  what its own (or `.gitignore`'s ancestor directory's) rules say — a rule

*  that happened to match it, such as a bare `*`, would otherwise make a

*  workspace's exclude source disappear from its own snapshots. */
const GITIGNORE_NAME = ".gitignore";
/**

* Recursively walk cwd collecting files (skipping .git dirs and excludes).

* @param rootDir - the workspace cwd.

* @param matcher - exclude matcher.

* @returns the collected files (rel paths, forward slashes).

*/
async function walkFiles(rootDir, matcher) {
	const files = [];
	const walk = async (absDir, relDir) => {
		const entries = await readdir(absDir, { withFileTypes: true });
		for (const entry of entries) {
			const name = entry.name;
			const rel = relDir.length === 0 ? name : `${relDir}/${name}`;
			const isRootGitignore = relDir.length === 0 && name === GITIGNORE_NAME;
			if (!isRootGitignore && matcher(rel, entry.isDirectory())) continue;
			if (entry.isDirectory()) {
				if (name === GIT_DIR_NAME) continue;
				await walk(join(absDir, name), rel);
			} else if (entry.isSymbolicLink()) continue;
			else if (entry.isFile()) {
				const info = await lstat(join(absDir, name));
				const mode = (info.mode & 73) !== 0 ? MODE_EXEC : MODE_FILE;
				files.push({
					rel,
					abs: join(absDir, name),
					mode,
					stat: {
						size: info.size,
						mtimeMs: info.mtimeMs,
						mode
					}
				});
			}
		}
	};
	await walk(rootDir, "");
	return files;
}
/** The empty tree object SHA (universal, present implicitly in every repo). */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/**

* Snapshot the whole workspace into the session's own shadow repo.

* @param subprocess - the subprocess service.

* @param root - history root.

* @param sessionId - the session that owns this workspace history.

* @param cwd - the workspace root to snapshot.

* @param message - commit message (authored by the caller with the contract).

* @returns the snapshot result.

*/
async function snapshotWorkspace(subprocess, root, sessionId, cwd, message) {
	const lockSeg = sessionId.replace(/[^\w.-]/g, "_");
	const lock = await acquireLock(root, `ws-session-${lockSeg}`);
	if (lock === null) return {
		ok: false,
		reason: "lock-busy"
	};
	try {
		const repoDir = workspaceRepoDir(root, sessionId);
		if (!await ensureBareRepo(subprocess, repoDir)) return {
			ok: false,
			reason: "git-unavailable"
		};
		await ensureWorkspaceGitignore(root, cwd);
		const excludes = await readExcludes(cwd);
		const matcher = compileExcludes(excludes);
		const files = await walkFiles(cwd, matcher);
		const repo = { gitDir: repoDir };
		const env = commitEnv();
		const cacheKey = repoDir;
		const signature = signatureOf(files, excludes);
		const cached = wsSignatureCache.get(cacheKey);
		if (cached !== void 0 && cached.signature === signature && existsSync(join(repoDir, "HEAD"))) return {
			ok: true,
			commit: cached.commit,
			reused: true
		};
		const shas = [];
		if (files.length > 0) {
			const stdin = files.map((file) => file.rel).join("\n") + "\n";
			const hashed = await runGit(subprocess, argvHashObjectStdinPaths(repo, false), cwd, env, stdin);
			if (hashed.exitCode !== 0) return {
				ok: false,
				reason: "hash-failed",
				detail: hashed.stderr
			};
			const lines = hashed.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
			if (lines.length !== files.length) return {
				ok: false,
				reason: "hash-count-mismatch",
				detail: hashed.stdout
			};
			shas.push(...lines);
		}
		const shaByRel = new Map();
		files.forEach((file, index) => {
			shaByRel.set(file.rel, shas[index]);
		});
		let rootTree;
		if (files.length === 0) rootTree = EMPTY_TREE;
		else {
			const indexFile = join(repoDir, `index.snapshot-${Date.now()}`);
			const treeEnv = {
				...env,
				GIT_INDEX_FILE: indexFile
			};
			try {
				const indexInfo = files.map((file) => {
					const sha = shaByRel.get(file.rel);
					if (sha === void 0) return null;
					return `${file.mode} ${sha}\t${file.rel}\x00`;
				});
				if (indexInfo.some((line) => line === null)) return {
					ok: false,
					reason: "hash-missing"
				};
				const loaded = await runGit(subprocess, argvUpdateIndexFromInfo(repo), cwd, treeEnv, indexInfo.join(""));
				if (loaded.exitCode !== 0) return {
					ok: false,
					reason: "update-index-failed",
					detail: loaded.stderr
				};
				const written = await runGit(subprocess, argvWriteTree(repo), cwd, treeEnv);
				if (written.exitCode !== 0) return {
					ok: false,
					reason: "write-tree-failed",
					detail: written.stderr
				};
				rootTree = firstLine(written.stdout);
				if (rootTree.length === 0) return {
					ok: false,
					reason: "write-tree-empty"
				};
			} finally {
				await unlink(indexFile).catch(() => void 0);
			}
		}
		let parent;
		let parentTree;
		const headRes = await runGit(subprocess, [
			"git",
			`--git-dir=${repoDir}`,
			"rev-list",
			"-1",
			"--pretty=%T",
			"refs/heads/main"
		], cwd, env);
		if (headRes.exitCode === 0) {
			const lines = headRes.stdout.trim().split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
			if (lines.length >= 2 && lines[0].startsWith("commit ")) {
				parent = lines[0].slice(7);
				parentTree = lines[1];
			}
		}
		if (parent !== void 0 && parentTree === rootTree) {
			wsSignatureCache.set(cacheKey, {
				signature,
				rootTree,
				commit: parent
			});
			return {
				ok: true,
				commit: parent,
				reused: true
			};
		}
		const committed = await runGit(subprocess, argvCommitTree(repo, rootTree, message, parent), cwd, env);
		if (committed.exitCode !== 0) return {
			ok: false,
			reason: "commit-failed"
		};
		const commit = firstLine(committed.stdout);
		if (commit.length === 0) return {
			ok: false,
			reason: "commit-empty"
		};
		const updated = await runGit(subprocess, argvUpdateRef(repo, "refs/heads/main", commit), cwd, env);
		if (updated.exitCode !== 0) return {
			ok: false,
			reason: "update-ref-failed"
		};
		wsSignatureCache.set(cacheKey, {
			signature,
			rootTree,
			commit
		});
		return {
			ok: true,
			commit,
			reused: false
		};
	} finally {
		await lock.release();
	}
}
/**

* List the file paths (forward slashes, tree-relative) under one bare-repo

* tree. Used to know exactly which files a restore wrote, so the fs

* observation state can be warmed for them.

* @param subprocess - the subprocess service.

* @param repoDir - the bare repo dir.

* @param treeish - commit or tree to list.

* @returns the relative path list, or null on failure.

*/
async function treeFileList(subprocess, repoDir, treeish) {
	const repo = { gitDir: repoDir };
	const listed = await runGit(subprocess, argvListTree(repo, treeish), repoDir, commitEnv());
	if (listed.exitCode !== 0) return null;
	const paths = [];
	for (const entry of listed.stdout.split("\0")) {
		if (entry.length === 0) continue;
		const tab = entry.indexOf("	");
		if (tab >= 0) paths.push(entry.slice(tab + 1));
	}
	return paths;
}
/**

* List the live workspace's in-scope files (same exclude rules as snapshots).

* @param cwd - the workspace root.

* @param excludes - exclude patterns (identical to the snapshot walk's set).

* @returns workspace-relative paths (forward slashes).

*/
async function workspaceFileList(cwd, excludes) {
	const matcher = compileExcludes(excludes);
	const files = await walkFiles(cwd, matcher);
	return files.map((file) => file.rel);
}
/**

* Materialize one tree (from a bare repo) into a target directory using a

* transient index; git writes the files itself (binary-safe). The index file

* lives inside the repo dir and is removed afterwards.

* @param subprocess - the subprocess service.

* @param repoDir - the bare repo dir.

* @param treeish - commit or tree to restore.

* @param targetDir - directory to write into (must exist).

* @returns the number of files written, or null on failure.

*/
async function materializeTree(subprocess, repoDir, treeish, targetDir) {
	const repo = { gitDir: repoDir };
	const env = {
		...commitEnv(),
		GIT_INDEX_FILE: join(repoDir, `index.restore-${Date.now()}`),
		GIT_WORK_TREE: targetDir
	};
	const listed = await runGit(subprocess, argvListTree(repo, treeish), repoDir, env);
	if (listed.exitCode !== 0) return null;
	const count = listed.stdout.split("\0").filter((line) => line.length > 0).length;
	try {
		const loaded = await runGit(subprocess, argvReadTree(repo, treeish), repoDir, env);
		if (loaded.exitCode !== 0) return null;
		const checked = await runGit(subprocess, argvCheckoutIndex(repo, targetDir), targetDir, env);
		if (checked.exitCode !== 0) return null;
	} finally {
		try {
			await unlink(env.GIT_INDEX_FILE);
		} catch {}
	}
	return count;
}
/**

* Restore one tree into a LIVE workspace so the result matches the snapshot

* EXACTLY — nothing more, nothing less. It first materializes the target files

* (checkout-index -a -f, same as {@link materializeTree}), then deletes every

* in-scope working-tree file the target tree does NOT contain, and prunes the

* directories left empty by those deletions.

*

* "In-scope" uses the SAME exclude rules as snapshotting (`.git`, `node_modules`,

* `dist`, … and the repo's info/exclude), so excluded paths are never walked and

* never deleted. The whole operation is guarded upstream by a full pre-rewind

* backup of the workspace, so the delete step is always recoverable.

*

* @param subprocess - the subprocess service.

* @param repoDir - the bare workspace shadow repo dir holding the tree.

* @param treeish - commit or tree to restore.

* @param targetDir - the live workspace root to make identical to the tree.

* @param excludes - exclude patterns (identical to the snapshot walk's set).

* @returns the number of files in the target tree, or null on failure.

*/
async function materializeTreeExact(subprocess, repoDir, treeish, targetDir, excludes) {
	const repo = { gitDir: repoDir };
	const listed = await runGit(subprocess, argvListTree(repo, treeish), repoDir, commitEnv());
	if (listed.exitCode !== 0) return null;
	const keep = new Set();
	for (const entry of listed.stdout.split("\0")) {
		if (entry.length === 0) continue;
		const tab = entry.indexOf("	");
		if (tab < 0) continue;
		keep.add(entry.slice(tab + 1));
	}
	const restored = await materializeTree(subprocess, repoDir, treeish, targetDir);
	if (restored === null) return null;
	const matcher = compileExcludes(excludes);
	const present = await walkFiles(targetDir, matcher);
	for (const file of present) {
		if (keep.has(file.rel)) continue;
		try {
			await unlink(file.abs);
		} catch {}
	}
	await pruneEmptyDirs(targetDir, matcher);
	return keep.size;
}
/**

* Remove now-empty directories under `rootDir` bottom-up. Excluded directories

* and `.git` are skipped entirely (never entered, never removed); `rootDir`

* itself is preserved. A directory that becomes empty only after its empty

* children are removed is removed too.

* @param rootDir - the workspace root (kept).

* @param matcher - the same exclude matcher used by the snapshot walk.

* @returns whether `rootDir` holds no in-scope entries after pruning.

*/
async function pruneEmptyDirs(rootDir, matcher) {
	const walk = async (absDir, relDir) => {
		const entries = await readdir(absDir, { withFileTypes: true }).catch(() => null);
		if (entries === null) return false;
		let empty = true;
		for (const entry of entries) {
			const name = entry.name;
			const rel = relDir.length === 0 ? name : `${relDir}/${name}`;
			if (entry.isDirectory()) {
				if (name === GIT_DIR_NAME || matcher(rel, true)) {
					empty = false;
					continue;
				}
				const childEmpty = await walk(join(absDir, name), rel);
				if (childEmpty) try {
					await rmdir(join(absDir, name));
				} catch {
					empty = false;
				}
				else empty = false;
			} else empty = false;
		}
		return empty;
	};
	return walk(rootDir, "");
}
/**

* Backup the current workspace tree into backups/ws-session-<id>/pre-rewind-<ts>.

* Follows the same exclude rules as snapshots: .git and excluded dirs are not

* copied, and everything under historyRoot is never copied (guard).

* @param root - history root (also defines the backup destination).

* @param sessionId - the session whose workspace is backed up.

* @param cwd - the workspace root.

* @returns the backup directory, or null (failure / unsafe).

*/
async function backupWorkspace(root, sessionId, cwd) {
	const absCwd = resolve(cwd);
	const absRoot = resolve(root);
	if (absCwd === absRoot || absCwd.startsWith(`${absRoot}${sep}`)) return null;
	const dest = join(workspaceBackupDir(root, sessionId), `pre-rewind-${Date.now()}`);
	const matcher = compileExcludes([".git"]);
	try {
		await cp(absCwd, dest, {
			recursive: true,
			filter: (src) => {
				if (src === absCwd) return true;
				const rel = relative(absCwd, src);
				const isDirFlag = false;
				return !matcher(rel, isDirFlag);
			}
		});
		return dest;
	} catch {
		return null;
	}
}

//#endregion
//#region src/state.ts
/** Per-session in-memory jump target (commit sha), process-lifetime only. */
const jumpTargets = new Map();
/** Record the jump target for one session (set at rewind). */
function setJumpTarget(sessionId, commit) {
	jumpTargets.set(sessionId, commit);
}
/** Read the in-memory jump target, if any. */
function getJumpTarget(sessionId) {
	return jumpTargets.get(sessionId);
}
/** Clear the jump target (first changed snapshot consumed it). */
function clearJumpTarget(sessionId) {
	jumpTargets.delete(sessionId);
}
/**

* Extract the numeric timestamp from a road ref name so the LATEST road is

* unambiguous. Returns -1 for non-road names.

* @param ref - full ref name.

* @returns the embedded timestamp, or -1.

*/
function roadTimestamp(ref) {
	if (!ref.startsWith(ROAD_REF_PREFIX)) return -1;
	const ts = Number(ref.slice(ROAD_REF_PREFIX.length));
	return Number.isFinite(ts) ? ts : -1;
}

//#endregion
//#region src/zstd-util.ts
const ZSTD_MAGIC = 4247762216;
/** Scan complete zstd frames; a torn tail is tolerated, corrupt magic throws. */
function scanZstdFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) return frames;
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt zstd frame magic at ${offset}`);
		offset += 4;
		if (offset === buffer.length) return frames;
		const descriptor = buffer.readUInt8(offset);
		offset += 1;
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag;
		offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		for (;;) {
			if (buffer.length - offset < 3) return frames;
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = blockHeader >>> 1 & 3;
			const blockSize = blockHeader >>> 3;
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) offset += 4;
		frames.push({
			start,
			end: offset
		});
	}
	return frames;
}
/**

* Byte length of the artifact prefix that ends JUST BEFORE the latest turn's

* user message — i.e. the start offset of the last zstd frame that contains a

* `turn/start` event. Because the persistence writes the turn-opening frame

* (turn/start + the inbox splice that carries the user message) separately

* from the earlier idle state, this prefix is a valid append-only artifact

* representing "the user has NOT yet sent this turn's message".

*

* Returns bytes.length when no turn/start frame is found (nothing to trim) so

* callers can hash the whole file unchanged.

* @param bytes - raw artifact bytes.

* @returns the truncation length (0..bytes.length).

*/
function preTurnPrefixLength(bytes) {
	let cut = bytes.length;
	for (const frame of scanZstdFrames(bytes)) {
		const text = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString("utf8");
		for (const line of text.split("\n")) {
			const t = line.trim();
			if (t.length === 0) continue;
			try {
				if (JSON.parse(t).type === "turn/start") {
					cut = frame.start;
					break;
				}
			} catch {}
		}
	}
	return cut;
}
/** Join the text parts of a message content array into one string. */
function textOf(content) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const part of content) if (part !== null && typeof part === "object" && part.type === "text") {
		const text = part.text;
		if (typeof text === "string") parts.push(text);
	}
	return parts.join(" ");
}
/**

* Extract the user and assistant message text of ONE COMPLETED TURN.

*

* Turn-bounded on purpose. The previous implementation took the newest

* `user/message` and the newest `assistant/message` independently, with no check

* that the two belonged to the same turn. That is a real data-corruption race:

* sending the next message exactly as a turn ends makes the artifact grow before

* the capture reads it (the capture even flushes it to disk first), so the commit

* for turn N could be stamped with turn N's assistant reply next to turn N+1's

* user message — a question paired with the answer to a different question, and

* turn N's real question lost from the timeline entirely. Commit messages are

* immutable, so a wrong pairing is permanent.

*

* Correctness therefore cannot rest on timing (no amount of locking closes the

* window — the next message may already be buffered before the turn/end event is

* even dispatched). It rests on the data: previews are only read from BETWEEN a

* `turn/start` and its paired `turn/end`, and anything after that boundary is

* ignored no matter how fast it arrived.

*

* When `endSeq` is given, the turn closed by exactly that `turn/end` event is

* selected — the caller knows which boundary it is snapshotting, so the turn is

* identified rather than inferred. Without it, the last completed turn is used.

*

* If the boundary cannot be resolved, NOTHING is returned rather than falling

* back to the newest-message guess: omitting a preview line is recoverable,

* writing a wrong pairing into an immutable commit is not.

*

* Frames are scanned NEWEST-first and decompressed only until the turn is fully

* covered (turn boundaries sit at the tail), so a multi-MB history costs a couple

* of frame decodes, not a full decompress. A corrupt tail is tolerated.

*

* @param bytes - raw artifact bytes.

* @param endSeq - seq of the `turn/end` event being snapshotted, when known.

* @returns the previews of that one turn (fields absent when not resolvable).

*/
function extractMessagePreviews(bytes, endSeq) {
	let frames;
	try {
		frames = scanZstdFrames(bytes);
	} catch {
		return {};
	}
	const lines = [];
	for (let f = frames.length - 1; f >= 0; f -= 1) {
		const frame = frames[f];
		let plaintext;
		try {
			plaintext = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString("utf8");
		} catch {
			continue;
		}
		const parsedFrame = [];
		for (const raw of plaintext.split("\n")) {
			const text = raw.trim();
			if (text.length === 0) continue;
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch {
				continue;
			}
			if (typeof parsed.type !== "string") continue;
			parsedFrame.push({
				type: parsed.type,
				seq: typeof parsed.seq === "number" ? parsed.seq : -1,
				data: parsed.data
			});
		}
		lines.unshift(...parsedFrame);
		const found = readTurnPreviews(lines, endSeq);
		if (found !== null) return found;
	}
	return {};
}
/**

* Resolve one turn's previews from chronologically ordered lines.

* @returns the previews, or null when the turn boundary is not fully covered yet.

*/
function readTurnPreviews(lines, endSeq) {
	let endIndex = -1;
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		if (lines[i].type !== "turn/end") continue;
		if (endSeq !== void 0 && lines[i].seq !== endSeq) continue;
		endIndex = i;
		break;
	}
	if (endIndex < 0) return null;
	let startIndex = -1;
	for (let i = endIndex - 1; i >= 0; i -= 1) if (lines[i].type === "turn/start") {
		startIndex = i;
		break;
	}
	if (startIndex < 0) return null;
	let user;
	let assistant;
	for (let i = startIndex + 1; i < endIndex; i += 1) {
		const line = lines[i];
		const data = line.data;
		if (data === void 0) continue;
		if (line.type === "user/message") {
			const source = data.source;
			if (source?.kind !== "user") continue;
			const value = textOf(data.content);
			if (value.length > 0 && user === void 0) user = value;
		} else if (line.type === "assistant/message") {
			const message = data.message;
			const content = message?.content ?? data.content;
			const value = textOf(content);
			if (value.length > 0) assistant = value;
		}
	}
	return {
		...user !== void 0 ? { user } : {},
		...assistant !== void 0 ? { assistant } : {}
	};
}
/**

* Read the composition facts that determine the wire request prefix.

*

* The artifact's head `session` line carries the creation-time preset; later

* `agent-preset/selected` events win (the session may have switched while

* blank). The last `request/header` config is the provider/model route the

* artifact's history was produced under. A corrupt artifact yields no facts —

* callers then fall back to the uncomposed resume, never fail on decode.

* @param bytes - raw artifact bytes.

* @returns the resolved facts (empty object when nothing is readable).

*/
function decodeTargetFacts(bytes) {
	let headerAgentPreset;
	let lastAgentPreset;
	let lastRoute;
	let lastRouteSeen = false;
	for (const frame of scanZstdFrames(bytes)) {
		const plaintext = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString("utf8");
		for (const line of plaintext.split("\n")) {
			const text = line.trim();
			if (text.length === 0) continue;
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch {
				continue;
			}
			if (parsed.type === "session" && typeof parsed.agentPreset === "string") headerAgentPreset = parsed.agentPreset;
			else if (parsed.type === "agent-preset/selected") {
				const data = parsed.data;
				if (data !== void 0 && typeof data.agentPreset === "string") lastAgentPreset = data.agentPreset;
			} else if (parsed.type === "request/header") {
				const data = parsed.data;
				const config = data?.header?.config;
				if (config !== void 0 && typeof config === "object") {
					lastRouteSeen = true;
					lastRoute = {
						...typeof config.provider === "string" ? { provider: config.provider } : {},
						...typeof config.model === "string" ? { model: config.model } : {}
					};
				}
			}
		}
	}
	const agentPreset = lastAgentPreset ?? headerAgentPreset;
	return {
		...agentPreset === void 0 ? {} : { agentPreset },
		...lastRouteSeen && lastRoute !== void 0 ? { route: lastRoute } : {}
	};
}
/** Decode all frames of one artifact (raw bytes) into event lines. */
function decodeSessionEventsFromBytes(bytes) {
	const frames = scanZstdFrames(bytes);
	const events = [];
	for (const frame of frames) {
		const plaintext = zstdDecompressSync(bytes.subarray(frame.start, frame.end)).toString("utf8");
		for (const line of plaintext.split("\n")) {
			const text = line.trim();
			if (text.length === 0) continue;
			const parsed = JSON.parse(text);
			if (typeof parsed.type !== "string" || typeof parsed.seq !== "number") continue;
			events.push({
				type: parsed.type,
				seq: parsed.seq,
				time: parsed.time ?? 0,
				json: text
			});
		}
	}
	events.sort((a, b) => a.seq - b.seq);
	return events;
}
/** Bookkeeping event types the loader appends on resume (never conversation). */
const BOOKKEEPING_TYPES = new Set(["session/end-seed"]);
/** True when the event is the loader's replay-drain of a mid-turn target. */
function isDrainEvent(event, baseLastTime) {
	return event.time <= baseLastTime + 1 && (event.type === "step/end" || event.type === "turn/end");
}
/**

* Semantic equality: the base (rewind target) event list vs the current

* (post-jump, post-resume) event list. Bookkeeping appends are ignored:

*   - session/end-seed (every resume);

*   - trailing step/end + turn/end replay-drain pair whose timestamps equal

*     the base's last event time (target ended mid-turn).

* The base events must be the exact HEAD of the current list (append-only).

* @param current - events decoded from the live artifact.

* @param base - events decoded from the base blob's bytes.

* @returns true when the conversation content is unchanged.

*/
function semanticallyEqual(current, base$1) {
	const baseLastTime = base$1.length > 0 ? base$1[base$1.length - 1].time : 0;
	let i = 0;
	let j = 0;
	while (i < current.length) {
		const event = current[i];
		if (BOOKKEEPING_TYPES.has(event.type)) {
			i += 1;
			continue;
		}
		if (j < base$1.length) {
			if (base$1[j].json !== event.json) return false;
			j += 1;
			i += 1;
			continue;
		}
		if (isDrainEvent(event, baseLastTime)) {
			i += 1;
			continue;
		}
		return false;
	}
	return j === base$1.length;
}
/**

* Append a bare EMPTY turn pair (`turn/start` → `turn/end`, no messages) as a

* NEW zstd frame, ALWAYS. Every WORKSPACE (turn-start) snapshot carries its own

* turn/start, so ANY snapshot is a valid non-blank conversation state: DSH's

* `sessionBlank` check passes for every backup point without having to know

* whether it was the first message. The empty turn contributes no message to

* the model (an empty turn projects no surface content).

* @param bytes - the artifact bytes to extend.

* @returns the extended bytes (unchanged when the format is unreadable).

*/
function appendEmptyTurn(bytes) {
	try {
		const events = decodeSessionEventsFromBytes(bytes);
		const baseSeq = events.length > 0 ? events[events.length - 1].seq + 1 : 0;
		const now = Date.now();
		const seedLines = [JSON.stringify({
			type: "turn/start",
			seq: baseSeq,
			time: now,
			data: { turn: 1 }
		}), JSON.stringify({
			type: "turn/end",
			seq: baseSeq + 1,
			time: now,
			data: {
				turn: 1,
				reason: { kind: "completed" }
			}
		})];
		const frame = zstdCompressSync(Buffer.from(seedLines.join("\n") + "\n", "utf8"));
		return Buffer.concat([bytes, frame]);
	} catch {
		return bytes;
	}
}
/**

* Blank-session fix (mirrors dsh-session-tree's seed trick): DSH's

* `sessionBlank` treats a log with NO `turn/start` as a brand-new session —

* the hero page, hidden from lists, reused by New Session. Rewinding onto

* such a pre-send empty state would therefore blank the chat window. When the

* target really has no `turn/start`, append a bare empty turn pair (see

* `appendEmptyTurn`); targets that already carry one are left untouched.

* @param bytes - the target artifact bytes (multi-frame zstd JSONL).

* @returns the possibly-extended bytes (original when no seeding is needed).

*/
function seedBlankSession(bytes) {
	try {
		const events = decodeSessionEventsFromBytes(bytes);
		if (events.some((event) => event.type === "turn/start")) return bytes;
		return appendEmptyTurn(bytes);
	} catch {
		return bytes;
	}
}

//#endregion
//#region src/snapshot.ts
/**

* Capture the official session artifact at event time: durability flush,

* then hash-object (git reads the file itself, zero bytes through us).

* The bytes are also kept when a jump target is set, for the later

* byte-different-but-semantically-equal compare.

* @returns null when the artifact is missing or git is unusable.

*/
async function captureSessionArtifact(subprocess, root, sessions, persistence, session, kind = "turn-end", endSeq) {
	const location = persistence?.locate({
		...session.header,
		id: session.id
	});
	if (location === void 0 || location.path.length === 0) return null;
	await ensureHistoryRoot(root);
	const sessionRepo = { gitDir: sessionRepoDir(root, session.id) };
	if (!await ensureBareRepo(subprocess, sessionRepo.gitDir)) return null;
	if (sessions?.flush !== void 0) try {
		await sessions.flush(session);
	} catch {}
	const { readFile: readFile$1, writeFile: writeFile$1, unlink: unlink$1 } = await import("node:fs/promises");
	let full;
	try {
		full = await readFile$1(location.path);
	} catch {
		full = void 0;
	}
	let userPreview;
	let asstPreview;
	if (full !== void 0 && kind === "turn-end") try {
		const previews = extractMessagePreviews(full, endSeq);
		userPreview = previews.user;
		asstPreview = previews.assistant;
	} catch {}
	let hashPath = location.path;
	let tempPath;
	let contentBytes = full;
	if (kind === "turn-start" && full !== void 0) try {
		const cut = preTurnPrefixLength(full);
		const prefix = appendEmptyTurn(full.subarray(0, cut));
		if (prefix.length !== full.length) {
			tempPath = join(root, `capture-${session.id.replace(/[^\w.-]/g, "_")}-${Date.now()}.tmp`);
			await writeFile$1(tempPath, prefix);
			hashPath = tempPath;
			contentBytes = prefix;
		}
	} catch {}
	let blobSha;
	try {
		const hashed = await runGit(subprocess, argvHashObjectFile(sessionRepo, hashPath), root, commitEnv());
		if (hashed.exitCode !== 0) return null;
		blobSha = firstLine(hashed.stdout);
	} finally {
		if (tempPath !== void 0) await unlink$1(tempPath).catch(() => void 0);
	}
	if (blobSha.length === 0) return null;
	const bytes = getJumpTarget(session.id) !== void 0 ? contentBytes : void 0;
	return {
		blobSha,
		path: location.path,
		...bytes !== void 0 ? { bytes } : {},
		...userPreview !== void 0 ? { userPreview } : {},
		...asstPreview !== void 0 ? { asstPreview } : {}
	};
}
/**

* Derive the TURN counter from the base road's history: scan newest-first for

* the first turn-bearing line (manual lines keep the last turn).

* @param subjects - commit subjects of the base road, newest first.

* @param kind - 'start' (next turn) or 'end' (the turn being ended).

* @returns the turn number to attribute.

*/
function deriveTurn(subjects, kind) {
	let turn = 0;
	let phase = "end";
	for (const subject of subjects) {
		const meta = parseMessage(subject);
		if (meta === null || meta.kind === "manual" || meta.kind === "rewind") continue;
		if (meta.turn !== void 0) {
			turn = meta.turn;
			phase = meta.phase ?? "end";
			break;
		}
	}
	if (kind === "start") return turn + 1;
	return phase === "start" ? turn : turn + 1;
}
/** One snapshot cycle (capture, workspace, session commit). */
async function takeSnapshot(subprocess, root, sessions, persistence, request) {
	const session = request.session;
	const sessionId = session.id;
	const cwd = session.header?.cwd;
	const sessionRepo = { gitDir: sessionRepoDir(root, sessionId) };
	const env = commitEnv();
	const captured = await (request.captured ?? captureSessionArtifact(subprocess, root, sessions, persistence, session, request.kind, request.kind === "turn-end" ? request.seq : void 0));
	if (captured === null) return {
		ok: false,
		reason: "no-artifact"
	};
	const blobSha = captured.blobSha;
	const refsRes = await runGit(subprocess, [
		"git",
		`--git-dir=${sessionRepo.gitDir}`,
		"for-each-ref",
		"--format=%(refname) %(objectname)",
		"refs/heads/main",
		`${ROAD_REF_PREFIX}*`
	], root, env);
	let mainTip;
	let road = null;
	let roadTip;
	let bestRoadTs = -1;
	if (refsRes.exitCode === 0) for (const line of refsRes.stdout.split("\n")) {
		const parts = line.trim().split(" ");
		if (parts.length < 2) continue;
		const [refname, sha] = parts;
		if (sha === void 0) continue;
		if (refname === "refs/heads/main") mainTip = sha;
		else if (refname.startsWith(ROAD_REF_PREFIX)) {
			const ts = roadTimestamp(refname);
			if (ts > bestRoadTs) {
				bestRoadTs = ts;
				road = refname;
				roadTip = sha;
			}
		}
	}
	let base$1;
	let activeRef = null;
	let fromJump = false;
	const jumpTarget = getJumpTarget(sessionId);
	if (jumpTarget !== void 0) {
		base$1 = jumpTarget;
		fromJump = true;
	} else if (road !== null && roadTip !== void 0) {
		base$1 = roadTip;
		activeRef = road;
	} else {
		base$1 = mainTip;
		activeRef = "refs/heads/main";
	}
	const subjects = [];
	if (base$1 !== void 0) {
		const log = await runGit(subprocess, argvLogSubjects(sessionRepo, base$1), root, env);
		if (log.exitCode === 0) for (const line of log.stdout.split("\n")) {
			const text = line.trim();
			if (text.length > 0) subjects.push(text);
		}
	}
	const kind = request.kind;
	const seq = request.seq;
	const derived = deriveTurn(subjects, kind === "turn-start" ? "start" : "end");
	const snap = kind === "manual" ? `manual-${Date.now()}` : `turn-${derived}-${kind === "turn-start" ? "start" : "end"}-${seq ?? 0}`;
	const meta = {
		kind,
		...kind === "turn-start" || kind === "turn-end" ? {
			turn: derived,
			phase: kind === "turn-start" ? "start" : "end",
			seq
		} : {},
		session: sessionId,
		snap,
		...kind === "turn-end" && captured.userPreview !== void 0 && captured.userPreview.length > 0 ? { userMessage: captured.userPreview } : {},
		...kind === "turn-end" && captured.asstPreview !== void 0 && captured.asstPreview.length > 0 ? {
			asstMessage: captured.asstPreview,
			message: captured.asstPreview
		} : {}
	};
	const dirName = `session-${sessionId}`;
	const dirTreePromise = runGit(subprocess, argvMktree(sessionRepo, true), root, env, `100644 blob ${blobSha}\tsession.jsonl.zstd\x00`);
	const rootTreePromise = dirTreePromise.then(async (dirTree) => {
		if (dirTree.exitCode !== 0) return null;
		const dirTreeSha = firstLine(dirTree.stdout);
		if (dirTreeSha.length === 0) return null;
		const rootTree = await runGit(subprocess, argvMktree(sessionRepo, true), root, env, `040000 tree ${dirTreeSha}\t${dirName}\x00`);
		if (rootTree.exitCode !== 0) return null;
		const rootTreeSha$1 = firstLine(rootTree.stdout);
		if (rootTreeSha$1.length === 0) return null;
		return rootTreeSha$1;
	});
	const baseBlobPromise = base$1 !== void 0 ? runGit(subprocess, [
		"git",
		`--git-dir=${sessionRepo.gitDir}`,
		"rev-parse",
		"--verify",
		"--quiet",
		`${base$1}:session-${sessionId}/session.jsonl.zstd`
	], root, env) : Promise.resolve(null);
	const wsPromise = cwd !== void 0 && cwd.length > 0 ? snapshotWorkspace(subprocess, root, sessionId, cwd, buildWorkspaceMessage(meta)) : Promise.resolve({ ok: true });
	const [ws, baseBlob, rootTreeSha] = await Promise.all([
		wsPromise,
		baseBlobPromise,
		rootTreePromise
	]);
	if (rootTreeSha === null) return {
		ok: false,
		reason: "mktree-failed"
	};
	const wsCommit = ws.ok && ws.commit !== void 0 ? ws.commit : void 0;
	if (kind === "turn-start" && ws.ok === true && ws.reused === true) return {
		ok: true,
		unchanged: true,
		base: base$1,
		snap,
		turn: derived
	};
	if (baseBlob !== null && baseBlob.exitCode === 0) {
		if (firstLine(baseBlob.stdout) === blobSha && !(kind === "turn-start" && !fromJump)) return {
			ok: true,
			unchanged: true,
			base: base$1,
			snap,
			turn: derived
		};
		if (fromJump && base$1 !== void 0) {
			const scratchCmp = join(root, "backups", `scratchcmp-${sessionId}-${Date.now()}`);
			try {
				await mkdir(scratchCmp, { recursive: true });
				const count = await materializeTree(subprocess, sessionRepo.gitDir, base$1, scratchCmp);
				if (count !== null && count > 0) {
					const basePath = join(scratchCmp, `session-${sessionId}`, "session.jsonl.zstd");
					const { readFile: readFile$1 } = await import("node:fs/promises");
					const baseBytes = await readFile$1(basePath);
					const currentBytes = captured.bytes ?? await readFile$1(captured.path);
					const currentEvents = decodeSessionEventsFromBytes(currentBytes);
					const baseEvents = decodeSessionEventsFromBytes(baseBytes);
					if (semanticallyEqual(currentEvents, baseEvents)) {
						await rm(scratchCmp, {
							recursive: true,
							force: true
						}).catch(() => void 0);
						return {
							ok: true,
							unchanged: true,
							base: base$1,
							snap,
							turn: derived
						};
					}
				}
			} catch {} finally {
				await rm(scratchCmp, {
					recursive: true,
					force: true
				}).catch(() => void 0);
			}
		}
	}
	const message = buildSessionMessage({
		...meta,
		base: base$1,
		ws: wsCommit
	});
	const committed = await runGit(subprocess, argvCommitTree(sessionRepo, rootTreeSha, message, base$1), root, env);
	if (committed.exitCode !== 0) return {
		ok: false,
		reason: "commit-failed"
	};
	const commit = firstLine(committed.stdout);
	if (commit.length === 0) return {
		ok: false,
		reason: "commit-empty"
	};
	let targetRef;
	let fork = false;
	if (fromJump) {
		targetRef = `${ROAD_REF_PREFIX}${Date.now()}`;
		fork = true;
		clearJumpTarget(sessionId);
	} else if (activeRef !== null) targetRef = activeRef;
	else targetRef = "refs/heads/main";
	const updated = await runGit(subprocess, argvUpdateRef(sessionRepo, targetRef, commit), root, env);
	if (updated.exitCode !== 0) return {
		ok: false,
		reason: "update-ref-failed"
	};
	return {
		ok: true,
		commit,
		base: base$1,
		ref: targetRef,
		fork,
		wsCommit,
		snap,
		turn: derived
	};
}

//#endregion
//#region src/rewind.ts
/** Work-tree gating used for the detach wait. */
const IDLE_WAIT_MS = 5e3;
/** Bound a promise wait (loop-idle), resolving on timeout. */
async function boundedWait(promise, ms) {
	let timer;
	const timeout = new Promise((resolve$1) => {
		timer = setTimeout(resolve$1, ms);
	});
	await Promise.race([promise.then(() => void 0, () => void 0), timeout]);
	if (timer !== void 0) clearTimeout(timer);
}
/**

* Resolve the workspace commit paired with a session snapshot by walking the

* target's ancestors (first-parent chain) until a subject with ws= shows up.

* @param subprocess - the subprocess service.

* @param repo - the session repo.

* @param startCommit - the rewind target (or its road).

* @param cwd - a neutral cwd for git calls.

* @returns the ws commit SHA, or null.

*/
async function resolveWorkspaceCommit(subprocess, repo, startCommit, cwd) {
	const log = await runGit(subprocess, argvLogSubjects(repo, startCommit), cwd, commitEnv());
	if (log.exitCode !== 0) return null;
	for (const line of log.stdout.split("\n")) {
		const meta = parseMessage(line.trim());
		if (meta !== null && meta.ws !== void 0 && meta.ws.length > 0) return meta.ws;
	}
	return null;
}
/**

* Resolve the workspace repo that actually contains `wsCommit`: the session's

* own repo first, then the legacy per-project repo (old snapshots whose ws

* commits live there). Returns the git dir, or null when neither carries it.

*/
async function wsRepoWithCommit(subprocess, root, sessionId, wsCommit, cwd, env) {
	const primary = workspaceRepoDir(root, sessionId);
	const first = await runGit(subprocess, argvRevParseCommit({ gitDir: primary }, wsCommit), root, env);
	if (first.exitCode === 0 && firstLine(first.stdout).length > 0) return primary;
	const legacy = legacyWorkspaceRepoDir(root, cwd);
	if (legacy === primary || !existsSync(legacy)) return null;
	const second = await runGit(subprocess, argvRevParseCommit({ gitDir: legacy }, wsCommit), root, env);
	if (second.exitCode === 0 && firstLine(second.stdout).length > 0) return legacy;
	return null;
}
/**

* Re-observe files through DSH's fs-observation policy after a jump.

*

* The rewind detaches + resumes the session, which reborn the AGENT. The

* policy's "read the file before you edit it" state is keyed by the agent's

* session object, so after EVERY jump the new agent starts with nothing

* observed — the first `edit` would fail with `FS_NOT_OBSERVED`

* ("edit requires reading ... first") until the model re-reads the file.

*

* Warming replays the same `fs/observed` event the read tool emits (same

* provider resolve + stat → authoritative version), so the next edit's CAS

* matches the on-disk state and succeeds directly.

*

* @param agentCtx - the agent context that carries `agent` (resumed or live).

* @param files - workspace-relative paths (forward slashes) to observe.

*/
async function warmFsObservation(agentCtx, files) {
	const agent = agentCtx?.agent;
	const session = agent?.session;
	const cwd = session?.header?.cwd;
	const fs = agentCtx?.get?.("fs");
	const emit = agentCtx?.emit;
	if (agent === void 0 || cwd === void 0 || cwd.length === 0 || fs === void 0 || typeof emit !== "function") return;
	for (const rel of files) try {
		const target = await fs.resolve(rel, { cwd });
		const info = await fs.stat(target);
		if (target !== void 0 && info !== void 0 && info.version !== void 0) emit("fs/observed", target, {
			kind: "present",
			version: info.version
		}, { agent });
	} catch {}
}
/** Current workspace in-scope file list under the same snapshot excludes. */
async function currentWorkspaceFiles(cwd) {
	try {
		const excludes = await readExcludes(cwd);
		return await workspaceFileList(cwd, excludes);
	} catch {
		return [];
	}
}
/**

* Perform one rewind (checkout-only). Single-flight per session (callers gate it).

* @param subprocess - the subprocess service.

* @param root - history root.

* @param sessions - the in-memory session store.

* @param persistence - locating the official artifact.

* @param agents - the agent registry (running gate + detach/resume).

* @param sessionId - the session to rewind.

* @param commit - the timeline commit to rewind to.

* @param restoreWorkspace - also restore the workspace paired with the target.

* @param agentPresets - optional preset roster; when present and the target

*   records one, the resumed agent is re-composed from it (cache contract).

* @returns the wire-facing result.

*/
async function rewindSession(subprocess, root, sessions, persistence, agents, sessionId, commit, restoreWorkspace, agentPresets, workspaceOnly = false) {
	const session = sessions?.get(sessionId);
	if (session === void 0 || session.header === void 0) return {
		ok: false,
		reason: "no-session"
	};
	const location = persistence?.locate({
		...session.header,
		id: sessionId
	});
	if (location === void 0 || location.path.length === 0) return {
		ok: false,
		reason: "no-artifact"
	};
	const agent = agents?.get(sessionId);
	if (agent?.status === "running") return {
		ok: false,
		reason: "session-running"
	};
	await ensureHistoryRoot(root);
	const sessionRepo = { gitDir: sessionRepoDir(root, sessionId) };
	const env = commitEnv();
	if (!await ensureBareRepo(subprocess, sessionRepo.gitDir)) return {
		ok: false,
		reason: "git-unavailable"
	};
	const targetRes = await runGit(subprocess, argvRevParseCommit(sessionRepo, commit), root, env);
	if (targetRes.exitCode !== 0 || firstLine(targetRes.stdout).length === 0) return {
		ok: false,
		reason: "unknown-commit"
	};
	const target = firstLine(targetRes.stdout);
	if (workspaceOnly) {
		const cwdWs = session.header.cwd;
		if (cwdWs === void 0 || cwdWs.length === 0) return {
			ok: false,
			reason: "no-workspace"
		};
		const wsCommit$1 = await resolveWorkspaceCommit(subprocess, sessionRepo, target, root);
		if (wsCommit$1 === null) return {
			ok: false,
			reason: "no-workspace-snapshot",
			target
		};
		const wsGit = await wsRepoWithCommit(subprocess, root, sessionId, wsCommit$1, cwdWs, env);
		if (wsGit === null) return {
			ok: false,
			reason: "no-workspace-snapshot",
			target
		};
		const backed = await backupWorkspace(root, sessionId, cwdWs);
		if (backed === null) return {
			ok: false,
			reason: "workspace-backup-failed"
		};
		const excludes = await readExcludes(cwdWs);
		const restored = await materializeTreeExact(subprocess, wsGit, wsCommit$1, cwdWs, excludes);
		if (restored !== null) await snapshotWorkspace(subprocess, root, sessionId, cwdWs, "dsh-history: re-anchor after workspace rewind").catch(() => void 0);
		if (restored !== null) {
			const files = await treeFileList(subprocess, wsGit, wsCommit$1) ?? [];
			const liveAgent$1 = agents?.get(sessionId);
			if (liveAgent$1 !== void 0 && liveAgent$1.ctx !== void 0 && files.length > 0) await warmFsObservation(liveAgent$1.ctx, files);
		}
		return {
			ok: restored !== null,
			target,
			workspaceOnly: true,
			backup: { workspace: backed },
			workspaceRestored: restored !== null,
			...restored === null ? { reason: "workspace-restore-failed" } : {}
		};
	}
	const backup = {};
	const scratch = join(root, "backups", `scratch-${sessionId}-${Date.now()}`);
	let targetFile = null;
	try {
		await mkdir(scratch, { recursive: true });
		const count = await materializeTree(subprocess, sessionRepo.gitDir, target, scratch);
		if (count === null || count === 0) return {
			ok: false,
			reason: "materialize-failed"
		};
		const basename$1 = location.path.split(/[/\\]/).pop() ?? "session.jsonl.zstd";
		targetFile = join(scratch, `session-${sessionId}`, basename$1);
		if (!existsSync(targetFile)) return {
			ok: false,
			reason: "materialize-empty"
		};
	} catch (error) {
		await rm(scratch, {
			recursive: true,
			force: true
		}).catch(() => void 0);
		return {
			ok: false,
			reason: "materialize-error",
			error: error instanceof Error ? error.message : String(error)
		};
	}
	if (sessions?.flush !== void 0) try {
		await sessions.flush(session);
	} catch {}
	try {
		const backupDir = sessionBackupDir(root, sessionId);
		await mkdir(backupDir, { recursive: true });
		const backupPath = join(backupDir, `pre-rewind-${Date.now()}.zstd`);
		await copyFile(location.path, backupPath);
		backup.session = backupPath;
	} catch {
		await rm(scratch, {
			recursive: true,
			force: true
		}).catch(() => void 0);
		return {
			ok: false,
			reason: "backup-failed"
		};
	}
	let wsCommit = null;
	const cwd = session.header.cwd;
	let noWorkspaceSnapshot = false;
	let workspaceRestored = false;
	/** Files to re-observe through the fs-observation policy after resume. */
	let warmFiles = [];
	if (restoreWorkspace && cwd !== void 0 && cwd.length > 0) {
		wsCommit = await resolveWorkspaceCommit(subprocess, sessionRepo, target, root);
		if (wsCommit === null) noWorkspaceSnapshot = true;
		else {
			const wsGit = await wsRepoWithCommit(subprocess, root, sessionId, wsCommit, cwd, env);
			if (wsGit !== null) {
				const backed = await backupWorkspace(root, sessionId, cwd);
				if (backed === null) {
					await rm(scratch, {
						recursive: true,
						force: true
					}).catch(() => void 0);
					return {
						ok: false,
						reason: "workspace-backup-failed"
					};
				}
				backup.workspace = backed;
				const excludes = await readExcludes(cwd);
				const restored = await materializeTreeExact(subprocess, wsGit, wsCommit, cwd, excludes);
				workspaceRestored = restored !== null;
				if (restored !== null) await snapshotWorkspace(subprocess, root, sessionId, cwd, "dsh-history: re-anchor after workspace rewind").catch(() => void 0);
				if (restored !== null) warmFiles = await treeFileList(subprocess, wsGit, wsCommit) ?? [];
			} else wsCommit = null;
		}
	}
	if (warmFiles.length === 0 && cwd !== void 0 && cwd.length > 0) warmFiles = await currentWorkspaceFiles(cwd);
	if (sessions === void 0 || sessions.liveEntryFor === void 0 || sessions.detachEntered === void 0 || agents === void 0 || agents.detachEntered === void 0 || !(agents.store instanceof Map)) {
		await rm(scratch, {
			recursive: true,
			force: true
		}).catch(() => void 0);
		return {
			ok: false,
			reason: "no-detach-primitives",
			...backup.session !== void 0 ? { backup } : {}
		};
	}
	const liveAgent = agents.get(sessionId);
	if (liveAgent !== void 0) {
		if (liveAgent.status === "running" && liveAgent.cancel !== void 0) liveAgent.cancel({ kind: "disposed" });
		if (liveAgent.whenIdle !== void 0) await boundedWait(liveAgent.whenIdle(), IDLE_WAIT_MS);
		const entry = agents.store.get(sessionId);
		if (entry !== void 0) agents.detachEntered(entry);
	}
	const sessionEntry = sessions.liveEntryFor(session);
	if (sessionEntry !== void 0) sessions.detachEntered(sessionEntry);
	const dir = dirname(location.path);
	const tempPath = join(dir, `session.jsonl.zstd.tmp-${Date.now()}`);
	let targetBytes = null;
	try {
		targetBytes = await readFile(targetFile);
		targetBytes = seedBlankSession(targetBytes);
		await writeFile(tempPath, targetBytes);
		await rename(tempPath, location.path);
	} catch (error) {
		await unlink(tempPath).catch(() => void 0);
		await rm(scratch, {
			recursive: true,
			force: true
		}).catch(() => void 0);
		return {
			ok: false,
			reason: "replace-failed",
			error: error instanceof Error ? error.message : String(error),
			...backup.session !== void 0 ? { backup } : {},
			...workspaceRestored ? { workspaceRestored: true } : {}
		};
	}
	const facts = {};
	if (targetBytes !== null) try {
		Object.assign(facts, decodeTargetFacts(targetBytes));
	} catch {}
	let reloaded = false;
	let resumeError;
	let compositionWarning;
	let resumeHandle;
	if (agents?.resume !== void 0) {
		const baseOptions = { resumeSessionId: sessionId };
		if (facts.route !== void 0 && (facts.route.provider !== void 0 || facts.route.model !== void 0)) baseOptions.agentOptions = { ...facts.route };
		const tries = [{ options: baseOptions }];
		if (agentPresets?.mount !== void 0 && facts.agentPreset !== void 0) tries.unshift({ options: {
			...baseOptions,
			setup: async (agentCtx) => {
				await agentPresets.mount(agentCtx, facts.agentPreset);
			}
		} });
		let resumeFailure;
		let succeededIndex = -1;
		for (let index = 0; index < tries.length; index += 1) {
			const { options } = tries[index];
			try {
				resumeHandle = await agents.resume(options);
				succeededIndex = index;
				break;
			} catch (error) {
				resumeFailure = error instanceof Error ? error.message : String(error);
			}
		}
		reloaded = succeededIndex >= 0;
		if (reloaded) {
			resumeError = void 0;
			if (succeededIndex > 0) compositionWarning = `preset "${facts.agentPreset}" could not be mounted (${resumeFailure ?? "unknown"})`;
		} else resumeError = resumeFailure;
	} else resumeError = "runtime exposes no agents.resume";
	const outcome = {
		ok: reloaded,
		target,
		...backup.session !== void 0 ? { backup } : {},
		...noWorkspaceSnapshot ? { noWorkspaceSnapshot: true } : {},
		...workspaceRestored ? { workspaceRestored: true } : {},
		...compositionWarning !== void 0 ? { compositionWarning } : {}
	};
	if (!reloaded) {
		outcome.reason = "resume-failed";
		outcome.detached = true;
		outcome.error = resumeError;
		await rm(scratch, {
			recursive: true,
			force: true
		}).catch(() => void 0);
		return outcome;
	}
	if (warmFiles.length > 0) {
		const agentCtx = resumeHandle?.agent?.ctx;
		if (agentCtx !== void 0) await warmFsObservation(agentCtx, warmFiles);
	}
	setJumpTarget(sessionId, target);
	await rm(scratch, {
		recursive: true,
		force: true
	}).catch(() => void 0);
	return outcome;
}

//#endregion
//#region src/timeline.ts
/** Build a ws-commit -> basenames map from ONE `git log --name-only` stream. */
function wsFilesByCommit(stdout) {
	const map = new Map();
	let current = null;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("commit ")) {
			const sha = line.slice(7).trim();
			current = sha;
			if (!map.has(sha)) map.set(sha, []);
			continue;
		}
		const name = line.trim();
		if (current === null || name.length === 0) continue;
		const basename$1 = name.split(/[/\\]/).pop();
		if (basename$1.length === 0) continue;
		map.get(current).push(basename$1);
	}
	return map;
}
/** Resolve a session repo's timeline, or null when git fails. */
async function timelineRows(subprocess, repoDir, sessionId, root, workspaceCwd) {
	const repo = { gitDir: repoDir };
	const res = await runGit(subprocess, argvLogAll(repo), root);
	if (res.exitCode !== 0) return null;
	const rows = [];
	for (const line of res.stdout.split("\n")) {
		const text = line.trim();
		if (text.length === 0) continue;
		const parts = text.split("|");
		if (parts.length < 4) continue;
		const sha = parts[0];
		const parents = parts[1].split(" ").filter((parent) => parent.length > 0);
		const subject = parts.slice(2, -1).join("|");
		const ct = Number(parts[parts.length - 1]);
		if (!Number.isFinite(ct)) continue;
		rows.push({
			sha,
			parents,
			subject,
			ct,
			meta: parseMessage(subject)
		});
	}
	if (workspaceCwd !== void 0 && workspaceCwd !== null && workspaceCwd.length > 0) {
		const byCommit = new Map();
		const mergeFiles = (part) => {
			for (const [sha, files] of part) if (!byCommit.has(sha)) byCommit.set(sha, files);
		};
		const newRepo = workspaceRepoDir(root, sessionId);
		const logNew = await runGit(subprocess, [
			"git",
			`--git-dir=${newRepo}`,
			"log",
			"--root",
			"--name-only",
			"--format=commit %H",
			"refs/heads/main"
		], root);
		if (logNew.exitCode === 0) mergeFiles(wsFilesByCommit(logNew.stdout));
		const legacyRepo = legacyWorkspaceRepoDir(root, workspaceCwd);
		if (legacyRepo !== newRepo && existsSync(legacyRepo)) {
			const logOld = await runGit(subprocess, [
				"git",
				`--git-dir=${legacyRepo}`,
				"log",
				"--root",
				"--name-only",
				"--format=commit %H",
				"refs/heads/main"
			], root);
			if (logOld.exitCode === 0) mergeFiles(wsFilesByCommit(logOld.stdout));
		}
		if (byCommit.size > 0) {
			const seenWs = new Set();
			for (let i = rows.length - 1; i >= 0; i--) {
				const row = rows[i];
				const meta = row.meta;
				if (meta === null || meta.kind !== "turn-start" && meta.kind !== "turn-end") continue;
				const ws = meta.ws;
				if (ws === void 0 || ws.length === 0) continue;
				if (seenWs.has(ws)) continue;
				const files = byCommit.get(ws);
				if (files !== void 0 && files.length > 0) {
					row.files = files;
					seenWs.add(ws);
				}
			}
		}
	}
	return rows;
}

//#endregion
//#region src/purge.ts
/** List one directory's entries sorted by name (timestamps are lexicographic). */
async function listEntries(dir) {
	try {
		const names = await readdir(dir);
		return names.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
	} catch {
		return [];
	}
}
/** Delete every fork ref (road-* now; abandoned-* legacy) in one bare repo. */
async function removeForkRefs(subprocess, gitDir, cwd) {
	const repo = { gitDir };
	const listed = await runGit(subprocess, [
		"git",
		`--git-dir=${gitDir}`,
		"for-each-ref",
		"--format=%(refname)",
		"refs/heads/"
	], cwd);
	if (listed.exitCode !== 0) return 0;
	let count = 0;
	for (const line of listed.stdout.split("\n")) {
		const ref = line.trim();
		if (!ref.startsWith("refs/heads/road-") && !ref.startsWith("refs/heads/abandoned-")) continue;
		const removed = await runGit(subprocess, [
			"git",
			`--git-dir=${gitDir}`,
			"update-ref",
			"-d",
			ref
		], cwd);
		if (removed.exitCode === 0) count += 1;
	}
	return count;
}
/** Expire reflogs and prune unreachable objects in one bare repo. */
async function pruneRepo(subprocess, gitDir, cwd) {
	const expired = await runGit(subprocess, [
		"git",
		`--git-dir=${gitDir}`,
		"reflog",
		"expire",
		"--expire=now",
		"--all"
	], cwd);
	if (expired.exitCode !== 0) return false;
	const gc = await runGit(subprocess, [
		"git",
		`--git-dir=${gitDir}`,
		"gc",
		"--prune=now",
		"--quiet"
	], cwd);
	return gc.exitCode === 0;
}
/** Rotate backups: delete all but the newest `keep`. Returns deleted count. */
async function rotateBackups(dir, keep) {
	const entries = await listEntries(dir);
	const items = entries.filter((name) => name.startsWith("pre-rewind-") || name.startsWith("scratch-"));
	const toDelete = items.slice(0, Math.max(0, items.length - keep));
	let deleted = 0;
	for (const name of toDelete) try {
		await rm(join(dir, name), {
			recursive: true,
			force: true
		});
		deleted += 1;
	} catch {}
	return deleted;
}
/**

* Purge one session's shadow history (session repo + its workspace repo +

* both backup trees). Irreversible; caller must have passed confirm.

* @param subprocess - the subprocess service.

* @param root - history root.

* @param sessionId - the session whose shadow history to purge.

* @param cwd - the workspace path (purges its repo + backups when present).

* @param keepBackups - newest backup files to retain (default 3).

* @returns the purge result.

*/
async function purgeSession(subprocess, root, sessionId, cwd, keepBackups = 3) {
	const result = { ok: false };
	const sessionGit = sessionRepoDir(root, sessionId);
	if (await ensureBareRepo(subprocess, sessionGit)) {
		result.sessionRefs = await removeForkRefs(subprocess, sessionGit, root);
		result.sessionPruned = await pruneRepo(subprocess, sessionGit, root);
	}
	if (cwd !== void 0 && cwd.length > 0) {
		const wsGit = workspaceRepoDir(root, sessionId);
		if (await ensureBareRepo(subprocess, wsGit)) {
			result.workspaceRefs = await removeForkRefs(subprocess, wsGit, root);
			result.workspacePruned = await pruneRepo(subprocess, wsGit, root);
		}
	}
	const sessionDeleted = await rotateBackups(sessionBackupDir(root, sessionId), keepBackups);
	const wsDeleted = cwd !== void 0 && cwd.length > 0 ? await rotateBackups(workspaceBackupDir(root, sessionId), keepBackups) : 0;
	result.backupsDeleted = sessionDeleted + wsDeleted;
	result.ok = true;
	return result;
}

//#endregion
//#region src/export-repo.ts
/**

* Clone one session shadow repo to `targetPath` as a work-tree repo.

* @param subprocess - the subprocess service.

* @param root - history root (resolves the source repo).

* @param sessionId - session whose repo to export.

* @param targetPath - absolute destination. Must be empty or missing; a

*   non-empty dir is refused so the clone never merges into an existing repo.

* @returns the export result (target = resolved absolute path).

*/
async function exportShadowRepo(subprocess, root, sessionId, targetPath) {
	const cleanTarget = targetPath.trim();
	if (cleanTarget.length === 0) return {
		ok: false,
		reason: "empty-target"
	};
	const srcRepo = sessionRepoDir(root, sessionId);
	if (!existsSync(srcRepo)) return {
		ok: false,
		reason: "no-session-repo"
	};
	const target = resolve(cleanTarget);
	const rootAbs = resolve(root);
	if (target === rootAbs || target.startsWith(`${rootAbs}${sep}`)) return {
		ok: false,
		reason: "target-inside-history-root"
	};
	if (target.startsWith(`${resolve(srcRepo)}${sep}`)) return {
		ok: false,
		reason: "target-inside-session-repo"
	};
	if (existsSync(target)) {
		const entries = await readdir(target).catch(() => null);
		if (entries === null) return {
			ok: false,
			reason: "target-unreadable"
		};
		if (entries.length > 0) return {
			ok: false,
			reason: "target-not-empty"
		};
	} else {
		const made = await mkdir(target, { recursive: true }).then(() => true).catch(() => false);
		if (!made) return {
			ok: false,
			reason: "target-unwritable"
		};
	}
	const cloned = await runGit(subprocess, [
		"git",
		"clone",
		"--quiet",
		srcRepo,
		target
	], root);
	if (cloned.exitCode !== 0) {
		const detail = cloned.stderr.trim().split("\n").slice(-3).join(" ");
		return {
			ok: false,
			reason: "clone-failed",
			detail
		};
	}
	await runGit(subprocess, [
		"git",
		"-C",
		target,
		"switch",
		"-c",
		"main",
		"origin/main"
	], target).catch(() => void 0);
	await runGit(subprocess, [
		"git",
		"-C",
		target,
		"checkout",
		"-f",
		"main"
	], target).catch(() => void 0);
	const roads = await runGit(subprocess, [
		"git",
		"-C",
		target,
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/remotes/origin/road-*",
		"refs/remotes/origin/abandoned-*"
	], target);
	if (roads.exitCode === 0) for (const line of roads.stdout.split("\n")) {
		const ref = line.trim();
		if (ref.length === 0) continue;
		const local = ref.replace(/^origin\//, "");
		if (local === "main" || local === "HEAD") continue;
		await runGit(subprocess, [
			"git",
			"-C",
			target,
			"branch",
			local,
			ref
		], target).catch(() => void 0);
	}
	const locals = await runGit(subprocess, [
		"git",
		"-C",
		target,
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/heads"
	], target);
	const branches = locals.stdout.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
	const countRes = await runGit(subprocess, [
		"git",
		"-C",
		target,
		"rev-list",
		"--count",
		"--all"
	], target);
	const commits = countRes.exitCode === 0 ? Number.parseInt(firstLine(countRes.stdout), 10) || 0 : 0;
	return {
		ok: true,
		target,
		branches: branches.length > 0 ? branches : ["main"],
		commits
	};
}

//#endregion
//#region src/index.ts
/** Whether the request came from the loopback face of this local tool. */
function isLoopbackHost(req) {
	const host = (req.headers.host ?? "").toLowerCase();
	return host.startsWith("127.0.0.1") || host.startsWith("localhost") || host.startsWith("[::1]");
}
/** Write one JSON response and end the exchange. */
function json(res, status, value) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(value));
}
/** Read the request body as JSON, rejecting malformed payloads. */
function readJson(req) {
	return new Promise((resolve$1, reject) => {
		const chunks = [];
		req.on("data", (chunk) => {
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				resolve$1(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", reject);
	});
}
/** One per-session single-flight gate: snapshot and rewind never interleave. */
var SessionGate = class {
	chain = new Map();
	/** Run `task` for one session after every previous task for it settled. */
	run(sessionId, task) {
		const previous = this.chain.get(sessionId) ?? Promise.resolve();
		const next = previous.then(task, task);
		this.chain.set(sessionId, next.then(() => void 0, () => void 0));
		return next;
	}
};
/**

* Build the loopback-gated route handler.

* @param engine - the resolved engine services.

* @param gate - the per-session single-flight gate (shared with the snapshot listeners).

* @returns a Node-style handler.

*/
function buildHandler(engine, gate) {
	return async (req, res) => {
		try {
			if (!isLoopbackHost(req)) {
				json(res, 403, {
					ok: false,
					reason: "forbidden"
				});
				return;
			}
			const url = new URL(req.url ?? "/", "http://localhost");
			const pathname = url.pathname;
			const method = req.method ?? "";
			if (pathname === `${ROUTE_PREFIX}/timeline` && (method === "GET" || method === "POST")) {
				const sessionId$1 = typeof url.searchParams.get("sessionId") === "string" ? url.searchParams.get("sessionId") : await bodySessionId(req);
				if (sessionId$1 === null || sessionId$1.length === 0) {
					json(res, 400, {
						ok: false,
						reason: "bad-args"
					});
					return;
				}
				const repoDir = sessionRepoDir(engine.root, sessionId$1);
				if (!existsSync(repoDir)) {
					json(res, 200, {
						ok: true,
						rows: []
					});
					return;
				}
				const session = engine.sessions?.get(sessionId$1);
				const workspaceCwd = session?.header?.cwd ?? null;
				const rows = await timelineRows(engine.subprocess, repoDir, sessionId$1, engine.root, workspaceCwd);
				if (rows === null) json(res, 200, {
					ok: false,
					reason: "git-unavailable"
				});
				else json(res, 200, {
					ok: true,
					rows
				});
				return;
			}
			if (pathname === `${ROUTE_PREFIX}/status`) {
				const sessionId$1 = url.searchParams.get("sessionId");
				if (typeof sessionId$1 !== "string" || sessionId$1.length === 0) {
					json(res, 400, {
						ok: false,
						reason: "bad-args"
					});
					return;
				}
				const repoDir = sessionRepoDir(engine.root, sessionId$1);
				let mainTip = null;
				let activeTip = null;
				if (existsSync(repoDir)) {
					const res2 = await runGit(engine.subprocess, argvRevParseCommit({ gitDir: repoDir }, "refs/heads/main"), engine.root);
					mainTip = res2.exitCode === 0 && firstLine(res2.stdout).length > 0 ? firstLine(res2.stdout) : null;
					const jumpTarget = getJumpTarget(sessionId$1);
					if (jumpTarget !== void 0) {
						const jumpRes = await runGit(engine.subprocess, argvRevParseCommit({ gitDir: repoDir }, jumpTarget), engine.root);
						if (jumpRes.exitCode === 0) activeTip = firstLine(jumpRes.stdout);
					}
					if (activeTip === null) {
						const roads = await runGit(engine.subprocess, [
							"git",
							`--git-dir=${repoDir}`,
							"for-each-ref",
							"--format=%(refname)",
							"refs/heads/road-*"
						], engine.root);
						let best = null;
						let bestTs = -1;
						for (const line of roads.stdout.split("\n")) {
							const ref = line.trim();
							if (ref.length === 0) continue;
							const ts = Number(ref.slice(16));
							if (Number.isFinite(ts) && ts > bestTs) {
								bestTs = ts;
								best = ref;
							}
						}
						if (best !== null) {
							const active = await runGit(engine.subprocess, argvRevParseCommit({ gitDir: repoDir }, best), engine.root);
							if (active.exitCode === 0) activeTip = firstLine(active.stdout);
						} else activeTip = mainTip;
					}
				}
				json(res, 200, {
					ok: true,
					repoExists: mainTip !== null,
					mainTip,
					activeTip
				});
				return;
			}
			if (pathname === `${ROUTE_PREFIX}/git-status` && method === "GET") {
				json(res, 200, await detectGit(engine.subprocess, engine.root));
				return;
			}
			if (pathname === `${ROUTE_PREFIX}/config` && method === "GET") {
				const config = await readConfig(engine.root);
				json(res, 200, {
					ok: true,
					...config
				});
				return;
			}
			if (method !== "POST") {
				json(res, 404, {
					ok: false,
					reason: "not-found"
				});
				return;
			}
			if (pathname === `${ROUTE_PREFIX}/install-git`) {
				json(res, 200, await installGit(engine.subprocess, engine.root));
				return;
			}
			if (pathname === `${ROUTE_PREFIX}/config`) {
				let configBody;
				try {
					configBody = await readJson(req);
				} catch {
					json(res, 400, {
						ok: false,
						reason: "bad-json"
					});
					return;
				}
				const configArgs = configBody !== null && typeof configBody === "object" ? configBody : {};
				if (typeof configArgs.gitignoreTemplate !== "string") {
					json(res, 400, {
						ok: false,
						reason: "bad-args"
					});
					return;
				}
				const updated = await writeConfig(engine.root, { gitignoreTemplate: configArgs.gitignoreTemplate });
				json(res, 200, {
					ok: true,
					...updated
				});
				return;
			}
			let body;
			try {
				body = await readJson(req);
			} catch {
				json(res, 400, {
					ok: false,
					reason: "bad-json"
				});
				return;
			}
			const args = body !== null && typeof body === "object" ? body : {};
			const sessionId = typeof args.sessionId === "string" ? args.sessionId : "";
			if (sessionId.length === 0) {
				json(res, 400, {
					ok: false,
					reason: "bad-args"
				});
				return;
			}
			if (pathname === `${ROUTE_PREFIX}/snapshot`) {
				const session = engine.sessions?.get(sessionId);
				if (session === void 0) {
					json(res, 200, {
						ok: false,
						reason: "no-session"
					});
					return;
				}
				const result = await gate.run(sessionId, () => takeSnapshot(engine.subprocess, engine.root, engine.sessions, engine.persistence, {
					session,
					kind: "manual"
				}));
				json(res, 200, result);
				return;
			}
			if (pathname === `${ROUTE_PREFIX}/rewind`) {
				const commit = typeof args.commit === "string" ? args.commit : "";
				const restoreWorkspace = args.restoreWorkspace === true;
				const workspaceOnly = args.workspaceOnly === true;
				if (commit.length === 0) {
					json(res, 400, {
						ok: false,
						reason: "bad-args"
					});
					return;
				}
				const result = await gate.run(sessionId, () => rewindSession(engine.subprocess, engine.root, engine.sessions, engine.persistence, engine.agents, sessionId, commit, restoreWorkspace, engine.agentPresets, workspaceOnly));
				json(res, 200, result);
				return;
			}
			if (pathname === `${ROUTE_PREFIX}/purge`) {
				if (args.confirm !== true) {
					json(res, 400, {
						ok: false,
						reason: "confirm-required"
					});
					return;
				}
				const session = engine.sessions?.get(sessionId);
				const cwd = session?.header?.cwd;
				const result = await gate.run(sessionId, () => purgeSession(engine.subprocess, engine.root, sessionId, cwd));
				json(res, 200, result);
				return;
			}
			if (pathname === `${ROUTE_PREFIX}/export`) {
				const target = typeof args.target === "string" ? args.target : "";
				const result = await gate.run(sessionId, () => exportShadowRepo(engine.subprocess, engine.root, sessionId, target));
				json(res, 200, result);
				return;
			}
			json(res, 404, {
				ok: false,
				reason: "not-found"
			});
		} catch (error) {
			json(res, 500, {
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
				...error instanceof Error && error.stack !== void 0 ? { stack: error.stack } : {}
			});
		}
	};
}
/** Detect whether git is available on the host PATH (plugin config card). */
async function detectGit(subprocess, cwd) {
	try {
		const res = await runGit(subprocess, ["git", "--version"], cwd);
		if (res.exitCode === 0) {
			const version = firstLine(res.stdout);
			return {
				ok: true,
				available: true,
				...version.length > 0 ? { version } : {}
			};
		}
		return {
			ok: true,
			available: false,
			message: res.stderr.trim() || "git 未安装"
		};
	} catch (error) {
		return {
			ok: true,
			available: false,
			message: error instanceof Error ? error.message : String(error)
		};
	}
}
/**

* Attempt a silent Git install via winget. A system-level install can be

* blocked by the sandbox or need elevation; the caller surfaces detail and

* manual-install guidance. Note: the running DSH process PATH is fixed, so a

* newly installed git becomes visible only after a DSH restart.

*/
async function installGit(subprocess, cwd) {
	try {
		const handle = subprocess.spawn({
			argv: [
				"winget",
				"install",
				"--id",
				"Git.Git",
				"-e",
				"--silent",
				"--accept-source-agreements",
				"--accept-package-agreements",
				"--disable-interactivity"
			],
			cwd,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: 2e5 },
				stderr: { maxBytes: 2e5 }
			},
			graceMs: 6e5
		});
		const outcome = await handle.done;
		const out = handle.collected.stdout?.readFrom(0).text ?? "";
		const err = handle.collected.stderr?.readFrom(0).text ?? "";
		const ok = outcome.exitCode === 0;
		const detail = `${out}\n${err}`.trim().slice(0, 2e3);
		return {
			ok,
			...ok ? { installed: true } : {},
			...detail.length > 0 ? { detail } : {},
			message: ok ? "已安装 Git。宿主进程的 PATH 不会动态更新，请重启 DSH 后生效。" : "自动安装失败，请查看 detail，或手动安装：https://git-scm.com/download/win"
		};
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			message: `无法自动安装 Git（${msg}）。请手动安装：https://git-scm.com/download/win`
		};
	}
}
/** Read a sessionId from a POST body (timeline is GET-first, POST tolerant). */
async function bodySessionId(req) {
	try {
		const body = await readJson(req);
		const args = body !== null && typeof body === "object" ? body : {};
		return typeof args.sessionId === "string" ? args.sessionId : null;
	} catch {
		return null;
	}
}
/**

* Register the snapshot listeners + routes.

* @param ctx - Host context whose subprocess, sessions, sessionPersistence,

*   agents and webServer services are consumed.

*/
function apply(ctx) {
	const subprocess = ctx.get("subprocess");
	if (subprocess === void 0) return;
	const sessions = ctx.get("sessions");
	if (sessions === void 0) return;
	const persistence = ctx.get("sessionPersistence");
	if (persistence === void 0) return;
	const agents = ctx.get("agents");
	const agentPresets = ctx.get("agentPresets");
	const root = historyRoot();
	mkdirSync(root, { recursive: true });
	ensureHistoryRoot(root);
	const engine = {
		subprocess,
		sessions,
		persistence,
		agents,
		agentPresets,
		root
	};
	const gate = new SessionGate();
	const captureChains = new Map();
	const captureOrdered = (session, kind, endSeq) => {
		const previous = captureChains.get(session.id) ?? Promise.resolve();
		const next = previous.then(() => captureSessionArtifact(subprocess, root, sessions, persistence, session, kind, endSeq), () => captureSessionArtifact(subprocess, root, sessions, persistence, session, kind, endSeq));
		captureChains.set(session.id, next.then(() => void 0, () => void 0));
		return next;
	};
	const onSession = ctx.on;
	onSession("session/event", (session, event) => {
		if (event.type !== "turn/start" && event.type !== "turn/end") return;
		const kind = event.type === "turn/start" ? "turn-start" : "turn-end";
		const captured = captureOrdered(session, kind, kind === "turn-end" ? event.seq : void 0);
		gate.run(session.id, () => takeSnapshot(subprocess, root, sessions, persistence, {
			session,
			kind,
			seq: event.seq,
			captured
		}).then((result) => {
			if (!result.ok) console.warn(`[dsh-history] snapshot ${event.type} seq ${event.seq} of ${session.id} failed: ${result.reason ?? "unknown"}`);
		}).catch((error) => {
			console.warn(`[dsh-history] snapshot ${event.type} seq ${event.seq} of ${session.id} threw:`, error);
		}));
	});
	const webServer = ctx.get("webServer");
	if (webServer === void 0) return;
	ctx.effect(() => webServer.register({
		kind: "prefix",
		path: ROUTE_PREFIX,
		handler: buildHandler(engine, gate)
	}), "dsh-history-rewind: snapshot + rewind + timeline routes");
	const commands = ctx.get("commands");
	if (commands !== void 0) ctx.effect(() => commands.register({
		name: "history",
		description: "open the session history (git graph / rewind) panel",
		handler: () => {
			return {
				kind: "success",
				text: "History panel opened."
			};
		}
	}), "dsh-history-rewind: /history command");
}

//#endregion
export { apply };