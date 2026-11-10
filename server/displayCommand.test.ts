/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { describe, expect, it } from 'vitest'
import type { DiffSpec } from './diffSource.ts'
import { displayCommand } from './displayCommand.ts'

const git = (displayArgs: string[], files: string[] = []): DiffSpec => ({
  vcs: 'git',
  range: { kind: 'opaque', args: displayArgs },
  toWorkingCopy: true,
  files,
  displayArgs,
})

describe('displayCommand', () => {
  it('leaves plain args unquoted', () => {
    expect(displayCommand(git(['--merge-base', 'origin/main']))).toBe(
      'git diff --merge-base origin/main',
    )
  })

  it('quotes args with shell metacharacters so the command is runnable', () => {
    const src: DiffSpec = {
      vcs: 'jj',
      range: { kind: 'fromTo', from: 'fork_point(trunk() | @)', to: '@' },
      toWorkingCopy: true,
      files: [],
      displayArgs: ['--from', 'fork_point(trunk() | @)'],
    }
    expect(displayCommand(src)).toBe("jj diff --from 'fork_point(trunk() | @)'")
  })

  it('escapes single quotes inside quoted args', () => {
    expect(displayCommand(git(["it's"]))).toBe(String.raw`git diff 'it'\''s'`)
  })

  it('shows jj interdiff as such', () => {
    const src: DiffSpec = {
      vcs: 'jj',
      range: { kind: 'interdiff', from: 'a', to: 'b' },
      toWorkingCopy: false,
      files: [],
      displayArgs: ['--from', 'a', '--to', 'b'],
    }
    expect(displayCommand(src)).toBe('jj interdiff --from a --to b')
  })

  it('quotes file paths after --', () => {
    expect(displayCommand(git(['main'], ['src/app.ts', 'my file.txt']))).toBe(
      "git diff main -- src/app.ts 'my file.txt'",
    )
  })
})
