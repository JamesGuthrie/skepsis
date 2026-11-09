/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

// Sent comments and their replies, kept in memory for the life of the run so
// they outlast a page reload.

import type { CommentId, SendRequest, Thread } from '../shared/types.ts'

type Message = Thread['messages'][number]

interface Entry {
  id: CommentId
  /** The comment as the page sent it, which follow-ups are anchored by */
  comment: SendRequest
  messages: Message[]
}

export type ReplyError = { kind: 'unknownComment'; id: string }

export class Threads {
  #entries = new Map<CommentId, Entry>()
  #lastId = 0
  #lastMessageId = 0

  /** An id for a comment that's about to be sent. It only becomes a thread
   *  with `open`, once the send has gone through. */
  nextId(): CommentId {
    return `c${++this.#lastId}` as CommentId
  }

  open(id: CommentId, comment: SendRequest): void {
    this.#entries.set(id, { id, comment, messages: [] })
  }

  /** The comment that opened a thread, or null if there's no such thread */
  comment(id: string): SendRequest | null {
    return this.#entries.get(id as CommentId)?.comment ?? null
  }

  add(id: string, message: Omit<Message, 'id'>): { ok: true } | ReplyError {
    const entry = this.#entries.get(id as CommentId)
    if (!entry) return { kind: 'unknownComment', id }
    entry.messages.push({ id: ++this.#lastMessageId, ...message })
    return { ok: true }
  }

  delete(id: string): boolean {
    return this.#entries.delete(id as CommentId)
  }

  list(): Thread[] {
    return [...this.#entries.values()].map(({ id, comment, messages }) => ({
      id,
      anchor:
        comment.file !== null && comment.side !== null && comment.lines !== null
          ? { file: comment.file, side: comment.side, lines: comment.lines }
          : null,
      quote: comment.quote ?? null,
      text: comment.text,
      messages: [...messages],
    }))
  }
}
