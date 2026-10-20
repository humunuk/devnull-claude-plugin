// The pane: bare `/devnull` opens it, or closes it when it is open. Every
// open loads the person's newest commits into the session's recent list
// (hooks/recent.ts), which the pane draws and `/devnull reply` completes from.
// Where the load stands lives in `$.state`, so a hot reload keeps it.
//
// The engine keeps the record of open panes: the person may close this one
// with its close mark or ctrl+x x, so the toggle asks `$.ui.panes()` instead of
// remembering what it did last.
//
// The ages drawn are relative to now, so while the pane is open a timer redraws
// it once a minute. The timer lives in a module variable, not `$.state` (it is
// no value): a hot reload drops the old environment's timers along with the
// variable (reference.md: "the previous environment's timers are dropped"),
// and the next drawing of a pane still open starts one again. It stops on
// `/devnull`'s close, on the person's close (`ui.close`), at the first tick
// that finds the pane gone, and at `session.end` (rule 8).
//
// Room is left in the drawing for what later units add: the tab row under the
// header, a `+N new` mark on a commit's line, and the rule and input at the
// bottom (security rule 1: only on the terminal and desktop surfaces).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpResponse, On, Timer } from 'claude-code'

import type { CommitSummary } from '../types'
import { ACCOUNT_KEY, parseAccount } from './lib/account'
import { FAILED_TEXT, splitSubcommand } from './lib/command'
import {
  COMMITS_REQUEST,
  failedLoad,
  finishLoad,
  pageOf,
  paneView,
  readCommitsAnswer,
  startLoad,
  userCommitsUrl,
} from './lib/pane'
import type { CommitsAnswer, PaneLoad } from './lib/pane'
import { readRecent, storeRecent } from './recent'

export const PANE_ID = 'devnull'

const PANE_TITLE = '/dev/null'

export const PANE_USAGE: readonly string[] = ['/devnull                          open or close the /dev/null pane']

export const NOT_PLACED_TEXT = 'The /dev/null pane is open, and shows once a screen that draws panes is attached.'

export const LOAD_FAILED_TOAST = '/devnull could not load your commits: Claude Code refused a step.'

const PANE_REF = { plugin: 'devnull', key: 'pane' } as const

const LOAD = atom(PANE_REF, { kind: 'idle' })

/** How often an open pane is redrawn, so the ages it shows move on. */
export const TICK_MS = 60_000

const TICK_FAILED_LOG = 'devnull: the pane stopped redrawing its ages: listing the open panes failed'

let ticker: Timer | undefined

/** What a load may do outside the mod, each bound to one fixed call on `$`. */
export type PaneIo = {
  now: () => Promise<number>
  newToken: () => string
  readAccount: () => Promise<unknown>
  fetchCommits: (url: string) => Promise<HttpResponse>
  storeCommits: (username: string, commits: readonly CommitSummary[], nowMs: number) => Promise<unknown>
  changeLoad: (change: (load: PaneLoad) => PaneLoad) => Promise<PaneLoad>
}

export function registerPane(on: On): void {
  on('command.run', { command: 'devnull' }, async ($, e, next) => {
    if (splitSubcommand(e.args).name !== '') return next(e)

    // Opening or closing a pane posts nothing, so any origin may toggle it.
    if (await isPaneOpen($)) {
      stopTicker(ticker)
      await $.ui.close({ id: PANE_ID })

      return {}
    }

    const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    startTicker($)
    // Not awaited: a fetch that gets no answer takes 30 s to fail, and the
    // pane says it is loading meanwhile.
    void load($)

    return opened.isPlaced ? {} : { text: NOT_PLACED_TEXT }
  }).catch(($, e, next) => (next.called ? next(e) : { text: FAILED_TEXT }))

  on('ui.close', { id: PANE_ID }, ($, e, next) => {
    stopTicker(ticker)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    // A pane drawn with no timer in this environment is one a hot reload left
    // open: the old environment's timer went with it.
    if (ticker === undefined) startTicker($)
    const loadNow = await read($, LOAD)
    const view = paneView(loadNow, await readRecent($), await $.clock.now())

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Text weight="bold" wrap="truncate-end">
            {view.title}
          </Text>
          <Box flexDirection="row" flexShrink={0}>
            <Button key="refresh" label="refresh" hotkey="r" plain dimColor onPress={() => load($)} />
            {view.freshness !== '' && <Text color="subtle"> {'\u00b7'} {view.freshness}</Text>}
          </Box>
        </Box>
        {view.message !== undefined && (
          <Text color={loadNow.kind === 'failed' ? 'error' : 'subtle'}>{view.message}</Text>
        )}
        {view.hint !== undefined && <Text color="subtle">{view.hint}</Text>}
        {view.commits.map(commit => (
          <Box key={`commit-${commit.id}`} flexDirection="column" marginTop={1}>
            <Text wrap="truncate-end">
              <Text color="warning">{commit.hash}</Text>
              <Text color="subtle"> {commit.meta}</Text>
            </Text>
            {commit.lines.map(line => (
              <Text wrap="truncate-end">{line === '' ? ' ' : line}</Text>
            ))}
            {commit.href !== undefined && (
              <Text>
                <Link href={commit.href} label={'open \u2197'} />
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )
  })
}

async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE_ID)
}

/**
 * Stops the redraw timer when the session ends (rule 8). register.tsx holds
 * the mod's one `session.end` hook: validate allows a single unmatched hook
 * per event across the mod.
 */
export function endPane(): void {
  stopTicker(ticker)
}

/** Starts the redraw timer, in place of any this environment runs already. */
function startTicker($: EngineInterface): void {
  stopTicker(ticker)
  const own = $.clock.every(TICK_MS, () => {
    void tick($, own)
  })
  ticker = own
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

/** Starts a load with this `$`; never rejects, and says so when it could not even record its failure. */
async function load($: EngineInterface): Promise<void> {
  const io: PaneIo = {
    now: () => $.clock.now(),
    newToken: () => crypto.randomUUID(),
    readAccount: () => $.store.get(ACCOUNT_KEY),
    fetchCommits: url => $.http.fetch(url, COMMITS_REQUEST),
    storeCommits: (username, commits, nowMs) => storeRecent($, username, commits, nowMs),
    changeLoad: change => update($, LOAD, change),
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
 * the recent list, and the load marked ready or failed. Rejects only when
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
    const claimed = await io.changeLoad(current => startLoad(current, name, mine, startedAtMs))
    if (claimed.kind !== 'loading' || claimed.token !== mine) return
    token = mine

    let answer: CommitsAnswer
    try {
      answer = readCommitsAnswer(await io.fetchCommits(url))
    } catch {
      // No answer within 30 s, a refused connection, or the fetch was refused.
      answer = { kind: 'problem', problem: { kind: 'network' } }
    }
    const doneAtMs = await io.now()
    if (answer.kind === 'list') await io.storeCommits(name, answer.commits, doneAtMs)
    await io.changeLoad(current => finishLoad(current, mine, answer, doneAtMs))
  } catch {
    // $.store, $.state or $.clock refused: say so rather than load forever.
    // Another load in flight is left alone.
    const failedAs = username
    const ownToken = token
    await io.changeLoad(current =>
      current.kind === 'loading' && current.token !== ownToken
        ? current
        : failedLoad(failedAs, { kind: 'local' }, 0, pageOf(current, failedAs)),
    )
  }
}
