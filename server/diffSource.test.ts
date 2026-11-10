/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildDiffSource, resolveDiff } from './diffSource.ts'
import { isolateVcsConfig, requireJj, run } from './testUtil.ts'

type Range = Parameters<typeof buildDiffSource>[0]

const jj = (opts: Range, files: string[] = []) => buildDiffSource(opts, files, 'jj')
const git = (opts: Range) => buildDiffSource(opts, [], 'git')

/** Run `f` with `dir` as the cwd, which is where git and jj look. */
async function inDir<T>(dir: string, f: () => T | Promise<T>): Promise<T> {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    return await f()
  } finally {
    process.chdir(prev)
  }
}

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'skepsis-source-'))
  dirs.push(dir)
  return dir
}

describe('buildDiffSource for jj', () => {
  it('defaults to the fork point of trunk and @', () => {
    expect(jj({}, ['src'])).toEqual({
      vcs: 'jj',
      range: { kind: 'fromTo', from: 'fork_point(trunk() | @)', to: '@' },
      toWorkingCopy: true,
      files: ['src'],
      displayArgs: ['--from', 'fork_point(trunk() | @)'],
    })
  })

  it('takes --from and --to, with comments only when --to is @', () => {
    expect(jj({ from: 'a' })).toMatchObject({
      range: { kind: 'fromTo', from: 'a', to: '@' },
      toWorkingCopy: true,
      displayArgs: ['--from', 'a'],
    })
    expect(jj({ to: 'b' })).toMatchObject({
      range: { kind: 'fromTo', from: '@', to: 'b' },
      toWorkingCopy: false,
      displayArgs: ['--to', 'b'],
    })
    expect(jj({ from: 'a', to: '@' })).toMatchObject({ toWorkingCopy: true })
  })

  it('takes -r ranges and single revisions', () => {
    expect(jj({ revisions: 'a..@' })).toMatchObject({
      range: { kind: 'range', left: 'a', right: '@' },
      toWorkingCopy: true,
      displayArgs: ['-r', 'a..@'],
    })
    expect(jj({ revisions: 'x' })).toMatchObject({
      range: { kind: 'single', rev: 'x' },
      toWorkingCopy: false,
    })
    expect(jj({ revisions: 'a..b..c' }).range).toEqual({
      kind: 'opaque',
      args: ['-r', 'a..b..c'],
    })
  })
})

describe('buildDiffSource for git', () => {
  it('takes --from and --to', () => {
    expect(git({ from: 'a', to: 'b' })).toMatchObject({
      range: { kind: 'fromTo', from: 'a', to: { rev: 'b' } },
      toWorkingCopy: false,
      displayArgs: ['a', 'b'],
    })
    expect(git({ from: 'a' })).toMatchObject({
      range: { kind: 'fromTo', from: 'a', to: 'workingCopy' },
      toWorkingCopy: true,
      displayArgs: ['a'],
    })
  })

  it('takes -r ranges and single refs', () => {
    expect(git({ revisions: 'a..b' })).toMatchObject({
      range: { kind: 'fromTo', from: 'a', to: { rev: 'b' } },
      toWorkingCopy: false,
      displayArgs: ['a..b'],
    })
    expect(git({ revisions: 'x' })).toMatchObject({
      range: { kind: 'fromTo', from: 'x', to: 'workingCopy' },
      toWorkingCopy: true,
      displayArgs: ['x'],
    })
    expect(git({ revisions: 'a...b' })).toMatchObject({
      range: { kind: 'opaque', args: ['a...b'] },
      toWorkingCopy: false,
    })
  })

  it('names a ref called workingCopy, not the working tree', () => {
    expect(git({ from: 'a', to: 'workingCopy' }).range).toEqual({
      kind: 'fromTo',
      from: 'a',
      to: { rev: 'workingCopy' },
    })
  })
})

/** Commit `file` with `contents` on the current branch, returning the sha. */
async function commit(dir: string, file: string, contents: string): Promise<string> {
  await writeFile(join(dir, file), contents)
  await run('git', ['add', '.'], dir)
  await run('git', ['commit', '-qm', file], dir)
  return (await run('git', ['rev-parse', 'HEAD'], dir)).stdout.trim()
}

describe('git', () => {
  beforeAll(async () => {
    dirs.push(await isolateVcsConfig())
  })

  async function repo(branch: string): Promise<string> {
    const dir = await tempDir()
    await run('git', ['init', '-q', '-b', branch], dir)
    await commit(dir, 'a', 'a\n')
    return dir
  }

  it('defaults to the working tree against the merge base with trunk', async () => {
    const dir = await repo('main')
    expect(await inDir(dir, () => git({}))).toMatchObject({
      range: { kind: 'mergeBase', with: 'main' },
      toWorkingCopy: true,
      displayArgs: ['--merge-base', 'main'],
    })
  })

  it('throws when there is no trunk to diff against', async () => {
    const dir = await repo('topic')
    await expect(inDir(dir, () => git({}))).rejects.toThrow(/No base revision found/)
  })

  it('resolves the merge base again after a rebase', async () => {
    const dir = await repo('main')
    const forkPoint = (await run('git', ['rev-parse', 'HEAD'], dir)).stdout.trim()
    await run('git', ['switch', '-qc', 'topic'], dir)
    await commit(dir, 'b', 'b\n')
    const spec = await inDir(dir, () => git({}))
    expect(await inDir(dir, () => resolveDiff(spec))).toEqual({
      vcs: 'git',
      interdiff: false,
      args: [forkPoint],
      files: [],
      snapshot: { left: forkPoint, right: 'workingCopy' },
    })

    await run('git', ['switch', '-q', 'main'], dir)
    const upstream = await commit(dir, 'c', 'c\n')
    await run('git', ['switch', '-q', 'topic'], dir)
    await run('git', ['rebase', '-q', 'main'], dir)
    expect(await inDir(dir, () => resolveDiff(spec))).toMatchObject({
      args: [upstream],
      snapshot: { left: upstream, right: 'workingCopy' },
    })
  })

  it('resolves both ends of a range to trees', async () => {
    const dir = await repo('main')
    await commit(dir, 'b', 'b\n')
    const tree = async (rev: string) =>
      (await run('git', ['rev-parse', `${rev}^{tree}`], dir)).stdout.trim()
    const [first, second] = [await tree('HEAD~'), await tree('HEAD')]
    const resolved = await inDir(dir, () => resolveDiff(git({ revisions: 'HEAD~..HEAD' })))
    expect(resolved).toMatchObject({
      args: [first, second],
      snapshot: { left: first, right: second },
    })
  })

  it('resolves a bare tree, such as the empty tree', async () => {
    const dir = await repo('main')
    const empty = (
      await run('git', ['hash-object', '-t', 'tree', '/dev/null'], dir)
    ).stdout.trim()
    const resolved = await inDir(dir, () => resolveDiff(git({ from: empty, to: 'HEAD' })))
    expect(resolved.snapshot?.left).toBe(empty)
  })

  it('names the revision that does not resolve', async () => {
    const dir = await repo('main')
    await expect(inDir(dir, () => resolveDiff(git({ from: 'nope' })))).rejects.toThrow(
      /Could not resolve 'nope'/,
    )
  })
})

describe('jj', () => {
  let dir: string
  const jjIn = (args: string[]) => run('jj', args, dir)
  const commitId = async (rev: string) =>
    (await jjIn(['log', '--no-graph', '-r', rev, '-T', 'commit_id'])).stdout.trim()

  beforeAll(async () => {
    await requireJj()
    dirs.push(await isolateVcsConfig())
    dir = await tempDir()
    await jjIn(['git', 'init'])
    await writeFile(join(dir, 'a'), 'a\n')
    await jjIn(['commit', '-m', 'a'])
    await jjIn(['bookmark', 'create', 'main', '-r', '@-'])
    await writeFile(join(dir, 'b'), 'b\n')
    await jjIn(['commit', '-m', 'b'])
    await writeFile(join(dir, 'w'), 'working copy\n')
  })

  it('pins both ends, @ included, to commits', async () => {
    const resolved = await inDir(dir, () => resolveDiff(jj({ from: 'main' })))
    // Resolving snapshotted the working copy, so @ is the commit with w in it.
    const left = await commitId('main')
    const right = await commitId('@')
    expect(resolved).toEqual({
      vcs: 'jj',
      interdiff: false,
      args: ['--ignore-working-copy', '--from', left, '--to', right],
      files: [],
      snapshot: { left, right },
    })
  })

  it('pins a single revision to it and its parent', async () => {
    const resolved = await inDir(dir, () => resolveDiff(jj({ revisions: '@-' })))
    const rev = await commitId('@-')
    expect(resolved).toMatchObject({
      args: ['--ignore-working-copy', '-r', rev],
      snapshot: { left: await commitId('main'), right: rev },
    })
  })

  it('resolves the base again when it moves', async () => {
    const spec = jj({ from: 'main' })
    const before = await inDir(dir, () => resolveDiff(spec))
    await jjIn(['bookmark', 'set', 'main', '-r', '@-'])
    const after = await inDir(dir, () => resolveDiff(spec))
    expect(after.snapshot!.left).toBe(await commitId('@-'))
    expect(after.snapshot!.left).not.toBe(before.snapshot!.left)
  })
})
