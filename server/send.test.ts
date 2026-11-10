/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CommentId,
  DiffResponse,
  ErrorResponse,
  SendRequest,
  ThreadsResponse,
} from '../shared/types.ts'
import { REPLY_TOKEN_HEADER, TOKEN_HEADER } from '../shared/types.ts'
import type { DiffSpec } from './diffSource.ts'
import { isolateVcsConfig } from './testUtil.ts'
import { buildPayload, renderPrompt, runSend } from './send.ts'
import type { SendPayload } from './send.ts'
import type { ReplyToken } from './reply.ts'
import type * as DiffModule from './diff.ts'

// getDiff is mocked so the routes don't need a repo.
const getDiff = vi.hoisted(() => vi.fn())
vi.mock('./diff.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof DiffModule>()),
  getDiff,
}))

// See main.test.ts: HOME must be isolated before main.ts loads.
const home = await isolateVcsConfig()
const { startServer } = await import('./main.ts')
const dir = await mkdtemp(join(tmpdir(), 'skepsis-send-'))

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
  lines: [42, 45],
  columns: null,
  code: [{ lines: [41, 46], text: 'const a = 1\nconst b = 2' }],
  blob: 'abc123',
  text: 'why two?',
}

const payload = (input: Partial<SendRequest> = {}, followUp = false): SendPayload =>
  buildPayload(
    jj,
    '/repo',
    { ...comment, ...input },
    { id: 'c1' as CommentId, followUp },
    null,
  )

const replies = {
  server: 'http://localhost:4000',
  token: 'secret' as ReplyToken,
  skepsis: ['/usr/bin/node', '/opt/my tools/cli.js'],
}

const replyingPayload = (followUp = false, id = 'c1'): SendPayload =>
  buildPayload(jj, '/repo', comment, { id: id as CommentId, followUp }, replies)

describe('renderPrompt', () => {
  it('names the file, the lines, the side and the diff, then the code and text', () => {
    expect(payload().prompt).toBe(
      'Review comment on src/a.ts, lines 42–45 (new side of `jj diff -r @-`), in lines 41–46:\n\n' +
        '```\nconst a = 1\nconst b = 2\n```\n\nwhy two?',
    )
  })

  it('says one line and the old side for a deletion', () => {
    const p = payload({
      side: 'deletions',
      lines: [7, 7],
      code: [{ lines: [7, 7], text: 'x' }],
    })
    expect(p.prompt).toMatch(
      /^Review comment on src\/a\.ts, line 7 \(old side of `jj diff -r @-`\), in line 7:/,
    )
  })

  it('fences code that has its own fences', () => {
    const p = payload({ code: [{ lines: [1, 1], text: 'say ```hi```' }] })
    expect(p.prompt).toContain('\n````\nsay ```hi```\n````\n')
  })

  it('shows each run of an excerpt with a gap between', () => {
    const p = payload({
      lines: [10, 50],
      code: [
        { lines: [8, 13], text: 'a' },
        { lines: [47, 52], text: 'b' },
      ],
    })
    expect(p.prompt).toBe(
      'Review comment on src/a.ts, lines 10–50 (new side of `jj diff -r @-`), in lines 8–13 and lines 47–52:\n\n' +
        '```\na\n```\n\n```\nb\n```\n\nwhy two?',
    )
  })

  it('marks the selected text in the excerpt', () => {
    const p = payload({
      lines: [2, 2],
      columns: [6, 11],
      code: [{ lines: [1, 3], text: 'one\nthe quick fox\nthree' }],
    })
    expect(p.prompt).toBe(
      'Review comment on src/a.ts, line 2 (new side of `jj diff -r @-`), on the text between ⟦ and ⟧, in lines 1–3:\n\n' +
        '```\none\nthe qu⟦ick f⟧ox\nthree\n```\n\nwhy two?',
    )
  })

  it('marks a selection that spans lines and runs', () => {
    const p = payload({
      lines: [2, 9],
      columns: [1, 2],
      code: [
        { lines: [1, 3], text: 'aa\nbb\ncc' },
        { lines: [8, 10], text: 'dd\nee\nff' },
      ],
    })
    expect(p.prompt).toContain('```\naa\nb⟦b\ncc\n```\n\n```\ndd\nee⟧\nff\n```')
  })

  it('handles a comment with no anchor', () => {
    const p = payload({ file: null, side: null, lines: null, code: null })
    expect(p.prompt).toBe('Review comment on `jj diff -r @-`:\n\nwhy two?')
  })

  it('names a follow-up as one, without the excerpt', () => {
    expect(payload({ text: 'and this?' }, true).prompt).toBe(
      'Follow-up on the review comment on src/a.ts, lines 42–45 (new side of `jj diff -r @-`):\n\nand this?',
    )
    expect(payload({ file: null, side: null, lines: null, code: null }, true).prompt).toBe(
      'Follow-up on the review comment on `jj diff -r @-`:\n\nwhy two?',
    )
  })

  it('is the same function the payload uses', () => {
    const { prompt, ...rest } = payload()
    expect(renderPrompt(rest)).toBe(prompt)
    const { prompt: replying, ...replyingRest } = replyingPayload()
    expect(renderPrompt(replyingRest)).toBe(replying)
  })

  it('says nothing about replying without --replies', () => {
    const p = payload()
    expect(p.reply).toBe(null)
    expect(p.prompt).not.toMatch(/--reply|reply token|review page/)
  })

  it('ends with the reply command and how to write the reply', () => {
    const { prompt, reply } = replyingPayload()
    const command =
      "/usr/bin/node '/opt/my tools/cli.js' --reply c1 --server http://localhost:4000 --token secret"
    expect(reply).toEqual({ server: 'http://localhost:4000', token: 'secret', command })
    expect(prompt.startsWith(payload().prompt + '\n\n')).toBe(true)
    expect(prompt).toContain(`${command} - <<'EOF'\n<your reply>\nEOF`)
    expect(prompt).toMatch(/one to three short sentences of plain text/)
    expect(prompt).toMatch(/doesn't render Markdown/)
  })

  it("answers a follow-up on the thread's id", () => {
    const p = replyingPayload(true, 'c7')
    expect(p.reply!.command).toContain('--reply c7 ')
    expect(p.prompt).toMatch(/^Follow-up on the review comment/)
  })
})

describe('buildPayload', () => {
  it('carries the contract fields', () => {
    const { prompt: _, ...rest } = payload()
    expect(rest).toEqual({
      version: 1,
      comment_id: 'c1',
      follow_up: false,
      root: '/repo',
      diff: { command: 'jj diff -r @-', toWorkingCopy: false },
      file: 'src/a.ts',
      side: 'additions',
      lines: [42, 45],
      columns: null,
      code: [{ lines: [41, 46], text: 'const a = 1\nconst b = 2' }],
      blob: 'abc123',
      text: 'why two?',
      reply: null,
    })
  })
})

describe('runSend', () => {
  const opts = { cwd: dir, env: { SKEPSIS_URL: 'http://localhost:1', SKEPSIS_ROOT: dir } }

  it('pipes the payload as JSON and reports stdout', async () => {
    const out = join(dir, 'stdin.json')
    const result = await runSend(`cat > ${out}; echo sent; echo more`, payload(), opts)
    expect(result).toEqual({ ok: true, output: 'sent\nmore' })
    expect(JSON.parse(await readFile(out, 'utf8'))).toEqual(payload())
  })

  it('runs in cwd with SKEPSIS_URL and SKEPSIS_ROOT set', async () => {
    const result = await runSend('echo "$PWD $SKEPSIS_URL $SKEPSIS_ROOT"', payload(), opts)
    expect(result).toEqual({
      ok: true,
      output: `${await realpath(dir)} http://localhost:1 ${dir}`,
    })
  })

  it('reports stderr on a nonzero exit, or the status without any', async () => {
    expect(await runSend('echo nope >&2; exit 1', payload(), opts)).toEqual({
      ok: false,
      error: 'nope',
    })
    expect(await runSend('exit 3', payload(), opts)).toEqual({
      ok: false,
      error: '--send command exited with 3',
    })
  })

  it('kills a command that runs past the timeout, with what it started', async () => {
    const start = Date.now()
    const result = await runSend('sleep 30', payload(), { ...opts, timeoutMs: 200 })
    expect(result).toEqual({ ok: false, error: '--send command timed out after 0.2 s' })
    expect(Date.now() - start).toBeLessThan(5000)
  })

  it('caps output', async () => {
    const result = await runSend('head -c 100000 /dev/zero | tr "\\0" x', payload(), {
      ...opts,
      maxOutput: 1000,
    })
    expect(result.ok && result.output.length).toBe(1000)
  })

  it("doesn't mind a command that ignores stdin", async () => {
    expect(await runSend('true', payload(), opts)).toEqual({ ok: true, output: '' })
  })
})

const post = (
  url: string,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  fetch(`${url}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token, ...headers },
    body: JSON.stringify(body),
  })

describe('/api/send', () => {
  beforeEach(() => {
    getDiff.mockReset()
    getDiff.mockResolvedValue({
      patch: 'diff --git a/src/a.ts b/src/a.ts\nindex a1d0001..fe0002 100644\n',
      fileHashes: { 'src/a.ts': 'fe0002' },
    })
  })

  async function serve(command: string | null) {
    const { port, token, close } = await startServer({
      diffSource: jj,
      cwd: dir,
      send: command === null ? null : { command, replies: null },
    })
    return { url: `http://localhost:${port}`, token, close }
  }

  it("doesn't exist without --send", async () => {
    const { url, token, close } = await serve(null)
    expect((await post(url, token, comment)).status).toBe(404)
    const diff = (await (
      await fetch(`${url}/api/diff`, { headers: { [TOKEN_HEADER]: token } })
    ).json()) as { send: unknown }
    expect(diff.send).toBe(null)
    close()
  })

  it("sends the page's blob, even once the file has changed", async () => {
    // The server's diff has moved on to fe0002, but the lines and excerpt
    // come from the version the page shows.
    const out = join(dir, 'route.json')
    const { url, token, close } = await serve(`cat > ${out}`)
    const res = await post(url, token, comment)
    expect(res.status).toBe(200)
    const sent = JSON.parse(await readFile(out, 'utf8')) as SendPayload
    expect(sent.blob).toBe('abc123')
    expect(sent.text).toBe('why two?')
    expect((await post(url, token, { ...comment, blob: 'not a blob' })).status).toBe(400)
    close()
  })

  it('reports a failed command as an error', async () => {
    const { url, token, close } = await serve('echo "no agent" >&2; exit 1')
    const res = await post(url, token, comment)
    expect(res.status).toBe(502)
    expect(((await res.json()) as ErrorResponse).error).toBe('no agent')
    close()
  })

  it('turns away other origins and hosts', async () => {
    const { url, token, close } = await serve('true')
    const { port } = new URL(url)
    expect(
      (await post(url, token, comment, { Origin: 'http://localhost:9999' })).status,
    ).toBe(403)
    // undici won't let a request set Host, so check that one through the gate
    // test; same-origin requests from the page pass.
    expect(
      (await post(url, token, comment, { Origin: `http://localhost:${port}` })).status,
    ).toBe(200)
    close()
  })

  it('runs sends one at a time, in order', async () => {
    const log = join(dir, 'order.log')
    // The first send is the slow one, so without the queue it would finish last.
    const { url, token, close } = await serve(
      `t=$(grep -o '"text":"[a-z]*"' | cut -d '"' -f 4); [ "$t" = one ] && sleep 0.3; echo "$t" >> ${log}`,
    )
    const first = post(url, token, { ...comment, text: 'one' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = post(url, token, { ...comment, text: 'two' })
    await Promise.all([first, second])
    expect(await readFile(log, 'utf8')).toBe('one\ntwo\n')
    close()
  })
})

const followUp = (url: string, token: string, id: string, text: string) =>
  fetch(`${url}/api/threads/${id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [TOKEN_HEADER]: token },
    body: JSON.stringify({ text }),
  })

const listThreads = async (url: string, token: string) =>
  (
    (await (
      await fetch(`${url}/api/threads`, { headers: { [TOKEN_HEADER]: token } })
    ).json()) as ThreadsResponse
  ).threads

const agentReply = (
  url: string,
  replyToken: string | undefined,
  id: string,
  text: string,
  headers: Record<string, string> = {},
) =>
  fetch(`${url}/api/threads/${id}/replies`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(replyToken === undefined ? {} : { [REPLY_TOKEN_HEADER]: replyToken }),
      ...headers,
    },
    body: JSON.stringify({ text }),
  })

const diffSend = async (url: string, token: string) =>
  (
    (await (
      await fetch(`${url}/api/diff`, { headers: { [TOKEN_HEADER]: token } })
    ).json()) as DiffResponse
  ).send

describe('threads', () => {
  beforeEach(() => {
    getDiff.mockReset()
    getDiff.mockResolvedValue({ patch: '', fileHashes: {} })
  })

  /** A server whose --send command appends each payload to a file, and the
   *  reply token from the first payload once something has been sent. */
  async function serve({
    withReplies = true,
    command,
  }: { withReplies?: boolean; command?: string } = {}) {
    const out = join(dir, `sent-${Math.random().toString(36).slice(2)}.jsonl`)
    const { port, token, close } = await startServer({
      diffSource: jj,
      cwd: dir,
      send: {
        command: command ?? `cat >> ${out}`,
        replies: withReplies ? { skepsis: ['skepsis'] } : null,
      },
    })
    const sent = async () =>
      (await readFile(out, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as SendPayload)
    const replyToken = async () => (await sent())[0]!.reply!.token
    return { url: `http://localhost:${port}`, token, close, sent, replyToken }
  }

  it('only takes replies with --replies, and tells the page so', async () => {
    const without = await serve({ withReplies: false })
    await post(without.url, without.token, comment)
    expect((await without.sent())[0]!.reply).toBe(null)
    expect(await diffSend(without.url, without.token)).toEqual({ replies: false })
    expect(
      (
        await agentReply(without.url, undefined, 'c1', 'hi', {
          [TOKEN_HEADER]: without.token,
        })
      ).status,
    ).toBe(404)
    without.close()

    const withReplies = await serve()
    expect(await diffSend(withReplies.url, withReplies.token)).toEqual({ replies: true })
    withReplies.close()
  })

  it('makes a thread per send, with a new id each', async () => {
    const { url, token, close, sent } = await serve()
    expect((await post(url, token, comment)).status).toBe(200)
    expect((await post(url, token, { ...comment, text: 'again' })).status).toBe(200)
    expect((await sent()).map((p) => [p.comment_id, p.follow_up, p.text])).toEqual([
      ['c1', false, 'why two?'],
      ['c2', false, 'again'],
    ])
    expect((await listThreads(url, token)).map((t) => t.id)).toEqual(['c1', 'c2'])
    close()
  })

  it('keeps replies and follow-ups in the order they arrived', async () => {
    const { url, token, close, replyToken } = await serve()
    await post(url, token, comment)
    const rt = await replyToken()
    expect((await agentReply(url, rt, 'c1', 'because')).status).toBe(200)
    expect((await followUp(url, token, 'c1', 'why though?')).status).toBe(200)
    expect((await agentReply(url, rt, 'c1', 'it reads better')).status).toBe(200)
    const [thread] = await listThreads(url, token)
    expect(thread).toMatchObject({
      id: 'c1',
      anchor: { file: 'src/a.ts', side: 'additions', lines: [42, 45] },
      text: 'why two?',
    })
    expect(thread!.messages.map(({ from, text }) => [from, text])).toEqual([
      ['agent', 'because'],
      ['reviewer', 'why though?'],
      ['agent', 'it reads better'],
    ])
    close()
  })

  it("sends a follow-up under the thread's id and anchor, with the same token", async () => {
    const { url, token, close, sent } = await serve()
    await post(url, token, comment)
    await followUp(url, token, 'c1', 'and here?')
    const [first, second] = await sent()
    expect(second).toMatchObject({
      comment_id: 'c1',
      follow_up: true,
      file: 'src/a.ts',
      lines: [42, 45],
      text: 'and here?',
    })
    expect(second!.reply!.token).toBe(first!.reply!.token)
    close()
  })

  it('takes a reply only with the reply token', async () => {
    const { url, token, close, replyToken } = await serve()
    await post(url, token, comment)
    expect((await agentReply(url, undefined, 'c1', 'hi')).status).toBe(403)
    expect((await agentReply(url, 'wrong', 'c1', 'hi')).status).toBe(403)
    // The page's token isn't enough: replies are the agent's.
    expect(
      (await agentReply(url, undefined, 'c1', 'hi', { [TOKEN_HEADER]: token })).status,
    ).toBe(403)
    expect((await agentReply(url, token, 'c1', 'hi')).status).toBe(403)
    expect((await listThreads(url, token))[0]!.messages).toEqual([])
    // And the reply token opens nothing else.
    const rt = await replyToken()
    const asAgent = { [REPLY_TOKEN_HEADER]: rt }
    expect((await fetch(`${url}/api/diff`, { headers: asAgent })).status).toBe(401)
    expect((await fetch(`${url}/api/threads`, { headers: asAgent })).status).toBe(401)
    const send = await fetch(`${url}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...asAgent },
      body: JSON.stringify(comment),
    })
    expect(send.status).toBe(401)
    close()
  })

  it('turns away a reply from another origin', async () => {
    const { url, token, close, replyToken } = await serve()
    await post(url, token, comment)
    const rt = await replyToken()
    expect(
      (await agentReply(url, rt, 'c1', 'hi', { Origin: 'http://evil.example' })).status,
    ).toBe(403)
    close()
  })

  it('turns away a reply or follow-up to an unknown comment', async () => {
    const { url, token, close, sent, replyToken } = await serve()
    await post(url, token, comment)
    const rt = await replyToken()
    const res = await agentReply(url, rt, 'c9', 'hello')
    expect(res.status).toBe(404)
    expect(((await res.json()) as ErrorResponse).error).toMatch(/^No comment c9/)
    expect((await followUp(url, token, 'c9', 'hello')).status).toBe(404)
    expect(await sent()).toHaveLength(1)
    expect((await listThreads(url, token))[0]!.messages).toEqual([])
    close()
  })

  it('opens no thread when the command fails', async () => {
    const { url, token, close } = await serve({ command: 'exit 1' })
    expect((await post(url, token, comment)).status).toBe(502)
    expect(await listThreads(url, token)).toEqual([])
    close()
  })

  it('dismisses a thread', async () => {
    const { url, token, close, replyToken } = await serve()
    await post(url, token, comment)
    const del = await fetch(`${url}/api/threads/c1`, {
      method: 'DELETE',
      headers: { [TOKEN_HEADER]: token },
    })
    expect(del.status).toBe(200)
    expect(await listThreads(url, token)).toEqual([])
    expect((await agentReply(url, await replyToken(), 'c1', 'too late')).status).toBe(404)
    close()
  })
})
