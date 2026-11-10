/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

// --send: pipe a review comment to a user-supplied shell command. The JSON on
// the command's stdin is a public contract (see the README): fields can be
// added, but removing or changing one is a major version.

import { spawn } from 'node:child_process'
import type { CommentId, SendRequest } from '../shared/types.ts'
import type { DiffSpec } from './diffSource.ts'
import { displayCommand } from './displayCommand.ts'
import { replyCommand } from './reply.ts'
import type { ReplyAccess, ReplyToken } from './reply.ts'

export interface SendPayload {
  version: 1
  /** The thread this message belongs to: the comment's own id, or for a
   *  follow-up, the id of the comment that opened the thread */
  comment_id: CommentId
  /** Whether this is the reviewer following up on an earlier comment. The
   *  anchor fields are then the opening comment's. */
  follow_up: boolean
  /** The directory skepsis runs in, which is also the command's cwd */
  root: string
  diff: {
    /** The diff command, as the page shows it */
    command: string
    /** Whether the diff ends at the working copy */
    toWorkingCopy: boolean
  }
  file: string | null
  side: 'additions' | 'deletions' | null
  /** 1-based and inclusive, in `side`'s numbering */
  lines: [number, number] | null
  /** Set when the comment is on selected text rather than whole lines: where
   *  the text starts in line `lines[0]` and ends (exclusive) in `lines[1]`,
   *  0-based, in UTF-16 code units */
  columns: [number, number] | null
  /** An excerpt of `side`: the lines commented on and a little around them,
   *  as runs of consecutive lines, each from line `lines[0]` to `lines[1]`.
   *  More than one where the diff hid lines in between. */
  code: { lines: [number, number]; text: string }[] | null
  /** The blob ID of `side`'s version of the file as the page showed it, the
   *  version `lines` number. Null where the diff has none, such as an added
   *  file's old side or a pure rename. */
  blob: string | null
  text: string
  /** How to answer this comment in the page. Null without --replies. */
  reply: {
    server: string
    token: ReplyToken
    /** Ready to run with the reply text after it, or `-` and the text on
     *  stdin */
    command: string
  } | null
  /** All of the above as plain text, for consumers that just want a message */
  prompt: string
}

export function buildPayload(
  diffSource: DiffSpec,
  root: string,
  input: SendRequest,
  thread: { id: CommentId; followUp: boolean },
  /** `skepsis` is how to run this skepsis, for the reply command */
  replies: (ReplyAccess & { skepsis: readonly string[] }) | null,
): SendPayload {
  const base = {
    version: 1 as const,
    comment_id: thread.id,
    follow_up: thread.followUp,
    root,
    diff: {
      command: displayCommand(diffSource),
      toWorkingCopy: diffSource.toWorkingCopy,
    },
    file: input.file,
    side: input.side,
    lines: input.lines,
    columns: input.columns,
    code: input.code,
    blob: input.blob,
    text: input.text,
    reply: replies && {
      server: replies.server,
      token: replies.token,
      command: replyCommand(replies.skepsis, replies, thread.id),
    },
  }
  return { ...base, prompt: renderPrompt(base) }
}

/** A fence one backtick longer than any run of backticks in `code`. */
function fence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Where the selected text starts and ends, as start-of-text and end-of-text
 *  marks put into the excerpt. */
const MARKS = ['⟦', '⟧'] as const

/** `code` with `columns` marked: the start in line `lines[0]` and the end in
 *  `lines[1]`. Null when the excerpt doesn't hold both lines. */
function markExcerpt(
  code: NonNullable<SendPayload['code']>,
  lines: [number, number],
  columns: [number, number],
): NonNullable<SendPayload['code']> | null {
  const runs = code.map((run) => ({ ...run, rows: run.text.split('\n') }))
  const points = [0, 1].map((i) => {
    const run = runs.find((r) => lines[i]! >= r.lines[0] && lines[i]! <= r.lines[1])
    return run && { run, row: lines[i]! - run.lines[0] }
  })
  if (!points[0] || !points[1]) return null
  // The end first, so a start on the same row keeps its column
  for (const i of [1, 0]) {
    const { run, row } = points[i]!
    const text = run.rows[row]!
    const col = Math.min(columns[i]!, text.length)
    run.rows[row] = text.slice(0, col) + MARKS[i] + text.slice(col)
  }
  return runs.map(({ lines: range, rows }) => ({ lines: range, text: rows.join('\n') }))
}

/** How to answer in the page, for the end of the prompt. The reviewer only
 *  sees the page, so the agent hears it with every comment. */
function replyInstructions(command: string): string {
  return `The reviewer reads the review page, not this session, so answer there by running:

${command} - <<'EOF'
<your reply>
EOF

If the comment asks for a change, make it first, then reply saying what you did; the page picks up the new diff on its own. Write the reply like a reply in a pull request review: one to three short sentences of plain text. The page doesn't render Markdown, so no headings, lists, bold or code blocks. Answer the question or say what you changed, and stop. Don't restate the comment, summarise the diff, or paste code the reviewer can already see in the diff.`
}

export function renderPrompt(p: Omit<SendPayload, 'prompt'>): string {
  const message = renderMessage(p)
  return p.reply ? `${message}\n\n${replyInstructions(p.reply.command)}` : message
}

function renderMessage(p: Omit<SendPayload, 'prompt'>): string {
  const command = `\`${p.diff.command}\``
  if (p.file === null)
    return p.follow_up
      ? `Follow-up on the review comment on ${command}:\n\n${p.text}`
      : `Review comment on ${command}:\n\n${p.text}`
  const where = !p.lines
    ? ''
    : p.lines[0] === p.lines[1]
      ? `, line ${p.lines[0]}`
      : `, lines ${p.lines[0]}–${p.lines[1]}`
  const side = p.side === 'deletions' ? 'old side' : 'new side'
  if (p.follow_up)
    return `Follow-up on the review comment on ${p.file}${where} (${side} of ${command}):\n\n${p.text}`
  const head = `Review comment on ${p.file}${where} (${side} of ${command})`
  if (!p.code) return `${head}:\n\n${p.text}`
  const ranges = p.code.map(({ lines: [first, last] }) =>
    first === last ? `line ${first}` : `lines ${first}–${last}`,
  )
  const marked = p.lines && p.columns && markExcerpt(p.code, p.lines, p.columns)
  const on = marked ? `, on the text between ${MARKS[0]} and ${MARKS[1]}` : ''
  const excerpts = (marked ?? p.code).map(({ text }) => {
    const f = fence(text)
    return `${f}\n${text}\n${f}`
  })
  return `${head}${on}, in ${ranges.join(' and ')}:\n\n${excerpts.join('\n\n')}\n\n${p.text}`
}

export type SendResult = { ok: true; output: string } | { ok: false; error: string }

export interface RunOptions {
  /** Added to skepsis's own environment */
  env: Record<string, string>
  cwd: string
  timeoutMs?: number
  /** Per stream, in bytes */
  maxOutput?: number
}

const TIMEOUT_MS = 10_000
const MAX_OUTPUT = 64 * 1024

/** Run `sh -c command` with the payload as JSON on stdin. Exit 0 is success;
 *  anything else, or running past the timeout, is an error. */
export function runSend(
  command: string,
  payload: SendPayload,
  { env, cwd, timeoutMs = TIMEOUT_MS, maxOutput = MAX_OUTPUT }: RunOptions,
): Promise<SendResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      // Its own process group, so the timeout kills what it started too
      // (`sleep` under `sh -c`, the far end of a pipe).
      detached: true,
    })
    const collect = (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = []
      let size = 0
      stream.on('data', (chunk: Buffer) => {
        if (size >= maxOutput) return
        chunks.push(chunk.subarray(0, maxOutput - size))
        size += chunk.length
      })
      return () => Buffer.concat(chunks).toString('utf8').trim()
    }
    const stdout = collect(child.stdout)
    const stderr = collect(child.stderr)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid!, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: err.message })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) {
        resolve({
          ok: false,
          error: `--send command timed out after ${timeoutMs / 1000} s`,
        })
      } else if (code === 0) {
        resolve({ ok: true, output: stdout() })
      } else {
        const status = signal ? `was killed (${signal})` : `exited with ${code}`
        resolve({ ok: false, error: stderr() || `--send command ${status}` })
      }
    })
    // A command that never reads stdin (`true`) closes the pipe early; that's
    // its business, not an error.
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(payload) + '\n')
  })
}
