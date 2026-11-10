/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { RevisionId, FileContentsResponse, Snapshot } from '../shared/types.ts'

/**
 * Run a command and return stdout, or null if it exits nonzero. A nonzero exit
 * is the normal signal that a path does not exist at a given revision (an added
 * or deleted file), so it's not treated as an error.
 */
function tryRun(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    const stdout: Buffer[] = []
    proc.stdout.on('data', (d) => stdout.push(d))
    proc.stderr.on('data', () => {})
    proc.on('error', reject)
    proc.on('close', (code) =>
      resolve(code === 0 ? Buffer.concat(stdout).toString() : null),
    )
  })
}

/** Fetch a file's contents at the snapshot's left revision. */
function fetchOld(
  vcs: 'jj' | 'git',
  left: RevisionId,
  oldPath: string,
): Promise<string | null> {
  return vcs === 'jj'
    ? tryRun('jj', ['--ignore-working-copy', 'file', 'show', '-r', left, '--', oldPath])
    : tryRun('git', ['show', `${left}:${oldPath}`])
}

/** Fetch a file's contents at the snapshot's right revision, or from disk when
 *  the diff ends at the working tree. */
async function fetchNew(
  vcs: 'jj' | 'git',
  right: Snapshot['right'],
  path: string,
  cwd: string,
): Promise<string | null> {
  if (right === 'workingCopy') {
    const abs = join(cwd, path)
    const stat = await lstat(abs).catch(() => null)
    if (stat?.isSymbolicLink()) {
      return readlink(abs).catch(() => null)
    }
    return readFile(abs, 'utf-8').catch(() => null)
  }
  return vcs === 'jj'
    ? tryRun('jj', ['--ignore-working-copy', 'file', 'show', '-r', right, '--', path])
    : tryRun('git', ['show', `${right}:${path}`])
}

/**
 * Full file contents at both ends of a diff snapshot, used by the client to
 * build a non-partial diff that supports hunk expansion. `oldPath` differs
 * from `path` for renamed files (the old-side path).
 */
export async function getFileContents(
  vcs: 'jj' | 'git',
  cwd: string,
  snapshot: Snapshot,
  path: string,
  oldPath?: string,
): Promise<FileContentsResponse> {
  const [oldContents, newContents] = await Promise.all([
    fetchOld(vcs, snapshot.left, oldPath ?? path),
    fetchNew(vcs, snapshot.right, path, cwd),
  ])
  return { oldContents, newContents }
}
