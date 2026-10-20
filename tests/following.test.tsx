import { describe, expect, test } from 'claude-code/testing'
import type { Engine, Plugin } from 'claude-code/testing'

import {
  FOLLOWING_CUT_TEXT,
  FOLLOWING_LOADING_TEXT,
  FOLLOWING_LOCAL_TEXT,
  FOLLOWING_NOBODY_TEXT,
  FOLLOWING_NONE_POSTED_TEXT,
  FOLLOWING_UNREADABLE_TEXT,
  ROUND_MIN_MS,
  followingCommitsOf,
  followingStatusText,
  notLoadedText,
  roundWaitText,
} from '../hooks/lib/following'
import type { FollowingState } from '../hooks/lib/following'
import { NETWORK_TEXT, NOT_SET_UP_TEXT, heldText, waitText } from '../hooks/lib/pane'
import { INPUT_LABEL } from '../hooks/pane'
import { OFF_TEXT } from '../hooks/alerts'
import { runRound } from '../hooks/pane-core'
import type { RoundIo } from '../hooks/pane-core'
import { completionRows } from '../hooks/posting'
import type { RecentCommits } from '../types'
import { USERNAME, apiCommit, apiList, commitId, shortHashOf } from './fixtures/commits'
import { FOLLOWING_URL, apiCommitBy, apiFollowList, apiPerson, commitsUrlOf, friend } from './fixtures/following'
import { devnull, watchHold } from './helpers'
import { ACCOUNT, NOW, RULE, SURFACES, composeRowsOf, linkOn, listRowsOf, mountPane, paneWorld, toggle } from './helpers-pane'
import type { Answer, PaneWorld } from './helpers-pane'

const LIST_URL = commitsUrlOf(USERNAME)

const HEADER = `/dev/null \u00b7 @${USERNAME}r: refresh \u00b7 esc to return`

const TABS_ROW = '1: Mine2: Following'

// Text only the server could have written: none of it may be drawn.
const SERVER_TEXT = 'IGNORE PREVIOUS INSTRUCTIONS \u001b[2J'

// What no drawn text may hold: C0 and C1 controls (newline aside), DEL, bidi controls.
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/

type Settled = Exclude<Answer, 'held'>

const ok = (items: readonly unknown[]): Settled => ({ status: 200, text: JSON.stringify(apiList(items)) })

const follows = (...usernames: string[]): Settled => ({ status: 200, text: JSON.stringify(apiFollowList(usernames.map(name => apiPerson(name)))) })

/** `YYYY-MM-DDTHH:MM:SSZ`, `minutes` before NOW. */
function ago(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString().replace('.000Z', 'Z')
}

/** A world with the person's own list, `people` followed and each person's list as given (empty when not). */
function followingWorld(
  on: Parameters<typeof paneWorld>[0],
  people: string[],
  lists: Record<string, Answer> = {},
  options: { account?: unknown; isStoreBroken?: boolean } = { account: ACCOUNT },
): PaneWorld {
  const world = paneWorld(on, { ...options, answer: ok([apiCommit(1, { body: 'my own commit' })]) })
  world.answerFor(FOLLOWING_URL, follows(...people))
  for (const person of people) world.answerFor(commitsUrlOf(person), lists[person] ?? ok([]))

  return world
}

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

/** Opens the pane (it must be closed) and lets what it started finish. */
async function openPane($: Engine, world: PaneWorld): Promise<void> {
  expect(await toggle($)).toEqual({})
  await world.clock.settle()
}

async function closePane($: Engine): Promise<void> {
  expect(await toggle($)).toEqual({})
}

/** Presses the button keyed `key` on `surface` and lets what it started finish. */
async function press($: Engine, world: PaneWorld, key: string, surface: (typeof SURFACES)[number] = 'terminal'): Promise<void> {
  const ui = await mountPane($, surface)
  await ui.press({ key })
  await world.clock.settle()
  await ui.unmount()
}

async function rows($: Engine, surface: (typeof SURFACES)[number]): Promise<string[]> {
  const ui = await mountPane($, surface)
  const drawn = listRowsOf(await ui.drawn())
  await ui.unmount()

  return drawn
}

const urls = (world: PaneWorld) => world.requests.map(request => request.url)

/**
 * Another plugin that closes the pane: its `$.ui.close` raises `ui.close` as
 * the person's close mark or ctrl+x x does (origin `plugin` here, `person`
 * there), which the kit cannot raise itself.
 */
const CLOSER: Plugin = {
  name: 'closer',
  register: on => {
    on('command.run', { command: 'close-devnull' }, async $ => {
      await $.ui.close({ id: 'devnull' })

      return {}
    })
  },
}

describe('the tab row', () => {
  for (const surface of SURFACES) {
    test(`draws 1 Mine and 2 Following under the header, Mine marked, and nothing for phase 2, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [friend(1)])
      await start($)
      await openPane($, world)

      const ui = await mountPane($, surface)
      expect((await ui.find({ type: 'Button', key: 'tab-mine' }))?.props).toMatchObject({ label: 'Mine', hotkey: '1', plain: true, variant: 'primary' })
      expect((await ui.find({ type: 'Button', key: 'tab-following' }))?.props).toMatchObject({ label: 'Following', hotkey: '2', plain: true, dimColor: true })
      expect((await ui.find({ type: 'Button', key: 'tab-mine' }))?.props.dimColor).toBeUndefined()
      expect((await ui.findAll({ type: 'Button' })).map(button => button.props.key)).toEqual(['refresh', 'tab-mine', 'tab-following'])
      expect(listRowsOf(await ui.drawn()).slice(0, 3)).toEqual([`${HEADER} \u00b7 updated now`, TABS_ROW, `${shortHashOf(commitId(1))} 5h \u00b7 \u2605 3 \u00b7 \u21b3 1`])
      await ui.unmount()
      // Opening on Mine loads Mine alone.
      expect(urls(world)).toEqual([LIST_URL])
    })

    test(`switches with its buttons and marks the tab shown, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [friend(1)], { [friend(1)]: ok([apiCommitBy(friend(1), 11, { body: 'their commit' })]) })
      await start($)
      await openPane($, world)

      await press($, world, 'tab-following', surface)
      const ui = await mountPane($, surface)
      expect((await ui.find({ type: 'Button', key: 'tab-following' }))?.props).toMatchObject({ variant: 'primary' })
      expect((await ui.find({ type: 'Button', key: 'tab-mine' }))?.props).toMatchObject({ dimColor: true })
      const drawn = listRowsOf(await ui.drawn())
      expect(drawn).toContain('their commit')
      expect(drawn).not.toContain('my own commit')
      await ui.press({ key: 'tab-mine' })
      await world.clock.settle()
      expect((await ui.find({ type: 'Button', key: 'tab-mine' }))?.props).toMatchObject({ variant: 'primary' })
      expect(listRowsOf(await ui.drawn())).toContain('my own commit')
      expect(listRowsOf(await ui.drawn())).not.toContain('their commit')
      await ui.unmount()
      // Switching to Mine fetched nothing.
      expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL, commitsUrlOf(friend(1))])
    })
  }

  test('keeps the input under Mine: Following draws none on the terminal', async ($, on) => {
    const world = followingWorld(on, [friend(1)])
    await start($)
    await openPane($, world)

    await press($, world, 'tab-following')
    const ui = await mountPane($, 'terminal')
    expect(await ui.findAll({ type: 'Input' })).toHaveLength(0)
    expect(composeRowsOf(await ui.drawn())).toEqual([])
    await ui.press({ key: 'tab-mine' })
    expect(composeRowsOf(await ui.drawn())).toEqual([RULE, `${INPUT_LABEL} []`])
    await ui.unmount()
  })

  test('a reopen shows the last tab, and loads Mine first, then the round once the minute is over', async ($, on) => {
    const world = followingWorld(on, [friend(1)], { [friend(1)]: ok([apiCommitBy(friend(1), 11, { body: 'their commit' })]) })
    await start($)
    await openPane($, world)
    await press($, world, 'tab-following')
    await closePane($)

    // Within the minute: the last round is drawn, and only Mine is fetched.
    await openPane($, world)
    expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL, commitsUrlOf(friend(1)), LIST_URL])
    expect(await rows($, 'terminal')).toContain('their commit')
    await closePane($)

    await world.clock.advance(ROUND_MIN_MS)
    await openPane($, world)
    expect(urls(world).slice(4)).toEqual([LIST_URL, FOLLOWING_URL, commitsUrlOf(friend(1))])
    expect(world.overlaps()).toBe(0)
  })
})

describe('a Following round', () => {
  for (const surface of SURFACES) {
    test(`asks for the follow list, then each list in its order, and draws only each author's own commits, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [friend(1), friend(2)], {
        [friend(1)]: ok([
          apiCommitBy(friend(1), 11, { body: 'one from friend one', created_at: ago(3), stars_count: 2, replies_count: 4 }),
          apiCommitBy(friend(2), 12, { body: 'claims to be friend two' }),
          apiCommitBy(friend(1), 13, { body: 'a reply', parent_id: commitId(99) }),
        ]),
        [friend(2)]: ok([apiCommitBy(friend(2), 21, { body: 'one from friend two', created_at: ago(1) })]),
      })
      await start($)
      await openPane($, world)
      await press($, world, 'tab-following', surface)

      expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL, commitsUrlOf(friend(1)), commitsUrlOf(friend(2))])
      expect(world.requests.every(request => request.init?.method === 'GET')).toBe(true)
      const ui = await mountPane($, surface)
      expect(listRowsOf(await ui.drawn())).toEqual([
        `${HEADER} \u00b7 updated now`,
        TABS_ROW,
        `@${friend(2)} ${shortHashOf(commitId(21))} 1m \u00b7 \u2605 3 \u00b7 \u21b3 1`,
        'one from friend two',
        'open \u2197',
        `@${friend(1)} ${shortHashOf(commitId(11))} 3m \u00b7 \u2605 2 \u00b7 \u21b3 4`,
        'one from friend one',
        'open \u2197',
      ])
      expect((await ui.find({ type: 'Text', text: new RegExp(`^@${friend(2)}$`) }))?.props).toEqual({ color: 'suggestion' })
      expect((await ui.find({ type: 'Text', text: new RegExp(`^ ${shortHashOf(commitId(21))}$`) }))?.props).toEqual({ color: 'warning' })
      expect((await ui.findAll({ type: 'Link' })).map(link => link.props)).toEqual([
        { href: linkOn(surface, commitId(21), friend(2)), label: 'open \u2197' },
        { href: linkOn(surface, commitId(11), friend(1)), label: 'open \u2197' },
      ])
      // No +N new: the alerts are about the person's own commits.
      expect(await ui.findAll({ type: 'Text', text: /new$/ })).toHaveLength(0)
      await ui.unmount()
    })

    test(`asks for at most 20 lists and draws the 30 newest commits, on ${surface}`, async ($, on) => {
      const people = Array.from({ length: 25 }, (_, i) => friend(i + 1))
      const lists: Record<string, Answer> = {}
      people.forEach((person, i) => {
        // Person i's commits are i, i + 25 and i + 50 minutes old.
        lists[person] = ok([0, 1, 2].map(k => apiCommitBy(person, 100 * (i + 1) + k, { created_at: ago(i + 25 * k) })))
      })
      const world = followingWorld(on, people, lists)
      await start($)
      await openPane($, world)
      await press($, world, 'tab-following', surface)

      expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL, ...people.slice(0, 20).map(commitsUrlOf)])
      const ui = await mountPane($, surface)
      const lines = listRowsOf(await ui.drawn()).filter(row => row.startsWith('@'))
      expect(lines).toHaveLength(30)
      // Newest first: of the first 20 people, every k = 0 commit (0 to 19 min), then k = 1 from 25 min on.
      const expected = [
        ...Array.from({ length: 20 }, (_, i) => ({ person: friend(i + 1), n: 100 * (i + 1) })),
        ...Array.from({ length: 10 }, (_, i) => ({ person: friend(i + 1), n: 100 * (i + 1) + 1 })),
      ]
      expect(lines.map(line => line.split(' ').slice(0, 2).join(' '))).toEqual(expected.map(({ person, n }) => `@${person} ${shortHashOf(commitId(n))}`))
      await ui.unmount()
    })

    test(`leaves out and counts a list that fails, and goes on after a 404 or an unreadable list, on ${surface}`, async ($, on) => {
      const people = [1, 2, 3, 4].map(friend)
      const world = followingWorld(on, people, {
        [friend(1)]: { status: 404, text: SERVER_TEXT },
        [friend(2)]: { status: 200, text: SERVER_TEXT },
        [friend(3)]: ok([apiCommitBy(friend(3), 31, { body: 'still here' })]),
        [friend(4)]: { status: 410, text: SERVER_TEXT },
      })
      await start($)
      await openPane($, world)
      await press($, world, 'tab-following', surface)

      expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL, ...people.map(commitsUrlOf)])
      const drawn = await rows($, surface)
      expect(drawn.slice(0, 4)).toEqual([`${HEADER} \u00b7 updated now`, TABS_ROW, notLoadedText(3, 4), `@${friend(3)} ${shortHashOf(commitId(31))} 5h \u00b7 \u2605 3 \u00b7 \u21b3 1`])
      expect(notLoadedText(3, 4)).toBe('3 of 4 people could not be loaded')
      expect(drawn.join('\n')).not.toContain('IGNORE')
    })

    test(`stops at a 5xx or no answer, counting the people not reached, and backs off, on ${surface}`, async ($, on) => {
      const people = [1, 2, 3, 4].map(friend)
      const world = followingWorld(on, people, {
        [friend(1)]: ok([apiCommitBy(friend(1), 11, { body: 'arrived before' })]),
        [friend(2)]: { status: 503, text: SERVER_TEXT },
      })
      await start($)
      await openPane($, world)
      await press($, world, 'tab-following', surface)

      expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL, commitsUrlOf(friend(1)), commitsUrlOf(friend(2))])
      const drawn = await rows($, surface)
      expect(drawn.slice(0, 3)).toEqual([`${HEADER} \u00b7 updated now`, TABS_ROW, notLoadedText(3, 4)])
      expect(drawn).toContain('arrived before')

      // The next round waits two minutes, not one.
      await world.clock.advance(ROUND_MIN_MS)
      await press($, world, 'refresh', surface)
      expect(world.requests).toHaveLength(4)
      expect((await rows($, surface))[0]).toBe(`${HEADER} \u00b7 updated 1m \u00b7 ${roundWaitText(60)}`)
      // It fails again, with no answer at all: then four minutes.
      world.answerFor(commitsUrlOf(friend(1)), 'unreachable')
      await world.clock.advance(ROUND_MIN_MS)
      await press($, world, 'refresh', surface)
      expect(urls(world).slice(4)).toEqual([FOLLOWING_URL, commitsUrlOf(friend(1))])
      expect((await rows($, surface)).slice(2, 3)).toEqual([notLoadedText(4, 4)])
      await world.clock.advance(3 * ROUND_MIN_MS + 59_000)
      await press($, world, 'refresh', surface)
      expect(world.requests).toHaveLength(6)
      // A round that goes through resets it: the next waits a minute again.
      world.answerFor(commitsUrlOf(friend(1)), ok([]))
      world.answerFor(commitsUrlOf(friend(2)), ok([]))
      await world.clock.advance(1000)
      await press($, world, 'refresh', surface)
      expect(urls(world).slice(6)).toEqual([FOLLOWING_URL, ...people.map(commitsUrlOf)])
      await world.clock.advance(ROUND_MIN_MS)
      await press($, world, 'refresh', surface)
      expect(world.requests).toHaveLength(16)
    })

    test(`backs off after a follow list that answered 5xx, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [friend(1)])
      await start($)
      await openPane($, world)
      world.answerFor(FOLLOWING_URL, { status: 502, text: SERVER_TEXT })
      await press($, world, 'tab-following', surface)
      expect(await rows($, surface)).toEqual([HEADER, TABS_ROW, followingStatusText(502)])

      await world.clock.advance(ROUND_MIN_MS)
      await press($, world, 'refresh', surface)
      expect(world.requests).toHaveLength(2)
      await world.clock.advance(ROUND_MIN_MS)
      await press($, world, 'refresh', surface)
      expect(urls(world).slice(2)).toEqual([FOLLOWING_URL])
    })

    test(`leaves out and counts a followed account whose name fails the pattern, never asking for it, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [friend(1)], { [friend(1)]: ok([apiCommitBy(friend(1), 11, { body: 'their commit' })]) })
      world.answerFor(FOLLOWING_URL, {
        status: 200,
        text: JSON.stringify(apiFollowList([apiPerson('_renamed-123'), apiPerson(friend(1)), apiPerson('evil\u202e name')])),
      })
      await start($)
      await openPane($, world)
      await press($, world, 'tab-following', surface)

      expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL, commitsUrlOf(friend(1))])
      const drawn = await rows($, surface)
      expect(drawn.slice(0, 3)).toEqual([`${HEADER} \u00b7 updated now`, TABS_ROW, notLoadedText(2, 3)])
      expect(drawn).toContain('their commit')
      expect(drawn.join('\n')).not.toContain('renamed')
      expect(drawn.join('\n')).not.toMatch(UNSAFE)
    })

    test(`stops at a 429, draws what arrived with a note, and waits as long as it asked, on ${surface}`, async ($, on) => {
      const people = [1, 2, 3].map(friend)
      const world = followingWorld(on, people, {
        [friend(1)]: ok([apiCommitBy(friend(1), 11, { body: 'arrived before' })]),
        [friend(2)]: { status: 429, text: SERVER_TEXT, headers: { 'retry-after': '120' } },
        [friend(3)]: ok([apiCommitBy(friend(3), 31, { body: 'never asked for' })]),
      })
      await start($)
      await openPane($, world)
      await press($, world, 'tab-following', surface)

      expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL, commitsUrlOf(friend(1)), commitsUrlOf(friend(2))])
      const drawn = await rows($, surface)
      expect(drawn.slice(0, 4)).toEqual([`${HEADER} \u00b7 updated now`, TABS_ROW, FOLLOWING_CUT_TEXT, `@${friend(1)} ${shortHashOf(commitId(11))} 5h \u00b7 \u2605 3 \u00b7 \u21b3 1`])
      expect(drawn).toContain('arrived before')
      expect(drawn).not.toContain('never asked for')

      // A minute is not enough: the 429 asked for two.
      await world.clock.advance(ROUND_MIN_MS + 1000)
      await press($, world, 'refresh', surface)
      expect(world.requests).toHaveLength(4)
      expect((await rows($, surface))[0]).toBe(`${HEADER} \u00b7 updated 1m \u00b7 ${roundWaitText(59)}`)
      world.answerFor(commitsUrlOf(friend(2)), ok([]))
      await world.clock.advance(59_000)
      await press($, world, 'refresh', surface)
      expect(urls(world).slice(4)).toEqual([FOLLOWING_URL, ...people.map(commitsUrlOf)])
      expect(await rows($, surface)).toContain('never asked for')
    })

    test(`starts at most one round a minute: an r sooner says how long to wait, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [friend(1)], { [friend(1)]: ok([apiCommitBy(friend(1), 11, { body: 'their commit' })]) })
      await start($)
      await openPane($, world)
      await press($, world, 'tab-following', surface)
      expect(world.requests).toHaveLength(3)

      await world.clock.advance(30_000)
      await press($, world, 'refresh', surface)
      expect(world.requests).toHaveLength(3)
      const ui = await mountPane($, surface)
      expect((await ui.find({ type: 'Text', text: /wait/ }))?.props).toEqual({ color: 'warning' })
      await ui.unmount()
      expect((await rows($, surface))[0]).toBe(`${HEADER} \u00b7 updated now \u00b7 ${roundWaitText(30)}`)

      // Switching away and back within the minute draws the same round, fetching nothing.
      await press($, world, 'tab-mine', surface)
      await press($, world, 'tab-following', surface)
      expect(world.requests).toHaveLength(3)
      expect(await rows($, surface)).toContain('their commit')

      await world.clock.advance(30_000)
      // The minute's redraw has dropped the wait.
      expect((await rows($, surface))[0]).toBe(`${HEADER} \u00b7 updated 1m`)
      await press($, world, 'refresh', surface)
      expect(urls(world).slice(3)).toEqual([FOLLOWING_URL, commitsUrlOf(friend(1))])
    })
  }

  test('is never polled: an open pane on Following fetches nothing more as time goes on', async ($, on) => {
    const world = followingWorld(on, [friend(1)])
    await start($)
    await openPane($, world)
    await press($, world, 'tab-following')
    const sent = world.requests.length

    await world.clock.advance(10 * ROUND_MIN_MS)
    expect(world.requests).toHaveLength(sent)
  })

  test('sends one request at a time, each list after the one before answered', async ($, on) => {
    const people = [1, 2, 3].map(friend)
    const world = followingWorld(on, people)
    await start($)
    await openPane($, world)
    for (const url of [FOLLOWING_URL, ...people.map(commitsUrlOf)]) world.answerFor(url, 'held')

    const ui = await mountPane($, 'terminal')
    const pressed = ui.press({ key: 'tab-following' })
    await world.clock.settle()
    expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL])
    expect(listRowsOf(await ui.drawn())).toEqual([`${HEADER} \u00b7 loading\u2026`, TABS_ROW, FOLLOWING_LOADING_TEXT])
    // A second r and a switch meanwhile start nothing.
    void ui.press({ key: 'refresh' })
    void ui.press({ key: 'tab-following' })
    await world.clock.settle()
    expect(world.requests).toHaveLength(2)

    world.release(follows(...people))
    await world.clock.settle()
    expect(urls(world).slice(2)).toEqual([commitsUrlOf(friend(1))])
    world.release(ok([]))
    await world.clock.settle()
    expect(urls(world).slice(2)).toEqual([commitsUrlOf(friend(1)), commitsUrlOf(friend(2))])
    world.release(ok([]))
    await world.clock.settle()
    world.release(ok([]))
    await pressed
    await world.clock.settle()
    expect(urls(world).slice(2)).toEqual(people.map(commitsUrlOf))
    expect(world.overlaps()).toBe(0)
    expect(listRowsOf(await ui.drawn())).toEqual([`${HEADER} \u00b7 updated now`, TABS_ROW, FOLLOWING_NONE_POSTED_TEXT])
    await ui.unmount()
  })

  test('never overlaps the Mine load: an open on Following waits for it, and an r on Mine waits for the round', async ($, on) => {
    const people = [1, 2].map(friend)
    const world = followingWorld(on, people)
    await start($)
    await openPane($, world)
    await press($, world, 'tab-following')
    await closePane($)
    await world.clock.advance(ROUND_MIN_MS)

    // Reopened on Following with the Mine list held: the round waits for it.
    world.answer('held')
    expect(await toggle($)).toEqual({})
    await world.clock.settle()
    expect(urls(world).slice(4)).toEqual([LIST_URL])
    expect((await rows($, 'terminal'))[0]).toBe(`${HEADER} \u00b7 loading\u2026`)
    world.answer(ok([]))
    world.answerFor(commitsUrlOf(friend(1)), 'held')
    world.release(ok([]))
    await world.clock.settle()
    expect(urls(world).slice(4)).toEqual([LIST_URL, FOLLOWING_URL, commitsUrlOf(friend(1))])

    // An r on Mine while the round's request is out goes after it.
    const ui = await mountPane($, 'terminal')
    await ui.press({ key: 'tab-mine' })
    const refreshed = ui.press({ key: 'refresh' })
    await world.clock.settle()
    expect(world.requests).toHaveLength(7)
    world.release(ok([]))
    await refreshed
    await world.clock.settle()
    expect(urls(world).slice(6)).toEqual([commitsUrlOf(friend(1)), LIST_URL, commitsUrlOf(friend(2))])
    expect(world.overlaps()).toBe(0)
    await ui.unmount()
  })
})

describe('the Following tab says', () => {
  for (const surface of SURFACES) {
    test(`to run setup when no account is kept, and sends nothing, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [friend(1)], {}, {})
      await start($)
      await openPane($, world)
      await press($, world, 'tab-following', surface)

      expect(world.requests).toEqual([])
      expect(await rows($, surface)).toEqual(['/dev/nullr: refresh \u00b7 esc to return', TABS_ROW, NOT_SET_UP_TEXT])
    })

    test(`that the person follows nobody, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [])
      await start($)
      await openPane($, world)
      await press($, world, 'tab-following', surface)

      expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL])
      expect(await rows($, surface)).toEqual([`${HEADER} \u00b7 updated now`, TABS_ROW, FOLLOWING_NOBODY_TEXT])
      expect(FOLLOWING_NOBODY_TEXT).toBe('You follow nobody on /dev/null yet.')
    })

    test(`that none of them has posted, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [friend(1), friend(2)], { [friend(2)]: ok([apiCommitBy(friend(1), 11)]) })
      await start($)
      await openPane($, world)
      await press($, world, 'tab-following', surface)

      expect(await rows($, surface)).toEqual([`${HEADER} \u00b7 updated now`, TABS_ROW, FOLLOWING_NONE_POSTED_TEXT])
    })

    test(`the status number of a failed follow list and nothing of its text, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [friend(1)])
      await start($)
      await openPane($, world)
      world.answerFor(FOLLOWING_URL, { status: 404, text: SERVER_TEXT })
      await press($, world, 'tab-following', surface)

      expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL])
      const ui = await mountPane($, surface)
      expect(listRowsOf(await ui.drawn())).toEqual([HEADER, TABS_ROW, followingStatusText(404)])
      expect((await ui.find({ type: 'Text', text: followingStatusText(404) }))?.props).toEqual({ color: 'error' })
      await ui.unmount()
    })

    test(`a 429 on the follow list with how long it asked to wait, and waits that long, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [friend(1)])
      await start($)
      await openPane($, world)
      world.answerFor(FOLLOWING_URL, { status: 429, text: SERVER_TEXT, headers: { 'retry-after': '90' } })
      await press($, world, 'tab-following', surface)

      expect(await rows($, surface)).toEqual([HEADER, TABS_ROW, followingStatusText(429), waitText(90)])
      world.answerFor(FOLLOWING_URL, follows(friend(1)))
      await world.clock.advance(89_000)
      await press($, world, 'refresh', surface)
      expect(world.requests).toHaveLength(2)
      await world.clock.advance(1000)
      await press($, world, 'refresh', surface)
      expect(urls(world).slice(2)).toEqual([FOLLOWING_URL, commitsUrlOf(friend(1))])
    })

    test(`it could not reach dev-null.sh, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [friend(1)])
      await start($)
      await openPane($, world)
      world.answerFor(FOLLOWING_URL, 'unreachable')
      await press($, world, 'tab-following', surface)

      expect(await rows($, surface)).toEqual([HEADER, TABS_ROW, NETWORK_TEXT])
    })

    test(`it could not read a follow list with a hostile item, and asks for no list, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [friend(1)])
      await start($)
      const bodies = [
        apiFollowList([apiPerson(friend(1)), { name: 'no username' }]),
        apiFollowList([apiPerson(friend(1)), apiPerson(friend(2), { username: ['x'] })]),
        apiFollowList([apiPerson(friend(1)), 'friend-2']),
        apiFollowList([apiPerson(friend(1)), apiPerson(friend(1))]),
        apiFollowList(Array.from({ length: 31 }, (_, i) => apiPerson(friend(i + 1)))),
        { data: 'nope' },
      ]
      await openPane($, world)
      for (const body of bodies) {
        world.answerFor(FOLLOWING_URL, { status: 200, text: JSON.stringify(body) })
        await world.clock.advance(ROUND_MIN_MS)
        await press($, world, 'tab-following', surface)

        expect(await rows($, surface)).toEqual([HEADER, TABS_ROW, FOLLOWING_UNREADABLE_TEXT])
        expect(urls(world).filter(url => url !== LIST_URL && url !== FOLLOWING_URL)).toEqual([])
      }
    })

    test(`their bodies cleaned and capped, on ${surface}`, async ($, on) => {
      const hostile = ['\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007 \u001b[31mred\u001b[0m \u202eevil\u2066 \u0000bell', 'B'.repeat(5000), 'third', 'fourth'].join('\n')
      const world = followingWorld(on, [friend(1)], { [friend(1)]: ok([apiCommitBy(friend(1), 11, { body: hostile })]) })
      await start($)
      await openPane($, world)
      await press($, world, 'tab-following', surface)

      const drawn = await rows($, surface)
      expect(drawn[3]).toBe('click red evil bell')
      expect(drawn.join('\n')).not.toMatch(UNSAFE)
      expect(drawn.join('\n')).not.toContain('evil.example')
      expect(drawn.join('\n')).not.toContain('fourth')
    })

    test(`it could not load when Claude Code refused a step, on ${surface}`, async ($, on) => {
      const world = followingWorld(on, [friend(1)], {}, { isStoreBroken: true })
      await start($)
      await openPane($, world)
      await press($, world, 'tab-following', surface)

      expect(world.requests).toEqual([])
      expect(await rows($, surface)).toEqual(['/dev/nullr: refresh \u00b7 esc to return', TABS_ROW, FOLLOWING_LOCAL_TEXT])
      expect(world.toasts).toEqual([])
    })
  }
})

describe('the round and /devnull reply', () => {
  test("lends its hashes to the completion, labelled with the author, and never joins the person's own list", async ($, on) => {
    const states: FollowingState[] = []
    const recents: RecentCommits[] = []
    on('state.set', (_, e, next) => {
      if (e.plugin === 'devnull' && e.key === 'following') states.push(e.value)
      if (e.plugin === 'devnull' && e.key === 'recent' && e.value !== null) recents.push(e.value)

      return next(e)
    })
    const world = followingWorld(on, [friend(1)], { [friend(1)]: ok([apiCommitBy(friend(1), 11, { body: 'their commit' })]) })
    await start($)
    await openPane($, world)
    await press($, world, 'tab-following')

    const last = states.at(-1)
    if (last === undefined) throw new Error('the round wrote nothing')
    const hash = shortHashOf(commitId(11))
    const rowsFor = (token: string) =>
      completionRows(
        { readRecent: async () => recents.at(-1) ?? null, readFollowing: async () => followingCommitsOf(last), nowMs: async () => NOW },
        { text: `/devnull reply ${token}`, token, start: '/devnull reply '.length },
      )
    expect(await rowsFor(hash)).toEqual([{ text: hash, label: `${hash} @${friend(1)}`, description: '5h' }])
    expect((await rowsFor('0000001')).map(row => row.text)).toEqual([shortHashOf(commitId(1))])
    expect(recents.flatMap(recent => recent.commits.map(commit => commit.username))).toEqual([USERNAME])
  })
})

describe('closing the pane, /devnull off and the session end', () => {
  test('/devnull off while a list request is out: no further request, and the round ends with what arrived', async ($, on) => {
    const people = [1, 2, 3].map(friend)
    const world = followingWorld(on, people, { [friend(1)]: ok([apiCommitBy(friend(1), 11, { body: 'arrived before' })]) })
    await start($)
    await openPane($, world)
    world.answerFor(commitsUrlOf(friend(2)), 'held')
    const ui = await mountPane($, 'terminal')
    const pressed = ui.press({ key: 'tab-following' })
    await world.clock.settle()
    await ui.unmount()
    expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL, commitsUrlOf(friend(1)), commitsUrlOf(friend(2))])

    expect(await devnull($, 'off')).toBe(OFF_TEXT)
    world.release(ok([]))
    await pressed
    await world.clock.settle()
    expect(world.requests).toHaveLength(4)
    // The round ended with what arrived (the list already out answered); the one not asked for is counted.
    const drawn = await rows($, 'terminal')
    expect(drawn.slice(0, 3)).toEqual([`${HEADER} \u00b7 updated now`, TABS_ROW, notLoadedText(1, 3)])
    expect(drawn).toContain('arrived before')
    await world.clock.advance(10 * ROUND_MIN_MS)
    expect(world.requests).toHaveLength(4)
  })

  for (const how of ['the toggle', 'the session end'] as const) {
    test(`${how} stops a round waiting in the lane before it sends anything`, async ($, on) => {
      const people = [1, 2].map(friend)
      const world = followingWorld(on, people)
      await start($)
      await openPane($, world)
      world.answerFor(FOLLOWING_URL, 'held')
      const ui = await mountPane($, 'terminal')
      const pressed = ui.press({ key: 'tab-following' })
      await world.clock.settle()
      await ui.unmount()
      expect(world.requests).toHaveLength(2)

      if (how === 'the toggle') await closePane($)
      else await $.session.end({ reason: 'clear', sessionId: 'test-session', resume: { id: 'test-session' } })
      world.release(follows(...people))
      await pressed
      await world.clock.settle()
      expect(world.requests).toHaveLength(2)
    })
  }

  test("another's close of the pane (as the person's close mark raises it) stops a round waiting in the lane", { plugins: [CLOSER] }, async ($, on) => {
    const people = [1, 2].map(friend)
    const world = followingWorld(on, people)
    await start($)
    await openPane($, world)
    world.answerFor(FOLLOWING_URL, 'held')
    const ui = await mountPane($, 'terminal')
    const pressed = ui.press({ key: 'tab-following' })
    await world.clock.settle()
    await ui.unmount()
    expect(world.requests).toHaveLength(2)

    await $.command.run({ command: 'close-devnull', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
    expect(world.open.has('devnull')).toBe(false)
    world.release(follows(...people))
    await pressed
    await world.clock.settle()
    expect(world.requests).toHaveLength(2)
    // Its redraw timer stopped with it.
    const asked = world.panesAsked()
    await world.clock.advance(10 * ROUND_MIN_MS)
    expect(world.panesAsked()).toBe(asked)
  })

  test('a Mine load the close kept from going out records no failure, and the reopen loads', async ($, on) => {
    const people = [1].map(friend)
    const world = followingWorld(on, people)
    await start($)
    await openPane($, world)
    world.answerFor(FOLLOWING_URL, 'held')
    const ui = await mountPane($, 'terminal')
    const pressed = ui.press({ key: 'tab-following' })
    await world.clock.settle()
    await ui.press({ key: 'tab-mine' })
    const refreshed = ui.press({ key: 'refresh' })
    await world.clock.settle()
    await ui.unmount()
    expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL])

    await closePane($)
    expect(await toggle($)).toEqual({})
    world.release(follows(...people))
    await pressed
    await refreshed
    await world.clock.settle()
    // The reopen's own load went out once the held request settled.
    expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL, LIST_URL])
    const drawn = await rows($, 'terminal')
    expect(drawn).not.toContain(NETWORK_TEXT)
    expect(drawn).toContain('my own commit')
    expect(drawn[0]).toBe(`${HEADER} \u00b7 updated now`)
  })

  test('a Mine load queued behind a held request is not sent once the pane is closed', async ($, on) => {
    const people = [1].map(friend)
    const world = followingWorld(on, people)
    await start($)
    await openPane($, world)
    world.answerFor(FOLLOWING_URL, 'held')
    const ui = await mountPane($, 'terminal')
    const pressed = ui.press({ key: 'tab-following' })
    await world.clock.settle()
    await ui.press({ key: 'tab-mine' })
    const refreshed = ui.press({ key: 'refresh' })
    await world.clock.settle()
    await ui.unmount()
    expect(world.requests).toHaveLength(2)

    expect(await devnull($, 'off')).toBe(OFF_TEXT)
    world.release(follows(...people))
    await pressed
    await refreshed
    await world.clock.settle()
    expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL])
  })
})

describe('a 429 holds the whole pane back', () => {
  test("after a round's 429, Mine does not load until Retry-After has passed", async ($, on) => {
    const world = followingWorld(on, [friend(1)], { [friend(1)]: { status: 429, text: '', headers: { 'retry-after': '120' } } })
    await start($)
    await openPane($, world)
    await press($, world, 'tab-following')
    expect(world.requests).toHaveLength(3)

    await press($, world, 'tab-mine')
    await press($, world, 'refresh')
    await world.clock.advance(119_000)
    await press($, world, 'refresh')
    expect(world.requests).toHaveLength(3)
    await world.clock.advance(1000)
    await press($, world, 'refresh')
    expect(urls(world).slice(3)).toEqual([LIST_URL])
  })

  for (const surface of SURFACES) {
    test(`a hold set while requests wait in the lane stops them: the round ends cut, the queued load is not sent, on ${surface}`, async ($, on) => {
      const hold = watchHold(on)
      const world = followingWorld(on, [1, 2].map(friend), { [friend(1)]: 'held' })
      await start($)
      await openPane($, world)
      const ui = await mountPane($, surface)
      const pressed = ui.press({ key: 'tab-following' })
      await world.clock.settle()
      await ui.press({ key: 'tab-mine' })
      const refreshed = ui.press({ key: 'refresh' })
      await world.clock.settle()
      // Friend 1's list is out, and Mine's load waits behind it in the lane.
      expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL, commitsUrlOf(friend(1))])

      // A poll meets a 429 while it is out.
      hold.set(NOW + 120_000)
      world.release(ok([apiCommitBy(friend(1), 11, { body: 'arrived before' })]))
      await pressed
      await refreshed
      await world.clock.settle()
      expect(urls(world)).toEqual([LIST_URL, FOLLOWING_URL, commitsUrlOf(friend(1))])
      // Mine keeps its page, with the wait under the header and no failure.
      const mine = listRowsOf(await ui.drawn())
      expect(mine).toContain('my own commit')
      expect(mine).toContain(heldText(120))
      expect(mine).not.toContain(NETWORK_TEXT)
      await ui.unmount()

      // The round drew what arrived, cut.
      await press($, world, 'tab-following', surface)
      const drawn = await rows($, surface)
      expect(drawn).toContain(FOLLOWING_CUT_TEXT)
      expect(drawn).toContain('arrived before')
      expect(world.requests).toHaveLength(3)
    })
  }

  test('a hold that comes into force mid-round stops it before the next request, lane or not', async () => {
    const people = [1, 2, 3].map(friend)
    const texts: Record<string, string> = {
      [FOLLOWING_URL]: JSON.stringify(apiFollowList(people.map(name => apiPerson(name)))),
      [commitsUrlOf(friend(1))]: JSON.stringify(apiList([apiCommitBy(friend(1), 11)])),
    }
    const asked: string[] = []
    let state: FollowingState = { kind: 'idle' }
    let notBeforeMs = 0
    const io: RoundIo = {
      now: async () => NOW,
      newToken: () => 'round-1',
      readAccount: async () => ACCOUNT,
      fetchList: async url => {
        asked.push(url)
        // A poll meets a 429 while friend 1's list is out.
        if (url === commitsUrlOf(friend(1))) notBeforeMs = NOW + 120_000

        return { status: 200, ok: true, headers: {}, text: texts[url] ?? JSON.stringify(apiList([])) }
      },
      changeRound: async change => {
        state = change(state)

        return state
      },
      readNotBefore: async () => notBeforeMs,
      holdUntil: async atMs => {
        notBeforeMs = Math.max(notBeforeMs, atMs)
      },
      isStopped: () => false,
    }

    await runRound(io, 'show', Promise.resolve())

    expect(asked).toEqual([FOLLOWING_URL, commitsUrlOf(friend(1))])
    expect(state).toMatchObject({ kind: 'ended', last: { outcome: { kind: 'list', people: 3, failed: 0, isCut: true } } })
    expect(followingCommitsOf(state).map(commit => commit.id)).toEqual([commitId(11)])
  })

  test("after Mine's 429, the round does not start until Retry-After has passed", async ($, on) => {
    const world = followingWorld(on, [friend(1)])
    world.answer({ status: 429, text: '', headers: { 'retry-after': '120' } })
    await start($)
    await openPane($, world)
    expect(urls(world)).toEqual([LIST_URL])

    await press($, world, 'tab-following')
    await press($, world, 'refresh')
    await world.clock.advance(119_000)
    await press($, world, 'refresh')
    await press($, world, 'tab-following')
    expect(world.requests).toHaveLength(1)
    await world.clock.advance(1000)
    await press($, world, 'refresh')
    expect(urls(world).slice(1)).toEqual([FOLLOWING_URL, commitsUrlOf(friend(1))])
  })
})
