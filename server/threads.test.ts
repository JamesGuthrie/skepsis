/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { CommentId, MessageId, SendRequest } from '../shared/types.ts'
import { Threads } from './threads.ts'

const comment: SendRequest = {
  file: 'a.ts',
  side: 'additions',
  lines: [1, 1],
  columns: null,
  code: null,
  blob: null,
  text: 'why?',
}

let threads: Threads
let id: CommentId

beforeEach(() => {
  threads = new Threads()
  id = threads.nextId()
  threads.open(id, comment)
})

const thread = () => threads.list()[0]!
const unread = () => thread().unread
/** The id of the thread's newest message */
const last = () => thread().messages.at(-1)!.id

describe('unread', () => {
  it('is false for a comment nobody has answered', () => {
    expect(unread()).toBe(false)
  })

  it('is true once the agent answers', () => {
    threads.add(id, { from: 'agent', text: 'because' })
    expect(unread()).toBe(true)
  })

  it('is false once read through the answer', () => {
    threads.add(id, { from: 'agent', text: 'because' })
    expect(threads.markRead(id, last())).toEqual({ ok: true })
    expect(unread()).toBe(false)
  })

  it('stays true when read through an earlier answer than the newest', () => {
    threads.add(id, { from: 'agent', text: 'because' })
    const seen = last()
    threads.add(id, { from: 'agent', text: 'and also' })
    threads.markRead(id, seen)
    expect(unread()).toBe(true)
  })

  it("doesn't move back for a stale read", () => {
    threads.add(id, { from: 'agent', text: 'because' })
    const first = last()
    threads.add(id, { from: 'agent', text: 'and also' })
    threads.markRead(id, last())
    threads.markRead(id, first)
    expect(unread()).toBe(false)
  })

  it('is false when the reviewer spoke last', () => {
    threads.add(id, { from: 'agent', text: 'because' })
    threads.add(id, { from: 'reviewer', text: 'fix it' })
    expect(unread()).toBe(false)
  })

  it('is true again when the agent answers after a read', () => {
    threads.add(id, { from: 'agent', text: 'because' })
    threads.markRead(id, last())
    threads.add(id, { from: 'reviewer', text: 'fix it' })
    threads.add(id, { from: 'agent', text: 'fixed' })
    expect(unread()).toBe(true)
  })
})

describe('markRead', () => {
  it('says which part of the request is unknown', () => {
    threads.add(id, { from: 'agent', text: 'because' })
    expect(threads.markRead('c9', last())).toEqual({ kind: 'unknownComment', id: 'c9' })
    expect(threads.markRead(id, 99 as MessageId)).toEqual({
      kind: 'unknownMessage',
      id: 99,
    })
    expect(unread()).toBe(true)
  })

  it('rejects a message from another thread', () => {
    const other = threads.nextId()
    threads.open(other, comment)
    threads.add(other, { from: 'agent', text: 'elsewhere' })
    const elsewhere = threads.list()[1]!.messages[0]!.id
    expect(threads.markRead(id, elsewhere)).toEqual({
      kind: 'unknownMessage',
      id: elsewhere,
    })
  })
})
