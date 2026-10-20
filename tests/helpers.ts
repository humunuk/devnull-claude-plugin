// The world beneath the mod in a test: an SSH agent answering `ssh-add -L`,
// dev-null.sh answering the key lookup, and a store that records each write
// (or refuses it). Each hook records what the mod asked, so a test can show
// what was (not) run, sent or kept.

import type { HttpInit, HttpResponse, On, ProcessRunInit, PromptOrigin } from 'claude-code'
import type { Engine } from 'claude-code/testing'

/** What `ssh-add -L` does: exits with this code and output, or never runs. */
export type Agent = { exitCode: number; stdout: string } | 'cannot-run'

/** What the key lookup gets: an answer, or a request that fails. */
export type Server = { status: number; text: string; headers?: Record<string, string> } | 'unreachable'

export type World = {
  runs: { argv: readonly string[]; init: ProcessRunInit | undefined }[]
  requests: { url: string; init: HttpInit | undefined }[]
  writes: { key: string; value: unknown }[]
}

export function world(on: On, agent: Agent, server?: Server, options: { isStoreBroken?: boolean } = {}): World {
  const runs: World['runs'] = []
  const requests: World['requests'] = []
  const writes: World['writes'] = []

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
    if (server === undefined) return { deny: 'this test sends nothing' }
    if (server === 'unreachable') return { deny: 'getaddrinfo ENOTFOUND dev-null.sh' }
    const response: HttpResponse = {
      status: server.status,
      ok: server.status >= 200 && server.status < 300,
      headers: server.headers ?? {},
      text: server.text,
    }

    return { value: response }
  })

  return { runs, requests, writes }
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
