/**
 * Shadow-git execution layer: runs the pure argv builders through the
 * subprocess seam. Everything goes through `ctx.subprocess` (never host
 * child_process) so it works under the remote sandbox; argv is never
 * shell-interpreted, so a workspace path with spaces is safe.
 *
 * Two invariants hold everywhere:
 *  - git NEVER passes binary bytes to us via stdout (session zstd blobs and
 *    workspace files are materialized by git itself through a transient
 *    index, or hashed with git reading the file directly);
 *  - every git call targets an explicit `--git-dir` (bare shadows), so the
 *    user's own repositories are never touched.
 */

/** Minimal structural view of one collected output stream reader. */
interface OutputReader {
  readFrom(fromByte: number): { text: string }
}

/** Minimal structural view of a subprocess handle (only what we read). */
interface SubprocessHandleLike {
  readonly collected: { readonly stdout?: OutputReader; readonly stderr?: OutputReader }
  readonly done: Promise<{ exitCode: number | null; signal: string | null }>
}

/** Minimal structural view of the subprocess service. */
export interface SubprocessLike {
  spawn(spec: {
    argv: readonly string[]
    cwd: string
    stdio: { stdin: 'ignore' | { data: string }; stdout: { maxBytes: number }; stderr: { maxBytes: number } }
    graceMs: number
    env?: Record<string, string>
  }): SubprocessHandleLike
}

/** One completed git invocation's outcome. */
export interface GitResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

const OUT_CAP = 4_000_000
const GRACE_MS = 30_000

/**
 * Run one git argv through the subprocess seam.
 * @param subprocess - the subprocess service.
 * @param argv - full git argv (argv[0] === 'git').
 * @param cwd - working directory for the child.
 * @param env - optional extra environment (commit identity / transient index).
 * @param stdin - optional bytes written to stdin then closed.
 * @returns the exit code and captured stdout/stderr text.
 */
export async function runGit(
  subprocess: SubprocessLike,
  argv: readonly string[],
  cwd: string,
  env?: Record<string, string>,
  stdin?: string,
): Promise<GitResult> {
  const handle = subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: stdin !== undefined ? { data: stdin } : 'ignore',
      stdout: { maxBytes: OUT_CAP },
      stderr: { maxBytes: OUT_CAP },
    },
    graceMs: GRACE_MS,
    ...(env !== undefined ? { env } : {}),
  })
  const outcome = await handle.done
  return {
    exitCode: outcome.exitCode,
    stdout: handle.collected.stdout?.readFrom(0).text ?? '',
    stderr: handle.collected.stderr?.readFrom(0).text ?? '',
  }
}

/** First non-empty line of trimmed stdout (git single-value output). */
export function firstLine(stdout: string): string {
  return stdout.trim().split('\n')[0]?.trim() ?? ''
}
