/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { zValidator } from '@hono/zod-validator'
import { basename, join, relative } from 'node:path'
import { readFile } from 'node:fs/promises'
import { getDiff, patchHash } from './diff.ts'
import { isInterdiff, resolveDiff } from './diffSource.ts'
import type { DiffSpec } from './diffSource.ts'
import { displayCommand } from './displayCommand.ts'
import { getFileContents } from './fileContents.ts'
import { getGeneratedFiles } from './generated.ts'
import { loadViewed, markViewed, unmarkViewed, unmarkViewedAll } from './viewed.ts'
import { insertComment, removeComment } from './comment.ts'
import { getCommentSyntaxes } from './commentSyntax.ts'
import { loadTheme, saveTheme, themeBootScript } from './settings.ts'
import { newToken, sendGate, tokenMatches } from './gate.ts'
import { buildPayload, runSend } from './send.ts'
import type { SendResult } from './send.ts'
import { Threads } from './threads.ts'

import type { ReplyToken } from './reply.ts'
import {
  viewedRequestSchema,
  viewedDeleteSchema,
  viewedDeleteAllSchema,
  commentRequestSchema,
  commentDeleteSchema,
  sendRequestSchema,
  followUpRequestSchema,
  replyRequestSchema,
  fileContentsQuerySchema,
  themeRequestSchema,
  TOKEN_HEADER,
  REPLY_TOKEN_HEADER,
} from '../shared/types.ts'
import type {
  DiffHashResponse,
  DiffResponse,
  FileContentsResponse,
  OkResponse,
  ErrorResponse,
  ThemeResponse,
  ThreadsResponse,
  CommentId,
  SendRequest,
} from '../shared/types.ts'

/** What Send runs, and whether the agent at the other end can answer */
export interface SendTarget {
  command: string
  /** With --replies: `skepsis` is how to run this skepsis, e.g.
   *  [node, /path/to/cli.js], for the reply command each comment carries */
  replies: { skepsis: readonly string[] } | null
}

export async function startServer(opts: {
  diffSource: DiffSpec
  port?: number
  hostname?: string
  cwd: string
  /** Serve /api/diff-hash for the page's change polling. Default true. */
  poll?: boolean
  /** Unset, /api/send and the thread routes don't exist. */
  send?: SendTarget | null
  /** Overrides runSend's timeout, for tests */
  sendTimeoutMs?: number
}): Promise<{ port: number; token: string; close: () => void }> {
  const { diffSource, port = 0, hostname = 'localhost', cwd, poll = true, send } = opts
  // Fail fast on bad args by running the exact diff command we'll serve.
  // Result is discarded: /api/diff resolves and re-runs it per request to
  // stay fresh.
  await getDiff(await resolveDiff(diffSource))

  const app = new Hono()
  const token = newToken()
  const replyToken = send?.replies ? (newToken() as ReplyToken) : null
  // Known once listening; for SKEPSIS_URL and the reply command.
  let serverUrl = ''

  // Every API call must carry the token (see tokenMatches). The theme boot
  // script is the exception: a <script src> can't send a header, and all it
  // gives away is the theme. So is the agent's reply, which carries the reply
  // token instead.
  app.use('/api/*', async (c, next) => {
    if (
      c.req.path === '/api/theme.js' ||
      (replyToken &&
        c.req.method === 'POST' &&
        /^\/api\/threads\/[^/]+\/replies$/.test(c.req.path)) ||
      tokenMatches(c.req.header(TOKEN_HEADER), token)
    )
      return next()
    return c.json(
      {
        error:
          'This page has no valid token. Open the URL skepsis printed when it started.',
      } satisfies ErrorResponse,
      401,
    )
  })

  // An interdiff that ends at the working copy still can't take comments: a
  // changed description shows as a file named JJ-COMMIT-DESCRIPTION, which a
  // comment would create on disk.
  const commentsEnabled = diffSource.toWorkingCopy && !isInterdiff(diffSource)

  app.get('/api/diff', async (c) => {
    const resolved = await resolveDiff(diffSource)
    const { patch, fileHashes } = await getDiff(resolved)
    const files = Object.keys(fileHashes)
    const [viewed, generated, commentSyntaxes] = await Promise.all([
      loadViewed(cwd, fileHashes),
      getGeneratedFiles(cwd, files),
      commentsEnabled ? getCommentSyntaxes(cwd, files) : {},
    ])
    return c.json({
      patch,
      revset: displayCommand(diffSource),
      repo: basename(cwd),
      vcs: diffSource.vcs,
      interdiff: isInterdiff(diffSource),
      commentsEnabled,
      snapshot: resolved.snapshot,
      fileHashes,
      patchHash: patchHash(patch),
      poll,
      send: send ? { replies: send.replies !== null } : null,
      viewed,
      commentSyntaxes,
      generated,
    } satisfies DiffResponse)
  })

  // Polled every few seconds while the page is visible. Requests that arrive
  // while a diff is running share its result rather than starting another, so
  // several tabs, or a diff slower than the interval, never pile up. /api/diff
  // doesn't share: it follows the page's own edits (a comment), and a poll
  // that started before the edit would hand back the old patch. For the same
  // reason, an edit stops later polls from sharing a diff already running.
  let hashInFlight: Promise<string> | null = null
  app.get('/api/diff-hash', async (c) => {
    if (!poll)
      return c.json({ error: 'polling is off (--no-poll)' } satisfies ErrorResponse, 404)
    if (!hashInFlight) {
      const run = resolveDiff(diffSource)
        .then(getDiff)
        .then(({ patch }) => patchHash(patch))
        .finally(() => {
          if (hashInFlight === run) hashInFlight = null
        })
      hashInFlight = run
    }
    return c.json({ hash: await hashInFlight } satisfies DiffHashResponse)
  })

  app.get('/api/file-contents', zValidator('query', fileContentsQuerySchema), async (c) => {
    const { path, oldPath, snapshot } = c.req.valid('query')
    const contents = await getFileContents(diffSource.vcs, cwd, snapshot, path, oldPath)
    return c.json(contents satisfies FileContentsResponse)
  })

  app.post('/api/viewed', zValidator('json', viewedRequestSchema), async (c) => {
    const { file, hash } = c.req.valid('json')
    await markViewed(cwd, file, hash)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.delete('/api/viewed', zValidator('json', viewedDeleteSchema), async (c) => {
    const { file, hash } = c.req.valid('json')
    await unmarkViewed(cwd, file, hash)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.delete('/api/viewed-all', zValidator('json', viewedDeleteAllSchema), async (c) => {
    const { files } = c.req.valid('json')
    await unmarkViewedAll(cwd, files)
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.post('/api/comment', zValidator('json', commentRequestSchema), async (c) => {
    const { file, afterLine, lineText, text, lineCount, quote } = c.req.valid('json')
    await insertComment(cwd, file, afterLine, lineText, text, lineCount, quote)
    hashInFlight = null
    return c.json({ ok: true } satisfies OkResponse)
  })

  // Send runs the --send command, so only the page may call it (see
  // gate.ts). Sends run one at a time in arrival order, so two quick ones
  // can't reach the far end swapped.
  const threads = new Threads()
  let sendQueue: Promise<SendResult> = Promise.resolve({ ok: true, output: '' })
  if (send) {
    const gate = createMiddleware(async (c, next) => {
      const headers = { host: c.req.header('host'), origin: c.req.header('origin') }
      if (!sendGate(headers))
        return c.json({ error: 'forbidden' } satisfies ErrorResponse, 403)
      await next()
    })
    // Nothing here awaits before joining the queue, so sends join it as they
    // arrive.
    const deliver = (
      comment: SendRequest,
      thread: { id: CommentId; followUp: boolean },
    ): Promise<SendResult> => {
      const replies =
        send.replies && replyToken
          ? { server: serverUrl, token: replyToken, skepsis: send.replies.skepsis }
          : null
      const payload = buildPayload(diffSource, cwd, comment, thread, replies)
      const run = (): Promise<SendResult> => {
        const env = { SKEPSIS_URL: serverUrl, SKEPSIS_ROOT: cwd }
        return runSend(send.command, payload, { cwd, env, timeoutMs: opts.sendTimeoutMs })
      }
      const result = sendQueue.then(run, run)
      sendQueue = result
      return result
    }

    app.post('/api/send', gate, zValidator('json', sendRequestSchema), async (c) => {
      // The blob comes from the page with the lines and excerpt, so all
      // three describe the version on screen even if the file has changed
      // since.
      const comment = c.req.valid('json')
      const id = threads.nextId()
      const r = await deliver(comment, { id, followUp: false })
      if (!r.ok) return c.json({ error: r.error } satisfies ErrorResponse, 502)
      threads.open(id, comment)
      return c.json({ ok: true } satisfies OkResponse)
    })

    app.post(
      '/api/threads/:id/messages',
      gate,
      zValidator('json', followUpRequestSchema),
      async (c) => {
        const id = c.req.param('id')
        const comment = threads.comment(id)
        if (!comment)
          return c.json({ error: `No sent comment ${id}` } satisfies ErrorResponse, 404)
        const { text } = c.req.valid('json')
        const r = await deliver(
          { ...comment, text },
          { id: id as CommentId, followUp: true },
        )
        if (!r.ok) return c.json({ error: r.error } satisfies ErrorResponse, 502)
        threads.add(id, { from: 'reviewer', text })
        return c.json({ ok: true } satisfies OkResponse)
      },
    )

    // The page token doesn't reach this route (see the token middleware), so
    // it checks the reply token itself.
    if (replyToken)
      app.post(
        '/api/threads/:id/replies',
        gate,
        async (c, next) => {
          if (!tokenMatches(c.req.header(REPLY_TOKEN_HEADER), replyToken))
            return c.json(
              { error: 'Wrong or missing reply token' } satisfies ErrorResponse,
              403,
            )
          await next()
        },
        zValidator('json', replyRequestSchema),
        (c) => {
          const id = c.req.param('id')
          const r = threads.add(id, { from: 'agent', text: c.req.valid('json').text })
          if ('kind' in r)
            return c.json(
              {
                error: `No comment ${id}: it was dismissed, or belongs to an earlier run of skepsis.`,
              } satisfies ErrorResponse,
              404,
            )
          return c.json({ ok: true } satisfies OkResponse)
        },
      )

    app.get('/api/threads', (c) =>
      c.json({ threads: threads.list() } satisfies ThreadsResponse),
    )

    app.delete('/api/threads/:id', (c) => {
      const id = c.req.param('id')
      if (!threads.delete(id))
        return c.json({ error: `No sent comment ${id}` } satisfies ErrorResponse, 404)
      return c.json({ ok: true } satisfies OkResponse)
    })
  }

  app.delete('/api/comment', zValidator('json', commentDeleteSchema), async (c) => {
    const { file, line } = c.req.valid('json')
    await removeComment(cwd, file, line)
    hashInFlight = null
    return c.json({ ok: true } satisfies OkResponse)
  })

  app.get('/api/theme', async (c) => {
    return c.json({ theme: await loadTheme() } satisfies ThemeResponse)
  })

  // Loaded by a render-blocking <script> in index.html (see themeBootScript).
  // no-store: a cached copy would re-apply an old preference before React
  // corrects it, flashing the wrong theme — the exact problem this solves.
  app.get('/api/theme.js', async (c) => {
    c.header('Cache-Control', 'no-store')
    c.header('Content-Type', 'text/javascript')
    return c.body(themeBootScript(await loadTheme()))
  })

  app.post('/api/theme', zValidator('json', themeRequestSchema), async (c) => {
    await saveTheme(c.req.valid('json').theme)
    return c.json({ ok: true } satisfies OkResponse)
  })

  // Keep this path valid from source (`server/`) and from the published bundle
  // (`dist/cli.js`): both are one directory below the package root.
  const distDir = join(import.meta.dirname, '..', 'dist', 'web')

  // @hono/node-server resolves `root` relative to cwd. On Windows, this cannot
  // cross drive letters; installed-package use is expected on Unix-like hosts.
  app.use('*', serveStatic({ root: relative(cwd, distDir) }))

  // SPA fallback
  app.get('*', async (c) => {
    const html = await readFile(join(distDir, 'index.html'), 'utf-8')
    return c.html(html)
  })

  app.onError((err, c) => {
    return c.json({ error: err.message } satisfies ErrorResponse, 500)
  })

  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      const assignedPort = typeof info === 'string' ? port : info.port
      // An IPv6 literal needs brackets in a URL, or the reply command and
      // SKEPSIS_URL point nowhere.
      const host = hostname.includes(':') ? `[${hostname}]` : hostname
      serverUrl = `http://${host}:${assignedPort}`
      console.info(
        `skepsis on ${serverUrl}/#token=${token} (${displayCommand(diffSource)})`,
      )
      resolve({ port: assignedPort, token, close: () => server.close() })
    })
    server.on('error', reject)
  })
}
