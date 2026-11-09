/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'node:child_process'

function urlOpenCommand(
  url: string,
  openCmd: string | null,
): { cmd: string; args: string[] } {
  // "$1" rather than splicing the URL into the command, so the shell never
  // parses it.
  if (openCmd) return { cmd: 'sh', args: ['-c', `${openCmd} "$1"`, 'sh', url] }
  switch (process.platform) {
    case 'darwin':
      return { cmd: 'open', args: [url] }
    case 'win32':
      return { cmd: 'cmd', args: ['/c', 'start', '', url] }
    default:
      return { cmd: 'xdg-open', args: [url] }
  }
}

/** Open `url` with `openCmd`, or the system opener when it's null. */
export function openUrl(url: string, openCmd: string | null): void {
  const { cmd, args } = urlOpenCommand(url, openCmd)
  // A custom command's stderr shows, since a typo there is the user's to fix.
  const opener = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', 'ignore', openCmd ? 'inherit' : 'ignore'],
  })
  // The URL is already printed on server startup, so a failed system opener
  // (e.g. no xdg-open on illumos) needs no message — swallow the error and
  // carry on.
  opener.on('error', () => {})
  if (openCmd)
    opener.on('exit', (code) => {
      if (code) console.error(`The open command exited with status ${code}`)
    })
  opener.unref()
}
