/**
 * Snapshot exclusion rules come SOLELY from a workspace's own `.gitignore`.
 *
 *  - readExcludes(cwd) reads only <cwd>/.gitignore (no merged default list).
 *  - snapshotWorkspace auto-seeds a fresh workspace's .gitignore from the
 *    global default template on its FIRST snapshot, and never touches an
 *    existing one afterwards.
 *  - A root .gitignore is always part of the snapshot tree, even when its own
 *    rules would otherwise match it.
 *  - `!`-prefixed (negation) lines are dropped rather than mis-parsed as a
 *    literal exclude pattern.
 *  - readConfig / writeConfig round-trip the global gitignoreTemplate.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeSubprocess } from './fake-subprocess.ts'
import { snapshotWorkspace } from '../src/workspace.ts'
import { readExcludes, readConfig, writeConfig, ensureWorkspaceGitignore } from '../src/store.ts'
import { runGit } from '../src/git-runner.ts'
import { workspaceRepoDir } from '../src/store.ts'

/** List files in `main` of the given bare repo (sorted, empty lines dropped). */
async function treeFiles(historyRoot: string, sessionId: string, cwd: string): Promise<string[]> {
  const subprocess = fakeSubprocess()
  const repoDir = workspaceRepoDir(historyRoot, sessionId)
  const res = await runGit(subprocess, ['git', `--git-dir=${repoDir}`, 'ls-tree', '-r', '--name-only', 'main'], cwd)
  return res.stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0).sort()
}

test('readExcludes reads ONLY the workspace .gitignore, with no merged defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gi-'))
  // No .gitignore at all: excludes nothing.
  assert.deepEqual(await readExcludes(root), [])

  await writeFile(join(root, '.gitignore'), '# comment\n\n*.secret\nbuild/\n', 'utf8')
  assert.deepEqual(await readExcludes(root), ['*.secret', 'build/'])

  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

test('readExcludes drops ! negation lines instead of mis-parsing them as literal excludes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gi-'))
  await writeFile(join(root, '.gitignore'), '*.log\n!keep.log\n', 'utf8')
  assert.deepEqual(await readExcludes(root), ['*.log'])
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

test('snapshotWorkspace seeds .gitignore from the global template on first snapshot, never on later ones', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-gi-'))
  const cwd = join(root, 'ws')
  const sessionId = 's-seed'
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, 'a.txt'), 'v1', 'utf8')

  const first = await snapshotWorkspace(subprocess, root, sessionId, cwd, 'dsh-history: A')
  assert.equal(first.ok, true)
  assert.equal(existsSync(join(cwd, '.gitignore')), true, 'first snapshot seeds .gitignore')
  const seeded = await readFile(join(cwd, '.gitignore'), 'utf8')
  assert.ok(seeded.includes('.git'), 'seeded content comes from the default template')

  // Files that exist after seeding: a.txt AND the seeded .gitignore itself.
  assert.deepEqual(await treeFiles(root, sessionId, cwd), ['.gitignore', 'a.txt'])

  // User edits their .gitignore afterwards.
  await writeFile(join(cwd, '.gitignore'), '*.custom\n', 'utf8')
  await writeFile(join(cwd, 'x.custom'), 'ignored-by-user-rule', 'utf8')
  await writeFile(join(cwd, 'b.txt'), 'v2', 'utf8')
  const second = await snapshotWorkspace(subprocess, root, sessionId, cwd, 'dsh-history: B')
  assert.equal(second.ok, true)

  // The second snapshot must NOT have overwritten the user's edit, and must
  // honor the user's own rule (x.custom excluded, .gitignore itself kept).
  assert.equal(await readFile(join(cwd, '.gitignore'), 'utf8'), '*.custom\n')
  assert.deepEqual(await treeFiles(root, sessionId, cwd), ['.gitignore', 'a.txt', 'b.txt'])

  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

test('a root .gitignore that matches itself is still snapshotted (forced whitelist)', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-gi-'))
  const cwd = join(root, 'ws')
  const sessionId = 's-self'
  await mkdir(cwd, { recursive: true })
  // A bare "*" rule would, without the forced whitelist, exclude EVERYTHING
  // including .gitignore itself.
  await writeFile(join(cwd, '.gitignore'), '*\n', 'utf8')
  await writeFile(join(cwd, 'a.txt'), 'v1', 'utf8')

  const result = await snapshotWorkspace(subprocess, root, sessionId, cwd, 'dsh-history: A')
  assert.equal(result.ok, true)
  // a.txt is excluded by the user's own "*" rule; .gitignore survives regardless.
  assert.deepEqual(await treeFiles(root, sessionId, cwd), ['.gitignore'])

  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

test('workspace snapshots report complete added modified and deleted paths', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-gi-'))
  const cwd = join(root, 'ws')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, '.gitignore'), '.git\n', 'utf8')
  await writeFile(join(cwd, 'modified.txt'), 'v1', 'utf8')
  await writeFile(join(cwd, 'deleted.txt'), 'gone', 'utf8')

  const first = await snapshotWorkspace(subprocess, root, 's-changes', cwd, 'first')
  assert.equal(first.ok, true)
  assert.deepEqual(first.changes?.map((change) => [change.status, change.path]), [
    ['A', '.gitignore'],
    ['A', 'deleted.txt'],
    ['A', 'modified.txt'],
  ])

  await writeFile(join(cwd, 'modified.txt'), 'v2', 'utf8')
  await rm(join(cwd, 'deleted.txt'))
  await writeFile(join(cwd, 'added.txt'), 'new', 'utf8')
  const second = await snapshotWorkspace(subprocess, root, 's-changes', cwd, 'second')
  assert.equal(second.ok, true)
  assert.deepEqual(second.changes?.map((change) => [change.status, change.path]), [
    ['A', 'added.txt'],
    ['D', 'deleted.txt'],
    ['M', 'modified.txt'],
  ])

  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

test('ensureWorkspaceGitignore never overwrites a pre-existing .gitignore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gi-'))
  const cwd = join(root, 'ws')
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, '.gitignore'), 'pre-existing-rule\n', 'utf8')

  await ensureWorkspaceGitignore(root, cwd)
  assert.equal(await readFile(join(cwd, '.gitignore'), 'utf8'), 'pre-existing-rule\n')

  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

test('readConfig / writeConfig round-trip the global gitignoreTemplate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gi-'))

  // Fresh root: defaults apply.
  const initial = await readConfig(root)
  assert.equal(initial.enabled, true)
  assert.ok(initial.gitignoreTemplate.includes('.git'))

  const updated = await writeConfig(root, { gitignoreTemplate: '*.tmp\ncache/\n' })
  assert.equal(updated.gitignoreTemplate, '*.tmp\ncache/\n')
  assert.equal(updated.enabled, true, 'unspecified fields keep their current value')

  const reread = await readConfig(root)
  assert.equal(reread.gitignoreTemplate, '*.tmp\ncache/\n')

  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

test('readConfig tolerates a corrupt config.json by falling back to full defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-gi-'))
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'config.json'), '{ not valid json', 'utf8')

  const config = await readConfig(root)
  assert.equal(config.enabled, true)
  assert.ok(config.gitignoreTemplate.includes('.git'))

  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})
