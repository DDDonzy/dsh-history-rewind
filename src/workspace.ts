/**
 * Workspace snapshotting and restoration against a pure-bare shadow repo.
 *
 * Snapshot = plumbing walk: every file under cwd (skipping `.git` directories
 * and the repo's exclude list) is batch-hashed with `hash-object
 * --stdin-paths` (git reads each file itself — zero copy, no bytes through
 * our process), trees are built bottom-up with `mktree`, then
 * `commit-tree -p <main tip>` + `update-ref main`. Because the walk sees
 * nested `.git` dirs as plain directories to skip, a workspace that is itself
 * a git repository can never degrade into a single gitlink entry.
 *
 * Restore = `ls-tree -r` validation + a transient index inside the repo dir:
 * `read-tree` + `checkout-index -a -f` with GIT_INDEX_FILE pointed at a
 * disposable index. Git writes the files into cwd (binary-safe); the index is
 * deleted afterwards, so the repo stays work-tree-less.
 */

import { readdir, lstat, cp, unlink, rmdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, sep, basename, relative, resolve } from 'node:path'
import type { SubprocessLike } from './git-runner.ts'
import { runGit, firstLine } from './git-runner.ts'
import {
  argvHashObjectStdinPaths, argvUpdateIndexFromInfo, argvWriteTree, argvCommitTree,
  argvUpdateRef, argvRevParseCommit, argvListTree, argvReadTree, argvCheckoutIndex,
  commitEnv, MODE_FILE, MODE_EXEC, type ShadowRepo,
} from './git-commands.ts'
import { acquireLock, ensureBareRepo, ensureExcludes, readExcludes, workspaceRepoDir, workspaceBackupDir } from './store.ts'

/** One file in the walk. */
interface WalkFile {
  /** Relative path (forward slashes) from cwd. */
  rel: string
  /** Absolute path for hashing. */
  abs: string
  /** Git mode ('100644' | '100755'). */
  mode: string
  /** Stat fingerprint captured at walk time. */
  stat: StatFingerprint
}

/**
 * One workspace file's stat fingerprint (only what decides content identity
 * in practice: size + last-mod time, plus mode for the exec bit).
 */
interface StatFingerprint {
  size: number
  mtimeMs: number
  mode: string
}

/**
 * In-memory workspace-unchanged cache: (walk signature -> root tree +
 * commit). The signature is the exact stat set of every walked file, so a
 * hit means nothing on disk could have changed under the walk rules — the
 * whole git pipeline (hash-object + update-index + write-tree + commit) is
 * skipped and the cached commit is reused. On ANY difference the full path
 * runs and re-pins the cache, so staleness is impossible under normal
 * filesystem semantics (a rewrite always bumps mtime/size).
 */
const wsSignatureCache = new Map<string, { signature: string; rootTree: string; commit: string }>()

/** Build the one-string walk signature from a file list (hash-free, size-bounded). */
function signatureOf(files: readonly WalkFile[], excludes: readonly string[]): string {
  let sig = ''
  for (const file of files) {
    const stat = file.stat
    sig += `${file.rel}\u0000${stat.size}\u0000${stat.mtimeMs}\u0000${file.mode}\u0000`
  }
  // The exclusion set shapes the walk itself; a change in it must never hit
  // the fast path (a newly excluded dir would otherwise stay cached).
  sig += `\u0000excludes:${excludes.join('\u0001')}`
  return sig
}

/** Compiled exclude rule. */
interface ExcludeRule {
  regex: RegExp
  dirOnly: boolean
  anchored: boolean
}

/** Default exclude patterns (never filtered out of the walk). */
const GIT_DIR_NAME = '.git'

/** Glob-to-regex for basename patterns (`*`, `?` supported). */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

/**
 * Compile exclude patterns into a matcher. Patterns without `/` match the
 * basename at any depth; a leading `/` anchors to the root level; a trailing
 * `/` matches directories only.
 * @param patterns - raw patterns ("#..." comments and blanks pre-filtered).
 * @returns a matcher over (rel, isDir).
 */
export function compileExcludes(patterns: readonly string[]): (rel: string, isDir: boolean) => boolean {
  const rules: ExcludeRule[] = []
  for (const raw of patterns) {
    if (raw.length === 0) continue
    let pattern = raw
    let dirOnly = false
    if (pattern.endsWith('/')) {
      dirOnly = true
      pattern = pattern.slice(0, -1)
    }
    let anchored = false
    if (pattern.startsWith('/')) {
      anchored = true
      pattern = pattern.slice(1)
    }
    if (pattern.length === 0) continue
    rules.push({ regex: globToRegex(pattern), dirOnly, anchored })
  }
  return (rel, isDir) => {
    const name = basename(rel)
    const isRoot = !rel.includes('/')
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue
      if (rule.anchored && !isRoot) continue
      if (rule.regex.test(name)) return true
    }
    return false
  }
}

/**
 * Recursively walk cwd collecting files (skipping .git dirs and excludes).
 * @param rootDir - the workspace cwd.
 * @param matcher - exclude matcher.
 * @returns the collected files (rel paths, forward slashes).
 */
async function walkFiles(rootDir: string, matcher: (rel: string, isDir: boolean) => boolean): Promise<WalkFile[]> {
  const files: WalkFile[] = []
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    const entries = await readdir(absDir, { withFileTypes: true })
    for (const entry of entries) {
      const name = entry.name
      const rel = relDir.length === 0 ? name : `${relDir}/${name}`
      if (matcher(rel, entry.isDirectory())) continue
      if (entry.isDirectory()) {
        if (name === GIT_DIR_NAME) continue
        await walk(join(absDir, name), rel)
      } else if (entry.isSymbolicLink()) {
        // Symlinks are recorded as regular files with the link target's mode
        // semantics skipped: readlink-following is out of scope, so skip.
        continue
      } else if (entry.isFile()) {
        const info = await lstat(join(absDir, name))
        const mode = (info.mode & 0o111) !== 0 ? MODE_EXEC : MODE_FILE
        files.push({ rel, abs: join(absDir, name), mode, stat: { size: info.size, mtimeMs: info.mtimeMs, mode } })
      }
    }
  }
  await walk(rootDir, '')
  return files
}

/** The empty tree object SHA (universal, present implicitly in every repo). */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Result of one workspace snapshot. */
export interface WorkspaceSnapshotResult {
  ok: boolean
  reason?: string
  /** git diagnostic text (stderr/stdout of the failing stage). */
  detail?: string
  /** Commit SHA pinned under main (null when the tree was unchanged and main had the same tree). */
  commit?: string
  /** True when the snapshot reused the parent commit (unchanged tree). */
  reused?: boolean
}

/**
 * Snapshot the whole workspace into the session's own shadow repo.
 * @param subprocess - the subprocess service.
 * @param root - history root.
 * @param sessionId - the session that owns this workspace history.
 * @param cwd - the workspace root to snapshot.
 * @param message - commit message (authored by the caller with the contract).
 * @returns the snapshot result.
 */
export async function snapshotWorkspace(
  subprocess: SubprocessLike,
  root: string,
  sessionId: string,
  cwd: string,
  message: string,
): Promise<WorkspaceSnapshotResult> {
  const lockSeg = sessionId.replace(/[^\w.-]/g, '_')
  const lock = await acquireLock(root, `ws-session-${lockSeg}`)
  if (lock === null) return { ok: false, reason: 'lock-busy' }
  try {
    const repoDir = workspaceRepoDir(root, sessionId)
    if (!(await ensureBareRepo(subprocess, repoDir))) return { ok: false, reason: 'git-unavailable' }
    await ensureExcludes(root, sessionId)
    const excludes = await readExcludes(root, cwd)
    const matcher = compileExcludes(excludes)
    const files = await walkFiles(cwd, matcher)
    const repo: ShadowRepo = { gitDir: repoDir }
    const env = commitEnv()

    // 0. Fast path: nothing changed on disk since the last walk of THIS
    //    repo — reuse the cached commit without touching git at all. The
    //    signature is the exact stat set, so any real change misses it.
    const cacheKey = repoDir
    const signature = signatureOf(files, excludes)
    const cached = wsSignatureCache.get(cacheKey)
    if (cached !== undefined && cached.signature === signature && existsSync(join(repoDir, 'HEAD'))) {
      return { ok: true, commit: cached.commit, reused: true }
    }

    // 1. Batch-hash every file (git reads them itself; any order is fine).
    //    `--stdin-paths` takes newline-separated paths (no -z support) and
    //    emits one blob SHA per input line, in input order.
    const shas: string[] = []
    if (files.length > 0) {
      const stdin = files.map((file) => file.rel).join('\n') + '\n'
      const hashed = await runGit(subprocess, argvHashObjectStdinPaths(repo, false), cwd, env, stdin)
      if (hashed.exitCode !== 0) return { ok: false, reason: 'hash-failed', detail: hashed.stderr }
      const lines = hashed.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
      if (lines.length !== files.length) return { ok: false, reason: 'hash-count-mismatch', detail: hashed.stdout }
      shas.push(...lines)
    }
    const shaByRel = new Map<string, string>()
    files.forEach((file, index) => { shaByRel.set(file.rel, shas[index]!) })

    // 2. Build the root tree in ONE git process: load every entry through
    //    update-index --index-info -z, then write-tree. The old per-dir
    //    mktree loop spawned one git process per DIRECTORY (~1000 spawns
    //    for a large workspace), which is where snapshot latency went.
    //    The transient index lives inside the repo dir and is deleted
    //    afterwards, so the repo stays work-tree-less.
    let rootTree: string
    if (files.length === 0) {
      rootTree = EMPTY_TREE
    } else {
      const indexFile = join(repoDir, `index.snapshot-${Date.now()}`)
      const treeEnv = {
        ...env,
        GIT_INDEX_FILE: indexFile,
      }
      try {
        const indexInfo = files.map((file) => {
          const sha = shaByRel.get(file.rel)
          if (sha === undefined) return null
          return `${file.mode} ${sha}\t${file.rel}\x00`
        })
        if (indexInfo.some((line) => line === null)) return { ok: false, reason: 'hash-missing' }
        const loaded = await runGit(
          subprocess,
          argvUpdateIndexFromInfo(repo),
          cwd,
          treeEnv,
          (indexInfo as string[]).join(''),
        )
        if (loaded.exitCode !== 0) return { ok: false, reason: 'update-index-failed', detail: loaded.stderr }
        const written = await runGit(subprocess, argvWriteTree(repo), cwd, treeEnv)
        if (written.exitCode !== 0) return { ok: false, reason: 'write-tree-failed', detail: written.stderr }
        rootTree = firstLine(written.stdout)
        if (rootTree.length === 0) return { ok: false, reason: 'write-tree-empty' }
      } finally {
        await unlink(indexFile).catch(() => undefined)
      }
    }

    // 3. Commit onto main tip (dedup: unchanged tree reuses the parent commit).
    //    ONE spawn gives both the commit sha and its tree sha (rev-list
    //    --pretty=%T prints "commit <sha>" then the tree; a missing ref
    //    exits 128 with empty stdout).
    let parent: string | undefined
    let parentTree: string | undefined
    const headRes = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'rev-list', '-1', '--pretty=%T', 'refs/heads/main'], cwd, env)
    if (headRes.exitCode === 0) {
      const lines = headRes.stdout.trim().split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
      if (lines.length >= 2 && lines[0]!.startsWith('commit ')) {
        parent = lines[0]!.slice('commit '.length)
        parentTree = lines[1]!
      }
    }
    if (parent !== undefined && parentTree === rootTree) {
      wsSignatureCache.set(cacheKey, { signature, rootTree, commit: parent })
      return { ok: true, commit: parent, reused: true }
    }
    const committed = await runGit(subprocess, argvCommitTree(repo, rootTree, message, parent), cwd, env)
    if (committed.exitCode !== 0) return { ok: false, reason: 'commit-failed' }
    const commit = firstLine(committed.stdout)
    if (commit.length === 0) return { ok: false, reason: 'commit-empty' }
    const updated = await runGit(subprocess, argvUpdateRef(repo, 'refs/heads/main', commit), cwd, env)
    if (updated.exitCode !== 0) return { ok: false, reason: 'update-ref-failed' }
    wsSignatureCache.set(cacheKey, { signature, rootTree, commit })
    return { ok: true, commit, reused: false }
  } finally {
    await lock.release()
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
export async function treeFileList(
  subprocess: SubprocessLike,
  repoDir: string,
  treeish: string,
): Promise<string[] | null> {
  const repo: ShadowRepo = { gitDir: repoDir }
  const listed = await runGit(subprocess, argvListTree(repo, treeish), repoDir, commitEnv())
  if (listed.exitCode !== 0) return null
  const paths: string[] = []
  for (const entry of listed.stdout.split('\x00')) {
    if (entry.length === 0) continue
    const tab = entry.indexOf('\t')
    if (tab >= 0) paths.push(entry.slice(tab + 1))
  }
  return paths
}

/**
 * List the live workspace's in-scope files (same exclude rules as snapshots).
 * @param cwd - the workspace root.
 * @param excludes - exclude patterns (identical to the snapshot walk's set).
 * @returns workspace-relative paths (forward slashes).
 */
export async function workspaceFileList(cwd: string, excludes: readonly string[]): Promise<string[]> {
  const matcher = compileExcludes(excludes)
  const files = await walkFiles(cwd, matcher)
  return files.map((file) => file.rel)
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
export async function materializeTree(
  subprocess: SubprocessLike,
  repoDir: string,
  treeish: string,
  targetDir: string,
): Promise<number | null> {
  const repo: ShadowRepo = { gitDir: repoDir }
  const env = {
    ...commitEnv(),
    GIT_INDEX_FILE: join(repoDir, `index.restore-${Date.now()}`),
    GIT_WORK_TREE: targetDir,
  }
  const listed = await runGit(subprocess, argvListTree(repo, treeish), repoDir, env)
  if (listed.exitCode !== 0) return null
  const count = listed.stdout.split('\x00').filter((line) => line.length > 0).length
  try {
    const loaded = await runGit(subprocess, argvReadTree(repo, treeish), repoDir, env)
    if (loaded.exitCode !== 0) return null
    const checked = await runGit(subprocess, argvCheckoutIndex(repo, targetDir), targetDir, env)
    if (checked.exitCode !== 0) return null
  } finally {
    try { await unlink(env.GIT_INDEX_FILE!) } catch { /* transient index already gone */ }
  }
  return count
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
export async function materializeTreeExact(
  subprocess: SubprocessLike,
  repoDir: string,
  treeish: string,
  targetDir: string,
  excludes: readonly string[],
): Promise<number | null> {
  const repo: ShadowRepo = { gitDir: repoDir }
  const listed = await runGit(subprocess, argvListTree(repo, treeish), repoDir, commitEnv())
  if (listed.exitCode !== 0) return null
  // ls-tree -r -z lines: "<mode> <type> <sha>\t<path>" — take the path after the tab.
  const keep = new Set<string>()
  for (const entry of listed.stdout.split('\x00')) {
    if (entry.length === 0) continue
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    keep.add(entry.slice(tab + 1))
  }

  // 1. Write the target files into the workspace (force-overwrites existing).
  const restored = await materializeTree(subprocess, repoDir, treeish, targetDir)
  if (restored === null) return null

  // 2. Delete every in-scope file the target does not contain, using the same
  //    exclude matcher as the snapshot walk (excluded dirs are never entered).
  const matcher = compileExcludes(excludes)
  const present = await walkFiles(targetDir, matcher)
  for (const file of present) {
    if (keep.has(file.rel)) continue
    try { await unlink(file.abs) } catch { /* already gone or locked; best-effort */ }
  }

  // 3. Prune directories left empty by the deletions (bottom-up; never touch
  //    excluded dirs or .git, which the walk already skips).
  await pruneEmptyDirs(targetDir, matcher)
  return keep.size
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
async function pruneEmptyDirs(
  rootDir: string,
  matcher: (rel: string, isDir: boolean) => boolean,
): Promise<boolean> {
  const walk = async (absDir: string, relDir: string): Promise<boolean> => {
    const entries = await readdir(absDir, { withFileTypes: true }).catch(() => null)
    if (entries === null) return false
    let empty = true
    for (const entry of entries) {
      const name = entry.name
      const rel = relDir.length === 0 ? name : `${relDir}/${name}`
      if (entry.isDirectory()) {
        if (name === GIT_DIR_NAME || matcher(rel, true)) { empty = false; continue }
        const childEmpty = await walk(join(absDir, name), rel)
        if (childEmpty) {
          try { await rmdir(join(absDir, name)) } catch { empty = false }
        } else {
          empty = false
        }
      } else {
        // Any surviving file keeps the directory alive.
        empty = false
      }
    }
    return empty
  }
  return walk(rootDir, '')
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
export async function backupWorkspace(root: string, sessionId: string, cwd: string): Promise<string | null> {
  const absCwd = resolve(cwd)
  const absRoot = resolve(root)
  if (absCwd === absRoot || absCwd.startsWith(`${absRoot}${sep}`)) return null
  const dest = join(workspaceBackupDir(root, sessionId), `pre-rewind-${Date.now()}`)
  const matcher = compileExcludes(['.git'])
  try {
    await cp(absCwd, dest, {
      recursive: true,
      filter: (src) => {
        if (src === absCwd) return true
        const rel = relative(absCwd, src)
        const isDirFlag = false // cp's filter cannot distinguish; basename match suffices
        return !matcher(rel, isDirFlag)
      },
    })
    return dest
  } catch {
    return null
  }
}
