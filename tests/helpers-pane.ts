// The world beneath the pane in a test: the engine's record of open panes,
// a store holding (or not) the account setup chose, a clock that moves only
// when the test moves it, and dev-null.sh answering the commit list. Each
// request is recorded, and one can be held unanswered until the test lets it go.

import type { CommandRunResult, HttpInit, HttpResponse, On, PromptOrigin } from 'claude-code'
import { mock } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'

import { ED25519 } from './fixtures/keys'
import { USERNAME } from './fixtures/commits'

export const NOW = Date.UTC(2026, 9, 20, 12, 0, 0)

export const ACCOUNT = { fingerprint: ED25519.fingerprint, publicKey: ED25519.line, username: USERNAME }

export const SURFACES = ['terminal', 'desktop'] as const

/** What dev-null.sh does with the next request: answers, fails, or holds it until `release`. */
export type Answer = { status: number; text: string; headers?: Record<string, string> } | 'unreachable' | 'held'

export type PaneWorld = {
  requests: { url: string; init: HttpInit | undefined }[]
  toasts: string[]
  clock: MockClock
  /** The ids the engine holds open. */
  open: Set<string>
  /** How often the mod has asked which panes are open: the toggle, and each tick of its redraw timer. */
  panesAsked: () => number
  /** Sets what every request from now on gets. */
  answer: (answer: Answer) => void
  /** Answers the held request with `answer`. */
  release: (answer: Exclude<Answer, 'held'>) => void
  /** The person closes the pane (its close mark, ctrl+x x): the engine's record drops it. */
  closeByPerson: () => void
  /** What `/devnull setup` would have kept, from now on. */
  setAccount: (value: unknown) => void
}

export function paneWorld(
  on: On,
  options: { account?: unknown; answer?: Answer; isPlaced?: boolean; isStoreBroken?: boolean } = {},
): PaneWorld {
  const requests: PaneWorld['requests'] = []
  const toasts: string[] = []
  const open = new Set<string>()
  let current: Answer = options.answer ?? 'unreachable'
  let held: ((answer: Exclude<Answer, 'held'>) => void) | undefined

  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // The store as the pane reads it: setup's account, or nothing.
  let account: unknown = options.account
  on('store.get', (_, e) => {
    if (options.isStoreBroken === true) return { deny: 'disk on fire at /home/someone' }

    return { value: e.key === 'account' ? account : undefined }
  })
  const clock = mock.clock(on, { now: NOW })

  on('ui.open', (_, e) => {
    open.add(e.id)

    return { value: options.isPlaced === false ? { isPlaced: false, reason: 'no-surface' } : { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    open.delete(e.id)

    return { value: undefined }
  })
  let panesAsked = 0
  on('ui.panes', () => {
    panesAsked += 1

    return { value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }
  })
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  on('http.fetch', (_, e) => {
    requests.push({ url: e.url, init: e.init })
    if (current !== 'held') return respond(current)

    return new Promise(resolve => {
      held = answer => resolve(respond(answer))
    })
  })

  return {
    requests,
    toasts,
    clock,
    open,
    panesAsked: () => panesAsked,
    answer: answer => {
      current = answer
    },
    release: answer => {
      if (held === undefined) throw new Error('no request is held')
      const answerHeld = held
      held = undefined
      answerHeld(answer)
    },
    closeByPerson: () => {
      open.delete('devnull')
    },
    setAccount: value => {
      account = value
    },
  }
}

function respond(answer: Exclude<Answer, 'held'>): { value: HttpResponse } | { deny: string } {
  if (answer === 'unreachable') return { deny: 'getaddrinfo ENOTFOUND dev-null.sh' }

  return {
    value: {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: answer.headers ?? {},
      text: answer.text,
    },
  }
}

/** Runs a bare `/devnull`, as the session would, from `origin`. */
export function toggle($: Engine, origin: PromptOrigin = { kind: 'composer' }): Promise<CommandRunResult> {
  return $.command.run({ command: 'devnull', args: '', origin, presentation: { isFullscreen: false, columns: 120 } })
}

export const PANE_PROPS = {
  title: '/dev/null',
  isFocused: true,
  bodyColumns: 60,
  placement: 'inline',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
} as const

export function mountPane($: Engine, surface: (typeof SURFACES)[number] | 'vscode' | 'mobile') {
  return $.ui.mount({ plugin: 'devnull', component: 'Pane', requestId: 'devnull', surface, props: PANE_PROPS })
}

/**
 * The drawing as rows of text, roughly as the terminal lays it out: each
 * child of a column Box a row of its own, a row Box's children side by side,
 * a plain Button with a hotkey as `r: label`, a Link as its label. For
 * reading a whole drawing in a test; a surface's paint may differ.
 */
export function rowsOf(tree: unknown): string[] {
  if (typeof tree === 'string') return [tree]
  if (!isElement(tree)) return []
  const { type, props, children } = partsOf(tree)
  switch (type) {
    case 'Box': {
      if (props.flexDirection === 'row') return [children.map(child => rowsOf(child).join(' ')).join('')]

      return children.flatMap(child => rowsOf(child))
    }
    case 'Button': {
      const label = typeof props.label === 'string' ? props.label : ''

      return [typeof props.hotkey === 'string' ? `${props.hotkey}: ${label}` : `[ ${label} ]`]
    }
    case 'Link':
      return [typeof props.label === 'string' ? props.label : typeof props.href === 'string' ? props.href : '']
    default:
      return [children.map(child => rowsOf(child).join('')).join('')]
  }
}

type DrawnElement = { type: string; props: Record<string, unknown>; children: unknown[] }

function isElement(value: unknown): value is object {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'type') === 'string'
}

/** An element of a drawn tree as plain parts: its props and children, empty when it has none. */
function partsOf(value: object): DrawnElement {
  const type: unknown = Reflect.get(value, 'type')
  const props: unknown = Reflect.get(value, 'props')
  const children: unknown = Reflect.get(value, 'children')

  return {
    type: typeof type === 'string' ? type : '',
    props: typeof props === 'object' && props !== null ? Object.fromEntries(Object.entries(props)) : {},
    children: Array.isArray(children) ? children : [],
  }
}
