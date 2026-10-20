// The world beneath the mod in a test: an SSH agent answering `ssh-add -L`,
// dev-null.sh answering the key lookup and the profile lookup, a store that
// records each write (or refuses it), and a clock that moves only when the
// test moves it. Each hook records what the mod
// asked, so a test can show what was (not) run, sent or kept.

import type { HttpInit, HttpResponse, On, ProcessRunInit, PromptOrigin } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { apiProfile } from './fixtures/profiles'

/** What `ssh-add -L` does: exits with this code and output, or never runs. */
export type Agent = { exitCode: number; stdout: string } | 'cannot-run'

/** What the key lookup gets: an answer, or a request that fails. */
export type Server = { status: number; text: string; headers?: Record<string, string> } | 'unreachable'

/** What the profile lookup gets: as Server, or (the default) a 200 with the profile of the username asked for. */
export type Profile = Server | 'echo'

export const PROFILE_URL = 'https://dev-null.sh/api/v1/users/'

export const NOW = Date.UTC(2026, 9, 20, 12, 0, 0)

export type World = {
  runs: { argv: readonly string[]; init: ProcessRunInit | undefined }[]
  requests: { url: string; init: HttpInit | undefined }[]
  writes: { key: string; value: unknown }[]
  clock: MockClock
}

export function world(
  on: On,
  agent: Agent,
  server?: Server,
  options: {
    isStoreBroken?: boolean
    profile?: Profile
    /** Runs as each request arrives, before it is answered. */
    onRequest?: (url: string) => void
  } = {},
): World {
  const runs: World['runs'] = []
  const requests: World['requests'] = []
  const writes: World['writes'] = []

  const clock = mock.clock(on, { now: NOW })

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.set', (_, e) => {
    if (options.isStoreBroken === true) return { deny: 'disk full at /home/someone' }
    writes.push({ key: e.key, value: e.value })

    return { value: undefined }
  })

  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, init: e.init })
    if (agent === 'cannot-run') return { deny: 'ssh-add: command not found' }

    return { value: { ...agent, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  on('http.fetch', (_, e) => {
    requests.push({ url: e.url, init: e.init })
    options.onRequest?.(e.url)
    const answer = e.url.startsWith(PROFILE_URL) ? profileAnswer(e.url, options.profile ?? 'echo') : server
    if (answer === undefined) return { deny: 'this test sends nothing' }
    if (answer === 'unreachable') return { deny: 'getaddrinfo ENOTFOUND dev-null.sh' }
    const response: HttpResponse = {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: answer.headers ?? {},
      text: answer.text,
    }

    return { value: response }
  })

  return { runs, requests, writes, clock }
}

function profileAnswer(url: string, profile: Profile): Server {
  if (profile !== 'echo') return profile

  return { status: 200, text: JSON.stringify(apiProfile(url.slice(PROFILE_URL.length))) }
}

/**
 * The mod's one 429 hold (`devnull.paneNotBeforeMs`) as a test sees it: each
 * value written, and `set`, which makes every read answer `atMs` as if
 * another of the mod's requests had met a 429 (undefined goes back to what
 * the mod wrote).
 */
export function watchHold(on: On): { written: unknown[]; set: (atMs: number | undefined) => void } {
  const written: unknown[] = []
  let forced: number | undefined
  on('state.get', { plugin: 'devnull', key: 'paneNotBeforeMs' }, (_, e, next) =>
    forced === undefined ? next(e) : { value: { value: forced, version: 0 } },
  )
  on('state.set', { plugin: 'devnull', key: 'paneNotBeforeMs' }, (_, e, next) => {
    written.push(e.value)

    return next(e)
  })

  return {
    written,
    set: atMs => {
      forced = atMs
    },
  }
}

/** Runs `/devnull <args>` as the session would, from `origin`. */
export async function devnull($: Engine, args: string, origin: PromptOrigin = { kind: 'composer' }): Promise<string> {
  const { text } = await $.command.run({
    command: 'devnull',
    args,
    origin,
    presentation: { isFullscreen: false, columns: 80 },
  })
  if (text === undefined) throw new Error('/devnull answered with no text')

  return text
}

/** `ssh-add -L` output: one key line and comment per entry. */
export function agentList(...lines: readonly string[]): string {
  return lines.map(line => `${line}\n`).join('')
}
