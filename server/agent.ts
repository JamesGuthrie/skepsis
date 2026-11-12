/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

// --agent-session: send comments to the coding agent session skepsis runs
// in. The harness tells the commands it runs how to reach the session
// through the environment, so skepsis has to be started by the agent.

import { createConnection } from 'node:net'
import { runProcess } from './send.ts'
import type { RunOptions, SendResult } from './send.ts'

export type SocketPath = string & { readonly __brand: 'SocketPath' }
export type CodexThreadId = string & { readonly __brand: 'CodexThreadId' }

export type AgentSession =
  | { kind: 'claudeCode'; socket: SocketPath }
  | { kind: 'codex'; thread: CodexThreadId }

export type DetectError = { kind: 'noSession' } | { kind: 'ambiguous' }

export const CLAUDE_CODE_SOCKET_VAR = 'CLAUDE_CODE_MESSAGING_SOCKET'
export const CODEX_THREAD_VAR = 'CODEX_THREAD_ID'

/** The session `env` points at. Both set means one agent runs inside the
 *  other, and the environment can't say which one started skepsis. */
export function detectAgent(
  env: Record<string, string | undefined>,
): AgentSession | DetectError {
  const socket = env[CLAUDE_CODE_SOCKET_VAR] || null
  const thread = env[CODEX_THREAD_VAR] || null
  if (socket && thread) return { kind: 'ambiguous' }
  if (socket) return { kind: 'claudeCode', socket: socket as SocketPath }
  if (thread) return { kind: 'codex', thread: thread as CodexThreadId }
  return { kind: 'noSession' }
}

export function agentName(session: AgentSession): string {
  switch (session.kind) {
    case 'claudeCode':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
  }
}

const TIMEOUT_MS = 10_000

export function sendToAgent(
  session: AgentSession,
  prompt: string,
  opts: RunOptions,
): Promise<SendResult> {
  switch (session.kind) {
    case 'claudeCode':
      return sendToClaudeCode(session.socket, prompt, opts.timeoutMs ?? TIMEOUT_MS)
    case 'codex':
      return runProcess(
        ['codex', 'queue', '--thread', session.thread, '--message', prompt],
        '',
        'codex queue',
        opts,
      )
  }
}

/** Write the prompt to the session's socket as a user message. Delivered
 *  means flushed to the socket: the session doesn't answer on it. */
function sendToClaudeCode(
  socket: SocketPath,
  prompt: string,
  timeoutMs: number,
): Promise<SendResult> {
  const message = { type: 'user', message: { role: 'user', content: prompt } }
  return new Promise((resolve) => {
    const conn = createConnection(socket)
    const timer = setTimeout(() => {
      conn.destroy()
      resolve({
        ok: false,
        error: `Claude Code didn't take the comment within ${timeoutMs / 1000} s`,
      })
    }, timeoutMs)
    conn.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        error: `Can't reach the Claude Code session at ${socket}: ${err.message}`,
      })
    })
    conn.end(JSON.stringify(message) + '\n', () => {
      clearTimeout(timer)
      conn.destroy()
      resolve({ ok: true, output: '' })
    })
  })
}
