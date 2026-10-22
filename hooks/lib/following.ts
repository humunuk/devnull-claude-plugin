// The Following tab's pure parts: the follow list's address and guard, the one
// round in flight and the minute between rounds, which commits of the
// followed people's lists count, and what the tab draws. Pure:
// hooks/pane-core.ts fetches and keeps the round, hooks/pane.tsx draws it.
//
// The follow list is `GET /api/v1/users/{username}/following`: the people the
// user follows, newest follow first, 30 a page (KNOWLEDGE_BASE.md of
// dev-null-sh/dev-null.sh, "Public read API and Atom feeds"). Read live on
// 2026-10-20, its body is `data`, one profile per item, beside `links` and
// `meta`. The mod reads each item's `username` alone and copies nothing else
// (security rule 5).

import type { PluginState, RenderSurface } from 'claude-code'

import type { CommitSummary, FollowingRound } from '../../types'
import { USERNAME } from './account'
import { pollDelayMs, retryAfterSeconds } from './backoff'
import { ORIGIN } from './links'
import { NETWORK_TEXT, NOT_SET_UP_TEXT, drawnCommit, heldSecondsLeft, heldText, waitText } from './pane'
import type { CommitsResponse, PaneCommit, PaneProblem } from './pane'
import { newestFirst } from './recent'
import { relativeAge } from './text'

/** Where the round stands, as the `$.state` contract declares it. */
export type FollowingState = PluginState['devnull']['following']

/** What asked for a round: the tab shown (an open, a switch) or an r on it. */
export type RoundTrigger = 'show' | 'refresh'

/** A round asks for the commit lists of at most this many of the people followed, the newest follows. */
export const FOLLOWED_MAX = 20

/** The most commits the tab draws. */
export const FOLLOWING_DRAWN_MAX = 30

/** The follow list's page size (KNOWLEDGE_BASE.md, "Public read API and Atom feeds"): a longer list is not one the endpoint answers. */
export const FOLLOW_PAGE_MAX = 30

/**
 * A round starts at most this long after the one before it started; after
 * rounds that a 5xx or a network failure stopped, twice as long for each in a
 * row, up to 15 minutes (pollDelayMs).
 */
export const ROUND_MIN_MS = 60_000

/**
 * A round that has not moved on for this long is taken as lost: each step
 * waits for at most one other request of the pane, then its own, and
 * $.http.fetch rejects each after 30 s. Only a round whose answer never came
 * back (the mod reloaded under it) is this still.
 */
export const ROUND_STALE_MS = 65_000

export const FOLLOWING_IDLE_TEXT = 'Press r to load the commits of the people you follow.'
export const FOLLOWING_LOADING_TEXT = 'Loading the commits of the people you follow\u2026'
export const FOLLOWING_NOBODY_TEXT = 'You follow nobody on /dev/null yet.'
export const FOLLOWING_NONE_POSTED_TEXT = 'Nobody you follow has posted yet.'
export const FOLLOWING_CUT_TEXT = 'dev-null.sh asked to slow down, so this round stopped early: the people loaded before that are shown.'
export const FOLLOWING_UNREADABLE_TEXT = 'dev-null.sh answered with a follow list the mod could not read. Press r to retry.'
export const FOLLOWING_LOCAL_TEXT = "Couldn't load the people you follow: Claude Code refused a step. Press r to retry."

export function followingStatusText(status: number): string {
  return `Couldn't load the people you follow (HTTP ${status}). Press r to retry.`
}

/** How many of the people a round set out to load could not be. */
export function notLoadedText(failed: number, people: number): string {
  return `${failed} of ${people} people could not be loaded`
}

/** What an r too soon after the last round gets. */
export function roundWaitText(seconds: number): string {
  return `wait ${seconds}s`
}

/** `https://dev-null.sh/api/v1/users/<username>/following`, or undefined when the username is not valid. */
export function userFollowingUrl(username: string): string | undefined {
  if (!USERNAME.test(username)) return undefined

  return `${ORIGIN}/api/v1/users/${username}/following`
}

/**
 * The people in a follow list's body, in its order, each a username or null
 * for one the mod cannot use; undefined when the body is not such a list.
 */
export function parseFollowList(text: string): (string | null)[] | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }

  return readFollowList(value)
}

/**
 * The people in a parsed follow list, or undefined when the body or any one
 * item is not what the mod expects, a name comes twice, or the list is longer
 * than a page: there is no partial list. A username that is a string but
 * fails the username pattern is null: dev-null.sh renames an account whose
 * GitHub handle someone else took to `_renamed-<id>`
 * (app/Actions/UpdateStaleUsernames.php at 230c004), and such a person is
 * left out and counted, never asked for. Every field but `username` is
 * passed over.
 */
export function readFollowList(value: unknown): (string | null)[] | undefined {
  if (!isRecord(value)) return undefined
  const data: unknown = Reflect.get(value, 'data')
  if (!Array.isArray(data) || data.length > FOLLOW_PAGE_MAX) return undefined

  const seen = new Set<string>()
  const people: (string | null)[] = []
  for (const item of data) {
    if (!isRecord(item)) return undefined
    const username: unknown = Reflect.get(item, 'username')
    if (typeof username !== 'string' || seen.has(username)) return undefined
    seen.add(username)
    people.push(USERNAME.test(username) ? username : null)
  }

  return people
}

export type FollowAnswer = { kind: 'list'; usernames: (string | null)[] } | { kind: 'problem'; problem: PaneProblem }

/** Whether a failed list calls for backing off: a 5xx, or no answer at all. */
export function isBackOffProblem(problem: PaneProblem): boolean {
  return problem.kind === 'network' || (problem.kind === 'status' && problem.status >= 500 && problem.status <= 599)
}

/**
 * What the follow list's answer means, as the pane reads its own commit list:
 * only a 200 whose body is exactly a follow list is one; any other status is
 * kept by its number alone, never its text.
 */
export function readFollowAnswer(response: CommitsResponse): FollowAnswer {
  const { status } = response
  if (status === 200) {
    const usernames = parseFollowList(response.text)

    return usernames === undefined ? { kind: 'problem', problem: { kind: 'unreadable' } } : { kind: 'list', usernames }
  }
  if (!Number.isInteger(status) || status < 100 || status > 599) return { kind: 'problem', problem: { kind: 'unreadable' } }
  const retryAfter = status === 429 ? retryAfterSeconds(response.headers['retry-after']) : undefined

  return { kind: 'problem', problem: { kind: 'status', status, retryAfterSeconds: retryAfter ?? null } }
}

/** The round that ended last, drawn while none newer has; null before the first. */
export function lastRoundOf(state: FollowingState): FollowingRound | null {
  switch (state.kind) {
    case 'idle':
    case 'not-set-up':
      return null
    case 'loading':
      return state.last
    case 'ended':
      return state.last
    default: {
      const unknownState: never = state

      return unknownState
    }
  }
}

/** Whether a round is in flight at `nowMs`: one started and still moving on. */
export function isRoundInFlight(state: FollowingState, nowMs: number): boolean {
  return state.kind === 'loading' && nowMs >= state.steppedAtMs && nowMs - state.steppedAtMs < ROUND_STALE_MS
}

/**
 * The state after a round for `username` was asked for: a new round named
 * `token`; or the current state unchanged while a round is in flight, before
 * the last one's next round is due, or before `notBeforeMs`, when a 429 on
 * any of the pane's requests asked it to wait. An r too soon after a round is
 * marked with when the next is due, so the tab says how long to wait.
 */
export function startRound(
  current: FollowingState,
  username: string,
  token: string,
  nowMs: number,
  trigger: RoundTrigger,
  notBeforeMs: number,
): FollowingState {
  if (isRoundInFlight(current, nowMs)) return current
  const last = lastRoundOf(current)
  const dueAtMs = Math.max(last?.nextAtMs ?? 0, notBeforeMs)
  if (nowMs < dueAtMs) return trigger === 'refresh' && last !== null ? { kind: 'ended', last, waitUntilMs: dueAtMs } : current

  return { kind: 'loading', username, token, startedAtMs: nowMs, steppedAtMs: nowMs, last }
}

/**
 * The state after the round named `token` was stopped before it sent
 * anything: the round before it again, or nothing; any other round's stop
 * changes nothing.
 */
export function dropRound(current: FollowingState, token: string): FollowingState {
  if (current.kind !== 'loading' || current.token !== token) return current

  return current.last === null ? { kind: 'idle' } : { kind: 'ended', last: current.last, waitUntilMs: null }
}

/** The state after the round named `token` moved on at `nowMs`; any other round's step changes nothing. */
export function stepRound(current: FollowingState, token: string, nowMs: number): FollowingState {
  if (current.kind !== 'loading' || current.token !== token) return current

  return { ...current, steppedAtMs: nowMs }
}

/** The state after the round named `token` ended as `round`; any other round's end changes nothing. */
export function endRound(current: FollowingState, token: string, round: FollowingRound): FollowingState {
  if (current.kind !== 'loading' || current.token !== token) return current

  return { kind: 'ended', last: round, waitUntilMs: null }
}

/** The commits of `username`'s list that count: the top-level ones whose author is `username`. */
export function theirCommits(username: string, commits: readonly CommitSummary[]): CommitSummary[] {
  return commits.filter(commit => commit.username === username && commit.parentId === null)
}

/** The commits a round draws: each once by id, newest first, at most 30. */
export function mergeFollowing(commits: readonly CommitSummary[]): CommitSummary[] {
  const byId = new Map<string, CommitSummary>()
  for (const commit of commits) {
    if (!byId.has(commit.id)) byId.set(commit.id, commit)
  }

  return [...byId.values()].sort(newestFirst).slice(0, FOLLOWING_DRAWN_MAX)
}

/**
 * A round that read the follow list. `cut` is set when a 429 stopped it,
 * with the seconds its Retry-After asked for, if it said: the next round
 * waits for those as well as for the minute. `failures` is the rounds in a
 * row, this one included, that a 5xx or a network failure stopped.
 */
export function listRound(parts: {
  username: string
  startedAtMs: number
  endedAtMs: number
  people: number
  failed: number
  cut: { retryAfterSeconds: number | undefined } | undefined
  failures: number
  commits: readonly CommitSummary[]
}): FollowingRound {
  const asked = parts.cut?.retryAfterSeconds

  return {
    username: parts.username,
    startedAtMs: parts.startedAtMs,
    endedAtMs: parts.endedAtMs,
    nextAtMs: nextRoundAtMs(parts.startedAtMs, parts.endedAtMs, asked, parts.failures),
    failures: parts.failures,
    outcome: {
      kind: 'list',
      people: parts.people,
      failed: parts.failed,
      isCut: parts.cut !== undefined,
      commits: mergeFollowing(parts.commits),
    },
  }
}

/** A round whose follow list could not be read; `failures` as for listRound. */
export function failedRound(
  username: string | null,
  problem: PaneProblem,
  startedAtMs: number,
  endedAtMs: number,
  failures: number,
): FollowingRound {
  const asked = problem.kind === 'status' ? problem.retryAfterSeconds ?? undefined : undefined

  return {
    username,
    startedAtMs,
    endedAtMs,
    nextAtMs: nextRoundAtMs(startedAtMs, endedAtMs, asked, failures),
    failures,
    outcome: { kind: 'failed', problem },
  }
}

/**
 * The rounds in a row before this one that a 5xx or a network failure
 * stopped. A round kept in `$.state` by an older copy of the mod has no count.
 */
export function failuresOf(round: FollowingRound | null): number {
  const failures: unknown = round === null ? 0 : round.failures

  return typeof failures === 'number' && Number.isSafeInteger(failures) && failures > 0 ? failures : 0
}

function nextRoundAtMs(startedAtMs: number, endedAtMs: number, retryAfter: number | undefined, failures: number): number {
  const floor = startedAtMs + pollDelayMs({ intervalSeconds: ROUND_MIN_MS / 1000, consecutiveFailures: failures, retryAfter: undefined })

  return retryAfter === undefined ? floor : Math.max(floor, endedAtMs + retryAfter * 1000)
}

/** The commits the last round brought, for the hash completion of `/devnull reply`. */
export function followingCommitsOf(state: FollowingState): CommitSummary[] {
  const last = lastRoundOf(state)

  return last === null || last.outcome.kind !== 'list' ? [] : [...last.outcome.commits]
}

/** One commit as the Following tab draws it: as the Mine tab does, with its author. No `+N new`: alerts are the person's own. */
export type FollowingCommit = Omit<PaneCommit, 'newReplies'> & {
  /** The author's username, which passed the username pattern. */
  author: string
}

/** What the Following tab shows under the header and the tab row. */
export type FollowingView = {
  /** `updated 5m`, `loading\u2026`, or empty. */
  freshness: string
  /** `wait 42s` after an r too soon, or undefined. */
  wait: string | undefined
  /** A fixed state line, when there is one. */
  message: string | undefined
  /** Whether the message tells of a failure. */
  isProblem: boolean
  /** Fixed lines about the last round: lists that failed, a 429 that cut it, how long dev-null.sh asked to wait. */
  notes: string[]
  commits: FollowingCommit[]
}

/**
 * The Following tab's content on `surface` for the round as it stands at
 * `nowMs`. With no round to draw, while the 429 hold (`notBeforeMs`) is in
 * force, it says how long to wait: startRound starts nothing until then.
 */
export function followingView(state: FollowingState, nowMs: number, surface: RenderSurface, notBeforeMs = 0): FollowingView {
  const none = { freshness: '', wait: undefined, isProblem: false, notes: [], commits: [] }
  switch (state.kind) {
    case 'idle': {
      const heldFor = heldSecondsLeft(notBeforeMs, nowMs)

      return { ...none, message: heldFor === undefined ? FOLLOWING_IDLE_TEXT : heldText(heldFor) }
    }
    case 'not-set-up':
      return { ...none, message: NOT_SET_UP_TEXT }
    case 'loading': {
      const commits = state.last === null ? [] : roundCommits(state.last, nowMs, surface)

      return { ...none, freshness: 'loading\u2026', message: commits.length === 0 ? FOLLOWING_LOADING_TEXT : undefined, commits }
    }
    case 'ended': {
      const { last } = state
      const waitMs = state.waitUntilMs === null ? 0 : state.waitUntilMs - nowMs
      const wait = waitMs > 0 ? roundWaitText(Math.ceil(waitMs / 1000)) : undefined

      return { ...roundView(last, nowMs, surface), wait }
    }
    default: {
      const unknownState: never = state

      return unknownState
    }
  }
}

function roundView(round: FollowingRound, nowMs: number, surface: RenderSurface): Omit<FollowingView, 'wait'> {
  const { outcome } = round
  switch (outcome.kind) {
    case 'list': {
      const commits = roundCommits(round, nowMs, surface)
      const notes = [
        ...(outcome.failed > 0 ? [notLoadedText(outcome.failed, outcome.people)] : []),
        ...(outcome.isCut ? [FOLLOWING_CUT_TEXT] : []),
      ]
      const message =
        outcome.people === 0
          ? FOLLOWING_NOBODY_TEXT
          : commits.length === 0 && outcome.failed === 0 && !outcome.isCut
            ? FOLLOWING_NONE_POSTED_TEXT
            : undefined

      return { freshness: `updated ${relativeAge(round.endedAtMs, nowMs)}`, message, isProblem: false, notes, commits }
    }
    case 'failed': {
      const { problem } = outcome
      const wait = problem.kind === 'status' ? problem.retryAfterSeconds : null

      return {
        freshness: '',
        message: problemText(problem),
        isProblem: true,
        notes: wait === null ? [] : [waitText(wait)],
        commits: [],
      }
    }
    default: {
      const unknownOutcome: never = outcome

      return unknownOutcome
    }
  }
}

function roundCommits(round: FollowingRound, nowMs: number, surface: RenderSurface): FollowingCommit[] {
  if (round.outcome.kind !== 'list') return []

  return round.outcome.commits
    .filter(commit => USERNAME.test(commit.username))
    .slice(0, FOLLOWING_DRAWN_MAX)
    .map(commit => ({ ...drawnCommit(commit, nowMs, surface), author: commit.username }))
}

function problemText(problem: PaneProblem): string {
  switch (problem.kind) {
    case 'status':
      return followingStatusText(problem.status)
    case 'network':
      return NETWORK_TEXT
    case 'unreadable':
      return FOLLOWING_UNREADABLE_TEXT
    case 'local':
      return FOLLOWING_LOCAL_TEXT
    default: {
      const unknownProblem: never = problem

      return unknownProblem
    }
  }
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
