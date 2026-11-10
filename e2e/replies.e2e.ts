/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Page } from '@playwright/test'

import { COMMITTED, WORKING, expect, test } from './fixtures.ts'

const exec = promisify(execFile)

// Appends each payload to a file in .git, out of the diff's way.
const SEND = 'cat >> .git/sent.jsonl'

type Payload = { comment_id: string; follow_up: boolean; reply: { command: string } }

async function sent(dir: string): Promise<Payload[]> {
  const text = await readFile(join(dir, '.git', 'sent.jsonl'), 'utf8').catch(() => '')
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Payload)
}

/** Send a comment on the first line of a.ts */
async function sendComment(page: Page, text: string) {
  await page.keyboard.press('j')
  await page.keyboard.press('c')
  await page.getByPlaceholder('Leave a review comment').fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
}

/** Play the agent: wait for the nth comment and answer it with the reply
 *  command it carries */
async function answerIn(dir: string, n: number, text: string): Promise<Payload> {
  await expect.poll(async () => (await sent(dir)).length).toBe(n)
  const payload = (await sent(dir))[n - 1]!
  await exec('sh', ['-c', `${payload.reply.command} "$1"`, 'sh', text], { cwd: dir })
  return payload
}

test.describe('with --send --replies', () => {
  // Replies arrive by polling; poll fast so the test needn't wait long.
  test.use({ cliArgs: ['--send', SEND, '--replies'], pollMs: 200 })

  test('the agent answers comments and follow-ups in the page', async ({ page, repo }) => {
    const answer = (n: number, text: string) => answerIn(repo.dir, n, text)

    await sendComment(page, 'why 22?')
    expect(await answer(1, 'a typo')).toMatchObject({ comment_id: 'c1', follow_up: false })

    const thread = page.locator('.sent-comment')
    await expect(thread.locator('.from-agent')).toContainText('a typo')

    await thread.getByRole('button', { name: 'Reply' }).click()
    await page.getByPlaceholder('Follow up').fill('fix it then')
    await page.keyboard.press('ControlOrMeta+Enter')
    expect(await answer(2, 'fixed')).toMatchObject({ comment_id: 'c1', follow_up: true })

    const messages = thread.locator('.sent-comment-message .sent-comment-text')
    await expect(messages).toHaveText(['a typo', 'fix it then', 'fixed'])

    // The thread lives on the server, so it outlasts a reload.
    await page.reload()
    await expect(messages).toHaveText(['a typo', 'fix it then', 'fixed'])
  })
})

const tree = (page: Page) => page.locator('.file-tree')

/** The tree row's decoration, by its title */
const decoration = (page: Page, name: string) =>
  tree(page)
    .getByRole('treeitem', { name, exact: true })
    .locator('[data-item-section="decoration"] [title]')

test.describe('unread replies', () => {
  // In a folder, so the tree has a folder row to collapse. b.ts gives the
  // tree a second file to select.
  test.use({
    cliArgs: ['--send', SEND, '--replies'],
    pollMs: 200,
    repoFiles: {
      committed: { 'src/a.ts': COMMITTED['a.ts']! },
      // b.ts sorts after a.ts, so sendComment's first line is still in a.ts.
      working: { 'src/a.ts': WORKING['a.ts']!, 'src/b.ts': 'export const b = 1\n' },
    },
  })

  // Longer than the page's read dwell
  const DWELL = 5000

  /** Send a comment, mark the file viewed (which collapses it, hiding the
   *  thread), and have the agent answer */
  async function unreadReply(page: Page, dir: string) {
    await sendComment(page, 'why 22?')
    await expect(page.locator('.sent-comment')).toBeVisible()
    await page.locator('.viewed-button').first().click()
    await expect(page.locator('.sent-comment')).toBeHidden()
    await answerIn(dir, 1, 'a typo')
  }

  test('show in the tree until read, ahead of the viewed check', async ({ page, repo }) => {
    await unreadReply(page, repo.dir)
    await expect(decoration(page, 'a.ts')).toHaveAttribute('title', 'Unread reply')

    // Expanding the viewed file shows the reply; it's read once it stays on
    // screen.
    await page.keyboard.press('e')
    const thread = page.locator('.sent-comment')
    await expect(thread.locator('.sent-comment-new')).toBeVisible()
    await expect(decoration(page, 'a.ts')).toHaveAttribute('title', 'Viewed', {
      timeout: DWELL,
    })
    await expect(thread.locator('.sent-comment-new')).toBeHidden()

    // Read survives a reload: it's on the server.
    await page.reload()
    await expect(decoration(page, 'a.ts')).toHaveAttribute('title', 'Viewed')

    // Unviewed, the read thread shows instead of nothing.
    await page.locator('.viewed-button').first().click()
    await expect(thread).toBeVisible()
    await expect(thread.locator('.sent-comment-new')).toBeHidden()
    await expect(decoration(page, 'a.ts')).toHaveAttribute('title', 'Conversation')
  })

  test('show on a collapsed folder', async ({ page, repo }) => {
    await unreadReply(page, repo.dir)
    await expect(decoration(page, 'src')).toHaveCount(0)
    await tree(page).getByRole('treeitem', { name: 'src', exact: true }).click()
    await expect(
      tree(page).getByRole('treeitem', { name: 'a.ts', exact: true }),
    ).toBeHidden()
    await expect(decoration(page, 'src')).toHaveAttribute('title', 'Unread reply')
  })

  test('the header toast goes to the first one', async ({ page, repo }) => {
    await unreadReply(page, repo.dir)
    const toast = page.locator('.header-toast')
    await expect(toast).toContainText('1 unread reply')

    // The reply is in a viewed, so collapsed, file; going there opens it.
    await toast.getByRole('button', { name: 'Go to first' }).click()
    await expect(page.locator('.sent-comment-new')).toBeInViewport()
    await expect(toast).toBeHidden({ timeout: DWELL })
  })

  test('u goes to the first one', async ({ page, repo }) => {
    await unreadReply(page, repo.dir)
    await expect(page.locator('.header-toast')).toBeVisible()
    await page.keyboard.press('u')
    await expect(page.locator('.sent-comment-new')).toBeInViewport()
  })

  test("the tree's bubble goes to the file's thread", async ({ page, repo }) => {
    await unreadReply(page, repo.dir)
    const bubble = decoration(page, 'a.ts')
    await expect(bubble).toHaveAttribute('title', 'Unread reply')
    // Focus is elsewhere first, so following it to a.ts is the bubble's doing.
    await tree(page).getByRole('treeitem', { name: 'b.ts', exact: true }).click()
    await bubble.click()
    await expect(page.locator('.sent-comment-new')).toBeInViewport()
    const row = tree(page).getByRole('treeitem', { name: 'a.ts', exact: true })
    await expect(row).toHaveAttribute('aria-selected', 'true')
    // The focus ring follows, as for a click anywhere else on the row
    await expect(row).toHaveAttribute('data-item-focused')
  })

  test("aren't read by passing over them", async ({ page, repo }) => {
    await unreadReply(page, repo.dir)
    await page.keyboard.press('e')
    await expect(page.locator('.sent-comment')).toBeVisible()
    await page.keyboard.press('e')
    await expect(page.locator('.sent-comment')).toBeHidden()
    await page.waitForTimeout(DWELL)
    await expect(decoration(page, 'a.ts')).toHaveAttribute('title', 'Unread reply')
  })
})

test.describe('with --send alone', () => {
  test.use({ cliArgs: ['--send', SEND], pollMs: 200 })

  test("doesn't poll for replies", async ({ page, repo }) => {
    let fetches = 0
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/threads') fetches++
    })
    await sendComment(page, 'why 22?')
    await expect.poll(async () => (await sent(repo.dir)).length).toBe(1)
    await expect(page.locator('.sent-comment')).toBeVisible()
    const settled = fetches
    // Several poll intervals' worth
    await page.waitForTimeout(1000)
    expect(fetches).toBe(settled)
  })
})
