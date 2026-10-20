// The pane's list and its life outside the drawing: the load of the person's
// newest commits into the session's recent list (hooks/recent.ts), the redraw
// timer, and closing and reloading the pane. hooks/pane.tsx draws it and
// toggles it; posting reloads it after a commit, and `/devnull off` closes it.
// They import this module rather than the pane, which imports them.
//
// Where the load stands lives in `$.state`, so a hot reload keeps it; every
// read and write of it is here (validate accepts them only in the file that
// defines the atom), and the pane reads it through readLoad.
//
// The engine keeps the record of open panes: the person may close this one
// with its close mark or ctrl+x x, so this module asks `$.ui.panes()` instead
// of remembering what it did last.
//
// The ages drawn are relative to now, so while the pane is open a timer redraws
// it once a minute. The timer lives in a module variable, not `$.state` (it is
// no value): a hot reload drops the old environment's timers along with the
// variable (reference.md: "the previous environment's timers are dropped"),
// and the next drawing of a pane still open starts one again. It stops on
// every close the mod makes (`/devnull`, `/devnull off`), on the person's close
// (`ui.close`), at the first tick that finds the pane gone, and at
// `session.end` (rule 8).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpResponse, StateDollar, Timer } from 'claude-code'

import type { CommitSummary } from '../types'
import { ACCOUNT_KEY, parseAccount } from './lib/account'
import { COMMITS_REQUEST, failedLoad, fetchedAtOf, finishLoad, pageOf, readCommitsAnswer, startLoad, userCommitsUrl } from './lib/pane'
import type { CommitsAnswer, PaneLoad } from './lib/pane'
import { storeRecent } from './recent'

export const PANE_ID = 'devnull'

export const LOAD_FAILED_TOAST = '/devnull could not load your commits: Claude Code refused a step.'

const LOAD = atom({ plugin: 'devnull', key: 'pane' } as const, { kind: 'idle' })

/** How often an open pane is redrawn, so the ages it shows move on. */
export const TICK_MS = 60_000

const TICK_FAILED_LOG = 'devnull: the pane stopped redrawing its ages: listing the open panes failed'

const RELOAD_FAILED_LOG = 'devnull: the pane was not reloaded after a post: listing the open panes failed'

let ticker: Timer | undefined

/** Where the load stands; a drawing that reads it is drawn again when it changes. */
export function readLoad($: StateDollar): Promise<PaneLoad> {
  return read($, LOAD)
}

export async function isPaneOpen($: EngineInterface): Promise<boolean> {
  return (await $.ui.panes()).some(pane => pane.id === PANE_ID)
}

/** Closes the pane, which must be open, and stops its redraw timer. */
export async function shutPane($: EngineInterface): Promise<void> {
  stopTicker(ticker)
  await $.ui.close({ id: PANE_ID })
}

/** Closes the pane when it is open; its redraw timer stops either way. */
export async function closePane($: EngineInterface): Promise<void> {
  stopTicker(ticker)
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
 * Stops the redraw timer when the session ends (rule 8). register.tsx holds
 * the mod's one `session.end` hook: validate allows a single unmatched hook
 * per event across the mod.
 */
export function endPane(): void {
  stopTicker(ticker)
}

/** The person closed the pane: its redraw timer stops. */
export function paneClosed(): void {
  stopTicker(ticker)
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
}

/** Starts a load with this `$`; never rejects, and says so when it could not even record its failure. */
export async function load($: EngineInterface): Promise<void> {
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
        : failedLoad(failedAs, { kind: 'local' }, 0, pageOf(current, failedAs), fetchedAtOf(current, failedAs)),
    )
  }
}
