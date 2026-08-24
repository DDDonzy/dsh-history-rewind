/**
 * Test-only subprocess seam: spawns real git through node:child_process and
 * adapts it to the SubprocessLike shape the production code consumes. This
 * lets the integration tests exercise the REAL snapshot/rewind/timeline code
 * against a real git binary (in a temp dir), not against reimplementations.
 */

import { spawnSync } from 'node:child_process'
import type { SubprocessLike } from '../src/git-runner.ts'

/** Text capture as the production seam exposes it. */
export function fakeSubprocess(): SubprocessLike {
  return {
    spawn(spec) {
      const result = spawnSync(spec.argv[0]!, spec.argv.slice(1), {
        cwd: spec.cwd,
        input: spec.stdio.stdin === 'ignore' ? undefined : spec.stdio.stdin.data,
        encoding: 'utf8',
        env: { ...process.env, ...(spec.env ?? {}) },
        maxBuffer: 16 * 1024 * 1024,
      })
      const stdout = result.stdout ?? ''
      const stderr = result.stderr ?? ''
      return {
        collected: {
          stdout: { readFrom: () => ({ text: stdout }) },
          stderr: { readFrom: () => ({ text: stderr }) },
        },
        done: Promise.resolve({ exitCode: result.status, signal: result.signal }),
      }
    },
  }
}
