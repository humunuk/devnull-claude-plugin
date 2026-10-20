// The world beneath the mod when it posts: the stored account, an SSH agent,
// mktemp, ssh-keygen, rm and rmdir, the file system and dev-null.sh. Each hook
// records what the mod asked, so a test can show what was (not) run, written
// or sent, and in which order.

import type { HttpInit, HttpResponse, On, ProcessRunInit } from 'claude-code'
import { mock } from 'claude-code/testing'

import type { PostingIo } from '../hooks/posting'
import { ED25519 } from './fixtures/keys'
import { ED25519_SIGNATURE } from './fixtures/signatures'

/** What one command does: exits with this code and output, never runs, or is killed at its timeout. */
export type Step = { exitCode: number; stdout: string } | 'cannot-run' | 'times-out'

/** What the post gets: an answer, or a request that fails. */
export type Server = { status: number; text: string; headers?: Record<string, string> } | 'unreachable'

export const ACCOUNT = { fingerprint: ED25519.fingerprint, publicKey: ED25519.line, username: 'some-user' } as const

export const TEMP_DIR = '/tmp/tmp.Ab3dE5gH9k'

export const NOW_MS = Date.UTC(2026, 9, 20, 12, 0, 0, 500)

export const COMMIT_ID = '0190a1b2-c3d4-7e5f-8a9b-000000000042'

export const COMMITTED_BODY = `Committed: https://dev-null.sh/@some-user/commits/${COMMIT_ID}\n`

export type PostingSetup = {
  /** What `$.store` holds under `account`; the fixture account when not given, nothing when null. Writes are recorded, not kept. */
  account?: unknown
  agent?: Step
  mktemp?: Step
  sign?: Step
  rm?: Step
  rmdir?: Step
  server?: Server
  isWriteBroken?: boolean
}

export type Event =
  | { kind: 'run'; argv: readonly string[]; init: ProcessRunInit | undefined }
  | { kind: 'write'; path: string; text: string }
  | { kind: 'fetch'; url: string; init: HttpInit | undefined }
  | { kind: 'store-set'; key: string; value: unknown }

export type PostingWorld = {
  /** Every run, write and request, in order. */
  events: Event[]
  runs: () => { argv: readonly string[]; init: ProcessRunInit | undefined }[]
  requests: () => { url: string; init: HttpInit | undefined }[]
}

export const OK = (stdout = ''): Step => ({ exitCode: 0, stdout })

export function postingWorld(on: On, setup: PostingSetup = {}): PostingWorld {
  const events: Event[] = []
  const account = setup.account === undefined ? ACCOUNT : setup.account

  mock.clock(on, { now: NOW_MS })
  on('store.get', (_, e) => ({ value: e.key === 'account' && account !== null ? account : undefined }))
  on('store.set', (_, e) => {
    events.push({ kind: 'store-set', key: e.key, value: e.value })

    return { value: undefined }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  on('process.run', (_, e) => {
    events.push({ kind: 'run', argv: e.argv, init: e.init })
    const step = stepFor(e.argv[0], setup)
    if (step === 'cannot-run') return { deny: `${e.argv[0] ?? ''}: command not found` }
    if (step === 'times-out') return { deny: `${e.argv[0] ?? ''} killed after ${e.init?.timeoutMs ?? 30000}ms` }

    return { value: { ...step, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  on('fs.write', (_, e) => {
    events.push({ kind: 'write', path: e.path, text: e.text })
    if (setup.isWriteBroken === true) return { deny: 'EACCES: permission denied' }

    return { value: undefined }
  })

  on('http.fetch', (_, e) => {
    events.push({ kind: 'fetch', url: e.url, init: e.init })
    const server = setup.server
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

  return {
    events,
    runs: () => events.flatMap(event => (event.kind === 'run' ? [{ argv: event.argv, init: event.init }] : [])),
    requests: () => events.flatMap(event => (event.kind === 'fetch' ? [{ url: event.url, init: event.init }] : [])),
  }
}

function stepFor(command: string | undefined, setup: PostingSetup): Step {
  switch (command) {
    case 'ssh-add':
      return setup.agent ?? OK(`${ED25519.line} ${ED25519.comment}\n`)
    case 'mktemp':
      return setup.mktemp ?? OK(`${TEMP_DIR}\n`)
    case 'ssh-keygen':
      return setup.sign ?? OK(ED25519_SIGNATURE)
    case 'rm':
      return setup.rm ?? OK()
    case 'rmdir':
      return setup.rmdir ?? OK()
    default:
      return 'cannot-run'
  }
}

/**
 * A PostingIo for calling runPosting directly, as the hook does: each call
 * answers as postingWorld does by default and is recorded by name. The kit
 * cannot interrupt a command run, so a test flips `aborted` from inside a call
 * (`onCall` runs before the call answers, and may throw to make it fail).
 */
export function stubIo(onCall: (name: string, state: { aborted: boolean }) => void = () => {}) {
  const calls: string[] = []
  const state = { aborted: false }
  const record = (name: string) => {
    calls.push(name)
    onCall(name, state)
  }
  const ran = async (name: string, step: Step) => {
    record(name)
    if (typeof step === 'string') throw new Error(`${name} ${step}`)

    return { ...step, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  }
  const io: PostingIo = {
    readAccount: async () => {
      record('readAccount')

      return ACCOUNT
    },
    listAgentKeys: () => ran('ssh-add', OK(`${ED25519.line} ${ED25519.comment}\n`)),
    makeTempDir: () => ran('mktemp', OK(`${TEMP_DIR}\n`)),
    writeKey: async () => record('write'),
    sign: () => ran('ssh-keygen', OK(ED25519_SIGNATURE)),
    removeFile: () => ran('rm', OK()),
    removeDir: () => ran('rmdir', OK()),
    nowMs: async () => {
      record('clock')

      return NOW_MS
    },
    send: async () => {
      record('send')

      return { status: 201, ok: true, headers: {}, text: COMMITTED_BODY }
    },
    isAborted: () => state.aborted,
  }

  return { io, calls, state }
}
