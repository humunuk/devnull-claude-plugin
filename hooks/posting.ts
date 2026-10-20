// `/devnull commit <text>` and `/devnull reply <hash or link> <text>`: sign the
// commit through the SSH agent with the key setup chose, and post it. The
// command hook only checks who asked and hands `runPosting` the calls on `$`
// it may make; the pane's input posts through the same `postCommit`. After a
// commit, an open pane loads its list again. The same module completes
// `/devnull` subcommands and reply hashes in the prompt box, and drops every
// proposed prompt that would run `/devnull`, so a suggestion the model wrote
// is never a Tab and an Enter away from a post (security rule 1).

import type {
  EngineInterface,
  HttpResponse,
  On,
  ProcessRunResult,
  PromptAutocompleteInput,
  PromptAutocompleteSuggestion,
} from 'claude-code'

import type { RecentCommits } from '../types'

import { ACCOUNT_KEY, parseAccount } from './lib/account'
import type { Account } from './lib/account'
import { SSH_ADD_LIST, SSH_ADD_TIMEOUT_MS, readAgentList } from './lib/agent'
import type { AgentList } from './lib/agent'
import { FAILED_TEXT, isTypedByPerson, notTypedText, splitSubcommand } from './lib/command'
import type { AgentKey } from './lib/keys'
import { commitUrl, profileUrl } from './lib/links'
import { BODY_MAX, NONCE_BYTES, buildPayload, checkBody, newNonce, parseReplyReference } from './lib/payload'
import {
  COMMITS_URL,
  FILE_COMMAND_TIMEOUT_MS,
  MKTEMP_DIR,
  SIGN_TIMEOUT_MS,
  commitRequest,
  completionPlace,
  isDevnullPrompt,
  matchSubcommands,
  readPostAnswer,
  readTempDir,
  removeDirArgv,
  removeFileArgv,
  signArgv,
  signingKeyPath,
} from './lib/posting'
import type { PostOutcome, PostResult } from './lib/posting'
import { matchHashes } from './lib/recent'
import { readSignature } from './lib/signature'
import { reloadPaneIfOpen } from './pane-core'
import { readRecent } from './recent'
import { SSH_ADD_FAILED_TEXT } from './setup'

const COMMIT_USAGE = '/devnull commit <text>            post <text> to /dev/null, signed with your SSH key'
const REPLY_USAGE = '/devnull reply <hash> <text>      reply to the commit with that hash (or link)'

export const POSTING_USAGE: readonly string[] = [COMMIT_USAGE, REPLY_USAGE]

export type PostingName = 'commit' | 'reply'

export const COMMIT_EMPTY_TEXT = 'Nothing to post. Usage: /devnull commit <text>'

export const REPLY_EMPTY_TEXT = 'Nothing to post. Usage: /devnull reply <hash or link> <text>'

export const BAD_REFERENCE_TEXT =
  'Reply to a commit by its hash (7 to 12 hex characters, as shown on dev-null.sh) or by its https://dev-null.sh/ link.'

export const NO_ACCOUNT_TEXT = 'Run /devnull setup first, to choose your signing key and your /dev/null username.'

export const AGENT_UNREACHABLE_TEXT =
  'No SSH agent answered, so nothing was posted. /devnull signs through your SSH agent: start one in the shell you run Claude Code from (eval "$(ssh-agent)"), add your key with ssh-add <path to the key>, and post again.'

export const TEMP_DIR_FAILED_TEXT =
  'Could not make a private temporary folder with mktemp -d, so nothing was posted. Check that your temporary folder (TMPDIR, or /tmp) exists and is writable.'

export const TEMP_DIR_UNRECOGNISED_TEXT =
  'mktemp -d printed a folder this mod does not recognise, so it was not used and nothing was posted. An empty folder made by mktemp may be left in your temporary folder.'

export const CANCELLED_TEXT = 'Not posted: the command was cancelled.'

export const WRITE_FAILED_TEXT = 'Could not write your public key into the temporary folder, so nothing was posted.'

export const SIGN_DID_NOT_FINISH_TEXT =
  'ssh-keygen could not run, or did not sign within 60 seconds, so nothing was posted. If your SSH agent asks you to confirm each use of the key, confirm within a minute. /devnull needs OpenSSH 8.1 or later (ssh -V).'

export const BAD_SIGNATURE_TEXT = 'ssh-keygen printed something other than an SSH signature, so nothing was posted.'

export const PENDING_TEXT = 'It is pending review: only you can see it until it is approved.'

export const UNAUTHORIZED_TEXT = [
  'dev-null.sh did not accept the signature (401), so nothing was posted.',
  'Usually your key is no longer on your GitHub account, or your clock is more than 5 minutes off. Check both, then post again; run /devnull setup if you changed keys.',
].join('\n')

export const NOT_FOUND_TEXT =
  'dev-null.sh answered 404 Not Found to the post, so nothing was posted. Its posting address may have changed: check for an update of this mod.'

export const REFUSED_COMMIT_TEXT =
  'dev-null.sh refused the commit (422), so nothing was posted. A commit is 1 to 4000 characters once blank lines are collapsed.'

export const REFUSED_REPLY_TEXT = [
  'dev-null.sh refused the reply (422), so nothing was posted.',
  'Usually there is no commit with that hash that you can see, or the hash matches several commits: reply with the commit\'s link instead.',
].join('\n')

/** What posting may do outside the mod, each bound to one fixed call on `$`. */
export type PostingIo = {
  readAccount: () => Promise<unknown>
  listAgentKeys: () => Promise<ProcessRunResult>
  makeTempDir: () => Promise<ProcessRunResult>
  writeKey: (path: string, publicKeyLine: string) => Promise<void>
  sign: (keyPath: string, payload: string) => Promise<ProcessRunResult>
  removeFile: (path: string) => Promise<ProcessRunResult>
  removeDir: (dir: string) => Promise<ProcessRunResult>
  nowMs: () => Promise<number>
  send: (payload: string, signature: string) => Promise<HttpResponse>
  /** Whether the person interrupted the run (or the engine gave up on it): then nothing more is started or sent. */
  isAborted: () => boolean
}

/**
 * The calls on `$` a post makes, for the hook that owns that `$`: the command
 * run's, or the pane's drawing (its input). `isAborted` says whether the one
 * who asked gave up; the pane's input has no signal for that.
 */
export function postingIo($: EngineInterface, isAborted: () => boolean): PostingIo {
  return {
    readAccount: () => $.store.get(ACCOUNT_KEY),
    listAgentKeys: () => $.process.run(SSH_ADD_LIST, { timeoutMs: SSH_ADD_TIMEOUT_MS }),
    makeTempDir: () => $.process.run(MKTEMP_DIR, { timeoutMs: FILE_COMMAND_TIMEOUT_MS }),
    writeKey: (path, publicKeyLine) => $.fs.write(path, `${publicKeyLine}\n`),
    sign: (keyPath, payload) => $.process.run(signArgv(keyPath), { stdin: payload, timeoutMs: SIGN_TIMEOUT_MS }),
    removeFile: path => $.process.run(removeFileArgv(path), { timeoutMs: FILE_COMMAND_TIMEOUT_MS }),
    removeDir: dir => $.process.run(removeDirArgv(dir), { timeoutMs: FILE_COMMAND_TIMEOUT_MS }),
    nowMs: () => $.clock.now(),
    send: (payload, signature) => $.http.fetch(COMMITS_URL, commitRequest(payload, signature)),
    isAborted,
  }
}

export function registerPosting(on: On): void {
  on('command.run', { command: 'devnull' }, async ($, e, next) => {
    const { name, rest } = splitSubcommand(e.args)
    if (name !== 'commit' && name !== 'reply') return next(e)
    if (!isTypedByPerson(e.origin)) return { text: notTypedText(name) }

    const result = await postCommit(postingIo($, () => next.signal.aborted), name, rest)
    if (result.committed !== null) await reloadPaneIfOpen($)

    return { text: postingText(result) }
  }).catch(($, e, next) => (next.called ? next(e) : { text: FAILED_TEXT }))

  // The engine's rows are not on this event; the ones from plugins beneath
  // come first, then these.
  on('prompt.autocomplete', async ($, e, next) => {
    const below = await next(e)
    const io: CompletionIo = { readRecent: () => readRecent($), nowMs: () => $.clock.now() }
    const mine = await completionRows(io, e)

    return mine.length === 0 ? below : { suggestions: [...below.suggestions, ...mine] }
  }).catch(($, e, next) => next(e))

  // A guard: it answers before `next`, and drops the proposal if it fails.
  on('prompt.suggest', ($, e, next) => (isDevnullPrompt(e.text) ? { isShown: false } : next(e))).catch(
    ($, e, next) => (next.called ? next(e) : { isShown: false }),
  )
}

/**
 * What completion may read: the recent list the pane and the alerts keep in
 * `$.state`, and the clock for the ages. Nothing else, and no network.
 */
export type CompletionIo = {
  readRecent: () => Promise<RecentCommits | null>
  nowMs: () => Promise<number>
}

/** The mod's rows for the token at the cursor: subcommands, reply hashes, or none. */
export async function completionRows(
  io: CompletionIo,
  e: Pick<PromptAutocompleteInput, 'text' | 'token' | 'start'>,
): Promise<PromptAutocompleteSuggestion[]> {
  const place = completionPlace(e.text, e.start)
  switch (place) {
    case 'none':
      return []
    case 'subcommand':
      return matchSubcommands(e.token)
    case 'reply-hash':
      return matchHashes(await io.readRecent(), e.token, await io.nowMs())
    default: {
      const unknownPlace: never = place

      return unknownPlace
    }
  }
}

/** The answer to `/devnull commit` or `/devnull reply` and what followed it. */
export async function runPosting(io: PostingIo, name: PostingName, rest: string): Promise<string> {
  return postingText(await postCommit(io, name, rest))
}

/** A post's result as the command's answer: `Committed: <link>` first when it went through. */
function postingText(result: PostResult): string {
  const url = result.committed === null ? undefined : commitUrl(result.committed.username, result.committed.id)

  return [...(url === undefined ? [] : [`Committed: ${url}`]), ...result.lines].join('\n')
}

/** Lines alone: nothing went through. */
function notPosted(...lines: string[]): PostResult {
  return { committed: null, lines }
}

/** What `/devnull commit` or `/devnull reply` with what followed it came to. */
export async function postCommit(io: PostingIo, name: PostingName, rest: string): Promise<PostResult> {
  let replyTo: string | undefined
  let body: string
  switch (name) {
    case 'commit':
      body = rest
      break
    case 'reply': {
      const reply = splitSubcommand(rest)
      if (reply.name === '') return notPosted(REPLY_EMPTY_TEXT)
      replyTo = parseReplyReference(reply.name)
      if (replyTo === undefined) return notPosted(BAD_REFERENCE_TEXT)
      body = reply.rest
      break
    }
    default: {
      const unknownName: never = name

      return unknownName
    }
  }

  const bodyCheck = checkBody(body)
  switch (bodyCheck.kind) {
    case 'ok':
      break
    case 'empty':
      return notPosted(name === 'commit' ? COMMIT_EMPTY_TEXT : REPLY_EMPTY_TEXT)
    case 'too-long':
      return notPosted(tooLongText(bodyCheck.length))
    default: {
      const unknownCheck: never = bodyCheck

      return unknownCheck
    }
  }

  const account = parseAccount(await io.readAccount())
  if (account === undefined) return notPosted(NO_ACCOUNT_TEXT)

  const agent = await readAgent(io)
  if (agent.kind === 'unreachable') return notPosted(AGENT_UNREACHABLE_TEXT)
  if (agent.kind === 'failed') return notPosted(SSH_ADD_FAILED_TEXT)
  const key = agent.kind === 'keys' ? agent.keys.find(one => one.fingerprint === account.fingerprint) : undefined
  if (key === undefined) return notPosted(keyNotInAgentText(account.fingerprint))

  const payload = buildPayload({
    unixSeconds: Math.floor((await io.nowMs()) / 1000),
    nonce: newNonce(crypto.getRandomValues(new Uint8Array(NONCE_BYTES))),
    replyTo,
    body,
  })

  // Not even asking the agent once the run was abandoned: a key added with
  // `ssh-add -c` would show its confirmation for a post nobody wants.
  if (io.isAborted()) return notPosted(CANCELLED_TEXT)

  const signing = await signPayload(io, key, payload)
  const cleanupNote = signing.leftBehind === undefined ? [] : [leftBehindText(signing.leftBehind)]
  // Signing can wait up to a minute for a confirmation; an interrupt in that
  // time must not end in a post. Next.signal aborts when the person interrupts
  // (or a hook above settled first); the dispatch has then moved on, so this
  // text may never be shown, but nothing is sent.
  if (io.isAborted()) return notPosted(CANCELLED_TEXT, ...cleanupNote)
  if (signing.result.kind !== 'signed') return notPosted(signFailedText(signing.result), ...cleanupNote)

  let response: HttpResponse
  try {
    response = await io.send(payload, signing.result.signature)
  } catch {
    return notPosted(unreachableText(account.username), ...cleanupNote)
  }
  const posted = postedResult(readPostAnswer(response), name, account)

  return { committed: posted.committed, lines: [...posted.lines, ...cleanupNote] }
}

async function readAgent(io: PostingIo): Promise<AgentList> {
  let result: ProcessRunResult
  try {
    result = await io.listAgentKeys()
  } catch {
    // ssh-add could not start, or outlived its timeout.
    return { kind: 'failed' }
  }

  return readAgentList(result.exitCode, result.stdout)
}

type SignResult =
  | { kind: 'signed'; signature: string }
  | { kind: 'no-temp-dir' }
  | { kind: 'unrecognised-temp-dir' }
  | { kind: 'write-failed' }
  | { kind: 'did-not-finish' }
  | { kind: 'exited'; exitCode: number }
  | { kind: 'bad-signature' }

/**
 * Signs `payload` with `key` through the agent, from a fresh temporary
 * directory that holds only the public key, and removes both afterwards
 * whatever happened. `leftBehind` names the directory when removing failed.
 */
async function signPayload(
  io: PostingIo,
  key: AgentKey,
  payload: string,
): Promise<{ result: SignResult; leftBehind: string | undefined }> {
  let made: ProcessRunResult
  try {
    made = await io.makeTempDir()
  } catch {
    return { result: { kind: 'no-temp-dir' }, leftBehind: undefined }
  }
  if (made.exitCode !== 0) return { result: { kind: 'no-temp-dir' }, leftBehind: undefined }
  const dir = readTempDir(made.stdout)
  // Output that is not a path mktemp makes is not used as one, not even to
  // clean up, and not shown: the folder it may have made stays behind.
  if (dir === undefined) return { result: { kind: 'unrecognised-temp-dir' }, leftBehind: undefined }

  const keyPath = signingKeyPath(dir)
  let result: SignResult = { kind: 'did-not-finish' }
  let isRemoved = false
  try {
    result = await signWithKeyFile(io, keyPath, key.publicKey, payload)
  } finally {
    isRemoved = await removeTempDir(io, dir, keyPath)
  }

  return { result, leftBehind: isRemoved ? undefined : dir }
}

async function signWithKeyFile(io: PostingIo, keyPath: string, publicKey: string, payload: string): Promise<SignResult> {
  try {
    await io.writeKey(keyPath, publicKey)
  } catch {
    return { kind: 'write-failed' }
  }

  let signed: ProcessRunResult
  try {
    signed = await io.sign(keyPath, payload)
  } catch {
    // ssh-keygen could not start, or was killed at the timeout.
    return { kind: 'did-not-finish' }
  }
  if (signed.exitCode !== 0) return { kind: 'exited', exitCode: signed.exitCode }
  const signature = readSignature(signed.stdout)

  return signature === undefined ? { kind: 'bad-signature' } : { kind: 'signed', signature }
}

/** Removes the key file by name, then the directory if it is empty; whether both are gone. */
async function removeTempDir(io: PostingIo, dir: string, keyPath: string): Promise<boolean> {
  const isFileRemoved = await succeeds(() => io.removeFile(keyPath))
  // Tried even when the file was not removed: rmdir only removes an empty directory.
  const isDirRemoved = await succeeds(() => io.removeDir(dir))

  return isFileRemoved && isDirRemoved
}

async function succeeds(run: () => Promise<ProcessRunResult>): Promise<boolean> {
  try {
    return (await run()).exitCode === 0
  } catch {
    return false
  }
}

function postedResult(outcome: PostOutcome, name: PostingName, account: Account): PostResult {
  switch (outcome.kind) {
    case 'committed': {
      const { username, id, isPending } = outcome.committed
      if (commitUrl(username, id) === undefined) return notPosted(unexpectedText(undefined, account.username))
      const lines: string[] = []
      if (isPending) lines.push(PENDING_TEXT)
      if (username !== account.username) lines.push(otherUsernameText(username, account.username))

      return { committed: { username, id }, lines }
    }
    case 'unexpected-201':
      return notPosted(unexpectedText(201, account.username))
    case 'unauthorized':
      return notPosted(UNAUTHORIZED_TEXT)
    case 'not-found':
      return notPosted(NOT_FOUND_TEXT)
    case 'refused':
      return notPosted(name === 'commit' ? REFUSED_COMMIT_TEXT : REFUSED_REPLY_TEXT)
    case 'rate-limited':
      return notPosted(rateLimitedText(outcome.retryAfterSeconds))
    case 'server-error':
      return notPosted(serverErrorText(outcome.status, account.username))
    case 'other':
      return notPosted(unexpectedText(outcome.status, account.username))
    default: {
      const unknownOutcome: never = outcome

      return unknownOutcome
    }
  }
}

function signFailedText(result: Exclude<SignResult, { kind: 'signed' }>): string {
  switch (result.kind) {
    case 'no-temp-dir':
      return TEMP_DIR_FAILED_TEXT
    case 'unrecognised-temp-dir':
      return TEMP_DIR_UNRECOGNISED_TEXT
    case 'write-failed':
      return WRITE_FAILED_TEXT
    case 'did-not-finish':
      return SIGN_DID_NOT_FINISH_TEXT
    case 'exited':
      return signExitedText(result.exitCode)
    case 'bad-signature':
      return BAD_SIGNATURE_TEXT
    default: {
      const unknownResult: never = result

      return unknownResult
    }
  }
}

export function tooLongText(length: number): string {
  return `That is ${length} characters; /dev/null takes at most ${BODY_MAX}. Nothing was posted.`
}

export function keyNotInAgentText(fingerprint: string): string {
  return [
    `Your SSH agent does not hold the key you chose in /devnull setup (${fingerprint}), so nothing was posted.`,
    'Add it with ssh-add <path to the key>, or run /devnull setup to choose another.',
  ].join('\n')
}

export function signExitedText(exitCode: number): string {
  return [
    `ssh-keygen could not sign (exit status ${exitCode}), so nothing was posted.`,
    'Check that your SSH agent still holds the key (ssh-add -L), that you confirmed its use if it asks, and that OpenSSH is 8.1 or later (ssh -V).',
  ].join('\n')
}

export function leftBehindText(dir: string): string {
  return `Could not remove the temporary folder ${dir}, which holds only your public key. Remove it by hand.`
}

/** Where to look before posting again, when it is not known whether the commit went through. */
function checkProfile(username: string): string {
  const url = profileUrl(username)

  return url === undefined ? 'Check your profile on dev-null.sh' : `Check ${url}`
}

export function unreachableText(username: string): string {
  return `Could not reach dev-null.sh, or it did not answer within 30 seconds. The commit may still have arrived: ${checkProfile(username)} before posting it again.`
}

export function unexpectedText(status: number | undefined, username: string): string {
  const answer = status === undefined ? 'an unexpected answer' : `status ${status}`

  return `dev-null.sh answered with ${answer}, not the confirmation of a commit. ${checkProfile(username)} to see whether it was posted before posting it again.`
}

export function serverErrorText(status: number, username: string): string {
  return `dev-null.sh could not take the commit (status ${status}); it was most likely not posted. ${checkProfile(username)}, then try again in a minute.`
}

export function rateLimitedText(retryAfterSeconds: number | undefined): string {
  const when = retryAfterSeconds === undefined ? 'in a minute' : `in ${retryAfterSeconds} seconds`

  return `dev-null.sh takes 10 commits a minute, counting every way you post, so nothing was posted. Try again ${when}.`
}

export function otherUsernameText(postedAs: string, saved: string): string {
  return `Note: dev-null.sh posted this as ${postedAs}, but /devnull setup saved the username ${saved}. Run /devnull setup again to save ${postedAs}.`
}
