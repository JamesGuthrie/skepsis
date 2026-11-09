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

import { expect, test } from './fixtures.ts'

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

test.describe('with --send --replies', () => {
  // Replies arrive by polling; poll fast so the test needn't wait long.
  test.use({ cliArgs: ['--send', SEND, '--replies'], pollMs: 200 })

  // This test plays the agent: it runs the reply command each comment carries.
  test('the agent answers comments and follow-ups in the page', async ({ page, repo }) => {
    const answer = async (n: number, text: string) => {
      await expect.poll(async () => (await sent(repo.dir)).length).toBe(n)
      const payload = (await sent(repo.dir))[n - 1]!
      await exec('sh', ['-c', `${payload.reply.command} "$1"`, 'sh', text], {
        cwd: repo.dir,
      })
      return payload
    }

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
