#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { spawn } from 'child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Command, InvalidArgumentError } from '@commander-js/extra-typings'
import { startServer } from './server/main.ts'
import { LOOPBACK } from './server/gate.ts'
import { buildDiffSource } from './server/diffSource.ts'
import { openUrl } from './server/open.ts'

function parsePort(value: string): number {
  const port = /^\d+$/.test(value) ? Number(value) : NaN
  // 0 asks for a free port, the same as leaving the flag out
  if (!(port >= 0 && port <= 65535)) {
    throw new InvalidArgumentError('port must be an integer between 0 and 65535')
  }
  return port
}

const program = new Command()
  .name('skepsis')
  .description('Local diff review UI (auto-detects jj or git)')
  .option('-r, --revisions <revsets>', 'Show changes in these revisions')
  .option('-f, --from <rev>', 'Show changes from this revision')
  .option('-t, --to <rev>', 'Show changes to this revision')
  .option(
    '--interdiff',
    'Show how the change in --to differs from the change in --from (jj only)',
  )
  .option('--git', 'force git mode (skip jj detection)')
  .option(
    '-C, --cwd <dir>',
    'run as if started in this directory (files are relative to it)',
  )
  .option('--dev', 'run with Vite dev server for development')
  .option('--host <address>', 'address to bind the HTTP server to', 'localhost')
  .option('-p, --port <number>', 'port for the browser UI (default: a free one)', parsePort)
  .option('--no-open', "don't open a browser")
  .option(
    '--open-cmd <command>',
    'shell command that opens the page, given the URL as its last argument (default: $SKEPSIS_OPEN, else the system opener)',
  )
  .option('--no-poll', "don't check for changes to the diff while the page is open")
  .option(
    '--send <command>',
    'add a Send button that pipes the comment to this shell command (default: $SKEPSIS_SEND)',
  )
  .argument('[files...]', 'Limit diff to these paths (passed through to jj/git)')
  .addHelpText(
    'after',
    '\nOnce the server is listening, it prints one line to stdout,\n' +
      '`skepsis on <url> (<diff command>)`, for scripts that start it in the\n' +
      'background with --no-open. The URL ends in a per-run #token= the page\n' +
      'needs, so open it whole.\n\n' +
      'With --send, the comment box sends to `sh -c <command>`, run in the\n' +
      'working directory (-C), with the comment as one JSON object on stdin (its `prompt`\n' +
      'field has it all as plain text). Exit 0 means delivered; anything else,\n' +
      'or taking over 10 s, is an error, and stderr is shown.\n' +
      'See the README for the fields and recipes.',
  )
  .parse()

const opts = program.opts()

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

const files = program.processedArgs[0] ?? []
const hostname = opts.host
// The flag wins over the environment, and an empty value means the system
// opener.
const openCmd = (opts.openCmd ?? process.env['SKEPSIS_OPEN']) || null

// Changing the process's own directory, rather than passing the directory
// around, keeps everything that depends on it in agreement: VCS detection,
// every jj/git command, serveStatic's root, and the --send command.
if (opts.cwd !== undefined) {
  try {
    process.chdir(opts.cwd)
  } catch (err) {
    const { code, message } = err as NodeJS.ErrnoException
    const reason =
      code === 'ENOENT'
        ? 'no such directory'
        : code === 'ENOTDIR'
          ? 'not a directory'
          : message
    fail(`-C ${opts.cwd}: ${reason}`)
  }
}

// The flag wins over the environment, and an empty value turns sending off.
const send = (opts.send ?? process.env['SKEPSIS_SEND']) || null
if (send && !LOOPBACK.has(hostname === '::1' ? '[::1]' : hostname)) {
  fail(
    `--send runs a command on request from the page, so it needs a loopback\n` +
      `--host (localhost, 127.0.0.1 or ::1), not ${hostname}.`,
  )
}

const diffSource = (() => {
  try {
    return buildDiffSource(opts, files)
  } catch (err) {
    console.error((err as Error).message)
    process.exit(1)
  }
})()

const cwd = process.cwd()
const children: ReturnType<typeof spawn>[] = []

function findCheckoutRoot(): string | null {
  const sourceRoot = import.meta.dirname
  if (existsSync(join(sourceRoot, 'vite.config.ts'))) return sourceRoot

  const packageRoot = dirname(sourceRoot)
  if (existsSync(join(packageRoot, 'vite.config.ts'))) return packageRoot

  return null
}

function cleanup(code = 0): never {
  for (const child of children) child.kill()
  process.exit(code)
}

function requireCheckoutRoot(): string {
  const checkoutRoot = findCheckoutRoot()
  if (checkoutRoot === null) {
    console.error(
      '--dev only works from a skepsis source checkout, not the installed package.\n' +
        'Clone https://github.com/oxidecomputer/skepsis and run: node cli.ts --dev',
    )
    cleanup(1)
  }
  return checkoutRoot
}

process.on('SIGINT', () => cleanup())
process.on('SIGTERM', () => cleanup())

const checkoutRoot = opts.dev ? requireCheckoutRoot() : undefined
// In development Vite owns the browser-facing port and proxies API requests
// to this server, so leave the API on an ephemeral port. In the packaged app
// the API server also serves the UI and can bind the requested port directly.
const { port: apiPort, token } = await startServer({
  diffSource,
  cwd,
  hostname,
  port: opts.dev ? undefined : opts.port,
  poll: opts.poll,
  send,
}).catch((err: Error) => {
  console.error(err.message)
  return cleanup(1)
})

// Only auto-open a browser when bound to localhost. With any other host,
// the user is likely on a remote dev box and the browser lives elsewhere
// — opening locally would just spawn an unwanted browser.
const shouldAutoOpen = opts.open && hostname === 'localhost'

if (opts.dev) {
  const viteArgs = ['vite', '--host', hostname]
  if (opts.port) viteArgs.push('--port', String(opts.port), '--strictPort')
  // Vite resolves a string --open against its own URL, fragment included.
  if (shouldAutoOpen) viteArgs.push('--open', `/#token=${token}`)
  const vite = spawn('npx', viteArgs, {
    cwd: checkoutRoot,
    stdio: 'inherit',
    env: { ...process.env, API_HOST: hostname, API_PORT: String(apiPort) },
  })
  children.push(vite)
} else if (shouldAutoOpen) {
  openUrl(`http://localhost:${apiPort}/#token=${token}`, openCmd)
}
