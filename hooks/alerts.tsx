// Reply alerts: while an account is set up and alerts are on, poll the
// person's newest commits and replies, and when a `replies_count` rises show
// it in the band above the prompt, the status line and a toast.
// `/devnull off` and `/devnull on` stop and resume it, kept in `$.store`.
//
// What is compared and kept is pure, in lib/alerts.ts. This module holds the
// poller, the band and the two subcommands. Every call on `$` goes through an
// AlertsIo built in the hook that owns that `$`, so validate sees each call
// in a hook and the logic is the same in a test.
//
// Timers: `$.clock.after` timers die with the module's environment, which a
// hot reload replaces ("a hot reload of the plugin cancels its pending waits
// with the old environment", `clock` in the engine's types; reference.md,
// "Work that outlives a dispatch"). Within one environment the module keeps
// one poller at a time, so a second `session.start` replaces it instead of
// adding one. What must outlive a reload (the alerts on show, the back-off,
// when the next poll is due) is in `$.state`; what must outlive the session
// (what was seen, and what was toasted) is in the seen record in `$.store`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpResponse, On, PluginOptions, SessionEndReason, Timer } from 'claude-code'

import type { CommitSummary, ReplyAlerts } from '../types'
import { ACCOUNT_KEY, parseAccount } from './lib/account'
import {
  ALERTS_ON_KEY,
  SEEN_KEY,
  alertLead,
  alertLine,
  commitListUrls,
  dismissAlerts,
  intervalSecondsOf,
  isAlertsOn,
  parseSeen,
  readListResponse,
  reconcile,
  statusText,
  storedSeen,
} from './lib/alerts'
import type { ListResult } from './lib/alerts'
import { pollDelayMs } from './lib/backoff'
import { FAILED_TEXT, isTypedByPerson, notTypedText, splitSubcommand } from './lib/command'
import { commitUrl } from './lib/links'
import { storeRecent } from './recent'

const ON_USAGE = '/devnull on                       check for new replies again (the default)'
const OFF_USAGE = '/devnull off                      stop checking for new replies'

export const ALERTS_USAGE: readonly string[] = [ON_USAGE, OFF_USAGE]

export const ON_TEXT = 'Reply alerts are on. /devnull off stops them.'

export const OFF_TEXT = 'Reply alerts are off. /devnull on starts them again.'

export const ON_NOT_SAVED_TEXT = 'Reply alerts are on for this session, but saving that failed, so a restart may turn them off.'

export const OFF_NOT_SAVED_TEXT = 'Reply alerts are off for this session, but saving that failed, so they come back after a restart.'

export const EXTRA_WORDS_TEXT = '/devnull on and /devnull off take nothing after them.'

export const DISMISS_FAILED_TEXT = 'Could not save that you have seen these replies. Press d to try again.'

/** The interval setting in `plugin.json`'s `userConfig`. */
export const INTERVAL_OPTION = 'replyCheckSeconds'

/** At most this many commits get a row in the band; the status line has the total. */
export const BAND_ROWS_MAX = 5

const NO_ALERTS: ReplyAlerts = { alerts: [], failures: 0, nextPollAtMs: null }

const ALERTS = atom({ plugin: 'devnull', key: 'replyAlerts' } as const, NO_ALERTS)

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
// The seen counts are read, changed and written by the poller and by a
// dismiss; one at a time, so neither writes over the other.
let storeTurn: Promise<void> = Promise.resolve()
// The session's own io, for `/devnull on` to start the poller with.
let sessionIo: AlertsIo | undefined
let sessionIntervalSeconds = intervalSecondsOf(undefined)

/**
 * The poller's start and stop, `/devnull on` and `/devnull off`, and the band.
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
    // The seam for the pane: `/devnull off` also closes the pane. That is the
    // pane's to do, here, once alerts have stopped.

    return { text }
  }).catch(($, e, next) => (next.called ? next(e) : { text: FAILED_TEXT }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { alerts } = await read($, ALERTS)
    if (alerts.length === 0) return next(e)

    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const io = alertsIo($)
    const shown = alerts.slice(0, BAND_ROWS_MAX)
    const hidden = alerts.length - shown.length
    const dismissButton = <Button key="dismiss" label="dismiss" hotkey="d" onPress={() => dismiss(io)} />

    const rows = shown.map((alert, index) => {
      const url = commitUrl(alert.username, alert.id)
      const isLast = index === shown.length - 1 && hidden === 0

      return (
        <Box key={alert.id} flexDirection="row" columnGap={1}>
          <Text>
            {`${alertLead(alert)} `}
            <Text color="warning">{alert.shortHash}</Text>
          </Text>
          {url === undefined ? [] : [<Link key="open" href={url} label={'open \u2197'} />]}
          {isLast ? [dismissButton] : []}
        </Box>
      )
    })
    if (hidden > 0) {
      rows.push(
        <Box key="more" flexDirection="row" columnGap={1}>
          <Text color="subtle">{`and ${hidden} more`}</Text>
          {dismissButton}
        </Box>,
      )
    }

    return <Box flexDirection="column">{rows}</Box>
  })
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
        await scheduleNext(current, true, outcome.retryAfter)
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
  // poller was stopped (`/devnull off`) while the one before was out. A list
  // that fails changes nothing.
  const commits = await fetchList(io, urls.commits)
  if (commits.kind === 'failed') return commits
  if (poller !== current) return { kind: 'stopped' }
  const replies = await fetchList(io, urls.replies)
  if (replies.kind === 'failed') return replies
  if (poller !== current) return { kind: 'stopped' }

  const all = [...commits.commits, ...replies.commits]
  await io.storeRecent(account.username, all, await io.now())
  await showCounts(current, account.username, all)

  return { kind: 'done', retryAfter: replies.retryAfter }
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

/** Takes the alerts off the band and the status line. */
async function clearShown(io: AlertsIo): Promise<void> {
  const state = await io.readState()
  if (state.alerts.length > 0) await io.updateState(current => ({ ...current, alerts: [] }))
  io.status(undefined)
}

/** The band's `d`: every alert on show is seen, at its count now. */
async function dismiss(io: AlertsIo): Promise<void> {
  try {
    await inStoreTurn(async () => {
      const { alerts } = await io.readState()
      if (alerts.length === 0) return
      const account = parseAccount(await io.readStore(ACCOUNT_KEY))
      const kept = parseSeen(await io.readStore(SEEN_KEY))
      // Alerts for another account than the one kept are dropped, not saved:
      // the next poll starts that account's record afresh.
      if (account !== undefined && kept !== undefined && kept.username === account.username) {
        await io.writeStore(SEEN_KEY, storedSeen(dismissAlerts(kept, alerts)))
      }
      const dismissed = new Set(alerts.map(alert => alert.id))
      const state = await io.updateState(current => ({
        ...current,
        alerts: current.alerts.filter(alert => !dismissed.has(alert.id)),
      }))
      io.status(statusText(state.alerts))
    })
  } catch {
    io.toast(DISMISS_FAILED_TEXT)
  }
}

/** Runs `work` after every earlier store turn has ended, whether it failed or not. */
function inStoreTurn(work: () => Promise<void>): Promise<void> {
  const turn = storeTurn.then(work, work)
  storeTurn = turn.catch(() => undefined)

  return turn
}
