// `/devnull setup`: list the SSH agent's keys, or choose one of them and the
// /dev/null username once dev-null.sh confirms it knows the key and has a user
// of that username. The hook only checks who asked and hands `runSetup` the
// four things it may do outside the mod: run `ssh-add -L`, send the key
// lookup, ask for the profile, and keep the choice, besides reading and
// setting the mod's one 429 hold (pane-core).
//
// The profile GET is on the public API, whose per-IP limit the pane and the
// reply alerts share: while the hold is in force it is not sent, and its own
// 429 with Retry-After sets the hold. The key lookup has a throttle of its own
// (`/api/cli/key-lookups`), so its 429 sets no hold; but while the hold is in
// force setup sends nothing at all, as the profile GET it leads to would be
// held anyway.

import type { HttpResponse, On, ProcessRunResult } from 'claude-code'

import { ACCOUNT_KEY } from './lib/account'
import type { Account } from './lib/account'
import { SSH_ADD_LIST, SSH_ADD_TIMEOUT_MS, readAgentList } from './lib/agent'
import type { AgentList } from './lib/agent'
import { FAILED_TEXT, isTypedByPerson, notTypedText, splitSubcommand, splitWords } from './lib/command'
import { findKey, parseKeyChoice } from './lib/keys'
import type { AgentKey } from './lib/keys'
import { KEY_LOOKUP_URL, keyLookupRequest, readLookup } from './lib/lookup'
import type { LookupOutcome } from './lib/lookup'
import { PROFILE_REQUEST, readProfile, userProfileUrl } from './lib/user'
import type { ProfileOutcome } from './lib/user'
import { holdRequestsUntil, readNotBefore } from './pane-core'

const LIST_USAGE = '/devnull setup                    list the keys in your SSH agent'
const CHOOSE_USAGE = '/devnull setup <key> <username>   sign with that key (its number or SHA256: fingerprint) as that /dev/null user'

export const SETUP_USAGE: readonly string[] = [LIST_USAGE, CHOOSE_USAGE]

const CHOOSE_LINE = 'Choose one with /devnull setup <number or SHA256:fingerprint> <your /dev/null username>'

export const SSH_ADD_FAILED_TEXT =
  'Could not run ssh-add, or it did not answer within 5 seconds. /devnull needs OpenSSH (ssh-add on your PATH) and a running SSH agent.'

export const AGENT_UNREACHABLE_TEXT = [
  'No SSH agent answered. /devnull signs through your SSH agent and never reads a private key file.',
  'Start an agent in the shell you run Claude Code from (eval "$(ssh-agent)"), add the Ed25519 or RSA key that is on your GitHub account with ssh-add <path to the key>, then run /devnull setup again.',
].join('\n')

export const NO_USABLE_KEY_TEXT = [
  'Your SSH agent holds no Ed25519 key, or RSA key of 2048 bits or more. /devnull signs through your SSH agent and never reads a private key file.',
  'Add the key that is on your GitHub account with ssh-add <path to the key> (ssh-add -L lists what the agent holds), then run /devnull setup again.',
].join('\n')

export const BAD_ARGS_TEXT = ['Usage:', ...SETUP_USAGE.map(line => `  ${line}`)].join('\n')

export const BAD_CHOICE_TEXT =
  'Choose the key by its number in the list /devnull setup prints, or by its fingerprint (SHA256: and 43 characters).'

export const BAD_USERNAME_TEXT = 'A /dev/null username is 1 to 39 letters, digits or hyphens, as on GitHub.'

export const KEY_NOT_IN_AGENT_TEXT =
  'Your SSH agent does not hold that key now, so nothing was saved. Run /devnull setup to list the keys it holds.'

export const LOOKUP_UNREACHABLE_TEXT =
  'Could not reach dev-null.sh, so nothing was saved. Check your connection and run /devnull setup again.'

export const MISMATCH_TEXT =
  'dev-null.sh answered, but not with the key that was sent, so nothing was saved. Run /devnull setup again later.'

export const NOT_FOUND_TEXT = [
  'This key is not on the GitHub account of a /dev/null user, so nothing was saved.',
  'Add it on GitHub (Settings, SSH and GPG keys), sign in on https://dev-null.sh again, then run /devnull setup again.',
].join('\n')

export const USER_NOT_FOUND_TEXT = [
  'No /dev/null user has that username, so nothing was saved.',
  'Usernames are case-sensitive: type yours exactly as your profile on https://dev-null.sh shows it, then run /devnull setup again.',
].join('\n')

export const OTHER_USER_TEXT =
  'dev-null.sh answered with a profile, but not of the username that was asked for, so nothing was saved. Run /devnull setup again later.'

export const STORE_FAILED_TEXT = 'dev-null.sh knows this key and this username, but saving your choice failed. Run /devnull setup again.'

/** What setup may do outside the mod, each bound to one fixed call on `$`. */
export type SetupIo = {
  listAgentKeys: () => Promise<ProcessRunResult>
  lookUpKey: (publicKey: string) => Promise<HttpResponse>
  /** Asks for the profile at that URL, one userProfileUrl built. */
  lookUpUser: (url: string) => Promise<HttpResponse>
  saveAccount: (account: Account) => Promise<void>
  now: () => Promise<number>
  /** When the mod's requests may go out again after a 429; 0 when nothing asked to wait. */
  readNotBefore: () => Promise<number>
  /** Holds the mod's requests back until `atMs`, or later when they are already. */
  holdUntil: (atMs: number) => Promise<unknown>
  /** A line for the debug log alone. */
  log: (text: string) => void
}

export function registerSetup(on: On): void {
  on('command.run', { command: 'devnull' }, async ($, e, next) => {
    const { name, rest } = splitSubcommand(e.args)
    if (name !== 'setup') return next(e)
    if (!isTypedByPerson(e.origin)) return { text: notTypedText('setup') }

    const io: SetupIo = {
      listAgentKeys: () => $.process.run(SSH_ADD_LIST, { timeoutMs: SSH_ADD_TIMEOUT_MS }),
      lookUpKey: publicKey => $.http.fetch(KEY_LOOKUP_URL, keyLookupRequest(publicKey)),
      lookUpUser: url => $.http.fetch(url, PROFILE_REQUEST),
      saveAccount: account => $.store.set(ACCOUNT_KEY, account),
      now: () => $.clock.now(),
      readNotBefore: () => readNotBefore($),
      holdUntil: atMs => holdRequestsUntil($, atMs),
      log: text => $.ui.log(text, { to: 'debug' }),
    }

    return { text: await runSetup(io, rest) }
  }).catch(($, e, next) => (next.called ? next(e) : { text: FAILED_TEXT }))
}

/** Setup's answer to what followed `/devnull setup`. */
export async function runSetup(io: SetupIo, rest: string): Promise<string> {
  const words = splitWords(rest)
  if (words.length === 0) return listKeys(io)
  const [choiceText, username] = words
  if (words.length !== 2 || choiceText === undefined || username === undefined) return BAD_ARGS_TEXT

  return chooseKey(io, choiceText, username)
}

async function listKeys(io: SetupIo): Promise<string> {
  const agent = await readAgent(io)
  if (agent.kind !== 'keys') return agentProblemText(agent)

  return [
    'Keys in your SSH agent:',
    ...agent.keys.map((key, index) => `  ${index + 1}  ${describeKey(key)}`),
    '',
    CHOOSE_LINE,
  ].join('\n')
}

async function chooseKey(io: SetupIo, choiceText: string, username: string): Promise<string> {
  const choice = parseKeyChoice(choiceText)
  if (choice === undefined) return BAD_CHOICE_TEXT
  const profileUrl = userProfileUrl(username)
  if (profileUrl === undefined) return BAD_USERNAME_TEXT

  // The key must be in the agent now: it is the one that will sign.
  const agent = await readAgent(io)
  if (agent.kind !== 'keys') return agentProblemText(agent)
  const key = findKey(agent.keys, choice)
  if (key === undefined) return KEY_NOT_IN_AGENT_TEXT

  const heldFor = await heldSecondsOf(io)
  if (heldFor !== undefined) return heldText(heldFor)

  let outcome: LookupOutcome
  try {
    outcome = readLookup(key.publicKey, await io.lookUpKey(key.publicKey))
  } catch {
    return LOOKUP_UNREACHABLE_TEXT
  }

  switch (outcome.kind) {
    case 'found':
      return checkUserAndSave(io, key, username, profileUrl)
    case 'mismatch':
      return MISMATCH_TEXT
    case 'not-found':
      return NOT_FOUND_TEXT
    case 'rate-limited':
      return rateLimitedText(outcome.retryAfterSeconds)
    case 'failed':
      return failedText(outcome.status)
    default: {
      const unknownOutcome: never = outcome

      return unknownOutcome
    }
  }
}

/** Once the key is known: saves the choice only when dev-null.sh has a user of exactly that username. */
async function checkUserAndSave(io: SetupIo, key: AgentKey, username: string, profileUrl: string): Promise<string> {
  // A poll or the pane may have met a 429 while the key lookup was out.
  const heldFor = await heldSecondsOf(io)
  if (heldFor !== undefined) return heldText(heldFor)

  let outcome: ProfileOutcome
  try {
    outcome = readProfile(username, await io.lookUpUser(profileUrl))
  } catch {
    return LOOKUP_UNREACHABLE_TEXT
  }

  switch (outcome.kind) {
    case 'found': {
      try {
        await io.saveAccount({ fingerprint: key.fingerprint, publicKey: key.publicKey, username })
      } catch {
        return STORE_FAILED_TEXT
      }

      return savedText(key, username)
    }
    case 'other-user':
      return OTHER_USER_TEXT
    case 'not-found':
      return USER_NOT_FOUND_TEXT
    case 'rate-limited':
      await holdAfter429(io, outcome.retryAfterSeconds)

      return rateLimitedText(outcome.retryAfterSeconds)
    case 'failed':
      return failedText(outcome.status)
    default: {
      const unknownOutcome: never = outcome

      return unknownOutcome
    }
  }
}

/** The seconds left of the mod's 429 hold, rounded up, or undefined when it is not in force. */
async function heldSecondsOf(io: SetupIo): Promise<number | undefined> {
  const notBeforeMs = await io.readNotBefore()
  const now = await io.now()

  return now < notBeforeMs ? Math.ceil((notBeforeMs - now) / 1000) : undefined
}

/** The profile's 429 with a usable Retry-After holds the pane and the reply alerts back too. */
async function holdAfter429(io: SetupIo, retryAfterSeconds: number | undefined): Promise<void> {
  if (retryAfterSeconds === undefined) return
  try {
    await io.holdUntil((await io.now()) + retryAfterSeconds * 1000)
  } catch {
    io.log('devnull: a 429 on the profile lookup could not hold the mod\'s other requests back.')
  }
}

async function readAgent(io: SetupIo): Promise<AgentList> {
  let result: ProcessRunResult
  try {
    result = await io.listAgentKeys()
  } catch {
    // ssh-add could not start, or outlived its timeout.
    return { kind: 'failed' }
  }

  return readAgentList(result.exitCode, result.stdout)
}

function agentProblemText(agent: Exclude<AgentList, { kind: 'keys' }>): string {
  switch (agent.kind) {
    case 'no-usable-key':
      return NO_USABLE_KEY_TEXT
    case 'unreachable':
      return AGENT_UNREACHABLE_TEXT
    case 'failed':
      return SSH_ADD_FAILED_TEXT
    default: {
      const unknownAgent: never = agent

      return unknownAgent
    }
  }
}

function describeKey(key: AgentKey): string {
  const parts = [key.fingerprint, key.type.padEnd(11)]
  if (key.comment !== '') parts.push(key.comment)

  return parts.join('  ').trimEnd()
}

export function savedText(key: AgentKey, username: string): string {
  return [
    `Saved. /devnull will sign with ${describeKey(key)}`,
    `and post as ${username}. dev-null.sh knows this key and this username; your first post shows whether they belong together.`,
  ].join('\n')
}

export function heldText(seconds: number): string {
  return `dev-null.sh asked to wait, so nothing was sent and nothing was saved. Run /devnull setup again in ${seconds} seconds.`
}

export function rateLimitedText(retryAfterSeconds: number | undefined): string {
  const when = retryAfterSeconds === undefined ? 'in a minute' : `in ${retryAfterSeconds} seconds`

  return `dev-null.sh is limiting requests right now, so nothing was saved. Run /devnull setup again ${when}.`
}

export function failedText(status: number | undefined): string {
  const answer = status === undefined ? 'an unexpected answer' : `status ${status}`

  return `dev-null.sh answered with ${answer}, so nothing was saved. Run /devnull setup again later.`
}
