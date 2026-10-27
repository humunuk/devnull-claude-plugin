import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  EXTRA_WORDS_TEXT,
  OFF_NOT_SAVED_TEXT,
  OFF_TEXT,
  ON_TEXT,
  PANE_NOT_CLOSED_TEXT,
  SEEN_NOT_SAVED_TEXT,
} from '../hooks/alerts'
import { FAILED_TEXT, notTypedText } from '../hooks/lib/command'
import { FOLLOWING_IDLE_TEXT, FOLLOWING_LOADING_TEXT } from '../hooks/lib/following'
import { IDLE_TEXT, LOADING_TEXT, heldText } from '../hooks/lib/pane'
import { NEW_REPLIES_TITLE, NOT_PLACED_TEXT } from '../hooks/pane'
import { USERNAME, apiCommit, apiList, commitId, shortHashOf } from './fixtures/commits'
import {
  ACCOUNT,
  COMMITS_URL,
  REPLIES_URL,
  alertsWorld,
  devnullCommand,
  listText,
  ok,
  startSession,
} from './helpers-alerts'
import type { AlertsWorld } from './helpers-alerts'
import { linkOn, listRowsOf, mountPane, toggle } from './helpers-pane'

const SECOND = 1000
const MINUTE = 60 * SECOND

const SURFACES = ['terminal', 'desktop'] as const

/** Nothing above the prompt is the mod's: the engine draws the band alone. */
function engineBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
}

/** The band's texts on `surface`, joined by `|`: the engine's alone, whatever the alerts hold. */
async function bandText($: Engine, surface: (typeof SURFACES)[number]): Promise<string> {
  const ui = await $.ui.mount({
    plugin: 'devnull',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    surface,
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
  })
  const texts = (await ui.findAll({ type: 'Text' })).map(found => found.text)
  await ui.unmount()

  return texts.join('|')
}

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
  test('is shown once: one toast and the status line, and nothing above the prompt', async ($, on) => {
    engineBand(on)
    const world = alertsWorld(on, { server: { commits: ok([1, 2], { 1: 1 }), replies: ok([3]) } })
    await startSession($)
    await world.clock.settle()

    world.server.commits = ok([1, 2], { 1: 3 })
    await world.clock.advance(MINUTE)

    expect(world.requests).toHaveLength(4)
    expect(world.toasts).toEqual([`\u21b3 2 new replies on ${hashOf(1)}`])
    expect(world.statuses.at(-1)).toBe('devnull \u21b32')

    for (const surface of SURFACES) expect(await bandText($, surface)).toBe('engine')

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

  test('on many commits toasts each once and counts them all in the status line', async ($, on) => {
    const ns = [1, 2, 3, 4, 5, 6, 7]
    const world = alertsWorld(on, {
      store: { account: ACCOUNT, seenReplies: seen(Object.fromEntries(ns.map(n => [n, 0]))) },
      server: { commits: ok(ns, Object.fromEntries(ns.map(n => [n, 1]))), replies: ok([]) },
    })
    await startSession($)
    await world.clock.settle()

    expect(world.toasts).toEqual(ns.map(n => `\u21b3 1 new reply on ${hashOf(n)}`))
    expect(world.statuses.at(-1)).toBe('devnull \u21b37')
  })
})

/** The pane's commit rows on `surface` that carry a mark, each as `<hash> +N new`. */
async function markedRows($: Engine, surface: (typeof SURFACES)[number]): Promise<string[]> {
  const ui = await mountPane($, surface)
  const rows = listRowsOf(await ui.drawn())
  await ui.unmount()

  return rows.flatMap(row => {
    const marked = /^([0-9a-f]{7,12}) .* (\+\d+ new)$/.exec(row)

    return marked === null ? [] : [`${marked[1]} ${marked[2]}`]
  })
}

/** An answer to `?replies=1` holding the person's own reply 5, to commit 99, with `count` answers. */
function replyList(count: number): { status: number; text: string } {
  const reply = apiCommit(5, { parent_id: commitId(99), body: 'my reply\nits second line', replies_count: count })

  return { status: 200, text: JSON.stringify(apiList([reply])) }
}

/** The rows of the pane's `New replies` section on `surface`, or undefined when it is not drawn. */
async function newReplyRows($: Engine, surface: (typeof SURFACES)[number]): Promise<string[] | undefined> {
  const ui = await mountPane($, surface)
  const rows = listRowsOf(await ui.drawn())
  await ui.unmount()
  const at = rows.indexOf(NEW_REPLIES_TITLE)
  if (at === -1) return undefined
  const after = rows.slice(at + 1)
  const end = after.findIndex(row => !/\+\d+ new(open \u2197)?$/.test(row))

  return end === -1 ? after : after.slice(0, end)
}

/** Opens the pane (it must be closed) as the person's bare `/devnull` does, and lets what it started finish. */
async function openPane($: Engine, world: AlertsWorld): Promise<void> {
  expect(await toggle($)).toEqual({})
  expect(world.open.has('devnull')).toBe(true)
  await world.clock.settle()
}

describe('opening the pane', () => {
  for (const surface of SURFACES) {
    test(`counts as seeing the new replies, and the pane marks them until it closes, on ${surface}`, async ($, on) => {
      engineBand(on)
      const world = alertsWorld(on, {
        store: { account: ACCOUNT, seenReplies: seen({ 1: 1, 2: 0 }) },
        server: { commits: ok([1, 2], { 1: 3, 2: 1 }), replies: ok([]) },
      })
      await startSession($)
      await world.clock.settle()
      expect(world.statuses.at(-1)).toBe('devnull \u21b33')

      await openPane($, world)
      // The status line clears, and the seen counts go up to the counts now.
      expect(world.statuses.at(-1)).toBeUndefined()
      expect(world.store.get('seenReplies')).toEqual(seen({ 1: 3, 2: 1 }))
      expect(await markedRows($, surface)).toEqual([`${hashOf(1)} +2 new`, `${hashOf(2)} +1 new`])
      const ui = await mountPane($, surface)
      expect((await ui.findAll({ type: 'Link' })).map(link => link.props.href)).toEqual([linkOn(surface, commitId(1)), linkOn(surface, commitId(2))])
      await ui.unmount()

      // A poll while it stays open finds nothing new: the marks stay, and nothing alerts.
      await world.clock.advance(MINUTE)
      expect(world.requests.filter(url => url === REPLIES_URL)).toHaveLength(2)
      expect(world.statuses.at(-1)).toBeUndefined()
      expect(world.toasts).toHaveLength(2)
      expect(await markedRows($, surface)).toEqual([`${hashOf(1)} +2 new`, `${hashOf(2)} +1 new`])
      expect(await bandText($, surface)).toBe('engine')

      // Closed and opened again: those replies were seen, so nothing is marked.
      expect(await toggle($)).toEqual({})
      expect(world.open.has('devnull')).toBe(false)
      await openPane($, world)
      expect(await markedRows($, surface)).toEqual([])
      expect(world.statuses.at(-1)).toBeUndefined()
    })

    test(`does not stop a rise while it is open from toasting and counting, and adds it to the mark, on ${surface}`, async ($, on) => {
      const world = alertsWorld(on, {
        store: { account: ACCOUNT, seenReplies: seen({ 1: 1 }) },
        server: { commits: ok([1], { 1: 3 }), replies: ok([]) },
      })
      await startSession($)
      await world.clock.settle()
      await openPane($, world)
      expect(world.statuses.at(-1)).toBeUndefined()

      world.server.commits = ok([1], { 1: 4 })
      await world.clock.advance(MINUTE)
      expect(world.toasts).toEqual([`\u21b3 2 new replies on ${hashOf(1)}`, `\u21b3 1 new reply on ${hashOf(1)}`])
      expect(world.statuses.at(-1)).toBe('devnull \u21b31')
      // Two seen when it opened, one since.
      expect(await markedRows($, surface)).toEqual([`${hashOf(1)} +3 new`])

      // The next open counts the new one as seen.
      expect(await toggle($)).toEqual({})
      await openPane($, world)
      expect(world.statuses.at(-1)).toBeUndefined()
      expect(world.store.get('seenReplies')).toEqual(seen({ 1: 4 }))
      expect(await markedRows($, surface)).toEqual([`${hashOf(1)} +1 new`])
    })
  }

  for (const surface of SURFACES) {
    test(`with nothing new writes nothing and draws no mark and no New replies, on ${surface}`, async ($, on) => {
      const world = alertsWorld(on, { server: { commits: ok([1], { 1: 2 }), replies: ok([]) } })
      await startSession($)
      await world.clock.settle()
      const writes = world.writes.length

      await openPane($, world)
      expect(world.writes).toHaveLength(writes)
      expect(world.toasts).toEqual([])
      expect(await markedRows($, surface)).toEqual([])
      expect(await newReplyRows($, surface)).toBeUndefined()
    })

    test(`that cannot save the seen counts says so in a toast, and keeps the alerts on show, marked once, on ${surface}`, async ($, on) => {
      const world = alertsWorld(on, {
        // A reply not seen yet, already toasted: the poll has nothing to write.
        store: { account: ACCOUNT, seenReplies: seen({ 1: [0, 1] }) },
        server: { commits: ok([1], { 1: 1 }), replies: ok([]) },
        brokenKeys: ['seenReplies'],
      })
      await startSession($)
      await world.clock.settle()
      expect(world.statuses.at(-1)).toBe('devnull \u21b31')

      await openPane($, world)
      expect(world.toasts).toEqual([SEEN_NOT_SAVED_TEXT])
      expect(world.toasts.join('\n')).not.toContain('/home/someone')
      expect(world.statuses.at(-1)).toBe('devnull \u21b31')
      expect(await markedRows($, surface)).toEqual([`${hashOf(1)} +1 new`])
    })

    test(`draws answers to the person's own reply in New replies until it closes, and not on Following, on ${surface}`, async ($, on) => {
      const world = alertsWorld(on, {
        store: { account: ACCOUNT, seenReplies: seen({ 1: 0, 5: 0 }) },
        server: { commits: ok([1], { 1: 0 }), replies: ok([]) },
      })
      world.server.replies = replyList(2)
      await startSession($)
      await world.clock.settle()
      // The answers to the reply are toasted and counted.
      expect(world.toasts).toEqual([`\u21b3 2 new replies on ${hashOf(5)}`])
      expect(world.statuses.at(-1)).toBe('devnull \u21b32')

      await openPane($, world)
      expect(world.statuses.at(-1)).toBeUndefined()
      expect(world.store.get('seenReplies')).toEqual(seen({ 1: 0, 5: 2 }))
      expect(await newReplyRows($, surface)).toEqual([`${hashOf(5)}my reply\u2026+2 newopen \u2197`])
      const ui = await mountPane($, surface)
      expect((await ui.find({ type: 'Text', text: NEW_REPLIES_TITLE }))?.props).toMatchObject({ weight: 'bold' })
      expect((await ui.find({ type: 'Text', text: '+2 new' }))?.props).toMatchObject({ color: 'success', weight: 'bold' })
      expect((await ui.findAll({ type: 'Link' })).map(link => link.props.href)).toContain(linkOn(surface, commitId(5)))
      // Not on Following.
      await ui.press({ key: 'tab-following' })
      await world.clock.settle()
      expect(await ui.find({ type: 'Text', text: NEW_REPLIES_TITLE })).toBeUndefined()
      await ui.press({ key: 'tab-mine' })
      await ui.unmount()

      // A poll while it stays open: the row stays.
      await world.clock.advance(MINUTE)
      expect(world.statuses.at(-1)).toBeUndefined()
      expect(await newReplyRows($, surface)).toEqual([`${hashOf(5)}my reply\u2026+2 newopen \u2197`])

      // Closed and opened again: seen, so the section is gone.
      expect(await toggle($)).toEqual({})
      await openPane($, world)
      expect(await newReplyRows($, surface)).toBeUndefined()
    })

    test(`adds an answer to the reply that came while open to the one held since the open, on ${surface}`, async ($, on) => {
      const world = alertsWorld(on, {
        store: { account: ACCOUNT, seenReplies: seen({ 1: 0, 5: 0 }) },
        server: { commits: ok([1], { 1: 0 }), replies: replyList(2) },
      })
      await startSession($)
      await world.clock.settle()
      await openPane($, world)

      world.server.replies = replyList(3)
      await world.clock.advance(MINUTE)
      expect(world.toasts.at(-1)).toBe(`\u21b3 1 new reply on ${hashOf(5)}`)
      expect(world.statuses.at(-1)).toBe('devnull \u21b31')
      expect(await newReplyRows($, surface)).toEqual([`${hashOf(5)}my reply\u2026+3 newopen \u2197`])
    })
  }

  for (const [how, opens, answer] of [
    ['waits undrawn', 'unplaced', { text: NOT_PLACED_TEXT }],
    ['is refused', 'refused', { text: FAILED_TEXT }],
  ] as const) {
    test(`that ${how} counts nothing as seen`, async ($, on) => {
      const world = alertsWorld(on, {
        store: { account: ACCOUNT, seenReplies: seen({ 1: 1 }) },
        server: { commits: ok([1], { 1: 3 }), replies: ok([]) },
        opens,
      })
      await startSession($)
      await world.clock.settle()
      const writes = world.writes.length
      expect(world.statuses.at(-1)).toBe('devnull \u21b32')

      expect(await toggle($)).toEqual(answer)
      await world.clock.settle()
      expect(world.writes).toHaveLength(writes)
      expect(world.store.get('seenReplies')).toEqual(seen({ 1: [1, 3] }))
      expect(world.statuses.at(-1)).toBe('devnull \u21b32')
    })
  }
})

describe('a restart', () => {
  test('before the pane was opened counts the replies again from the kept counts, without a second toast', async ($, on) => {
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
    for (const surface of SURFACES) expect(await bandText($, surface)).toBe('engine')
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

  test('after the pane was opened shows nothing', async ($, on) => {
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

describe('one 429 hold for the pane and the poller', () => {
  test("a 429 on the pane's load holds the next poll until Retry-After has passed", async ($, on) => {
    const world = alertsWorld(on)
    await startSession($)
    await world.clock.settle()
    expect(world.requests).toEqual([COMMITS_URL, REPLIES_URL])

    world.server.commits = { status: 429, text: 'slow down', headers: { 'retry-after': '600' } }
    await openPane($, world)
    // The pane's load asks for the same list as the poller.
    expect(world.requests).toEqual([COMMITS_URL, REPLIES_URL, COMMITS_URL])

    world.server.commits = ok([])
    await world.clock.advance(10 * MINUTE - 1)
    expect(world.requests).toHaveLength(3)
    await world.clock.advance(1)
    expect(world.requests).toEqual([COMMITS_URL, REPLIES_URL, COMMITS_URL, COMMITS_URL, REPLIES_URL])

    // A poll skipped for the hold is no failure: the interval stands after it.
    await world.clock.advance(MINUTE)
    expect(world.requests).toHaveLength(7)
    expect(world.logs.join('\n')).not.toContain('HTTP 429')
  })

  test("the pane's 429 between the poll's two lists keeps the second from going, and the next poll waits for the hold", async ($, on) => {
    const world = alertsWorld(on, { server: { commits: { status: 200, text: listText([]), delayMs: SECOND }, replies: ok([]) } })
    await startSession($)
    await world.clock.settle()
    expect(world.pending()).toBe(1)

    // The pane's load of the same list meets a 429 while the poll's is out.
    world.server.commits = { status: 429, text: 'slow down', headers: { 'retry-after': '600' } }
    await openPane($, world)
    expect(world.requests).toEqual([COMMITS_URL, COMMITS_URL])
    world.server.commits = ok([])
    await world.clock.advance(SECOND)
    expect(world.pending()).toBe(0)
    expect(world.requests).toEqual([COMMITS_URL, COMMITS_URL])

    await world.clock.advance(10 * MINUTE - SECOND - 1)
    expect(world.requests).toHaveLength(2)
    await world.clock.advance(1)
    expect(world.requests).toEqual([COMMITS_URL, COMMITS_URL, COMMITS_URL, REPLIES_URL])
  })

  test("a 429 on a poll whose Retry-After is a date sets no hold: the pane's load goes out", async ($, on) => {
    const world = alertsWorld(on, {
      server: { commits: ok([]), replies: { status: 429, text: 'slow down', headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } } },
    })
    await startSession($)
    await world.clock.settle()

    await openPane($, world)
    expect(world.requests).toEqual([COMMITS_URL, REPLIES_URL, COMMITS_URL])
  })

  for (const surface of SURFACES) {
    test(`a 429 on a poll holds the pane's load until Retry-After has passed, on ${surface}`, async ($, on) => {
      const world = alertsWorld(on, {
        server: { commits: ok([]), replies: { status: 429, text: 'slow down', headers: { 'retry-after': '600' } } },
      })
      await startSession($)
      await world.clock.settle()
      expect(world.requests).toEqual([COMMITS_URL, REPLIES_URL])

      await openPane($, world)
      const ui = await mountPane($, surface)
      // Nothing is loading and r would send nothing: the pane says how long to wait.
      const held = listRowsOf(await ui.drawn())
      expect(held).toContain(heldText(600))
      expect(held).not.toContain(LOADING_TEXT)
      expect(held).not.toContain(IDLE_TEXT)
      await world.clock.advance(10 * MINUTE - 1)
      await ui.press({ key: 'refresh' })
      await world.clock.settle()
      expect(world.requests).toHaveLength(2)

      // When the hold ends the poller goes on, and a refresh loads the pane.
      world.server = { commits: ok([1]), replies: ok([]) }
      await world.clock.advance(1)
      expect(world.requests).toEqual([COMMITS_URL, REPLIES_URL, COMMITS_URL, REPLIES_URL])
      await ui.press({ key: 'refresh' })
      await world.clock.settle()
      expect(world.requests).toEqual([COMMITS_URL, REPLIES_URL, COMMITS_URL, REPLIES_URL, COMMITS_URL])
      const loaded = listRowsOf(await ui.drawn())
      expect(loaded).toContain('invented commit number 1')
      expect(loaded.some(row => row.startsWith('dev-null.sh asked to wait'))).toBe(false)
      await ui.unmount()
    })

    test(`a 429 on a poll, then the Following tab with no round yet, draws the wait, on ${surface}`, async ($, on) => {
      const world = alertsWorld(on, {
        server: { commits: ok([]), replies: { status: 429, text: 'slow down', headers: { 'retry-after': '600' } } },
      })
      await startSession($)
      await world.clock.settle()

      await openPane($, world)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'tab-following' })
      await world.clock.settle()
      // The tab press asked for a round, which the hold kept from starting.
      expect(world.requests).toHaveLength(2)
      const held = listRowsOf(await ui.drawn())
      expect(held).toContain(heldText(600))
      expect(held).not.toContain(FOLLOWING_LOADING_TEXT)
      expect(held).not.toContain(FOLLOWING_IDLE_TEXT)
      await ui.unmount()
    })
  }
})

describe('a list that is not exactly what the mod expects', () => {
  const hostileBodies: [string, string][] = [
    ['not JSON', '<html>maintenance</html>'],
    ['no data', JSON.stringify({ items: [] })],
    ['one item with a bad id', JSON.stringify(apiList([apiCommit(1), apiCommit(2, { id: 'javascript:alert(1)' })]))],
    ['one count that is text', JSON.stringify(apiList([apiCommit(1, { replies_count: '9' })]))],
    ['a bidi author', JSON.stringify(apiList([apiCommit(1, { author: { handle: 'evil\u202e' } })]))],
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
    engineBand(on)
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
  test('off stops polling and clears the status line; on starts again', async ($, on) => {
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

  test('off that cannot close the pane still stops, and says so', async ($, on) => {
    const world = alertsWorld(on, { arePanesBroken: true })
    await startSession($)
    await world.clock.settle()

    const text = await devnullCommand($, 'off')
    expect(text).toBe(`${OFF_TEXT}\n${PANE_NOT_CLOSED_TEXT}`)
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
