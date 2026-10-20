import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  DISMISS_FAILED_TEXT,
  EXTRA_WORDS_TEXT,
  OFF_NOT_SAVED_TEXT,
  OFF_TEXT,
  ON_TEXT,
} from '../hooks/alerts'
import { notTypedText } from '../hooks/lib/command'
import { USERNAME, apiCommit, apiList, commitId, shortHashOf } from './fixtures/commits'
import {
  ACCOUNT,
  BAND,
  COMMITS_URL,
  REPLIES_URL,
  alertsWorld,
  devnullCommand,
  listText,
  ok,
  startSession,
} from './helpers-alerts'

const SECOND = 1000
const MINUTE = 60 * SECOND

const SURFACES = ['terminal', 'desktop'] as const

/** What the engine draws in the band when the mod passes: a stand-in, as nothing draws beneath the plugin in a test. */
function engineBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

/** The band's texts on `surface`, joined by `|`. */
async function bandText($: Engine, surface: (typeof SURFACES)[number]): Promise<string> {
  const ui = await $.ui.mount({ ...BAND, surface })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  await ui.unmount()

  return texts.join('|')
}

/** A seen record for the invented commits, by number. */
/**
 * A seen record for the invented commits, by number, as the store keeps it:
 * `[seen, toasted]` per commit; a lone number is both.
 */
const seen = (counts: Record<number, number | readonly [number, number]>) => ({
  username: USERNAME,
  counts: Object.fromEntries(
    Object.entries(counts).map(([n, count]) => [commitId(Number(n)), typeof count === 'number' ? [count, count] : [...count]]),
  ),
})

const hashOf = (n: number) => shortHashOf(commitId(n))

/**
 * The row's `open` link to commit `n`. The desktop surface draws a link whose
 * address holds a raw `@` as plain text (2.1.304: "its href holds a raw @, and
 * the desktop surface is sent no other link"), which every commit link does.
 */
async function expectOpenLink(ui: { surface: string; find: (query: { type: string; text?: string }) => Promise<{ props: Record<string, unknown> } | undefined> }, n: number): Promise<void> {
  const link = await ui.find({ type: 'Link' })
  if (ui.surface === 'terminal') {
    expect(link?.props).toEqual({ href: `https://dev-null.sh/@${USERNAME}/commits/${commitId(n)}`, label: 'open \u2197' })
  } else {
    expect(link).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'open \u2197' })).toBeDefined()
  }
}

describe('the first poll for an account', () => {
  test('asks for both lists and keeps the counts it found without alerting', async ($, on) => {
    engineBand(on)
    const world = alertsWorld(on, { server: { commits: ok([1, 2], { 1: 3, 2: 1 }), replies: ok([3], { 3: 2 }) } })

    await startSession($)
    await world.clock.settle()

    expect(world.requests).toEqual([COMMITS_URL, REPLIES_URL])
    expect(world.inits).toEqual([
      { method: 'GET', headers: { Accept: 'application/json' } },
      { method: 'GET', headers: { Accept: 'application/json' } },
    ])
    expect(world.writes).toEqual([{ key: 'seenReplies', value: seen({ 1: 3, 2: 1, 3: 2 }) }])
    expect(world.toasts).toEqual([])
    expect(world.statuses.filter(text => text !== undefined)).toEqual([])
    for (const surface of SURFACES) expect(await bandText($, surface)).toBe('engine')
  })

  test('keeps both lists in the recent list for the hash completion', async ($, on) => {
    const world = alertsWorld(on, { server: { commits: ok([1, 2]), replies: ok([3]) } })

    await startSession($)
    await world.clock.settle()

    expect(world.recent).toHaveLength(1)
    expect(world.recent[0]).toMatchObject({ username: USERNAME, fetchedAtMs: world.clock.now() })
    expect(JSON.stringify(world.recent[0])).toContain(commitId(1))
    expect(JSON.stringify(world.recent[0])).toContain(commitId(2))
    expect(JSON.stringify(world.recent[0])).toContain(commitId(3))
  })
})

describe('a rise in a replies count', () => {
  test('is shown once: one toast, the band and the status line', async ($, on) => {
    engineBand(on)
    const world = alertsWorld(on, { server: { commits: ok([1, 2], { 1: 1 }), replies: ok([3]) } })
    await startSession($)
    await world.clock.settle()

    world.server.commits = ok([1, 2], { 1: 3 })
    await world.clock.advance(MINUTE)

    expect(world.requests).toHaveLength(4)
    expect(world.toasts).toEqual([`\u21b3 2 new replies on ${hashOf(1)}`])
    expect(world.statuses.at(-1)).toBe('devnull \u21b32')

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const row = await ui.find({ type: 'Text', text: /new replies/ })
      expect(row?.text).toBe(`\u21b3 2 new replies on ${hashOf(1)}`)
      const hash = await ui.find({ type: 'Text', text: new RegExp(`^${hashOf(1)}$`) })
      expect(hash?.props.color).toBe('warning')
      await expectOpenLink(ui, 1)
      const button = await ui.find({ key: 'dismiss' })
      expect(button?.props).toMatchObject({ label: 'dismiss', hotkey: 'd' })
      await ui.unmount()
    }

    // The same counts again: nothing new to toast.
    await world.clock.advance(MINUTE)
    await world.clock.advance(MINUTE)
    expect(world.requests).toHaveLength(8)
    expect(world.toasts).toHaveLength(1)
    expect(world.statuses.at(-1)).toBe('devnull \u21b32')
  })

  test('toasts again when the same commit rises further, and once per commit', async ($, on) => {
    const world = alertsWorld(on, { server: { commits: ok([1, 2]), replies: ok([3]) } })
    await startSession($)
    await world.clock.settle()

    world.server.commits = ok([1, 2], { 1: 1 })
    await world.clock.advance(MINUTE)
    world.server.commits = ok([1, 2], { 1: 2, 2: 4 })
    world.server.replies = ok([3], { 3: 1 })
    await world.clock.advance(MINUTE)

    expect(world.toasts).toEqual([
      `\u21b3 1 new reply on ${hashOf(1)}`,
      `\u21b3 2 new replies on ${hashOf(1)}`,
      `\u21b3 4 new replies on ${hashOf(2)}`,
      `\u21b3 1 new reply on ${hashOf(3)}`,
    ])
    expect(world.statuses.at(-1)).toBe('devnull \u21b37')
  })

  test('on a commit newer than the last poll counts all its replies', async ($, on) => {
    const world = alertsWorld(on, { server: { commits: ok([1]), replies: ok([]) } })
    await startSession($)
    await world.clock.settle()

    world.server.commits = ok([4, 1], { 4: 2 })
    await world.clock.advance(MINUTE)

    expect(world.toasts).toEqual([`\u21b3 2 new replies on ${hashOf(4)}`])
  })

  test('on a commit that left the lists and came back counts from what was seen', async ($, on) => {
    engineBand(on)
    const world = alertsWorld(on, { server: { commits: ok([4], { 4: 6 }), replies: ok([]) } })
    await startSession($)
    await world.clock.settle()

    // Newer commits push 4 out of the window, then it comes back (one of them was deleted).
    world.server.commits = ok([2, 3])
    await world.clock.advance(MINUTE)
    world.server.commits = ok([3, 4], { 4: 6 })
    await world.clock.advance(MINUTE)

    expect(world.toasts).toEqual([])
    expect(world.statuses.filter(text => text !== undefined)).toEqual([])
    for (const surface of SURFACES) expect(await bandText($, surface)).toBe('engine')
    expect(world.store.get('seenReplies')).toEqual(seen({ 3: 0, 4: 6, 2: 0 }))
  })

  test('after a fall alerts from the lower count', async ($, on) => {
    const world = alertsWorld(on, {
      store: { account: ACCOUNT, seenReplies: seen({ 1: 5 }) },
      server: { commits: ok([1], { 1: 3 }), replies: ok([]) },
    })
    await startSession($)
    await world.clock.settle()
    expect(world.toasts).toEqual([])
    expect(world.store.get('seenReplies')).toEqual(seen({ 1: 3 }))

    world.server.commits = ok([1], { 1: 4 })
    await world.clock.advance(MINUTE)
    expect(world.toasts).toEqual([`\u21b3 1 new reply on ${hashOf(1)}`])
  })

  test('shows at most five rows and says how many more', async ($, on) => {
    const ns = [1, 2, 3, 4, 5, 6, 7]
    const world = alertsWorld(on, {
      store: { account: ACCOUNT, seenReplies: seen(Object.fromEntries(ns.map(n => [n, 0]))) },
      server: { commits: ok(ns, Object.fromEntries(ns.map(n => [n, 1]))), replies: ok([]) },
    })
    await startSession($)
    await world.clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.findAll({ type: surface === 'terminal' ? 'Link' : 'Text', text: 'open \u2197' })).toHaveLength(5)
      expect((await ui.find({ type: 'Text', text: /more/ }))?.text).toBe('and 2 more')
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(1)
      await ui.unmount()
    }
    expect(world.statuses.at(-1)).toBe('devnull \u21b37')
  })

  test('yields the band to a survey', async ($, on) => {
    engineBand(on)
    const world = alertsWorld(on, {
      store: { account: ACCOUNT, seenReplies: seen({ 1: 0 }) },
      server: { commits: ok([1], { 1: 1 }), replies: ok([]) },
    })
    await startSession($)
    await world.clock.settle()

    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface })
      expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
      expect(await ui.find({ type: 'Link' })).toBeUndefined()
      await ui.unmount()
    }
  })
})

describe('dismissing', () => {
  for (const surface of SURFACES) {
    test(`with d on ${surface} marks the replies seen and clears the band and the status line`, async ($, on) => {
      engineBand(on)
      const world = alertsWorld(on, {
        store: { account: ACCOUNT, seenReplies: seen({ 1: 1, 2: 0 }) },
        server: { commits: ok([1, 2], { 1: 3, 2: 2 }), replies: ok([]) },
      })
      await startSession($)
      await world.clock.settle()
      expect(world.statuses.at(-1)).toBe('devnull \u21b34')

      const ui = await $.ui.mount({ ...BAND, surface })
      await ui.press({ key: 'dismiss' })
      await ui.unmount()

      expect(world.store.get('seenReplies')).toEqual(seen({ 1: 3, 2: 2 }))
      expect(world.statuses.at(-1)).toBeUndefined()
      expect(await bandText($, surface)).toBe('engine')

      // The next poll with the same counts brings nothing back.
      await world.clock.advance(MINUTE)
      expect(world.requests).toHaveLength(4)
      expect(world.statuses.at(-1)).toBeUndefined()
      expect(world.toasts).toHaveLength(2)
    })
  }

  test('that cannot be saved says so in a toast and keeps the alerts', async ($, on) => {
    const world = alertsWorld(on, {
      // A reply not seen yet, already toasted: the poll has nothing to write.
      store: { account: ACCOUNT, seenReplies: seen({ 1: [0, 1] }) },
      server: { commits: ok([1], { 1: 1 }), replies: ok([]) },
      brokenKeys: ['seenReplies'],
    })
    await startSession($)
    await world.clock.settle()
    expect(world.statuses.at(-1)).toBe('devnull \u21b31')

    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    await ui.press({ key: 'dismiss' })

    expect(world.toasts.at(-1)).toBe(DISMISS_FAILED_TEXT)
    expect(world.toasts.join('\n')).not.toContain('/home/someone')
    expect(await ui.find({ key: 'dismiss' })).toBeDefined()
    expect(world.statuses.at(-1)).toBe('devnull \u21b31')
    await ui.unmount()
  })
})

describe('a restart', () => {
  test('before dismissing shows the alerts again from the kept counts, without a second toast', async ($, on) => {
    engineBand(on)
    // What the store holds after a session that saw 1 reply, then was toasted for 3.
    const world = alertsWorld(on, {
      store: { account: ACCOUNT, seenReplies: seen({ 1: [1, 3] }) },
      server: { commits: ok([1], { 1: 3 }), replies: ok([]) },
    })

    await startSession($)
    await world.clock.settle()

    expect(world.writes).toEqual([])
    expect(world.toasts).toEqual([])
    expect(world.statuses.at(-1)).toBe('devnull \u21b32')
    for (const surface of SURFACES) expect(await bandText($, surface)).toContain('2 new replies')
  })

  test('keeps what was toasted: the toast of a rise is not raised again in the next session', async ($, on) => {
    const world = alertsWorld(on, {
      store: { account: ACCOUNT, seenReplies: seen({ 1: 1 }) },
      server: { commits: ok([1], { 1: 3 }), replies: ok([]) },
    })

    await startSession($)
    await world.clock.settle()
    expect(world.toasts).toEqual([`\u21b3 2 new replies on ${hashOf(1)}`])
    // The toasted count is kept before the toast is raised.
    expect(world.store.get('seenReplies')).toEqual(seen({ 1: [1, 3] }))
  })

  test('after dismissing shows nothing', async ($, on) => {
    engineBand(on)
    const world = alertsWorld(on, {
      store: { account: ACCOUNT, seenReplies: seen({ 1: 3 }) },
      server: { commits: ok([1], { 1: 3 }), replies: ok([]) },
    })

    await startSession($)
    await world.clock.settle()

    expect(world.writes).toEqual([])
    expect(world.toasts).toEqual([])
    for (const surface of SURFACES) expect(await bandText($, surface)).toBe('engine')
  })

  test('for another account starts that account silently', async ($, on) => {
    const world = alertsWorld(on, {
      store: { account: ACCOUNT, seenReplies: { username: 'someone-else', counts: { [commitId(1)]: [0, 0] } } },
      server: { commits: ok([1], { 1: 3 }), replies: ok([]) },
    })

    await startSession($)
    await world.clock.settle()

    expect(world.toasts).toEqual([])
    expect(world.store.get('seenReplies')).toEqual(seen({ 1: 3 }))
  })

  for (const [name, hostile] of [
    ['a negative count', { username: USERNAME, counts: { [commitId(1)]: [-1, 0] } }],
    ['a key that is no id', { username: USERNAME, counts: { 'not-a-uuid': [1, 1] } }],
    ['a lone count (no toasted count)', { username: USERNAME, counts: { [commitId(1)]: 1 } }],
    ['three counts', { username: USERNAME, counts: { [commitId(1)]: [1, 1, 1] } }],
    ['an extra field', { username: USERNAME, counts: {}, extra: 1 }],
    ['counts as a list', { username: USERNAME, counts: [] }],
    ['a string', 'everything'],
  ] as const) {
    test(`with a seen record holding ${name} starts silently`, async ($, on) => {
      const world = alertsWorld(on, {
        store: { account: ACCOUNT, seenReplies: hostile },
        server: { commits: ok([1], { 1: 3 }), replies: ok([]) },
      })
      await startSession($)
      await world.clock.settle()

      expect(world.toasts).toEqual([])
      expect(world.store.get('seenReplies')).toEqual(seen({ 1: 3 }))
    })
  }

  test('a second session.start leaves one poller', async ($, on) => {
    const world = alertsWorld(on)
    await startSession($)
    await world.clock.settle()
    await startSession($)
    await world.clock.settle()
    expect(world.requests).toHaveLength(2)

    await world.clock.advance(MINUTE)
    expect(world.requests).toHaveLength(4)
    await world.clock.advance(10 * MINUTE)
    expect(world.requests).toHaveLength(24)
  })

  test('a session.start again (as after a hot reload) polls when the last poll asked, not at once', async ($, on) => {
    const world = alertsWorld(on)
    await startSession($)
    await world.clock.settle()
    await world.clock.advance(20 * SECOND)

    await startSession($)
    await world.clock.advance(40 * SECOND - 1)
    expect(world.requests).toHaveLength(2)
    await world.clock.advance(1)
    expect(world.requests).toHaveLength(4)
  })
})

describe('polling politely', () => {
  test('waits the interval, 60 seconds by default', async ($, on) => {
    const world = alertsWorld(on)
    await startSession($)
    await world.clock.settle()
    await world.clock.advance(MINUTE - 1)
    expect(world.requests).toHaveLength(2)
    await world.clock.advance(1)
    expect(world.requests).toHaveLength(4)
  })

  test('never polls more often than every 30 seconds', { options: { replyCheckSeconds: 5 } }, async ($, on) => {
    const world = alertsWorld(on)
    await startSession($)
    await world.clock.settle()
    await world.clock.advance(30 * SECOND - 1)
    expect(world.requests).toHaveLength(2)
    await world.clock.advance(1)
    expect(world.requests).toHaveLength(4)
  })

  test('takes a longer interval from the setting', { options: { replyCheckSeconds: 300 } }, async ($, on) => {
    const world = alertsWorld(on)
    await startSession($)
    await world.clock.settle()
    await world.clock.advance(300 * SECOND - 1)
    expect(world.requests).toHaveLength(2)
    await world.clock.advance(1)
    expect(world.requests).toHaveLength(4)
  })

  test('backs off on errors and comes back to the interval after a success', async ($, on) => {
    const world = alertsWorld(on, { server: { commits: { status: 500, text: 'oops' }, replies: ok([]) } })
    await startSession($)
    await world.clock.settle()
    // A failing list ends the poll: the second list is not asked for.
    expect(world.requests).toEqual([COMMITS_URL])

    await world.clock.advance(2 * MINUTE - 1)
    expect(world.requests).toHaveLength(1)
    await world.clock.advance(1)
    expect(world.requests).toHaveLength(2)

    world.server.commits = 'unreachable'
    await world.clock.advance(4 * MINUTE - 1)
    expect(world.requests).toHaveLength(2)
    await world.clock.advance(1)
    expect(world.requests).toHaveLength(3)

    world.server.commits = ok([])
    await world.clock.advance(8 * MINUTE)
    expect(world.requests).toHaveLength(5)
    await world.clock.advance(MINUTE)
    expect(world.requests).toHaveLength(7)
    expect(world.logs.join('\n')).toContain('HTTP 500')
    expect(world.logs.join('\n')).not.toContain('oops')
    expect(world.toasts).toEqual([])
  })

  test('honours Retry-After on a 429, from either list', async ($, on) => {
    const world = alertsWorld(on, {
      server: { commits: ok([]), replies: { status: 429, text: 'slow down', headers: { 'retry-after': '600' } } },
    })
    await startSession($)
    await world.clock.settle()
    expect(world.requests).toHaveLength(2)

    await world.clock.advance(10 * MINUTE - 1)
    expect(world.requests).toHaveLength(2)
    await world.clock.advance(1)
    expect(world.requests).toHaveLength(4)
  })

  test('keeps one request in flight while one gets no answer', async ($, on) => {
    const world = alertsWorld(on, { server: { commits: 'silent', replies: ok([]) } })
    await startSession($)
    await world.clock.settle()
    expect(world.pending()).toBe(1)

    // Stopping and starting again does not send a second one beside it.
    await devnullCommand($, 'off')
    await devnullCommand($, 'on')
    await world.clock.advance(30 * SECOND - 1)
    expect(world.requests).toHaveLength(1)
    expect(world.pending()).toBe(1)

    // It fails at 30 s; the back-off it asked for stands for the new poller.
    world.server.commits = ok([])
    await world.clock.advance(1)
    expect(world.pending()).toBe(0)
    expect(world.requests).toHaveLength(1)
    await world.clock.advance(2 * MINUTE - 1)
    expect(world.requests).toHaveLength(1)
    await world.clock.advance(1)
    expect(world.requests).toHaveLength(3)
  })

  test('sends nothing while no account is set up, and starts once one is', async ($, on) => {
    const world = alertsWorld(on, { store: {} })
    await startSession($)
    await world.clock.settle()
    await world.clock.advance(10 * MINUTE)
    expect(world.requests).toEqual([])

    world.store.set('account', ACCOUNT)
    await world.clock.advance(MINUTE)
    expect(world.requests).toEqual([COMMITS_URL, REPLIES_URL])
  })

  test('sends nothing for an account that is not exactly one', async ($, on) => {
    const world = alertsWorld(on, { store: { account: { ...ACCOUNT, username: '../admin' } } })
    await startSession($)
    await world.clock.advance(5 * MINUTE)
    expect(world.requests).toEqual([])
  })

  test('sends nothing in a session with no person at the prompt', async ($, on) => {
    const world = alertsWorld(on)
    await $.session.start({ cwd: '/', surface: null, isInteractive: false })
    await world.clock.advance(5 * MINUTE)
    expect(world.requests).toEqual([])
  })

  test('stops when the session ends, but not on /clear', async ($, on) => {
    const world = alertsWorld(on)
    await startSession($)
    await world.clock.settle()

    await $.session.end({ reason: 'clear', sessionId: 's', resume: { id: 's' } })
    await world.clock.advance(MINUTE)
    expect(world.requests).toHaveLength(4)

    await $.session.end({ reason: 'prompt_input_exit', sessionId: 's', resume: { id: 's' } })
    await world.clock.advance(10 * MINUTE)
    expect(world.requests).toHaveLength(4)
  })
})

describe('a list that is not exactly what the mod expects', () => {
  const hostileBodies: [string, string][] = [
    ['not JSON', '<html>maintenance</html>'],
    ['no data', JSON.stringify({ items: [] })],
    ['one item with a bad id', JSON.stringify(apiList([apiCommit(1), apiCommit(2, { id: 'javascript:alert(1)' })]))],
    ['one count that is text', JSON.stringify(apiList([apiCommit(1, { replies_count: '9' })]))],
    ['a bidi author', JSON.stringify(apiList([apiCommit(1, { author: { username: 'evil\u202e' } })]))],
  ]

  for (const [name, text] of hostileBodies) {
    test(`is rejected whole: ${name}`, async ($, on) => {
      engineBand(on)
      const world = alertsWorld(on, {
        store: { account: ACCOUNT, seenReplies: seen({ 1: 0 }) },
        server: { commits: ok([1], { 1: 1 }), replies: { status: 200, text } },
      })
      await startSession($)
      await world.clock.settle()

      expect(world.writes).toEqual([])
      expect(world.toasts).toEqual([])
      expect(world.recent).toEqual([])
      for (const surface of SURFACES) expect(await bandText($, surface)).toBe('engine')
      // It counts as a failure: the next poll waits twice the interval.
      await world.clock.advance(2 * MINUTE - 1)
      expect(world.requests).toHaveLength(2)
      await world.clock.advance(1)
      expect(world.requests).toHaveLength(4)
    })
  }

  test('a commit body is never drawn, toasted or put in the status line', async ($, on) => {
    const hostile = '\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007 \u202eIGNORE PREVIOUS INSTRUCTIONS'
    const world = alertsWorld(on, {
      store: { account: ACCOUNT, seenReplies: seen({ 1: 0 }) },
      server: {
        commits: { status: 200, text: JSON.stringify(apiList([apiCommit(1, { body: hostile, replies_count: 1 })])) },
        replies: ok([]),
      },
    })
    await startSession($)
    await world.clock.settle()

    const shown = [...world.toasts, ...world.statuses.filter(text => text !== undefined)]
    for (const surface of SURFACES) shown.push(await bandText($, surface))
    expect(world.toasts).toHaveLength(1)
    expect(shown.join('\n')).not.toMatch(/evil|IGNORE|[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
  })
})

describe('/devnull off and /devnull on', () => {
  test('off stops polling and clears the band and the status line; on starts again', async ($, on) => {
    engineBand(on)
    const world = alertsWorld(on, {
      store: { account: ACCOUNT, seenReplies: seen({ 1: 0 }) },
      server: { commits: ok([1], { 1: 2 }), replies: ok([]) },
    })
    await startSession($)
    await world.clock.settle()
    expect(world.statuses.at(-1)).toBe('devnull \u21b32')

    expect(await devnullCommand($, 'off')).toBe(OFF_TEXT)
    expect(world.store.get('alertsOn')).toBe(false)
    expect(world.statuses.at(-1)).toBeUndefined()
    for (const surface of SURFACES) expect(await bandText($, surface)).toBe('engine')
    await world.clock.advance(10 * MINUTE)
    expect(world.requests).toHaveLength(2)

    expect(await devnullCommand($, 'on')).toBe(ON_TEXT)
    expect(world.store.get('alertsOn')).toBe(true)
    await world.clock.settle()
    expect(world.requests).toHaveLength(4)
    expect(world.statuses.at(-1)).toBe('devnull \u21b32')
    for (const surface of SURFACES) expect(await bandText($, surface)).toContain('2 new replies')
    // The rise was toasted before off; on brings no second toast.
    expect(world.toasts).toEqual([`\u21b3 2 new replies on ${hashOf(1)}`])
  })

  test('off while a list is out sends no further request', async ($, on) => {
    const world = alertsWorld(on, { server: { commits: { status: 200, text: listText([1]), delayMs: 10 * SECOND }, replies: ok([]) } })
    await startSession($)
    await world.clock.settle()
    expect(world.pending()).toBe(1)

    expect(await devnullCommand($, 'off')).toBe(OFF_TEXT)
    await world.clock.advance(10 * SECOND)
    expect(world.pending()).toBe(0)
    await world.clock.advance(10 * MINUTE)

    expect(world.requests).toEqual([COMMITS_URL])
    expect(world.writes.filter(write => write.key === 'seenReplies')).toEqual([])
    expect(world.recent).toEqual([])
  })

  test('on while polling does not poll sooner', async ($, on) => {
    const world = alertsWorld(on)
    await startSession($)
    await world.clock.settle()
    for (let i = 0; i < 5; i += 1) expect(await devnullCommand($, 'on')).toBe(ON_TEXT)
    await world.clock.settle()
    expect(world.requests).toHaveLength(2)
    await world.clock.advance(MINUTE)
    expect(world.requests).toHaveLength(4)
  })

  test('off and on in a row wait for the poll that was due', async ($, on) => {
    const world = alertsWorld(on)
    await startSession($)
    await world.clock.settle()
    await world.clock.advance(10 * SECOND)
    await devnullCommand($, 'off')
    await devnullCommand($, 'on')
    await world.clock.advance(50 * SECOND - 1)
    expect(world.requests).toHaveLength(2)
    await world.clock.advance(1)
    expect(world.requests).toHaveLength(4)
  })

  test('off is kept: the next session sends nothing', async ($, on) => {
    const world = alertsWorld(on, { store: { account: ACCOUNT, alertsOn: false } })
    await startSession($)
    await world.clock.advance(10 * MINUTE)
    expect(world.requests).toEqual([])
  })

  test('off that cannot be saved still stops, and says so', async ($, on) => {
    const world = alertsWorld(on, { brokenKeys: ['alertsOn'] })
    await startSession($)
    await world.clock.settle()

    const text = await devnullCommand($, 'off')
    expect(text).toBe(OFF_NOT_SAVED_TEXT)
    expect(text).not.toContain('/home/someone')
    await world.clock.advance(10 * MINUTE)
    expect(world.requests).toHaveLength(2)
  })

  test('take nothing after them', async ($, on) => {
    const world = alertsWorld(on)
    await startSession($)
    await world.clock.settle()
    expect(await devnullCommand($, 'off now')).toBe(EXTRA_WORDS_TEXT)
    expect(world.writes.filter(write => write.key === 'alertsOn')).toEqual([])
  })

  for (const origin of [
    { kind: 'plugin', name: 'other' },
    { kind: 'sdk' },
    { kind: 'bridge' },
    { kind: 'unclassified' },
    { kind: 'scheduled-trigger' },
  ] as const) {
    test(`are refused from ${origin.kind}`, async ($, on) => {
      const world = alertsWorld(on)
      await startSession($)
      await world.clock.settle()

      expect(await devnullCommand($, 'off', origin)).toBe(notTypedText('off'))
      expect(await devnullCommand($, 'on', origin)).toBe(notTypedText('on'))
      expect(world.writes.filter(write => write.key === 'alertsOn')).toEqual([])
      await world.clock.advance(MINUTE)
      expect(world.requests).toHaveLength(4)
    })
  }

  test('are listed in the usage', async ($, on) => {
    alertsWorld(on)
    const text = await devnullCommand($, 'nope')
    expect(text).toContain('/devnull on ')
    expect(text).toContain('/devnull off ')
  })
})
