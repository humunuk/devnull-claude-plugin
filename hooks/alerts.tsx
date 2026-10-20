// Reply alerts: while an account is set up and alerts are on, poll the
// person's newest commits and replies, and when a `replies_count` rises say so
// in a toast, once per rise, and as a count in the status line. There is no
// band above the prompt, and the status line cannot be pressed: opening the
// pane is what marks the replies seen (seeReplyAlerts), and the pane reads
// the alerts on show through readReplyAlerts, for its `+N new` marks.
// `/devnull off` and `/devnull on` stop and resume it, kept in `$.store`;
// `/devnull off` also closes the pane.
//
// What is compared and kept is pure, in lib/alerts.ts. This module holds the
// poller, the two subcommands and what the pane's open marks seen. Every call
// on `$` goes through an AlertsIo built in the hook (or the caller) that owns
// that `$`, so validate sees each call in a hook and the logic is the same in
// a test.
//
// Timers: `$.clock.after` timers die with the module's environment, which a
// hot reload replaces ("a hot reload of the plugin cancels its pending waits
// with the old environment", `clock` in the engine's types; reference.md,
// "Work that outlives a dispatch"). Within one environment the module keeps
// one poller at a time, so a second `session.start` replaces it instead of
// adding one. What must outlive a reload (the alerts on show, the back-off,
// when the next poll is due) is in `$.state`; what must outlive the session
// (what was seen, and what was toasted) is in the seen record in `$.store`.
//
// The poller and the pane share dev-null.sh's per-IP limit, so they share one
// 429 hold, kept by pane-core (readNotBefore, holdRequestsUntil): no poll goes
// out while it is in force, and a 429 with Retry-After on a poll sets it.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpResponse, On, PluginOptions, SessionEndReason, StateDollar, Timer } from 'claude-code'

import type { CommitSummary, ReplyAlert, ReplyAlerts } from '../types'
import { ACCOUNT_KEY, parseAccount } from './lib/account'
import {
  ALERTS_ON_KEY,
  SEEN_KEY,
  alertLine,
  commitListUrls,
  intervalSecondsOf,
  isAlertsOn,
  parseSeen,
  readListResponse,
  reconcile,
  seeAlerts,
  statusText,
  storedSeen,
} from './lib/alerts'
import type { ListResult } from './lib/alerts'
import { pollDelayMs, retryAfterSeconds } from './lib/backoff'
import { FAILED_TEXT, isTypedByPerson, notTypedText, splitSubcommand } from './lib/command'
import { closePane, holdRequestsUntil, readNotBefore } from './pane-core'
import { storeRecent } from './recent'

const ON_USAGE = '/devnull on                       check for new replies again (the default)'
const OFF_USAGE = '/devnull off                      stop checking for new replies, and close the pane'

export const ALERTS_USAGE: readonly string[] = [ON_USAGE, OFF_USAGE]

export const ON_TEXT = 'Reply alerts are on. /devnull off stops them.'

export const OFF_TEXT = 'Reply alerts are off. /devnull on starts them again.'

export const ON_NOT_SAVED_TEXT = 'Reply alerts are on for this session, but saving that failed, so a restart may turn them off.'

export const OFF_NOT_SAVED_TEXT = 'Reply alerts are off for this session, but saving that failed, so they come back after a restart.'

export const EXTRA_WORDS_TEXT = '/devnull on and /devnull off take nothing after them.'

export const SEEN_NOT_SAVED_TEXT = 'Could not save that you have seen the new replies: they count as new again until you open the /dev/null pane.'

export const PANE_NOT_CLOSED_TEXT = 'The /dev/null pane could not be closed: /devnull closes it.'

/** The interval setting in `plugin.json`'s `userConfig`. */
export const INTERVAL_OPTION = 'replyCheckSeconds'

const NO_ALERTS: ReplyAlerts = { alerts: [], failures: 0, nextPollAtMs: null }

const ALERTS = atom({ plugin: 'devnull', key: 'replyAlerts' } as const, NO_ALERTS)

/** The alerts on show now; a drawing that reads them is drawn again when they change. */
export async function readReplyAlerts($: StateDollar): Promise<ReplyAlert[]> {
  return (await read($, ALERTS)).alerts
}

/** What the alerts may do outside the mod, each bound to one fixed call on `$`. */
export type AlertsIo = {
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => Timer
  fetchList: (url: string) => Promise<HttpResponse>
  readStore: (key: string) => Promise<unknown>
  writeStore: (key: string, value: unknown) => Promise<void>
  storeRecent: (username: string, commits: readonly CommitSummary[], nowMs: number) => Promise<unknown>
  readState: () => Promise<ReplyAlerts>
  updateState: (change: (state: ReplyAlerts) => ReplyAlerts) => Promise<ReplyAlerts>
  toast: (text: string) => void
  status: (text: string | undefined) => void
  /** A line for the debug log alone. */
  log: (text: string) => void
  /** When the mod's requests may go out again after a 429, the pane's or a poll's; 0 when nothing asked to wait. */
  readNotBefore: () => Promise<number>
  /** Holds the mod's requests, the pane's too, back until `atMs`, or later when they are already. */
  holdUntil: (atMs: number) => Promise<unknown>
}

function alertsIo($: EngineInterface): AlertsIo {
  return {
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, fn),
    fetchList: url => $.http.fetch(url, { method: 'GET', headers: { Accept: 'application/json' } }),
    readStore: key => $.store.get(key),
    writeStore: (key, value) => $.store.set(key, value),
    storeRecent: (username, commits, nowMs) => storeRecent($, username, commits, nowMs),
    readState: () => read($, ALERTS),
    updateState: change => update($, ALERTS, change),
    toast: text => $.ui.toast(text),
    status: text => $.ui.status(text),
    log: text => $.ui.log(text, { to: 'debug' }),
    readNotBefore: () => readNotBefore($),
    holdUntil: atMs => holdRequestsUntil($, atMs),
  }
}

type Poller = {
  io: AlertsIo
  intervalSeconds: number
  timer: Timer | undefined
}

// The module's own state, which a hot reload starts over (the old one's
// timers are gone with it).
let poller: Poller | undefined
// The poll whose requests are out, if any: never more than one, even across
// a stop and a start (a request that gets no answer takes 30 s to reject).
let inFlight: Promise<void> | undefined
// The seen counts are read, changed and written by the poller and by the
// pane's open; one at a time, so neither writes over the other.
let storeTurn: Promise<void> = Promise.resolve()
// The session's own io, for `/devnull on` to start the poller with.
let sessionIo: AlertsIo | undefined
let sessionIntervalSeconds = intervalSecondsOf(undefined)

/**
 * The poller's start and stop, and `/devnull on` and `/devnull off`.
 * `options` are the plugin's `userConfig` values, for the interval.
 */
export function registerAlerts(on: On, options: PluginOptions): void {
  sessionIntervalSeconds = intervalSecondsOf(options[INTERVAL_OPTION])

  // Only where a person is at the prompt: a `-p` run or an SDK host has
  // nobody to tell, so it sends nothing.
  on('session.start', { isInteractive: true }, async ($, e, next) => {
    const io = alertsIo($)
    sessionIo = io
    try {
      if (isAlertsOn(await io.readStore(ALERTS_ON_KEY))) {
        await startPolling(io, sessionIntervalSeconds)
      } else {
        stopPolling()
        await clearShown(io)
      }
    } catch {
      io.log('devnull: reply alerts could not start; they start again with the next session.')
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'devnull' }, async ($, e, next) => {
    const { name, rest } = splitSubcommand(e.args)
    if (name !== 'on' && name !== 'off') return next(e)
    if (!isTypedByPerson(e.origin)) return { text: notTypedText(name) }
    if (rest !== '') return { text: EXTRA_WORDS_TEXT }

    const io = alertsIo($)
    if (name === 'on') return { text: await turnOn(io) }
    const text = await turnOff(io)
    try {
      await closePane($)
    } catch {
      return { text: `${text}\n${PANE_NOT_CLOSED_TEXT}` }
    }

    return { text }
  }).catch(($, e, next) => (next.called ? next(e) : { text: FAILED_TEXT }))
}

/** Starts the poller (replacing any), its first poll when the last one asked for it, or at once. */
async function startPolling(io: AlertsIo, intervalSeconds: number): Promise<void> {
  stopPolling()
  const current: Poller = { io, intervalSeconds, timer: undefined }
  poller = current
  const state = await io.readState()
  io.status(statusText(state.alerts))
  const now = await io.now()
  if (poller !== current) return
  schedule(current, state.nextPollAtMs === null ? 0 : Math.max(0, state.nextPollAtMs - now))
}

/**
 * Stops the poller when the session ends. After /clear or a resume the
 * process goes on and no `session.start` follows (SessionEndInput), so the
 * poller goes on with it. register.tsx holds the mod's one `session.end` hook:
 * validate allows a single unmatched hook per event across the mod.
 */
export function endAlerts(reason: SessionEndReason): void {
  if (reason !== 'clear' && reason !== 'resume') stopPolling()
}

function stopPolling(): void {
  poller?.timer?.cancel()
  poller = undefined
}

function schedule(current: Poller, delayMs: number): void {
  current.timer = current.io.after(delayMs, () => {
    void tick(current)
  })
}

async function tick(current: Poller): Promise<void> {
  current.timer = undefined
  if (inFlight !== undefined) {
    // A poll of a poller stopped meanwhile is still out: wait for it, then
    // for the time it asked for (its back-off or Retry-After stands).
    while (inFlight !== undefined) await inFlight
    if (poller !== current) return
    const { nextPollAtMs } = await current.io.readState()
    const now = await current.io.now()
    if (poller !== current) return
    if (nextPollAtMs !== null && nextPollAtMs > now) {
      schedule(current, nextPollAtMs - now)

      return
    }
  }
  if (poller !== current) return

  const run = pollAndSchedule(current)
  inFlight = run
  try {
    await run
  } finally {
    if (inFlight === run) inFlight = undefined
  }
}

type PollOutcome =
  | { kind: 'done'; retryAfter: string | undefined }
  | { kind: 'no-account' }
  | { kind: 'held'; untilMs: number }
  | { kind: 'failed'; status: number | undefined; retryAfter: string | undefined }
  | { kind: 'stopped' }

/** One poll and the next one's timer. Never rejects: anything unexpected counts as a failed poll. */
async function pollAndSchedule(current: Poller): Promise<void> {
  const { io, intervalSeconds } = current
  let outcome: PollOutcome
  try {
    outcome = await poll(current)
  } catch {
    outcome = { kind: 'failed', status: undefined, retryAfter: undefined }
  }

  try {
    switch (outcome.kind) {
      case 'stopped':
        return
      case 'failed':
        io.log(`devnull: checking for replies failed (${outcome.status === undefined ? 'no answer' : `HTTP ${outcome.status}`}).`)
        if (outcome.status === 429) await holdAfter429(io, outcome.retryAfter)
        await scheduleNext(current, true, outcome.retryAfter)
        return
      case 'held':
        await scheduleHeld(current, outcome.untilMs)
        return
      case 'no-account':
      case 'done':
        await scheduleNext(current, false, outcome.kind === 'done' ? outcome.retryAfter : undefined)
        return
      default: {
        const unknownOutcome: never = outcome
        void unknownOutcome
      }
    }
  } catch {
    // The state could not be written: go on at the interval from here.
    if (poller === current) schedule(current, pollDelayMs({ intervalSeconds, consecutiveFailures: 0, retryAfter: undefined }))
  }
}

/**
 * A 429 with a usable Retry-After on a poll holds the pane's requests back as
 * well: they share the per-IP limit. The poller's own back-off stands beside
 * it. A hold that cannot be kept leaves the back-off alone, with a log line.
 */
async function holdAfter429(io: AlertsIo, retryAfter: string | undefined): Promise<void> {
  const seconds = retryAfterSeconds(retryAfter)
  if (seconds === undefined) return
  try {
    await io.holdUntil((await io.now()) + seconds * 1000)
  } catch {
    io.log('devnull: a 429 on checking for replies could not hold the pane back.')
  }
}

/** A poll skipped while a 429 holds the mod's requests back: the next is due when the hold ends, no failure counted. */
async function scheduleHeld(current: Poller, untilMs: number): Promise<void> {
  const { io } = current
  const now = await io.now()
  await io.updateState(state => ({ ...state, nextPollAtMs: untilMs }))
  if (poller === current) schedule(current, Math.max(0, untilMs - now))
}

/** Keeps the back-off and when the next poll is due, and sets its timer. */
async function scheduleNext(current: Poller, isFailure: boolean, retryAfter: string | undefined): Promise<void> {
  const { io, intervalSeconds } = current
  const now = await io.now()
  let delayMs = 0
  await io.updateState(state => {
    const failures = isFailure ? state.failures + 1 : 0
    delayMs = pollDelayMs({ intervalSeconds, consecutiveFailures: failures, retryAfter })

    return { ...state, failures, nextPollAtMs: now + delayMs }
  })
  if (poller === current) schedule(current, delayMs)
}

async function poll(current: Poller): Promise<PollOutcome> {
  const { io } = current
  const account = parseAccount(await io.readStore(ACCOUNT_KEY))
  const urls = account === undefined ? undefined : commitListUrls(account.username)
  if (poller !== current) return { kind: 'stopped' }
  if (account === undefined || urls === undefined) {
    await clearShown(io)

    return { kind: 'no-account' }
  }

  // One after the other: one request in flight, and none sent once the
  // poller was stopped (`/devnull off`) while the one before was out, or
  // while a 429 on any of the mod's requests holds them back. A list that
  // fails changes nothing.
  const heldBefore = await heldUntil(io)
  if (heldBefore !== undefined) return { kind: 'held', untilMs: heldBefore }
  const commits = await fetchList(io, urls.commits)
  if (commits.kind === 'failed') return commits
  if (poller !== current) return { kind: 'stopped' }
  const heldBetween = await heldUntil(io)
  if (heldBetween !== undefined) return { kind: 'held', untilMs: heldBetween }
  const replies = await fetchList(io, urls.replies)
  if (replies.kind === 'failed') return replies
  if (poller !== current) return { kind: 'stopped' }

  const all = [...commits.commits, ...replies.commits]
  await io.storeRecent(account.username, all, await io.now())
  await showCounts(current, account.username, all)

  return { kind: 'done', retryAfter: replies.retryAfter }
}

/** When the hold a 429 set ends, while it is still in force; else undefined. */
async function heldUntil(io: AlertsIo): Promise<number | undefined> {
  const notBeforeMs = await io.readNotBefore()
  const now = await io.now()

  return now < notBeforeMs ? notBeforeMs : undefined
}

async function fetchList(io: AlertsIo, url: string): Promise<ListResult> {
  let response: HttpResponse
  try {
    response = await io.fetchList(url)
  } catch {
    return { kind: 'failed', status: undefined, retryAfter: undefined }
  }

  return readListResponse(response)
}

/**
 * Compares the counts with the seen record, keeps the record, and shows what
 * rose. The toasted counts are kept before the toasts are raised, so a toast
 * is never raised twice for one rise, across a restart or an off and on.
 */
async function showCounts(current: Poller, username: string, commits: readonly CommitSummary[]): Promise<void> {
  const { io } = current
  await inStoreTurn(async () => {
    const kept = parseSeen(await io.readStore(SEEN_KEY))
    const { seen, alerts, rises, isChanged } = reconcile(kept, username, commits)
    if (isChanged) await io.writeStore(SEEN_KEY, storedSeen(seen))
    if (poller !== current) return

    await io.updateState(state => ({ ...state, alerts }))
    io.status(statusText(alerts))
    for (const alert of rises) io.toast(alertLine(alert))
  })
}

async function turnOn(io: AlertsIo): Promise<string> {
  let isSaved = true
  try {
    await io.writeStore(ALERTS_ON_KEY, true)
  } catch {
    isSaved = false
  }
  // A poller that runs goes on as it is: starting it again would poll sooner.
  if (poller === undefined && sessionIo !== undefined) await startPolling(sessionIo, sessionIntervalSeconds)

  return isSaved ? ON_TEXT : ON_NOT_SAVED_TEXT
}

async function turnOff(io: AlertsIo): Promise<string> {
  stopPolling()
  let isSaved = true
  try {
    await io.writeStore(ALERTS_ON_KEY, false)
  } catch {
    isSaved = false
  }
  await clearShown(io)

  return isSaved ? OFF_TEXT : OFF_NOT_SAVED_TEXT
}

/** Takes the alerts off show: the status line clears. */
async function clearShown(io: AlertsIo): Promise<void> {
  const state = await io.readState()
  if (state.alerts.length > 0) await io.updateState(current => ({ ...current, alerts: [] }))
  io.status(undefined)
}

/**
 * Opening the pane: every alert on show now counts as seen. Its count goes
 * into the seen record in `$.store` and the alerts leave `$.state`, which
 * clears the status line; replies that come later alert as usual. Resolves
 * to the alerts it took off show, for the pane to keep marking until it
 * closes. Never rejects: when the record cannot be saved a toast says so and
 * the alerts stay on show (the pane marks them from there), so it resolves to
 * none.
 */
export async function seeReplyAlerts($: EngineInterface): Promise<ReplyAlert[]> {
  const io = alertsIo($)
  let seen: ReplyAlert[] = []
  try {
    await inStoreTurn(async () => {
      const { alerts } = await io.readState()
      if (alerts.length === 0) return
      const account = parseAccount(await io.readStore(ACCOUNT_KEY))
      const kept = parseSeen(await io.readStore(SEEN_KEY))
      // Alerts for another account than the one kept are dropped, not saved:
      // the next poll starts that account's record afresh.
      if (account !== undefined && kept !== undefined && kept.username === account.username) {
        await io.writeStore(SEEN_KEY, storedSeen(seeAlerts(kept, alerts)))
      }
      const ids = new Set(alerts.map(alert => alert.id))
      const state = await io.updateState(current => ({
        ...current,
        alerts: current.alerts.filter(alert => !ids.has(alert.id)),
      }))
      seen = alerts
      io.status(statusText(state.alerts))
    })
  } catch {
    io.toast(SEEN_NOT_SAVED_TEXT)
  }

  return seen
}

/** Runs `work` after every earlier store turn has ended, whether it failed or not. */
function inStoreTurn(work: () => Promise<void>): Promise<void> {
  const turn = storeTurn.then(work, work)
  storeTurn = turn.catch(() => undefined)

  return turn
}
