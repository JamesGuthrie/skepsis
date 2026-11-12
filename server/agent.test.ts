/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { detectAgent, sendToAgent } from './agent.ts'
import type { AgentSession, CodexThreadId, SocketPath } from './agent.ts'

const dir = await mkdtemp(join(tmpdir(), 'skepsis-agent-'))

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('detectAgent', () => {
  it.each([
    [{}, { kind: 'noSession' }],
    [
      { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc.sock' },
      { kind: 'claudeCode', socket: '/tmp/cc.sock' },
    ],
    [{ CODEX_THREAD_ID: 't1' }, { kind: 'codex', thread: 't1' }],
    [
      { CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc.sock', CODEX_THREAD_ID: 't1' },
      { kind: 'ambiguous' },
    ],
    [
      { CLAUDE_CODE_MESSAGING_SOCKET: '', CODEX_THREAD_ID: 't1' },
      { kind: 'codex', thread: 't1' },
    ],
    [{ CLAUDE_CODE_MESSAGING_SOCKET: '', CODEX_THREAD_ID: '' }, { kind: 'noSession' }],
  ])('%j', (env, expected) => {
    expect(detectAgent(env)).toEqual(expected)
  })
})

const opts = { cwd: dir, env: { SKEPSIS_URL: 'http://localhost:1', SKEPSIS_ROOT: dir } }

const prompt = 'Review comment on "a.ts":\n\nwhy $(rm -rf x) and `this`? ça va'

describe('sendToAgent with Claude Code', () => {
  /** A socket server that collects what each connection sends. `onConnection`
   *  replaces the default of reading to the end. */
  async function listen(onConnection?: (conn: Socket) => void) {
    const socket = join(dir, `cc-${Math.random().toString(36).slice(2)}.sock`) as SocketPath
    const received: Promise<string>[] = []
    const server: Server = createServer((conn) => {
      if (onConnection) return onConnection(conn)
      received.push(
        new Promise((resolve) => {
          let data = ''
          conn.on('data', (d: Buffer) => (data += d.toString()))
          conn.on('end', () => resolve(data))
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    const session: AgentSession = { kind: 'claudeCode', socket }
    return { session, received, close: () => server.close() }
  }

  it('writes the prompt as one user message line', async () => {
    const { session, received, close } = await listen()
    expect(await sendToAgent(session, prompt, opts)).toEqual({ ok: true, output: '' })
    await expect.poll(() => received.length).toBe(1)
    const data = await received[0]!
    expect(data.endsWith('\n')).toBe(true)
    expect(data.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(data)).toEqual({
      type: 'user',
      message: { role: 'user', content: prompt },
    })
    close()
  })

  it('names the socket when there is no session there', async () => {
    const socket = join(dir, 'missing.sock') as SocketPath
    const r = await sendToAgent({ kind: 'claudeCode', socket }, prompt, opts)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toContain(socket)
  })

  it('gives up on a session that never takes the message', async () => {
    const conns: Socket[] = []
    const { session, close } = await listen((conn) => {
      conn.pause()
      conns.push(conn)
    })
    // More than the socket buffers hold, so the write can't flush unread.
    const big = 'x'.repeat(16 * 1024 * 1024)
    const r = await sendToAgent(session, big, { ...opts, timeoutMs: 200 })
    expect(r).toEqual({
      ok: false,
      error: "Claude Code didn't take the comment within 0.2 s",
    })
    for (const c of conns) c.destroy()
    close()
  })
})

describe('sendToAgent with Codex', () => {
  /** A fake `codex` first on PATH that records its argv, cwd and SKEPSIS_*
   *  variables, then writes `stderr` and exits with `code` */
  async function fakeCodex({ code = 0, stderr = '' } = {}) {
    const bin = await mkdtemp(join(dir, 'bin-'))
    const out = join(bin, 'out.json')
    await writeFile(
      join(bin, 'codex'),
      `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  url: process.env.SKEPSIS_URL,
  root: process.env.SKEPSIS_ROOT,
}))
process.stderr.write(${JSON.stringify(stderr)})
process.exit(${code})
`,
    )
    await chmod(join(bin, 'codex'), 0o755)
    const env = { ...opts.env, PATH: `${bin}:${process.env['PATH']}` }
    const recorded = async () =>
      JSON.parse(await readFile(out, 'utf8')) as {
        argv: string[]
        cwd: string
        url: string
        root: string
      }
    return { runOpts: { ...opts, env }, recorded }
  }

  const session: AgentSession = { kind: 'codex', thread: 'thread-1' as CodexThreadId }

  it('queues the prompt on the thread as one argument', async () => {
    const { runOpts, recorded } = await fakeCodex()
    expect(await sendToAgent(session, prompt, runOpts)).toEqual({ ok: true, output: '' })
    const r = await recorded()
    expect(r.argv).toEqual(['queue', '--thread', 'thread-1', '--message', prompt])
    expect(r.cwd).toBe(await realpath(dir))
    expect(r.url).toBe('http://localhost:1')
    expect(r.root).toBe(dir)
  })

  it('reports stderr when codex fails', async () => {
    const { runOpts } = await fakeCodex({ code: 1, stderr: 'no such thread\n' })
    expect(await sendToAgent(session, prompt, runOpts)).toEqual({
      ok: false,
      error: 'no such thread',
    })
  })
})
