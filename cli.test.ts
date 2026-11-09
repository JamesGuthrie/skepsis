/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { TOKEN_HEADER, type DiffResponse, type SendRequest } from './shared/types.ts'
import { exec, isolateVcsConfig, requireJj, run, startCli } from './server/testUtil.ts'

const CLI = join(import.meta.dirname, 'cli.ts')

const home = await isolateVcsConfig()

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

/** Run the CLI to completion, for arguments it rejects before starting. */
async function runCli(args: string[], cwd: string) {
  const result = await exec('node', [CLI, '--no-open', ...args], { cwd }).catch(
    (error: { code: number; stderr: string }) => error,
  )
  return { code: 'code' in result ? result.code : 0, stderr: result.stderr }
}

describe('--interdiff', () => {
  let tmp: string
  let repo: string
  let oldCommit: string
  let newCommit: string

  beforeAll(async () => {
    await requireJj()
    tmp = await mkdtemp(join(tmpdir(), 'skepsis-cli-test-'))
    await run('jj', ['git', 'init', 'repo'], tmp)
    repo = join(tmp, 'repo')
    const commitId = async (rev: string) =>
      (await run('jj', ['log', '-r', rev, '--no-graph', '-T', 'commit_id'], repo)).stdout
    // base → feature, then rebase feature onto an upstream commit and change
    // both its description and its content.
    await writeFile(join(repo, 'f.txt'), 'a\nb\nc\n')
    await writeFile(join(repo, 'up.txt'), 'x\n')
    await run('jj', ['commit', '-m', 'base'], repo)
    await writeFile(join(repo, 'f.txt'), 'a\nB\nc\n')
    await run('jj', ['describe', '-m', 'feature'], repo)
    oldCommit = await commitId('@')
    await run('jj', ['new', '@-', '-m', 'upstream'], repo)
    await writeFile(join(repo, 'up.txt'), 'x\ny\n')
    await run('jj', ['rebase', '-r', oldCommit, '-d', '@'], repo)
    await run('jj', ['edit', `children(@)`], repo)
    await run('jj', ['describe', '-m', 'feature, reworded'], repo)
    await writeFile(join(repo, 'f.txt'), 'a\nB\nc\nd\n')
    newCommit = await commitId('@')
  })

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  it('needs jj', async () => {
    const { code, stderr } = await runCli(
      ['--git', '--interdiff', '-f', 'a', '-t', 'b'],
      repo,
    )
    expect(code).toBe(1)
    expect(stderr).toContain('--interdiff needs jj')
  })

  it("can't be combined with -r", async () => {
    const { code, stderr } = await runCli(['--interdiff', '-r', '@'], repo)
    expect(code).toBe(1)
    expect(stderr).toContain("--interdiff can't be combined with -r")
  })

  it('needs -f or -t', async () => {
    const { code, stderr } = await runCli(['--interdiff'], repo)
    expect(code).toBe(1)
    expect(stderr).toContain('--interdiff needs -f, -t, or both')
  })

  /** Start the CLI with `args` and fetch its /api/diff. */
  async function fetchDiff(args: string[]): Promise<DiffResponse> {
    const { proc, url } = await startCli(repo, ['--no-poll', ...args])
    try {
      const token = new URL(url).hash.replace('#token=', '')
      const res = await fetch(new URL('/api/diff', url), {
        headers: { [TOKEN_HEADER]: token },
      })
      return (await res.json()) as DiffResponse
    } finally {
      proc.kill()
    }
  }

  it("serves the change's interdiff without upstream changes", async () => {
    const data = await fetchDiff(['--interdiff', '-f', oldCommit, '-t', newCommit])
    expect(data.revset).toBe(`jj interdiff --from ${oldCommit} --to ${newCommit}`)
    expect(Object.keys(data.fileHashes).toSorted()).toEqual([
      'JJ-COMMIT-DESCRIPTION',
      'f.txt',
    ])
    expect(data.patch).toContain('+feature, reworded')
    expect(data.patch).toContain('+d')
    expect(data.patch).not.toContain('up.txt')
    expect(data.interdiff).toBe(true)
    expect(data.expandable).toBe(false)
  })

  // -t defaults to @, which is newCommit: the diff ends at the working copy,
  // but comments stay off.
  it('keeps comments off when the interdiff ends at the working copy', async () => {
    const data = await fetchDiff(['--interdiff', '-f', oldCommit])
    expect(data.revset).toBe(`jj interdiff --from ${oldCommit}`)
    expect(Object.keys(data.fileHashes).toSorted()).toEqual([
      'JJ-COMMIT-DESCRIPTION',
      'f.txt',
    ])
    expect(data.commentsEnabled).toBe(false)
  })
})

/** Where the CLI is started from: a directory outside the repo */
let elsewhere: string
let gitRepo: string
const procs: ChildProcess[] = []

beforeAll(async () => {
  elsewhere = await realpath(await mkdtemp(join(tmpdir(), 'skepsis-cli-elsewhere-')))
  gitRepo = await realpath(await mkdtemp(join(tmpdir(), 'skepsis-cli-repo-')))
  await mkdir(join(gitRepo, 'sub'))
  await run('git', ['init', '-q', '-b', 'main'], gitRepo)
  await writeFile(join(gitRepo, 'a.ts'), 'const a = 1\n')
  await writeFile(join(gitRepo, 'sub', 'b.ts'), 'const b = 1\n')
  await run('git', ['add', '.'], gitRepo)
  await run('git', ['commit', '-qm', 'init'], gitRepo)
  await writeFile(join(gitRepo, 'a.ts'), 'const a = 2\n')
  await writeFile(join(gitRepo, 'sub', 'b.ts'), 'const b = 2\n')
})

afterEach(() => {
  for (const p of procs.splice(0)) p.kill()
})

afterAll(async () => {
  await Promise.all(
    [elsewhere, gitRepo].map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

/** Start the CLI from `elsewhere` and resolve with the server's origin and
 *  page token once it prints its startup line. */
function start(args: string[]): Promise<{ origin: string; token: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [CLI, '--git', '--no-open', ...args], {
      cwd: elsewhere,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    procs.push(proc)
    let out = ''
    let err = ''
    proc.stdout.on('data', (d: Buffer) => {
      out += d.toString()
      const m = /skepsis on (\S+)/.exec(out)
      if (m) {
        const url = new URL(m[1]!)
        resolve({
          origin: url.origin,
          token: new URLSearchParams(url.hash.slice(1)).get('token')!,
        })
      }
    })
    proc.stderr.on('data', (d: Buffer) => (err += d.toString()))
    proc.on('exit', (code) => reject(new Error(`exited with ${code}: ${err}`)))
  })
}

const diff = async ({ origin, token }: { origin: string; token: string }) =>
  (await (
    await fetch(`${origin}/api/diff`, { headers: { [TOKEN_HEADER]: token } })
  ).json()) as DiffResponse

describe('-C', () => {
  it("serves that directory's gitRepo", async () => {
    const d = await diff(await start(['-C', gitRepo]))
    expect(d.repo).toBe(basename(gitRepo))
    expect(Object.keys(d.fileHashes).toSorted()).toEqual(['a.ts', 'sub/b.ts'])
  })

  it('takes files relative to it', async () => {
    const d = await diff(await start(['-C', gitRepo, 'a.ts']))
    expect(Object.keys(d.fileHashes)).toEqual(['a.ts'])
  })

  it('runs the --send command there', async () => {
    const out = join(elsewhere, 'send.out')
    const server = await start([
      '-C',
      gitRepo,
      '--send',
      `printf '%s\\n%s\\n' "$PWD" "$SKEPSIS_ROOT" > ${out}`,
    ])
    const comment: SendRequest = {
      file: 'a.ts',
      side: 'additions',
      lines: [1, 1],
      columns: null,
      code: null,
      blob: null,
      text: 'why?',
    }
    const res = await fetch(`${server.origin}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: server.token },
      body: JSON.stringify(comment),
    })
    expect(res.status).toBe(200)
    expect(await readFile(out, 'utf8')).toBe(`${gitRepo}\n${gitRepo}\n`)
  })

  it("says what is wrong with a directory it can't use", async () => {
    const cli = (args: string[]) =>
      exec(process.execPath, [CLI, '--no-open', ...args], { cwd: elsewhere }).then(
        () => ({ code: 0, stderr: '' }),
        (e: { code: number; stderr: string }) => ({ code: e.code, stderr: e.stderr }),
      )
    expect(await cli(['-C', join(gitRepo, 'nope')])).toEqual({
      code: 1,
      stderr: `-C ${join(gitRepo, 'nope')}: no such directory\n`,
    })
    expect(await cli(['-C', join(gitRepo, 'a.ts')])).toEqual({
      code: 1,
      stderr: `-C ${join(gitRepo, 'a.ts')}: not a directory\n`,
    })
  })

  it("can't be used with --reply", async () => {
    const r = await exec(
      process.execPath,
      [
        CLI,
        '--reply',
        'c1',
        '--server',
        'http://localhost:1',
        '--token',
        't',
        '-C',
        gitRepo,
        'hi',
      ],
      { cwd: elsewhere },
    ).catch((e: { code: number; stderr: string }) => e)
    expect(r).toMatchObject({ code: 1, stderr: "--reply can't be used with -C\n" })
  })
})
