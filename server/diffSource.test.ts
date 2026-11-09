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
import { afterAll, describe, expect, it } from 'vitest'
import { buildDiffSource } from './diffSource.ts'
import { isolateVcsConfig, run } from './testUtil.ts'

type Range = Parameters<typeof buildDiffSource>[0]

const jj = (opts: Range, files: string[] = []) => buildDiffSource(opts, files, 'jj')
const git = (opts: Range) => buildDiffSource(opts, [], 'git')

/** Run `f` with `dir` as the cwd, which is where the default git diff looks. */
function inDir<T>(dir: string, f: () => T): T {
  const prev = process.cwd()
  process.chdir(dir)
  try {
    return f()
  } finally {
    process.chdir(prev)
  }
}

describe('buildDiffSource for jj', () => {
  it('defaults to the fork point of trunk and @', () => {
    expect(jj({}, ['src'])).toEqual({
      vcs: 'jj',
      args: ['--from', 'fork_point(trunk() | @)'],
      toWorkingCopy: true,
      files: ['src'],
      endpoints: { left: 'fork_point(trunk() | @)', right: { rev: '@' } },
    })
  })

  it('takes --from and --to, with comments only when --to is @', () => {
    expect(jj({ from: 'a' })).toMatchObject({
      args: ['--from', 'a'],
      toWorkingCopy: true,
      endpoints: { left: 'a', right: { rev: '@' } },
    })
    expect(jj({ to: 'b' })).toMatchObject({
      args: ['--to', 'b'],
      toWorkingCopy: false,
      endpoints: { left: '@', right: { rev: 'b' } },
    })
    expect(jj({ from: 'a', to: '@' })).toMatchObject({ toWorkingCopy: true })
  })

  it('takes -r ranges and single revisions', () => {
    expect(jj({ revisions: 'a..@' })).toMatchObject({
      args: ['-r', 'a..@'],
      toWorkingCopy: true,
      endpoints: { left: 'a', right: { rev: '@' } },
    })
    expect(jj({ revisions: 'x' })).toMatchObject({
      toWorkingCopy: false,
      endpoints: { left: 'x-', right: { rev: 'x' } },
    })
    expect(jj({ revisions: 'a..b..c' }).endpoints).toBeNull()
  })
})

describe('buildDiffSource for git', () => {
  it('takes --from and --to', () => {
    expect(git({ from: 'a', to: 'b' })).toMatchObject({
      args: ['a', 'b'],
      toWorkingCopy: false,
      endpoints: { left: 'a', right: { rev: 'b' } },
    })
    expect(git({ from: 'a' })).toMatchObject({
      args: ['a'],
      toWorkingCopy: true,
      endpoints: { left: 'a', right: 'workingCopy' },
    })
  })

  it('takes -r ranges and single refs', () => {
    expect(git({ revisions: 'a..b' })).toMatchObject({
      args: ['a..b'],
      toWorkingCopy: false,
      endpoints: { left: 'a', right: { rev: 'b' } },
    })
    expect(git({ revisions: 'x' })).toMatchObject({
      args: ['x'],
      toWorkingCopy: true,
      endpoints: { left: 'x', right: 'workingCopy' },
    })
  })

  describe('by default', () => {
    const dirs: string[] = []
    afterAll(async () => {
      await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
    })

    async function repo(branch: string): Promise<string> {
      dirs.push(await isolateVcsConfig())
      const dir = await mkdtemp(join(tmpdir(), 'skepsis-source-'))
      dirs.push(dir)
      await run('git', ['init', '-q', '-b', branch], dir)
      await writeFile(join(dir, 'a'), 'a\n')
      await run('git', ['add', '.'], dir)
      await run('git', ['commit', '-qm', 'init'], dir)
      return dir
    }

    it('diffs the working tree against the merge base with trunk', async () => {
      const dir = await repo('main')
      const { stdout } = await run('git', ['rev-parse', 'HEAD'], dir)
      const sha = stdout.trim()
      expect(inDir(dir, () => git({}))).toMatchObject({
        args: [sha],
        displayArgs: ['--merge-base', 'main'],
        toWorkingCopy: true,
        endpoints: { left: sha, right: 'workingCopy' },
      })
    })

    it('throws when there is no trunk to diff against', async () => {
      const dir = await repo('topic')
      expect(() => inDir(dir, () => git({}))).toThrow(/No base revision found/)
    })
  })
})
