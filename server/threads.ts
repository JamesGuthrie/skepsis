/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

// Sent comments and their replies, kept in memory for the life of the run so
// they outlast a page reload.

import type { CommentId, MessageId, SendRequest, Thread } from '../shared/types.ts'

type Message = Thread['messages'][number]

interface Entry {
  id: CommentId
  /** The comment as the page sent it, which follow-ups are anchored by */
  comment: SendRequest
  messages: Message[]
  /** The newest message the reviewer has read, if any */
  readThrough: MessageId | null
}

export type ReplyError = { kind: 'unknownComment'; id: string }

export type ReadError = ReplyError | { kind: 'unknownMessage'; id: MessageId }

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
    this.#entries.set(id, { id, comment, messages: [], readThrough: null })
  }

  /** The comment that opened a thread, or null if there's no such thread */
  comment(id: string): SendRequest | null {
    return this.#entries.get(id as CommentId)?.comment ?? null
  }

  add(id: string, message: Omit<Message, 'id'>): { ok: true } | ReplyError {
    const entry = this.#entries.get(id as CommentId)
    if (!entry) return { kind: 'unknownComment', id }
    entry.messages.push({ id: ++this.#lastMessageId as MessageId, ...message })
    return { ok: true }
  }

  /** Mark a thread read up to and including `through`. It never moves back,
   *  so a stale request (from another tab, say) can't unread a reply. */
  markRead(id: string, through: MessageId): { ok: true } | ReadError {
    const entry = this.#entries.get(id as CommentId)
    if (!entry) return { kind: 'unknownComment', id }
    if (!entry.messages.some((m) => m.id === through))
      return { kind: 'unknownMessage', id: through }
    if (entry.readThrough === null || through > entry.readThrough)
      entry.readThrough = through
    return { ok: true }
  }

  delete(id: string): boolean {
    return this.#entries.delete(id as CommentId)
  }

  list(): Thread[] {
    return [...this.#entries.values()].map(({ id, comment, messages, readThrough }) => ({
      id,
      anchor:
        comment.file !== null && comment.side !== null && comment.lines !== null
          ? { file: comment.file, side: comment.side, lines: comment.lines }
          : null,
      quote: comment.quote ?? null,
      text: comment.text,
      messages: [...messages],
      unread: isUnread(messages, readThrough),
    }))
  }
}

function isUnread(messages: readonly Message[], readThrough: MessageId | null): boolean {
  const last = messages.at(-1)
  return last?.from === 'agent' && (readThrough === null || last.id > readThrough)
}
