/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { z } from 'zod'
import type { FileCommentSyntax } from './reviewComments.ts'

// --- Request schemas (validated by server) ---

export const viewedRequestSchema = z.object({
  file: z.string(),
  hash: z.string(),
})

export const viewedDeleteSchema = z.object({
  file: z.string(),
  hash: z.string(),
})

export const viewedDeleteAllSchema = z.object({
  files: z.array(viewedDeleteSchema),
})

export const commentRequestSchema = z.object({
  file: z.string(),
  afterLine: z.number(),
  /** What the page shows at afterLine, so a file that changed since the diff
   *  loaded can't take the comment on the wrong line. */
  lineText: z.string(),
  text: z.string(),
  /** How many lines the comment covers, ending at afterLine. */
  lineCount: z.number().int().min(1).optional(),
  /** The selected text, for a comment on part of those lines. */
  quote: z.string().optional(),
})

/** A comment for the --send command. Only `text` is required by the
 *  contract; the page always anchors it to lines. */
export const sendRequestSchema = z.object({
  file: z.string().nullable(),
  side: z.enum(['additions', 'deletions']).nullable(),
  lines: z.tuple([z.number().int().positive(), z.number().int().positive()]).nullable(),
  /** For a comment on selected text rather than whole lines: where the text
   *  starts in the first line and ends (exclusive) in the last, 0-based, in
   *  UTF-16 code units. */
  columns: z
    .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .nullable(),
  /** The selected text at `columns`, for the page to show on the sent
   *  comment. Not part of what --send delivers. */
  quote: z.string().optional(),
  /** An excerpt around the lines commented on, as runs of consecutive lines
   *  with each run's first and last line. Lines the diff hides split it. */
  code: z
    .array(
      z.object({
        lines: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        text: z.string(),
      }),
    )
    .min(1)
    .nullable(),
  /** The blob ID of `side`'s version of the file as the page shows it, the
   *  version `lines` and `code` come from */
  blob: z
    .string()
    .regex(/^[0-9a-f]+$/)
    .nullable(),
  text: z.string().min(1),
})

/** A follow-up from the reviewer on a sent comment's thread */
export const followUpRequestSchema = z.object({ text: z.string().min(1) })

/** The agent's answer on a sent comment's thread, from `skepsis --reply` */
export const replyRequestSchema = z.object({ text: z.string().min(1) })

export const commentDeleteSchema = z.object({
  file: z.string(),
  line: z.number(),
})

/** A full hex object id, so it can't pass for an option or a revset. */
const revisionIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  .transform((id) => id as RevisionId)

export const fileContentsQuerySchema = z
  .object({
    path: z.string(),
    // Present for renamed files: the path to fetch the old-side content from.
    oldPath: z.string().optional(),
    // The snapshot of the diff the page shows, so expansion reads the same
    // revisions as its patch. No `right` means the working copy.
    left: revisionIdSchema,
    right: revisionIdSchema.optional(),
  })
  .transform(({ left, right, ...rest }) => ({
    ...rest,
    snapshot: { left, right: right ?? 'workingCopy' } satisfies Snapshot,
  }))

// --- Request types (inferred from schemas) ---

export type ViewedRequest = z.infer<typeof viewedRequestSchema>
export type CommentRequest = z.infer<typeof commentRequestSchema>
export type CommentDeleteRequest = z.infer<typeof commentDeleteSchema>
export type SendRequest = z.infer<typeof sendRequestSchema>
export type FollowUpRequest = z.infer<typeof followUpRequestSchema>
export type ReplyRequest = z.infer<typeof replyRequestSchema>

// --- Threads ---

/** The server's name for a sent comment, unique within a run. The agent
 *  answers by it, so it's short: `c1`, `c2`, ... */
export type CommentId = string & { readonly __brand: 'CommentId' }

export type Side = 'additions' | 'deletions'

/** A sent comment and what followed it */
export interface Thread {
  id: CommentId
  /** Null for a comment on the diff as a whole. The page always sends from
   *  lines, but the --send contract allows one. */
  anchor: { file: string; side: Side; lines: [number, number] } | null
  /** The selected text, for a comment on part of the lines */
  quote: string | null
  /** The comment that opened the thread, from the reviewer */
  text: string
  /** Everything after it, in the order it arrived */
  messages: { id: number; from: 'reviewer' | 'agent'; text: string }[]
}

export interface ThreadsResponse {
  threads: Thread[]
}

/** The header every API request carries the per-run token in. The page gets
 *  the token from the `#token=` fragment of the URL skepsis prints and opens. */
export const TOKEN_HEADER = 'X-Skepsis-Token'

/** The header `skepsis --reply` carries the per-run reply token in. It's a
 *  separate token so the page's can't post replies and the agent's can't call
 *  anything else. */
export const REPLY_TOKEN_HEADER = 'X-Skepsis-Reply-Token'

// --- UI types ---

/** Color scheme. 'system' follows the OS preference; 'light' and 'dark' force
 *  it (e.g. light diffs on a dark desktop). One list drives the API schema,
 *  the toggle, and the client's data-theme validation. */
export const THEME_MODES = ['light', 'dark', 'system'] as const
export type ThemeMode = (typeof THEME_MODES)[number]

export const themeRequestSchema = z.object({ theme: z.enum(THEME_MODES) })

export interface ThemeResponse {
  theme: ThemeMode
}

// --- VCS types ---

/** The full object id of a fixed revision: a commit, or in git a tree, since
 *  a git diff can start from a bare tree such as the empty tree. */
export type RevisionId = string & { readonly __brand: 'RevisionId' }

/**
 * The revisions at the two ends of one diff response. The page sends it back
 * to /api/file-contents, so hunk expansion reads the revisions its patch came
 * from even if a branch has moved since. The right side is `'workingCopy'`
 * when the diff ends at the working tree (git only; in jj the working copy is
 * the real commit `@`).
 */
export type Snapshot = { left: RevisionId; right: RevisionId | 'workingCopy' }

// --- Response types (checked via satisfies on the server) ---

export type ViewedMap = Record<string, string>
export type FileHashes = Record<string, string>

export interface DiffResponse {
  patch: string
  revset: string
  /** The name of the directory skepsis runs in, for the page title */
  repo: string
  vcs: 'jj' | 'git'
  /** Whether this is a `jj interdiff`, which has no inline comments or hunk
   *  expansion */
  interdiff: boolean
  commentsEnabled: boolean
  /** The revisions this patch was diffed between, for /api/file-contents to
   *  serve full file contents for hunk expansion. Null when the range has no
   *  single pair of endpoints, which disables expansion. */
  snapshot: Snapshot | null
  fileHashes: FileHashes
  /** Hash of `patch`, compared against /api/diff-hash to notice changes. */
  patchHash: string
  /** Whether the page should poll /api/diff-hash (off with --no-poll). */
  poll: boolean
  /** Null when the comment box can't send. With `replies` (--replies), the
   *  agent can answer in the page, so there are replies to poll for. */
  send: { replies: boolean } | null
  viewed: ViewedMap
  /** Per-file comment syntax, shown in the comment form. An empty prefix
   *  means the format has no comment syntax (e.g. plain text); null means the
   *  file type wasn't recognized. Both get bare review tags on insert.
   *  Sections mean it depends on the line. Always empty when comments are
   *  disabled. */
  commentSyntaxes: Record<string, FileCommentSyntax>
  /** Files the page starts collapsed (see server/generated.ts) */
  generated: string[]
  error?: string
}

/** Full file contents at each diff endpoint. A side is `null` when the file
 *  does not exist there (added → old null; deleted → new null) or could not be
 *  read (treated as non-expandable by the client). */
export interface FileContentsResponse {
  oldContents: string | null
  newContents: string | null
}

export interface ErrorResponse {
  error: string
}

export interface OkResponse {
  ok: true
}

export interface DiffHashResponse {
  hash: string
}
