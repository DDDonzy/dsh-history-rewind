/**
 * Pure git-argv builders for the dsh-history shadow repos. No process
 * execution here: every function returns an argv array (argv[0] === 'git'),
 * so the command shapes are unit testable and free of any shell-quoting
 * concern (the subprocess seam never shell-interprets argv).
 *
 * Both shadow repos are PURE BARE repos: every command carries `--git-dir`
 * and nothing else. Snapshots use plumbing only (hash-object / mktree /
 * commit-tree / update-ref); restore materializes a tree through a transient
 * index (read-tree + checkout-index) that is deleted afterwards, so the repo
 * itself stays work-tree-less.
 */

import {
  SESSION_FILE_BASENAME, SESSION_TREE_DIR, MAIN_BRANCH,
  COMMIT_AUTHOR_NAME, COMMIT_AUTHOR_EMAIL,
} from './constants.ts'

/** Location of one bare shadow repository. */
export interface ShadowRepo {
  /** GIT_DIR: the bare repository directory. */
  gitDir: string
}

/** Tree-entry mode strings. */
export const MODE_FILE = '100644'
/** Executable file mode string. */
export const MODE_EXEC = '100755'
/** Directory mode string. */
export const MODE_DIR = '040000'

/**
 * Common `git --git-dir=…` prefix for every shadow command.
 * @param repo - the bare shadow repo.
 * @returns the argv prefix.
 */
function base(repo: ShadowRepo): string[] {
  return ['git', `--git-dir=${repo.gitDir}`]
}

/** argv: initialize a bare repo (parent dirs must already exist). */
export function argvInitBare(gitDir: string): string[] {
  return ['git', 'init', '--bare', '--quiet', gitDir]
}

/** argv: probe the repo (works when HEAD exists). */
export function argvRevParseGitDir(repo: ShadowRepo): string[] {
  return [...base(repo), 'rev-parse', '--git-dir']
}

/**
 * argv: hash one on-disk file into the object store; stdout is the blob SHA.
 * Git reads the file itself, so binary bytes never cross our process boundary
 * (the whole reason restore and snapshot avoid subprocess stdout).
 * @param repo - the bare shadow repo.
 * @param absPath - absolute path of the file to hash.
 * @returns the hash-object argv.
 */
export function argvHashObjectFile(repo: ShadowRepo, absPath: string): string[] {
  return [...base(repo), 'hash-object', '-w', '--', absPath]
}

/**
 * argv: batch-hash files listed on stdin (one path per line or NUL-separated
 * with -z) into the object store; stdout is one blob SHA per input file, in
 * the same order.
 * @param repo - the bare shadow repo.
 * @returns the hash-object argv.
 */
export function argvHashObjectStdinPaths(repo: ShadowRepo, zero: boolean): string[] {
  return [...base(repo), 'hash-object', '-w', '--stdin-paths', ...(zero ? ['-z'] : [])]
}

/**
 * argv: build a tree from stdin entries; stdout is the tree SHA. With `-z`
 * the entries are NUL-terminated (<mode> <type> <sha>\t<name>\0) and paths
 * are not quoted.
 * @param repo - the bare shadow repo.
 * @param zero - whether stdin is NUL-terminated.
 * @returns the mktree argv.
 */
export function argvMktree(repo: ShadowRepo, zero: boolean): string[] {
  return [...base(repo), 'mktree', ...(zero ? ['-z'] : [])]
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
export function argvUpdateIndexFromInfo(repo: ShadowRepo): string[] {
  return ['git', '-c', 'core.bare=false', `--git-dir=${repo.gitDir}`, 'update-index', '--add', '-z', '--index-info']
}

/**
 * argv: write the transient index into a tree object; stdout is the tree
 * SHA. One process for the whole tree, replacing one mktree spawn per
 * directory.
 * @param repo - the bare shadow repo.
 * @returns the write-tree argv.
 */
export function argvWriteTree(repo: ShadowRepo): string[] {
  return ['git', '-c', 'core.bare=false', `--git-dir=${repo.gitDir}`, 'write-tree']
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
export function argvCommitTree(repo: ShadowRepo, treeSha: string, message: string, parentSha?: string): string[] {
  const argv = [...base(repo), 'commit-tree', treeSha, '-m', message]
  if (parentSha !== undefined && parentSha.length > 0) argv.push('-p', parentSha)
  return argv
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
export function argvUpdateRef(repo: ShadowRepo, ref: string, newSha: string, oldSha?: string): string[] {
  const argv = [...base(repo), 'update-ref', ref, newSha]
  if (oldSha !== undefined && oldSha.length > 0) argv.push(oldSha)
  return argv
}

/** argv: resolve a commit-ish to its commit hash (nonzero exit when absent). */
export function argvRevParseCommit(repo: ShadowRepo, refish: string): string[] {
  return [...base(repo), 'rev-parse', '--verify', '--quiet', `${refish}^{commit}`]
}

/** argv: resolve a commit-ish to its tree hash. */
export function argvRevParseTreeOf(repo: ShadowRepo, refish: string): string[] {
  return [...base(repo), 'rev-parse', '--verify', '--quiet', `${refish}^{tree}`]
}

/**
 * argv: topological commit walk across ALL refs (main + road branches);
 * stdout lines are `<sha>|<parents>|<subject>|<unix>`.
 * @param repo - the bare shadow repo.
 * @returns the log argv.
 */
export function argvLogAll(repo: ShadowRepo): string[] {
  return [...base(repo), 'log', '--all', '--topo-order', '--pretty=format:%H|%P|%s|%ct']
}

/**
 * argv: subjects of commits reachable from `refish` (newest first); used to
 * derive the TURN counter from git alone.
 * @param repo - the bare shadow repo.
 * @param refish - ref or commit-ish (default main).
 * @returns the log argv.
 */
export function argvLogSubjects(repo: ShadowRepo, refish: string = `refs/heads/${MAIN_BRANCH}`): string[] {
  return [...base(repo), 'log', '--pretty=%s', refish]
}

/**
 * argv: list every tree entry recursively; stdout lines are
 * `<mode> <type> <sha>\t<path>`.
 * @param repo - the bare shadow repo.
 * @param treeish - commit or tree to list.
 * @returns the ls-tree argv.
 */
export function argvListTree(repo: ShadowRepo, treeish: string): string[] {
  return [...base(repo), 'ls-tree', '-r', '-z', treeish]
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
export function argvReadTree(repo: ShadowRepo, treeish: string): string[] {
  return ['git', '-c', 'core.bare=false', `--git-dir=${repo.gitDir}`, 'read-tree', '--reset', treeish]
}

/**
 * argv: materialize the whole index into `targetDir` (restore step 2).
 * Git writes the files itself — binary-safe, no bytes through our process.
 * @param repo - the bare shadow repo.
 * @param targetDir - the directory to write into (the workspace cwd).
 * @returns the checkout-index argv.
 */
export function argvCheckoutIndex(repo: ShadowRepo, targetDir: string): string[] {
  return ['git', '-c', 'core.bare=false', `--git-dir=${repo.gitDir}`, `--work-tree=${targetDir}`, 'checkout-index', '-a', '-f']
}

/**
 * argv: read a single blob to stdout. Only safe for text; binary blobs must
 * go through the temp-index materialization path instead.
 * @param repo - the bare shadow repo.
 * @param objectish - blob or `<commit>:<path>` to cat.
 * @returns the cat-file argv.
 */
export function argvCatBlob(repo: ShadowRepo, objectish: string): string[] {
  return [...base(repo), 'cat-file', 'blob', objectish]
}

/** Env entries that give shadow commits a fixed identity. */
export function commitEnv(): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL,
  }
}

/**
 * Format the fixed tree path of the session artifact inside a session commit.
 * @param sessionId - the session id.
 * @returns the tree path (e.g. session-<id>/session.jsonl.zstd).
 */
export function sessionArtifactPath(sessionId: string): string {
  return `${SESSION_TREE_DIR}${sessionId}/${SESSION_FILE_BASENAME}`
}
