/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

// The diff to show, from the CLI's range flags, and its per-request
// resolution to fixed revisions.

import { execFileSync } from 'node:child_process'
import type { RevisionId, Snapshot } from '../shared/types.ts'
import { run } from './diff.ts'

export interface RangeOptions {
  revisions?: string
  from?: string
  to?: string
  /** Run `jj interdiff` rather than `jj diff` (jj only) */
  interdiff?: boolean
  /** Force git mode (skip jj detection) */
  git?: boolean
}

/** The jj diff ranges skepsis understands. Anything else is `opaque`: run as
 *  given, with no snapshot and so no hunk expansion. */
type JjRange =
  | { kind: 'fromTo'; from: string; to: string }
  /** `jj interdiff`: how the change in `to` differs from the change in `from` */
  | { kind: 'interdiff'; from: string; to: string }
  | { kind: 'range'; left: string; right: string }
  /** `jj diff -r R`, R's own change: R-..R */
  | { kind: 'single'; rev: string }
  | { kind: 'opaque'; args: string[] }

type GitRange =
  /** The working tree against the merge base of `with` and HEAD */
  | { kind: 'mergeBase'; with: string }
  | { kind: 'fromTo'; from: string; to: { rev: string } | 'workingCopy' }
  | { kind: 'opaque'; args: string[] }

/** What the CLI flags asked for. Revs stay symbolic and are resolved again
 *  on every request (see resolveDiff), so a moved branch or a rebase shows up
 *  without restarting. */
export type DiffSpec = ({ vcs: 'jj'; range: JjRange } | { vcs: 'git'; range: GitRange }) & {
  files: string[]
  /** Whether the diff ends at the working copy, which review comments need */
  toWorkingCopy: boolean
  /** The user-facing args, for the command shown in the UI and log */
  displayArgs: string[]
}

/** One request's diff: concrete args and the snapshot they were built from. */
export interface ResolvedDiff {
  vcs: 'jj' | 'git'
  /** Run `jj interdiff` rather than `jj diff` */
  interdiff: boolean
  args: string[]
  files: string[]
  /** Null for an opaque range, an interdiff, or when the left side doesn't resolve to a
   *  single commit (`-r R` on a merge): hunk expansion is off then. */
  snapshot: Snapshot | null
}

export function isInterdiff(spec: DiffSpec): boolean {
  return spec.vcs === 'jj' && spec.range.kind === 'interdiff'
}

export function detectVcs(): 'jj' | 'git' {
  try {
    execFileSync('jj', ['root'], { stdio: 'ignore' })
    return 'jj'
  } catch {
    try {
      execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' })
      return 'git'
    } catch {
      throw new Error('Not in a jj or git repository')
    }
  }
}

/* Base rev candidates for the default git diff. A remote's default branch
 * (origin/HEAD) is optional — "Having a default branch for a remote is not
 * required" (https://git-scm.com/docs/git-remote, set-head) — so fall back to
 * common default-branch names, remote-tracking first — a poor man's version
 * of what jj's trunk() does. */
const GIT_BASE_CANDIDATES = [
  'origin/HEAD',
  'origin/main',
  'origin/master',
  'main',
  'master',
]

/** Find the trunk-ish base for the default diff: the first candidate that
 *  has a merge base with HEAD. The merge base itself is resolved again per
 *  request, since a rebase or fetch moves it. */
function findGitBase(): string {
  for (const base of GIT_BASE_CANDIDATES) {
    try {
      execFileSync('git', ['merge-base', base, 'HEAD'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      return base
    } catch (error) {
      // A missing candidate or no common ancestor means try the next one, but
      // outside a repo or without git installed every candidate fails the
      // same way — git's own error beats a misleading "no base revision
      // found" that suggests -r/-f flags that would also fail.
      const { code, stderr } = error as { code?: string; stderr?: Buffer }
      const message = stderr?.toString().trim()
      if (code === 'ENOENT' || message?.includes('not a git repository'))
        throw new Error(message || (error as Error).message, { cause: error })
    }
  }
  throw new Error(
    `No base revision found for the default diff (tried ${GIT_BASE_CANDIDATES.join(', ')}).\n` +
      'Specify a range explicitly with -r or -f/-t.',
  )
}

/** Split an `A..B` range into its two revs. Returns null for anything that
 *  isn't a simple two-sided range with both sides non-empty. */
function parseRange(rev: string): { left: string; right: string } | null {
  const idx = rev.indexOf('..')
  if (idx < 0 || rev.includes('...')) return null
  const left = rev.slice(0, idx)
  const right = rev.slice(idx + 2)
  if (!left || !right || right.includes('..')) return null
  return { left, right }
}

export function buildDiffSource(
  opts: RangeOptions,
  files: string[],
  vcs: 'jj' | 'git' = opts.git ? 'git' : detectVcs(),
): DiffSpec {
  if (opts.interdiff) {
    if (vcs !== 'jj') throw new Error('--interdiff needs jj')
    if (opts.revisions) throw new Error("--interdiff can't be combined with -r")
    // Without this, jj's own usage error shows up as "jj interdiff failed"
    if (!opts.from && !opts.to) throw new Error('--interdiff needs -f, -t, or both')
  }
  if (vcs === 'jj') {
    if (opts.from || opts.to || !opts.revisions) {
      // With no range flags at all, --from defaults to a GitHub-PR-style diff
      // from the fork point of trunk and @. Same output as `-r 'trunk()..@'`
      // for a linear branch, but still works after trunk has been merged into
      // the branch, where jj rejects `trunk()..@` ("Cannot diff revsets with
      // gaps in"). fork_point() requires jj >= 0.24
      // (https://github.com/jj-vcs/jj/releases/tag/v0.24.0).
      const from = opts.from ?? (opts.to ? undefined : 'fork_point(trunk() | @)')
      const displayArgs: string[] = []
      if (from) displayArgs.push('--from', from)
      if (opts.to) displayArgs.push('--to', opts.to)
      return {
        vcs,
        // jj defaults both --from and --to to @
        range: {
          kind: opts.interdiff ? 'interdiff' : 'fromTo',
          from: from ?? '@',
          to: opts.to ?? '@',
        },
        toWorkingCopy: !opts.to || opts.to === '@',
        files,
        displayArgs,
      }
    }
    const rev = opts.revisions
    const parsed = parseRange(rev)
    const range: JjRange = parsed
      ? { kind: 'range', ...parsed }
      : rev.includes('..')
        ? { kind: 'opaque', args: ['-r', rev] }
        : { kind: 'single', rev }
    return {
      vcs,
      range,
      toWorkingCopy: rev === '@' || rev.endsWith('..@'),
      files,
      displayArgs: ['-r', rev],
    }
  }

  const spec = (range: GitRange, displayArgs: string[]): DiffSpec => ({
    vcs,
    range,
    // An opaque range always has a `..` in it, so it ends at a commit.
    toWorkingCopy:
      range.kind === 'mergeBase' || (range.kind === 'fromTo' && range.to === 'workingCopy'),
    files,
    displayArgs,
  })
  if (opts.from || opts.to) {
    // Explicit --to: commit-to-commit diff. --from only: `git diff <from>`
    // ends at the working tree.
    const from = opts.from ?? 'HEAD'
    return opts.to
      ? spec({ kind: 'fromTo', from, to: { rev: opts.to } }, [from, opts.to])
      : spec({ kind: 'fromTo', from, to: 'workingCopy' }, [from])
  }
  if (!opts.revisions) {
    // Default: the git translation of the jj default — diff the working tree
    // against the branch's fork point from trunk (the merge base of the base
    // and HEAD). Using the merge base keeps upstream commits the branch
    // doesn't have from showing up as reversions, and ending at the working
    // tree means review comments work out of the box. resolveDiff runs `git
    // merge-base` itself rather than `git diff --merge-base <base>`, which
    // gives a sha to pin hunk expansion to and avoids --merge-base's hard
    // error when there are multiple merge bases.
    const base = findGitBase()
    return spec({ kind: 'mergeBase', with: base }, ['--merge-base', base])
  }
  const rev = opts.revisions
  const parsed = parseRange(rev)
  // `git diff A..B` is `git diff A B`, and a single ref diffs against the
  // working tree.
  if (parsed) {
    return spec({ kind: 'fromTo', from: parsed.left, to: { rev: parsed.right } }, [rev])
  }
  if (!rev.includes('..'))
    return spec({ kind: 'fromTo', from: rev, to: 'workingCopy' }, [rev])
  return spec({ kind: 'opaque', args: [rev] }, [rev])
}

/** Run a command and return its trimmed stdout, throwing on a nonzero exit. */
async function capture(cmd: string, args: string[], what: string): Promise<string> {
  const { stdout, stderr, code } = await run(cmd, args)
  if (code !== 0) {
    throw new Error(`Could not resolve ${what} (${cmd} exit ${code}): ${stderr.trim()}`)
  }
  return stdout.trim()
}

/** Peeled to a tree, since a git diff compares trees and its ends can be bare
 *  trees (`-f <empty tree>`), not only commits. */
const gitTree = async (rev: string): Promise<RevisionId> =>
  (await capture(
    'git',
    ['rev-parse', '--verify', `${rev}^{tree}`],
    `'${rev}'`,
  )) as RevisionId

/** The commits `rev` names. Only the first jj command of a request snapshots
 *  the working copy, so every later one sees the same `@`. */
async function jjCommits(rev: string, snapshot: boolean): Promise<RevisionId[]> {
  const out = await capture(
    'jj',
    [
      ...(snapshot ? [] : ['--ignore-working-copy']),
      'log',
      '--no-graph',
      '-r',
      rev,
      '-T',
      'commit_id ++ "\\n"',
    ],
    `'${rev}'`,
  )
  return out.split('\n').filter(Boolean) as RevisionId[]
}

async function jjCommit(rev: string, snapshot: boolean): Promise<RevisionId> {
  const ids = await jjCommits(rev, snapshot)
  if (ids.length !== 1) {
    throw new Error(`Could not resolve '${rev}': it names ${ids.length} revisions, not one`)
  }
  return ids[0]!
}

/** Resolve a spec's revs to fixed revisions, and build the diff args from
 *  those, so the patch and later hunk expansion read the same revisions. */
export async function resolveDiff(spec: DiffSpec): Promise<ResolvedDiff> {
  const { vcs, files } = spec
  if (spec.vcs === 'git') {
    const { range } = spec
    switch (range.kind) {
      case 'mergeBase': {
        const left = (await capture(
          'git',
          ['merge-base', range.with, 'HEAD'],
          `the merge base of ${range.with} and HEAD`,
        )) as RevisionId
        return {
          vcs,
          interdiff: false,
          files,
          args: [left],
          snapshot: { left, right: 'workingCopy' },
        }
      }
      case 'fromTo': {
        const { from, to } = range
        const [left, right] = await Promise.all([
          gitTree(from),
          to === 'workingCopy' ? to : gitTree(to.rev),
        ])
        const args = right === 'workingCopy' ? [left] : [left, right]
        return { vcs, interdiff: false, files, args, snapshot: { left, right } }
      }
      case 'opaque':
        return { vcs, interdiff: false, files, args: range.args, snapshot: null }
    }
  }
  const { range } = spec
  // The commits are resolved, and the first resolve snapshotted the working
  // copy, so the diff mustn't snapshot again and move @ past them.
  const pinned = '--ignore-working-copy'
  switch (range.kind) {
    case 'fromTo': {
      const right = await jjCommit(range.to, true)
      const left = await jjCommit(range.from, false)
      return {
        vcs,
        interdiff: false,
        files,
        args: [pinned, '--from', left, '--to', right],
        snapshot: { left, right },
      }
    }
    case 'interdiff': {
      const right = await jjCommit(range.to, true)
      const left = await jjCommit(range.from, false)
      // An interdiff's left side is --from rebased onto --to's parents, which
      // isn't a revision `jj file show` can read, so there's no hunk
      // expansion. Rebuilding the left file by applying the file's patch in
      // reverse to the right one would make it work.
      return {
        vcs,
        interdiff: true,
        files,
        args: [pinned, '--from', left, '--to', right],
        snapshot: null,
      }
    }
    case 'range': {
      const right = await jjCommit(range.right, true)
      const left = await jjCommit(range.left, false)
      return {
        vcs,
        interdiff: false,
        files,
        args: [pinned, '-r', `${left}..${right}`],
        snapshot: { left, right },
      }
    }
    case 'single': {
      const right = await jjCommit(range.rev, true)
      // A merge has several parents, so no single left side to expand from.
      const parents = await jjCommits(`${right}-`, false)
      return {
        vcs,
        interdiff: false,
        files,
        args: [pinned, '-r', right],
        snapshot: parents.length === 1 ? { left: parents[0]!, right } : null,
      }
    }
    case 'opaque':
      return { vcs, interdiff: false, files, args: range.args, snapshot: null }
  }
}
