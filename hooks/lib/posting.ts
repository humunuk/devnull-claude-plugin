// Posting a commit: the commands it runs, the request it sends, what the answer
// means, and where `/devnull` completions apply. Pure: hooks/posting.ts runs
// the commands and sends the request.
//
// Upstream (nunomaduro/dev-null.sh at 3e55ca6), `POST /api/cli/commits`:
// AuthenticateSshSignature answers 401 when the signature, payload, timestamp
// or nonce is refused, or the key is on no /dev/null user's GitHub account
// (SignedCommits, SshSignatures). ThrottleCommits answers 429 with
// `Retry-After` past 10 commits a minute, counted across every way of posting.
// CreateCliCommitRequest answers 422 for a body outside 1 to 4000 characters
// and for a reply reference that names no commit the user can see, or more
// than one (CommitReference). bootstrap/app.php answers 503 when GitHub could
// not be reached to check the key, and 500 for anything else that failed. The
// route itself never answers 404: that comes only from a request that did not
// reach this route. Every error body is plain text, and none of it is shown.

import type { HttpInit, HttpResponse } from 'claude-code'

import { retryAfterSeconds } from './backoff'
import { readCommitted } from './committed'
import type { Committed } from './committed'
import { ORIGIN } from './links'

export const COMMITS_URL = `${ORIGIN}/api/cli/commits`

export const SIGN_NAMESPACE = 'devnull-commit'

export const MKTEMP_DIR = ['mktemp', '-d'] as const

/** mktemp, rm and rmdir answer at once; 5 s only bounds a stuck file system. */
export const FILE_COMMAND_TIMEOUT_MS = 5000

/**
 * How long ssh-keygen may take to sign. Through the agent it takes some 20 ms,
 * but a key added with `ssh-add -c` (or an agent that asks for a touch or a
 * password, as some desktop agents do) waits until the person confirms in a
 * dialog. A minute leaves time to read and confirm it, and keeps the signed
 * timestamp well inside the 300 s dev-null.sh accepts.
 */
export const SIGN_TIMEOUT_MS = 60_000

export const SIGNING_KEY_FILE = 'signing.pub'

// What `mktemp -d` prints: `$TMPDIR` (or /tmp) and `tmp.` with random letters
// and digits, then a newline. GNU coreutils makes 10 of them (`tmp.XXXXXXXXXX`,
// checked with coreutils 8.32); macOS makes 10 (shell_cmds mktemp.c today) or 8
// (shell_cmds-207, macOS 10.15); busybox, Alpine's mktemp, makes 6
// (`tmp.XXXXXX` in coreutils/mktemp.c, and BusyBox 1.30.1 here), from glibc's
// letters and digits or musl's A-P and a-p. Each folder above it is visible
// ASCII with no `/`, and neither `.` nor `..`; anything else is refused, never
// repaired.
const TEMP_DIR = /^((?:\/[!-.0-~]+)*\/+tmp\.[A-Za-z0-9]{6,10})\n$/

/** The directory `mktemp -d` made, from its standard output, or undefined for any other output. */
export function readTempDir(stdout: string): string | undefined {
  const dir = TEMP_DIR.exec(stdout)?.[1]
  if (dir === undefined) return undefined
  if (dir.split('/').some(part => part === '.' || part === '..')) return undefined

  return dir
}

export function signingKeyPath(dir: string): string {
  return `${dir}/${SIGNING_KEY_FILE}`
}

/**
 * `ssh-keygen -Y sign` over standard input with the public key at `keyPath`.
 * No private key lies next to it, so ssh-keygen can only ask the agent, and
 * never prompts for a passphrase (CLAUDE.md, signing a commit).
 */
export function signArgv(keyPath: string): string[] {
  return ['ssh-keygen', '-Y', 'sign', '-n', SIGN_NAMESPACE, '-f', keyPath]
}

/** Removes the one file by name; `-f` so a file that was never written is not an error. */
export function removeFileArgv(path: string): string[] {
  return ['rm', '-f', '--', path]
}

/** Removes the directory only when it is empty: nothing is deleted recursively. */
export function removeDirArgv(dir: string): string[] {
  return ['rmdir', '--', dir]
}

export function commitRequest(payload: string, signature: string): HttpInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'text/plain', 'X-SSH-Signature': signature },
    body: payload,
  }
}

export type PostOutcome =
  | { kind: 'committed'; committed: Committed }
  | { kind: 'unexpected-201' }
  | { kind: 'unauthorized' }
  | { kind: 'not-found' }
  | { kind: 'refused' }
  | { kind: 'rate-limited'; retryAfterSeconds: number | undefined }
  | { kind: 'server-error'; status: number }
  | { kind: 'other'; status: number | undefined }

/**
 * What dev-null.sh's answer to a posted commit means. Only a 201 whose body
 * readCommitted accepts is a commit; the body of any other answer is not read.
 */
export function readPostAnswer(response: Pick<HttpResponse, 'status' | 'headers' | 'text'>): PostOutcome {
  const { status } = response
  if (status === 201) {
    const committed = readCommitted(response.text)

    return committed === undefined ? { kind: 'unexpected-201' } : { kind: 'committed', committed }
  }
  if (status === 401) return { kind: 'unauthorized' }
  if (status === 404) return { kind: 'not-found' }
  if (status === 422) return { kind: 'refused' }
  if (status === 429) return { kind: 'rate-limited', retryAfterSeconds: retryAfterSeconds(response.headers['retry-after']) }
  if (Number.isInteger(status) && status >= 500 && status <= 599) return { kind: 'server-error', status }

  return { kind: 'other', status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined }
}

export type Subcommand = { name: string; description: string }

/** The subcommands completed after `/devnull `, with the line beside each. */
export const SUBCOMMANDS: readonly Subcommand[] = [
  { name: 'commit', description: 'post a commit, signed with your SSH key' },
  { name: 'reply', description: 'reply to a commit by its hash or link' },
  { name: 'setup', description: 'choose your signing key and /dev/null username' },
]

export type CompletionPlace = 'subcommand' | 'reply-hash' | 'none'

/**
 * What the token starting at `start` in the draft `text` is: the first word
 * after `/devnull `, the second after `/devnull reply `, or neither.
 */
export function completionPlace(text: string, start: number): CompletionPlace {
  const before = text.slice(0, start)
  if (/^\/devnull +$/.test(before)) return 'subcommand'
  if (/^\/devnull +reply +$/.test(before)) return 'reply-hash'

  return 'none'
}

/** Completion rows for the subcommands that start with `token`. */
export function matchSubcommands(token: string): { text: string; label: string; description: string }[] {
  return SUBCOMMANDS.filter(one => one.name.startsWith(token)).map(one => ({
    text: one.name,
    label: one.name,
    description: one.description,
  }))
}

/** Whether a proposed prompt would run `/devnull` (any case, after any blank space). */
export function isDevnullPrompt(text: string): boolean {
  return text.trim().toLowerCase().startsWith('/devnull')
}
