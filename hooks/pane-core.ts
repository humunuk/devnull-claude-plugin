// The pane's lists and its life outside the drawing: the load of the person's
// newest commits into the session's recent list (hooks/recent.ts), the
// Following tab's round, the redraw timer, and closing and reloading the
// pane. hooks/pane.tsx draws it and toggles it; posting reloads it after a
// commit and completes reply hashes from the round, and `/devnull off` closes
// it. They import this module rather than the pane, which imports them.
//
// Where the load and the round stand lives in `$.state`, so a hot reload
// keeps it; every read and write of them is here (validate accepts them only
// in the file that defines the atom), and the others read them through
// readLoad, readFollowing and readFollowingCommits.
//
// The pane sends one request at a time, the load's and the round's together
// (rule 8): each goes through `inLane`, which starts it once every request
// the pane started before it has settled. A request out for LOAD_STALE_MS is
// taken as lost, as the load itself is ($.http.fetch rejects after 30 s, so
// only one whose answer can never come back is that old), and the next goes
// ahead of it. A 429 with Retry-After on any of them holds back both the
// load and the round (`paneNotBeforeMs` in `$.state`): they share the lane
// and the per-IP limit. Every close of the pane (`/devnull`, `/devnull off`,
// the person's own close mark or ctrl+x x) and the session's end stop the
// requests the pane started (stopPane): one not yet sent is not sent, and a
// round ends with what arrived.
//
// The lane is a module variable: a hot reload starts a new one. reference.md
// says of a reload only that `register` runs again in a fresh environment and
// the previous environment's timers are dropped; what the old environment's
// pending continuations do then (a request still out, the steps after it) is
// not verified, so one of its requests may overlap one of the new lane's.
//
// The engine keeps the record of open panes: the person may close this one
// with its close mark or ctrl+x x, so this module asks `$.ui.panes()` instead
// of remembering what it did last.
//
// The ages drawn are relative to now, so while the pane is open a timer redraws
// it once a minute. The timer lives in a module variable, not `$.state` (it is
// no value): a hot reload drops the old environment's timers along with the
// variable (reference.md: "the previous environment's timers are dropped"),
// and the next drawing of a pane still open starts one again. It stops with
// the requests on every close and at `session.end` (stopPane), and at the
// first tick that finds the pane gone (rule 8).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpResponse, StateDollar, Timer } from 'claude-code'

import type { CommitSummary } from '../types'
import { ACCOUNT_KEY, parseAccount } from './lib/account'
import {
  FOLLOWED_MAX,
  dropRound,
  endRound,
  failedRound,
  failuresOf,
  followingCommitsOf,
  isBackOffProblem,
  lastRoundOf,
  listRound,
  readFollowAnswer,
  startRound,
  stepRound,
  theirCommits,
  userFollowingUrl,
} from './lib/following'
import type { FollowAnswer, FollowingState, RoundTrigger } from './lib/following'
import {
  COMMITS_REQUEST,
  LOAD_STALE_MS,
  dropLoad,
  failedLoad,
  fetchedAtOf,
  finishLoad,
  pageOf,
  readCommitsAnswer,
  startLoad,
  userCommitsUrl,
} from './lib/pane'
import type { CommitsAnswer, PaneLoad, PaneProblem } from './lib/pane'
import { storeRecent } from './recent'

export const PANE_ID = 'devnull'

export const LOAD_FAILED_TOAST = '/devnull could not load your commits: Claude Code refused a step.'

export const ROUND_FAILED_TOAST = '/devnull could not load the commits of the people you follow: Claude Code refused a step.'

const LOAD = atom({ plugin: 'devnull', key: 'pane' } as const, { kind: 'idle' })

const FOLLOWING = atom({ plugin: 'devnull', key: 'following' } as const, { kind: 'idle' })

const NOT_BEFORE = atom({ plugin: 'devnull', key: 'paneNotBeforeMs' } as const, 0)

const STOPPED_ERROR = 'devnull: the pane was closed, so its request was not sent'

/** How often an open pane is redrawn, so the ages it shows move on. */
export const TICK_MS = 60_000

const TICK_FAILED_LOG = 'devnull: the pane stopped redrawing its ages: listing the open panes failed'

const RELOAD_FAILED_LOG = 'devnull: the pane was not reloaded after a post: listing the open panes failed'

let ticker: Timer | undefined

/** One request in the lane: settled once it has, whatever it came to; `startedAtMs` once it went out. */
type Turn = { settled: Promise<void>; startedAtMs: number | undefined }

let lastTurn: Turn = { settled: Promise.resolve(), startedAtMs: undefined }

/** How often the pane's requests were stopped: a request or round started under another count is stopped. */
let stops = 0

/**
 * The load that holds the claim in `$.state` (its token), the stop count it
 * claimed under, and whether its request went out. One claimed before the
 * last stop whose request never went out (it waited in the lane, and the
 * stop keeps it from going) gives way to the next load, which a reopen
 * starts; one whose request is out is waited for, as any load in flight. A
 * hot reload forgets it; LOAD_STALE_MS then lets that load go.
 */
let loadClaim: { token: string; stops: number; isSent: boolean } | undefined

/** Stops the requests the pane started: stopPane calls it. */
function stopRequests(): void {
  stops += 1
}

/**
 * Stops the pane's redraw timer and the requests it started. Every close
 * calls it: `/devnull` (shutPane), `/devnull off` (closePane), the person's
 * own close (the pane's `ui.close` hook), and the session's end (endPane).
 */
export function stopPane(): void {
  stopTicker(ticker)
  stopRequests()
}

/**
 * Starts `request` once the request the pane started before it has settled,
 * or at once when that one has been out for LOAD_STALE_MS. Each waits for the
 * one before, so one request is out at a time. Rejects, sending nothing, when
 * the pane's requests were stopped while it waited.
 */
function inLane<T>(now: () => Promise<number>, request: () => Promise<T>): Promise<T> {
  const before = lastTurn
  const own: Turn = { settled: Promise.resolve(), startedAtMs: undefined }
  const stopsAtEntry = stops
  const run = async (): Promise<T> => {
    const enteredAtMs = await now()
    if (!isLost(before, enteredAtMs)) await before.settled
    if (stops !== stopsAtEntry) throw new Error(STOPPED_ERROR)
    own.startedAtMs = await now()

    return request()
  }
  const result = run()
  own.settled = result.then(
    () => undefined,
    () => undefined,
  )
  lastTurn = own

  return result
}

function isLost(turn: Turn, nowMs: number): boolean {
  return turn.startedAtMs !== undefined && nowMs >= turn.startedAtMs && nowMs - turn.startedAtMs >= LOAD_STALE_MS
}

/** Where the load stands; a drawing that reads it is drawn again when it changes. */
export function readLoad($: StateDollar): Promise<PaneLoad> {
  return read($, LOAD)
}

export async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE_ID)
}

/** Closes the pane, which must be open, and stops its redraw timer and its requests. */
export async function shutPane($: EngineInterface): Promise<void> {
  stopPane()
  await $.ui.close({ id: PANE_ID })
}

/** Closes the pane when it is open; its redraw timer and its requests stop either way. */
export async function closePane($: EngineInterface): Promise<void> {
  stopPane()
  if (await isPaneOpen($)) await $.ui.close({ id: PANE_ID })
}

/**
 * Loads the list again when the pane is open, as after a post. Never rejects:
 * a pane that cannot be listed is left as it is, with a line in the debug log.
 */
export async function reloadPaneIfOpen($: EngineInterface): Promise<void> {
  try {
    // Not awaited: a fetch that gets no answer takes 30 s to fail.
    if (await isPaneOpen($)) void load($)
  } catch {
    $.ui.log(RELOAD_FAILED_LOG, { to: 'debug' })
  }
}

/**
 * Stops the redraw timer and the pane's requests when the session ends (rule
 * 8). register.tsx holds the mod's one `session.end` hook: validate allows a
 * single unmatched hook per event across the mod.
 */
export function endPane(): void {
  stopPane()
}

/** Starts the redraw timer, in place of any this environment runs already. */
export function startTicker($: EngineInterface): void {
  stopTicker(ticker)
  const own = $.clock.every(TICK_MS, () => {
    void tick($, own)
  })
  ticker = own
}

/**
 * Starts the redraw timer when this environment runs none: a pane drawn with
 * no timer is one a hot reload left open, the old environment's timer gone.
 */
export function keepTicking($: EngineInterface): void {
  if (ticker === undefined) startTicker($)
}

/** Stops `timer`, and forgets it when it is the current one. */
function stopTicker(timer: Timer | undefined): void {
  timer?.cancel()
  if (ticker === timer) ticker = undefined
}

/** Redraws the pane while it is open; a tick that finds it closed stops its timer. */
async function tick($: EngineInterface, own: Timer): Promise<void> {
  try {
    if (await isPaneOpen($)) $.ui.invalidate('ui.render')
    else stopTicker(own)
  } catch {
    stopTicker(own)
    $.ui.log(TICK_FAILED_LOG, { to: 'debug' })
  }
}

/** What a load may do outside the mod, each bound to one fixed call on `$`. */
export type PaneIo = {
  now: () => Promise<number>
  newToken: () => string
  readAccount: () => Promise<unknown>
  fetchCommits: (url: string) => Promise<HttpResponse>
  storeCommits: (username: string, commits: readonly CommitSummary[], nowMs: number) => Promise<unknown>
  changeLoad: (change: (load: PaneLoad) => PaneLoad) => Promise<PaneLoad>
  /** When the pane's requests may go out again after a 429; 0 when nothing asked to wait. */
  readNotBefore: () => Promise<number>
  /** Holds the pane's requests back until `atMs`, or later when they are already. */
  holdUntil: (atMs: number) => Promise<unknown>
  /** Whether the pane's requests were stopped (closed, off, session end) since this load began. */
  isStopped: () => boolean
  /** Keeps the load named `token` as the one holding the claim, under the stop count now. */
  holdClaim: (token: string) => void
  /** Whether the load named `token` claimed before the pane's requests were last stopped, and its request never went out. */
  isClaimStopped: (token: string) => boolean
}

/** Starts a load with this `$`; never rejects, and says so when it could not even record its failure. */
export async function load($: EngineInterface): Promise<void> {
  const stopsAtStart = stops
  let ownToken: string | undefined
  const io: PaneIo = {
    now: () => $.clock.now(),
    newToken: () => crypto.randomUUID(),
    readAccount: () => $.store.get(ACCOUNT_KEY),
    fetchCommits: url =>
      inLane(
        () => $.clock.now(),
        () => {
          if (loadClaim !== undefined && loadClaim.token === ownToken) loadClaim.isSent = true

          return $.http.fetch(url, COMMITS_REQUEST)
        },
      ),
    storeCommits: (username, commits, nowMs) => storeRecent($, username, commits, nowMs),
    changeLoad: change => update($, LOAD, change),
    readNotBefore: () => read($, NOT_BEFORE),
    holdUntil: atMs => update($, NOT_BEFORE, current => Math.max(current, atMs)),
    isStopped: () => stops !== stopsAtStart,
    holdClaim: token => {
      ownToken = token
      loadClaim = { token, stops, isSent: false }
    },
    isClaimStopped: token =>
      loadClaim !== undefined && loadClaim.token === token && loadClaim.stops !== stops && !loadClaim.isSent,
  }

  try {
    await runLoad(io)
  } catch {
    $.ui.toast(LOAD_FAILED_TOAST)
  }
}

/**
 * One load of the person's newest commits: nothing while another is in flight
 * or dev-null.sh asked to wait; else the list is fetched, checked, kept in
 * the recent list, and the load marked ready or failed. A load claimed before
 * the pane's requests were stopped, whose request the stop kept from going
 * out, gives way to this one, and gives up its claim without a failure when
 * it learns of the stop (as dropRound does for a round). Rejects only when
 * `$.state` refuses to record a failure.
 */
export async function runLoad(io: PaneIo): Promise<void> {
  let username: string | null = null
  let token: string | undefined
  try {
    const account = parseAccount(await io.readAccount())
    const url = account === undefined ? undefined : userCommitsUrl(account.username)
    if (account === undefined || url === undefined) {
      await io.changeLoad(() => ({ kind: 'not-set-up' }))

      return
    }
    const { username: name } = account
    username = name

    const startedAtMs = await io.now()
    const mine = io.newToken()
    const notBeforeMs = await io.readNotBefore()
    const claimed = await io.changeLoad(current => {
      const before = current.kind === 'loading' && io.isClaimStopped(current.token) ? dropLoad(current, current.token) : current

      return startLoad(before, name, mine, startedAtMs, notBeforeMs)
    })
    if (claimed.kind !== 'loading' || claimed.token !== mine) return
    token = mine
    io.holdClaim(mine)

    let answer: CommitsAnswer
    try {
      answer = readCommitsAnswer(await io.fetchCommits(url))
    } catch {
      // Stopped before it went out (the pane closed): not a failure of
      // dev-null.sh's, and the claim goes to the next load.
      if (io.isStopped()) {
        await io.changeLoad(current => dropLoad(current, mine))

        return
      }
      // No answer within 30 s, a refused connection, or the fetch was refused.
      answer = { kind: 'problem', problem: { kind: 'network' } }
    }
    const doneAtMs = await io.now()
    if (answer.kind === 'list') await io.storeCommits(name, answer.commits, doneAtMs)
    const heldUntil = answer.kind === 'problem' ? retryAtOf(answer.problem, doneAtMs) : undefined
    if (heldUntil !== undefined) await io.holdUntil(heldUntil)
    await io.changeLoad(current => finishLoad(current, mine, answer, doneAtMs))
  } catch {
    // $.store, $.state or $.clock refused: say so rather than load forever.
    // Another load in flight is left alone.
    const failedAs = username
    const ownToken = token
    await io.changeLoad(current =>
      current.kind === 'loading' && current.token !== ownToken
        ? current
        : failedLoad(failedAs, { kind: 'local' }, 0, pageOf(current, failedAs), fetchedAtOf(current, failedAs)),
    )
  }
}

/** Where the Following tab's round stands; a drawing that reads it is drawn again when it changes. */
export function readFollowing($: StateDollar): Promise<FollowingState> {
  return read($, FOLLOWING)
}

/**
 * The commits the last round brought, for the hash completion of `/devnull
 * reply`: other people's, kept apart from the person's own recent list.
 */
export async function readFollowingCommits($: StateDollar): Promise<CommitSummary[]> {
  return followingCommitsOf(await read($, FOLLOWING))
}

/** When a 429 with Retry-After asked the pane to send again, or undefined for any other problem. */
function retryAtOf(problem: PaneProblem, nowMs: number): number | undefined {
  return problem.kind === 'status' && problem.status === 429 && problem.retryAfterSeconds !== null
    ? nowMs + problem.retryAfterSeconds * 1000
    : undefined
}

/** What a round may do outside the mod, each bound to one fixed call on `$`. */
export type RoundIo = {
  now: () => Promise<number>
  newToken: () => string
  readAccount: () => Promise<unknown>
  /** A GET of a list on dev-null.sh, in the pane's lane. */
  fetchList: (url: string) => Promise<HttpResponse>
  changeRound: (change: (state: FollowingState) => FollowingState) => Promise<FollowingState>
  /** When the pane's requests may go out again after a 429; 0 when nothing asked to wait. */
  readNotBefore: () => Promise<number>
  /** Holds the pane's requests back until `atMs`, or later when they are already. */
  holdUntil: (atMs: number) => Promise<unknown>
  /** Whether the pane's requests were stopped (closed, off, session end) since the round began. */
  isStopped: () => boolean
}

/**
 * Starts a Following round with this `$`, its first request after `after`
 * settled (the load an open started with it); never rejects, and says so when
 * it could not even record its failure.
 */
export async function followRound($: EngineInterface, trigger: RoundTrigger, after: Promise<unknown> = Promise.resolve()): Promise<void> {
  const stopsAtStart = stops
  const io: RoundIo = {
    now: () => $.clock.now(),
    newToken: () => crypto.randomUUID(),
    readAccount: () => $.store.get(ACCOUNT_KEY),
    fetchList: url => inLane(() => $.clock.now(), () => $.http.fetch(url, COMMITS_REQUEST)),
    changeRound: change => update($, FOLLOWING, change),
    readNotBefore: () => read($, NOT_BEFORE),
    holdUntil: atMs => update($, NOT_BEFORE, current => Math.max(current, atMs)),
    isStopped: () => stops !== stopsAtStart,
  }

  try {
    await runRound(io, trigger, after)
  } catch {
    $.ui.toast(ROUND_FAILED_TOAST)
  }
}

/**
 * One Following round: nothing while another is in flight, before the last
 * one's next is due, or while a 429 holds the pane back; else the person's
 * follow list, then the commit lists of the first 20 people on it, one
 * request at a time. A list that fails is counted and left out. A 429, a 5xx,
 * no answer, or the pane's requests stopping end the round with what arrived,
 * the people not reached counted with the lists that failed (all but the
 * 429's note). Rejects only when `$.state` refuses to record a failure.
 */
export async function runRound(io: RoundIo, trigger: RoundTrigger, after: Promise<unknown>): Promise<void> {
  let username: string | null = null
  let token: string | undefined
  let startedAtMs = 0
  try {
    const account = parseAccount(await io.readAccount())
    const followingUrl = account === undefined ? undefined : userFollowingUrl(account.username)
    if (account === undefined || followingUrl === undefined) {
      await io.changeRound(() => ({ kind: 'not-set-up' }))

      return
    }
    const { username: name } = account
    username = name

    const startedAt = await io.now()
    const notBeforeMs = await io.readNotBefore()
    const mine = io.newToken()
    const claimed = await io.changeRound(current => startRound(current, name, mine, startedAt, trigger, notBeforeMs))
    if (claimed.kind !== 'loading' || claimed.token !== mine) return
    token = mine
    startedAtMs = startedAt
    const failuresBefore = failuresOf(claimed.last)

    await after
    let follow: FollowAnswer
    try {
      follow = readFollowAnswer(await io.fetchList(followingUrl))
    } catch {
      // No answer within 30 s, a refused connection, the fetch was refused,
      // or the pane's requests were stopped before it went out.
      follow = { kind: 'problem', problem: { kind: 'network' } }
    }
    // Stopped before any person's list was asked for: nothing to show.
    if (io.isStopped()) {
      await io.changeRound(current => dropRound(current, mine))

      return
    }
    if (follow.kind === 'problem') {
      const { problem } = follow
      const endedAt = await io.now()
      const heldUntil = retryAtOf(problem, endedAt)
      if (heldUntil !== undefined) await io.holdUntil(heldUntil)
      const failures = isBackOffProblem(problem) ? failuresBefore + 1 : 0
      await io.changeRound(current => endRound(current, mine, failedRound(name, problem, startedAt, endedAt, failures)))

      return
    }

    const people = follow.usernames.slice(0, FOLLOWED_MAX)
    const commits: CommitSummary[] = []
    let failed = 0
    let cut: { retryAfterSeconds: number | undefined } | undefined
    let isBackingOff = false
    let isStopped = false
    for (const [index, person] of people.entries()) {
      // A name the mod cannot use is never asked for.
      if (person === null) {
        failed += 1
        continue
      }
      if (io.isStopped()) {
        failed += people.length - index
        isStopped = true
        break
      }
      const stepAt = await io.now()
      const stepped = await io.changeRound(current => stepRound(current, mine, stepAt))
      // A newer round took over after this one went still: it stops here.
      if (stepped.kind !== 'loading' || stepped.token !== mine) return

      const answer = await fetchCommitsOf(io, person)
      if (answer.kind === 'list') {
        commits.push(...theirCommits(person, answer.commits))
        continue
      }
      const { problem } = answer
      if (io.isStopped() && problem.kind === 'network') {
        failed += people.length - index
        isStopped = true
        break
      }
      if (problem.kind === 'status' && problem.status === 429) {
        const heldUntil = retryAtOf(problem, await io.now())
        if (heldUntil !== undefined) await io.holdUntil(heldUntil)
        cut = { retryAfterSeconds: problem.retryAfterSeconds ?? undefined }
        break
      }
      if (isBackOffProblem(problem)) {
        // dev-null.sh is failing or out of reach: this list and the rest are
        // not asked for, and the next round waits longer.
        failed += people.length - index
        isBackingOff = true
        break
      }
      // Another status (a 404 for an account gone) or an unreadable list.
      failed += 1
    }
    const endedAt = await io.now()
    const failures = isBackingOff ? failuresBefore + 1 : isStopped ? failuresBefore : 0
    const round = listRound({ username: name, startedAtMs: startedAt, endedAtMs: endedAt, people: people.length, failed, cut, failures, commits })
    await io.changeRound(current => endRound(current, mine, round))
  } catch {
    // $.store, $.state or $.clock refused: say so rather than load forever.
    // Another round in flight is left alone, and the next one still waits
    // for any round's minute.
    const failedAs = username
    const ownToken = token
    const startedAt = startedAtMs
    await io.changeRound(current => {
      if (current.kind === 'loading' && current.token !== ownToken) return current
      const last = lastRoundOf(current)
      const round = failedRound(failedAs, { kind: 'local' }, startedAt, startedAt, failuresOf(last))
      const nextAtMs = Math.max(round.nextAtMs, last?.nextAtMs ?? 0)

      return { kind: 'ended', last: { ...round, nextAtMs }, waitUntilMs: null }
    })
  }
}

/** One followed person's commit list; a failed request is a network problem. */
async function fetchCommitsOf(io: RoundIo, person: string): Promise<CommitsAnswer> {
  const url = userCommitsUrl(person)
  // Never so: the follow list's guard holds every name to the same pattern.
  if (url === undefined) return { kind: 'problem', problem: { kind: 'unreadable' } }
  try {
    return readCommitsAnswer(await io.fetchList(url))
  } catch {
    return { kind: 'problem', problem: { kind: 'network' } }
  }
}
