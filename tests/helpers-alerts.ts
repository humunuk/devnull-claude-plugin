// The world beneath the reply alerts in a test: a clock that moves only when
// the test moves it, dev-null.sh answering the two commit lists, a store in
// memory that records each write (or refuses them), the engine's record of
// open panes, and the status line, toasts and debug log recorded as they are
// called.

import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { mock } from 'claude-code/testing'

import { ED25519 } from './fixtures/keys'
import { USERNAME, apiCommit, apiList } from './fixtures/commits'

export const NOW = Date.UTC(2026, 9, 20, 12, 0, 0)

export const COMMITS_URL = `https://dev-null.sh/api/v1/users/${USERNAME}/commits`
export const REPLIES_URL = `${COMMITS_URL}?replies=1`

export const ACCOUNT = { fingerprint: ED25519.fingerprint, publicKey: ED25519.line, username: USERNAME }

/**
 * What one list request gets: an answer (after `delayMs` on the mocked clock,
 * when given), a refused connection, or no answer (rejected after 30 s, as
 * `$.http.fetch` does).
 */
export type ListAnswer =
  | { status: number; text: string; headers?: Record<string, string>; delayMs?: number }
  | 'unreachable'
  | 'silent'

export type AlertsWorld = {
  clock: MockClock
  /** The URLs asked for, in order. */
  requests: string[]
  /** What each request was sent with, in order. */
  inits: unknown[]
  /** What the store holds now. */
  store: Map<string, unknown>
  writes: { key: string; value: unknown }[]
  toasts: string[]
  /** Each status line set; undefined is a clear. */
  statuses: (string | undefined)[]
  logs: string[]
  /** What the next requests for each list get; change it between polls. */
  server: { commits: ListAnswer; replies: ListAnswer }
  /** Each recent list the mod kept for the hash completion, in order. */
  recent: unknown[]
  /** Requests whose answer has not come yet. */
  pending: () => number
  /** The ids of the panes the engine holds open. */
  open: Set<string>
}

export function alertsWorld(
  on: On,
  options: {
    store?: Record<string, unknown>
    brokenKeys?: readonly string[]
    server?: AlertsWorld['server']
    /** Listing the open panes is refused, so `/devnull off` cannot close the pane. */
    arePanesBroken?: boolean
    /** How the engine takes `$.ui.open`: drawn (the default), opened but waiting undrawn, or refused. */
    opens?: 'placed' | 'unplaced' | 'refused'
  } = {},
): AlertsWorld {
  const clock = mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>(Object.entries(options.store ?? { account: ACCOUNT }))
  const world: AlertsWorld = {
    clock,
    requests: [],
    inits: [],
    store,
    writes: [],
    toasts: [],
    statuses: [],
    logs: [],
    recent: [],
    server: options.server ?? { commits: ok([]), replies: ok([]) },
    pending: () => waiting,
    open: new Set<string>(),
  }
  let waiting = 0

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  // The pane opens and closes as the engine would; none is open at first.
  on('ui.panes', () =>
    options.arePanesBroken === true
      ? { deny: 'panes refused at /home/someone' }
      : { value: [...world.open].map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) },
  )
  on('ui.open', (_, e) => {
    if (options.opens === 'refused') return { deny: 'open refused at /home/someone' }
    world.open.add(e.id)

    return { value: options.opens === 'unplaced' ? { isPlaced: false, reason: 'no-surface' } : { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    world.open.delete(e.id)

    return { value: undefined }
  })

  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    if (options.brokenKeys?.includes(e.key) === true) return { deny: 'disk full at /home/someone' }
    world.writes.push({ key: e.key, value: e.value })
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))

    return { value: undefined }
  })

  on('state.set', { plugin: 'devnull', key: 'recent' }, (_, e, next) => {
    world.recent.push(e.value)

    return next(e)
  })

  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    world.statuses.push(e.text)

    return { value: undefined }
  })
  on('ui.log', (_, e) => {
    world.logs.push(e.text)

    return { value: undefined }
  })

  on('http.fetch', async (_, e) => {
    world.requests.push(e.url)
    world.inits.push(e.init)
    const answer = e.url === REPLIES_URL ? world.server.replies : e.url === COMMITS_URL ? world.server.commits : undefined
    if (answer === undefined) return { deny: `this test serves no ${e.url}` }
    if (answer === 'unreachable') return { deny: 'getaddrinfo ENOTFOUND dev-null.sh' }
    if (answer === 'silent') {
      waiting += 1
      await clock.sleep(30_000)
      waiting -= 1

      return { deny: 'aborted: no complete answer within 30000ms' }
    }

    if (answer.delayMs !== undefined) {
      waiting += 1
      await clock.sleep(answer.delayMs)
      waiting -= 1
    }

    return {
      value: { status: answer.status, ok: answer.status >= 200 && answer.status < 300, headers: answer.headers ?? {}, text: answer.text },
    }
  })

  return world
}

/** The body of a list of invented commits `ns`, each with the replies count given (default 0). */
export function listText(ns: readonly number[], replies: Readonly<Record<number, number>> = {}): string {
  return JSON.stringify(apiList(ns.map(n => apiCommit(n, { replies_count: replies[n] ?? 0 }))))
}

/** A 200 with the list of invented commits `ns`, each with the replies count given (default 0). */
export function ok(ns: readonly number[], replies: Readonly<Record<number, number>> = {}): ListAnswer {
  return { status: 200, text: listText(ns, replies) }
}

/** Starts an interactive terminal session, as the REPL does. */
export async function startSession($: Engine): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

/** Runs `/devnull <args>` as the session would, from `origin`. */
export async function devnullCommand(
  $: Engine,
  args: string,
  origin: Parameters<Engine['command']['run']>[0]['origin'] = { kind: 'composer' },
): Promise<string> {
  const { text } = await $.command.run({ command: 'devnull', args, origin, presentation: { isFullscreen: false, columns: 80 } })
  if (text === undefined) throw new Error('/devnull answered with no text')

  return text
}
