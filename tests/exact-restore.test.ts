/**
 * materializeTreeExact: restoring a snapshot must make the live workspace
 * byte-identical to the tree — extra files removed, empty dirs pruned, and
 * excluded dirs (node_modules, .git) left untouched.
 *
 * Exclusion rules now come SOLELY from the workspace's own `.gitignore`
 * (auto-seeded by `snapshotWorkspace` on first snapshot when absent), not
 * from any hardcoded default list merged at snapshot time.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeSubprocess } from './fake-subprocess.ts'
import { snapshotWorkspace, materializeTreeExact } from '../src/workspace.ts'
import { workspaceRepoDir, readExcludes } from '../src/store.ts'

test('materializeTreeExact restores exactly: extra files removed, excluded dirs kept, empty dirs pruned', async () => {
  const subprocess = fakeSubprocess()
  const root = await mkdtemp(join(tmpdir(), 'dsh-exact-'))
  const cwd = join(root, 'ws')
  const sessionId = 's-exact'
  await mkdir(cwd, { recursive: true })

  // --- Snapshot A: one file at the workspace root. The FIRST snapshot of a
  //     workspace with no .gitignore yet auto-seeds one from the global
  //     default template, so snapshot A's tree carries game.html AND the
  //     freshly-created .gitignore. ---
  await writeFile(join(cwd, 'game.html'), 'v1', 'utf8')
  const snapA = await snapshotWorkspace(subprocess, root, sessionId, cwd, 'dsh-history: A')
  assert.equal(snapA.ok, true)
  const commitA = snapA.commit
  assert.ok(commitA !== undefined && commitA.length > 0)
  assert.equal(existsSync(join(cwd, '.gitignore')), true, 'first snapshot auto-seeds .gitignore')

  // --- Mutate: change game.html, add a nested extra file, add an excluded dir. ---
  await writeFile(join(cwd, 'game.html'), 'v2-modified', 'utf8')
  await mkdir(join(cwd, 'src', 'deep'), { recursive: true })
  await writeFile(join(cwd, 'src', 'deep', 'extra.js'), 'junk', 'utf8')
  await mkdir(join(cwd, 'node_modules', 'pkg'), { recursive: true })
  await writeFile(join(cwd, 'node_modules', 'pkg', 'index.js'), 'dep', 'utf8')

  // --- Exact restore back to A, using the workspace's OWN .gitignore (the
  //     seeded default template excludes node_modules). ---
  const excludes = await readExcludes(cwd)
  assert.ok(excludes.includes('node_modules'), 'seeded .gitignore excludes node_modules')
  const repoDir = workspaceRepoDir(root, sessionId)
  const restored = await materializeTreeExact(subprocess, repoDir, commitA!, cwd, excludes)
  assert.equal(restored, 2, 'snapshot A had exactly two files: game.html + .gitignore')

  // game.html restored to v1.
  assert.equal(await readFile(join(cwd, 'game.html'), 'utf8'), 'v1')
  // Extra nested file removed, and its now-empty dirs pruned.
  assert.equal(existsSync(join(cwd, 'src', 'deep', 'extra.js')), false, 'extra file removed')
  assert.equal(existsSync(join(cwd, 'src', 'deep')), false, 'empty deep dir pruned')
  assert.equal(existsSync(join(cwd, 'src')), false, 'empty src dir pruned')
  // Excluded dir (node_modules) preserved untouched.
  assert.equal(await readFile(join(cwd, 'node_modules', 'pkg', 'index.js'), 'utf8'), 'dep')

  // Only the expected in-scope entries remain at the root.
  const rootEntries = (await readdir(cwd)).sort()
  assert.deepEqual(rootEntries, ['.gitignore', 'game.html', 'node_modules'])

  await rm(root, { recursive: true, force: true }).catch(() => undefined)
})
