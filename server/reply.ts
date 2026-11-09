/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

// --replies: the agent answers a sent comment by running `skepsis --reply`,
// which posts to the running server. Every sent comment carries the command,
// with the server and reply token in it.

import type { CommentId, ErrorResponse } from '../shared/types.ts'
import { REPLY_TOKEN_HEADER } from '../shared/types.ts'

/** The per-run secret `skepsis --reply` authenticates with. Not the page's
 *  token: each one only opens its own routes. */
export type ReplyToken = string & { readonly __brand: 'ReplyToken' }

export interface ReplyAccess {
  /** The server's origin, e.g. http://localhost:4000 */
  server: string
  token: ReplyToken
}

export const replyPath = (id: string) => `/api/threads/${encodeURIComponent(id)}/replies`

/** `arg` as one shell word */
function shellQuote(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

/** The command that answers comment `id`, short of the text. `skepsis` is how
 *  to run this skepsis, e.g. [node, /path/to/cli.js]. */
export function replyCommand(
  skepsis: readonly string[],
  access: ReplyAccess,
  id: CommentId,
): string {
  return [...skepsis, '--reply', id, '--server', access.server, '--token', access.token]
    .map(shellQuote)
    .join(' ')
}

export type PostReplyError =
  | { kind: 'unreachable'; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'unknownComment'; message: string }
  | { kind: 'rejected'; message: string }

export async function postReply(
  access: ReplyAccess,
  id: string,
  text: string,
): Promise<{ ok: true } | PostReplyError> {
  let res: Response
  try {
    res = await fetch(new URL(replyPath(id), access.server), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [REPLY_TOKEN_HEADER]: access.token },
      body: JSON.stringify({ text }),
    })
  } catch (err) {
    const cause = (err as Error & { cause?: Error }).cause
    return {
      kind: 'unreachable',
      message: `Can't reach skepsis at ${access.server}: ${(cause ?? (err as Error)).message}`,
    }
  }
  if (res.ok) return { ok: true }
  const body = await res.text()
  let message: string
  try {
    message = (JSON.parse(body) as ErrorResponse).error
  } catch {
    message = body || `skepsis answered ${res.status}`
  }
  switch (res.status) {
    case 403:
      return { kind: 'forbidden', message }
    case 404:
      return { kind: 'unknownComment', message }
    default:
      return { kind: 'rejected', message }
  }
}
