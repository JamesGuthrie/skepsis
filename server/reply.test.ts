/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendRequest, ThreadsResponse } from '../shared/types.ts'
import { TOKEN_HEADER } from '../shared/types.ts'
import type { DiffSpec } from './diffSource.ts'
import { isolateVcsConfig } from './testUtil.ts'
import { postReply } from './reply.ts'
import type { ReplyAccess, ReplyToken } from './reply.ts'
import type { SendPayload } from './send.ts'
import type * as DiffModule from './diff.ts'

// getDiff is mocked so the server doesn't need a repo.
const getDiff = vi.hoisted(() => vi.fn())
vi.mock('./diff.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof DiffModule>()),
  getDiff,
}))

// See main.test.ts: HOME must be isolated before main.ts loads.
const home = await isolateVcsConfig()
const { startServer } = await import('./main.ts')
const dir = await mkdtemp(join(tmpdir(), 'skepsis-reply-'))
const CLI = join(import.meta.dirname, '..', 'cli.ts')

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(dir, { recursive: true, force: true })
})

const jj: DiffSpec = {
  vcs: 'jj',
  range: { kind: 'opaque', args: ['-r', '@-'] },
  toWorkingCopy: false,
  files: [],
  displayArgs: ['-r', '@-'],
}

const comment: SendRequest = {
  file: 'src/a.ts',
  side: 'additions',
  lines: [1, 1],
  columns: null,
  code: null,
  blob: null,
  text: 'why?',
}

/** A server with --replies whose command saves the last payload, with one
 *  comment (c1) sent */
let server: {
  url: string
  token: string
  close: () => void
  payload: SendPayload
  access: ReplyAccess
}

beforeEach(async () => {
  getDiff.mockReset()
  getDiff.mockResolvedValue({ patch: '', fileHashes: {} })
  const out = join(dir, `payload-${Math.random().toString(36).slice(2)}.json`)
  const { port, token, close } = await startServer({
    diffSource: jj,
    cwd: dir,
    send: { command: `cat > ${out}`, replies: { skepsis: [process.execPath, CLI] } },
  })
  const url = `http://localhost:${port}`
  const res = await fetch(`${url}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
    body: JSON.stringify(comment),
  })
  expect(res.status).toBe(200)
  const payload = JSON.parse(await readFile(out, 'utf8')) as SendPayload
  server = {
    url,
    token,
    close,
    payload,
    access: { server: payload.reply!.server, token: payload.reply!.token },
  }
})

afterEach(() => server.close())

const messages = async () =>
  (
    (await (
      await fetch(`${server.url}/api/threads`, {
        headers: { [TOKEN_HEADER]: server.token },
      })
    ).json()) as ThreadsResponse
  ).threads[0]!.messages.map((m) => m.text)

describe('postReply', () => {
  it('posts the reply to the thread', async () => {
    expect(await postReply(server.access, 'c1', 'because')).toEqual({ ok: true })
    expect(await messages()).toEqual(['because'])
  })

  it('says why a reply failed', async () => {
    expect(
      await postReply({ ...server.access, token: 'wrong' as ReplyToken }, 'c1', 'hi'),
    ).toMatchObject({ kind: 'forbidden' })
    expect(await postReply(server.access, 'c9', 'hi')).toMatchObject({
      kind: 'unknownComment',
      message: expect.stringMatching(/^No comment c9/),
    })
    // Port 1 is privileged and unused, so nothing answers.
    expect(
      await postReply({ ...server.access, server: 'http://localhost:1' }, 'c1', 'hi'),
    ).toMatchObject({ kind: 'unreachable' })
  })
})

/** Run `sh -c command` with `stdin`, for its exit status and output */
function sh(command: string, stdin = '') {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('sh', ['-c', command], { cwd: dir })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(stdin)
  })
}

const cli = (args: string) => `'${process.execPath}' '${CLI}' ${args}`

describe('skepsis --reply', () => {
  it('runs as the comment gives it, with the text as an argument', async () => {
    const r = await sh(`${server.payload.reply!.command} 'a typo, fixed'`)
    expect(r).toEqual({ code: 0, stdout: '', stderr: '' })
    expect(await messages()).toEqual(['a typo, fixed'])
  })

  it('reads the text from stdin with -', async () => {
    const text = "It's two lines:\nthis one's the second."
    const r = await sh(`${server.payload.reply!.command} -`, `${text}\n`)
    expect(r.code).toBe(0)
    expect(await messages()).toEqual([text])
  })

  it('refuses flags that are for serving a review', async () => {
    const { server: url, token } = server.access
    const runs = await Promise.all(
      ['--send cat', '-r @', '-f main', '-t main', '--replies'].map((flags) =>
        sh(cli(`--reply c1 --server ${url} --token ${token} ${flags} hi`)),
      ),
    )
    for (const r of runs) {
      expect(r.code).toBe(1)
      expect(r.stderr).toMatch(/^--reply can't be used with/)
    }
    expect((await sh(cli('--reply c1 hi'))).stderr).toMatch(/needs --server and --token/)
    expect(await messages()).toEqual([])
  })

  it('needs --send for --replies', async () => {
    const r = await sh(`SKEPSIS_SEND= ${cli('--replies')}`)
    expect(r.code).toBe(1)
    expect(r.stderr).toMatch(/--replies needs --send/)
  })

  it('exits 1 with the error on stderr when the reply fails', async () => {
    const r = await sh(cli(`--reply c9 --server ${server.access.server} --token wrong hi`))
    expect(r.code).toBe(1)
    expect(r.stdout).toBe('')
    expect(r.stderr).toMatch(/reply token/)
  })
})
