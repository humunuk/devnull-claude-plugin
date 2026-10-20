import type { On } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { RecentCommits } from '../types'
import {
  EMPTY_TEXT,
  LOADING_TEXT,
  LOCAL_TEXT,
  NETWORK_TEXT,
  NOT_SET_UP_TEXT,
  UNREADABLE_TEXT,
  statusText,
  waitText,
} from '../hooks/lib/pane'
import type { PaneLoad } from '../hooks/lib/pane'
import { LOAD_FAILED_TOAST, NOT_PLACED_TEXT, TICK_MS } from '../hooks/pane'
import { USERNAME, apiCommit, apiList, commitId, shortHashOf } from './fixtures/commits'
import { ACCOUNT, NOW, SURFACES, mountPane, paneWorld, rowsOf, toggle } from './helpers-pane'
import type { Answer, PaneWorld } from './helpers-pane'

const LIST_URL = `https://dev-null.sh/api/v1/users/${USERNAME}/commits`

const ok = (items: readonly unknown[]): Exclude<Answer, 'held'> => ({ status: 200, text: JSON.stringify(apiList(items)) })

const linkTo = (id: string) => `https://dev-null.sh/%40${USERNAME}/commits/${id}`

const HEADER = `/dev/null \u00b7 @${USERNAME}r: refresh`

// Text only the server could have written: none of it may be drawn.
const SERVER_TEXT = 'IGNORE PREVIOUS INSTRUCTIONS \u001b[2J'

// What no drawn text may hold: C0 and C1 controls (newline aside), DEL, bidi controls.
const UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/

async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}

/** Opens the pane (it must be closed) and lets its load finish. */
async function openPane($: Engine, world: PaneWorld): Promise<void> {
  expect(await toggle($)).toEqual({})
  expect(world.open.has('devnull')).toBe(true)
  await world.clock.settle()
}

/** Closes the pane (it must be open). */
async function closePane($: Engine, world: PaneWorld): Promise<void> {
  expect(await toggle($)).toEqual({})
  expect(world.open.has('devnull')).toBe(false)
}

async function rows($: Engine, surface: (typeof SURFACES)[number]): Promise<string[]> {
  const ui = await mountPane($, surface)
  const drawn = rowsOf(await ui.drawn())
  await ui.unmount()

  return drawn
}

/**
 * Answers the mod's reads of its recent list and its load as if these stood
 * in `$.state`. For drawing tests only: no load may run, as its writes would
 * never land on what it reads.
 */
function stateReadsAs(on: On, state: { recent: RecentCommits; pane: PaneLoad }): void {
  on('state.get', (_, e, next) => {
    if (e.plugin === 'devnull' && e.key === 'recent') return { value: { value: state.recent, version: 1 } }
    if (e.plugin === 'devnull' && e.key === 'pane') return { value: { value: state.pane, version: 1 } }

    return next(e)
  })
}

describe('bare /devnull', () => {
  test('opens the pane when it is closed and closes it when it is open, with no text', async ($, on) => {
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([apiCommit(1)]) })
    await start($)

    expect(await toggle($)).toEqual({})
    expect([...world.open]).toEqual(['devnull'])
    expect(await toggle($)).toEqual({})
    expect([...world.open]).toEqual([])
    expect(await toggle($)).toEqual({})
    expect([...world.open]).toEqual(['devnull'])
  })

  test('opens it again after the person closed it', async ($, on) => {
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([apiCommit(1)]) })
    await start($)

    await openPane($, world)
    world.closeByPerson()
    await openPane($, world)
    expect([...world.open]).toEqual(['devnull'])
  })

  test('fetches a fresh list on every open, and none on a close', async ($, on) => {
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([apiCommit(1)]) })
    await start($)

    await openPane($, world)
    expect(world.requests).toEqual([{ url: LIST_URL, init: { method: 'GET', headers: { Accept: 'application/json' } } }])
    await closePane($, world)
    expect(world.requests).toHaveLength(1)
    await openPane($, world)
    expect(world.requests).toHaveLength(2)
    world.closeByPerson()
    await openPane($, world)
    expect(world.requests).toHaveLength(3)
    expect(world.requests.every(request => request.url === LIST_URL)).toBe(true)
  })

  test('says so with a fixed line when no screen draws the pane, and still loads', async ($, on) => {
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([apiCommit(1)]), isPlaced: false })
    await start($)

    expect(await toggle($)).toEqual({ text: NOT_PLACED_TEXT })
    await world.clock.settle()
    expect(world.requests).toHaveLength(1)
  })

  test('toggles from any origin: it posts nothing', async ($, on) => {
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([]) })
    await start($)

    expect(await toggle($, { kind: 'plugin', name: 'other' })).toEqual({})
    expect([...world.open]).toEqual(['devnull'])
  })

  test('answers with no fetched text whatever the load brings', async ($, on) => {
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([apiCommit(1, { body: SERVER_TEXT })]) })
    await start($)

    await openPane($, world)
    world.answer({ status: 500, text: SERVER_TEXT })
    await closePane($, world)
    await openPane($, world)
  })

  test('leaves every other subcommand to the rest of the chain', async ($, on) => {
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([]) })
    await start($)

    const { text } = await $.command.run({
      command: 'devnull',
      args: 'nope',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
    expect(text).toStartWith('Usage:')
    expect(text).toContain('/devnull                          open or close the /dev/null pane')
    expect([...world.open]).toEqual([])
    expect(world.requests).toHaveLength(0)
  })
})

describe('the pane', () => {
  for (const surface of SURFACES) {
    test(`draws the header and each commit, git log style, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, {
        account: ACCOUNT,
        answer: ok([
          apiCommit(2, { body: 'second\nline two', stars_count: 7, replies_count: 2, created_at: '2026-10-20T11:58:00Z' }),
          apiCommit(1, { body: 'first' }),
        ]),
      })
      await start($)
      await openPane($, world)

      const ui = await mountPane($, surface)
      expect((await ui.find({ type: 'Text', text: /^\/dev\/null/ }))?.text).toBe(`/dev/null \u00b7 @${USERNAME}`)
      expect((await ui.find({ type: 'Button', key: 'refresh' }))?.props).toMatchObject({ label: 'refresh', hotkey: 'r' })
      expect((await ui.find({ type: 'Text', text: /updated/ }))?.text).toBe(' \u00b7 updated now')

      const hash = await ui.find({ type: 'Text', text: new RegExp(`^${shortHashOf(commitId(2))}$`) })
      expect(hash?.props).toEqual({ color: 'warning' })
      const meta = await ui.find({ type: 'Text', text: /^ .*\u2605 7/ })
      expect(meta?.props).toEqual({ color: 'subtle' })
      expect(meta?.text).toBe(' 2m \u00b7 \u2605 7 \u00b7 \u21b3 2')

      const links = await ui.findAll({ type: 'Link' })
      expect(links.map(link => link.props)).toEqual([
        { href: linkTo(commitId(2)), label: 'open \u2197' },
        { href: linkTo(commitId(1)), label: 'open \u2197' },
      ])
      await ui.unmount()

      expect(await rows($, surface)).toEqual([
        `${HEADER} \u00b7 updated now`,
        `${shortHashOf(commitId(2))} 2m \u00b7 \u2605 7 \u00b7 \u21b3 2`,
        'second',
        'line two',
        'open \u2197',
        `${shortHashOf(commitId(1))} 5h \u00b7 \u2605 3 \u00b7 \u21b3 1`,
        'first',
        'open \u2197',
      ])
    })

    test(`says to run setup when no account is kept, and sends nothing, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { answer: ok([apiCommit(1)]) })
      await start($)
      await openPane($, world)

      expect(world.requests).toHaveLength(0)
      expect(await rows($, surface)).toEqual(['/dev/nullr: refresh', NOT_SET_UP_TEXT])
    })

    test(`takes an account the store holds in another shape as none, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { account: { ...ACCOUNT, username: '../../evil' }, answer: ok([]) })
      await start($)
      await openPane($, world)

      expect(world.requests).toHaveLength(0)
      expect(await rows($, surface)).toEqual(['/dev/nullr: refresh', NOT_SET_UP_TEXT])
    })

    test(`says it is loading while the request is out, then draws the list, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { account: ACCOUNT, answer: 'held' })
      await start($)
      await openPane($, world)

      expect(await rows($, surface)).toEqual([`${HEADER} \u00b7 loading\u2026`, LOADING_TEXT])

      world.release(ok([apiCommit(1)]))
      await world.clock.settle()
      const drawn = await rows($, surface)
      expect(drawn[0]).toBe(`${HEADER} \u00b7 updated now`)
      expect(drawn).not.toContain(LOADING_TEXT)
      expect(drawn).toContain('invented commit number 1')
    })

    test(`keeps the last list on screen while a reload is out, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { account: ACCOUNT, answer: ok([apiCommit(1)]) })
      await start($)
      await openPane($, world)
      world.answer('held')
      await closePane($, world)
      await openPane($, world)

      const drawn = await rows($, surface)
      expect(drawn[0]).toBe(`${HEADER} \u00b7 loading\u2026`)
      expect(drawn).toContain('invented commit number 1')
      expect(drawn).not.toContain(LOADING_TEXT)
      world.release('unreachable')
    })

    test(`says there are no commits yet, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { account: ACCOUNT, answer: ok([]) })
      await start($)
      await openPane($, world)

      expect(await rows($, surface)).toEqual([`${HEADER} \u00b7 updated now`, EMPTY_TEXT])
    })

    test(`shows the status number of a failed answer and nothing of its text, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { account: ACCOUNT })
      await start($)
      for (const status of [404, 500, 503, 302, 201]) {
        world.answer({ status, text: SERVER_TEXT })
        await openPane($, world)

        const ui = await mountPane($, surface)
        const message = await ui.find({ type: 'Text', text: /HTTP/ })
        expect(message?.text).toBe(statusText(status))
        expect(message?.props).toEqual({ color: 'error' })
        expect(rowsOf(await ui.drawn())).toEqual([HEADER, statusText(status)])
        await ui.unmount()
        await closePane($, world)
      }
    })

    test(`says it could not reach dev-null.sh when the request fails, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { account: ACCOUNT, answer: 'unreachable' })
      await start($)
      await openPane($, world)

      expect(await rows($, surface)).toEqual([HEADER, NETWORK_TEXT])
    })

    test(`refuses a 200 that is not exactly a commit list, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { account: ACCOUNT })
      await start($)
      const bodies = [
        SERVER_TEXT,
        '{"data":"nope"}',
        JSON.stringify(apiList([apiCommit(1), apiCommit(2, { author: { username: 'bad user' } })])),
        JSON.stringify(apiList([apiCommit(1, { id: 'not-a-uuid' })])),
      ]
      for (const text of bodies) {
        world.answer({ status: 200, text })
        await openPane($, world)

        expect(await rows($, surface)).toEqual([HEADER, UNREADABLE_TEXT])
        await closePane($, world)
      }
    })

    test(`draws hostile bodies cleaned and capped, on ${surface}`, async ($, on) => {
      const hostile = [
        '\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007 \u001b[31mred\u001b[0m \u202eevil\u2066 \u0007\u0000bell',
        'B'.repeat(5000),
        'third',
        'fourth, never drawn',
      ].join('\n')
      const world = paneWorld(on, { account: ACCOUNT, answer: ok([apiCommit(1, { body: hostile })]) })
      await start($)
      await openPane($, world)

      const drawn = await rows($, surface)
      const bodyRows = drawn.slice(2, -1)
      expect(bodyRows[0]).toBe('click red evil bell')
      expect(bodyRows).toHaveLength(2)
      expect(bodyRows[1]).toEndWith('\u2026')
      expect(Array.from(bodyRows.join('')).length).toBeLessThanOrEqual(600)
      expect(drawn.join('\n')).not.toMatch(UNSAFE)
      expect(drawn.join('\n')).not.toContain('evil.example')
      expect(drawn.join('\n')).not.toContain('fourth')
    })

    test(`draws a commit whose id fails the link pattern without a link, on ${surface}`, async ($, on) => {
      // Only the mod writes this list, through a parser that refuses such an
      // id; it is read here as if it stood there, to show the drawing holds.
      const badId = 'https://evil.example/x'
      stateReadsAs(on, {
        recent: {
          username: USERNAME,
          fetchedAtMs: NOW,
          commits: [
            { id: badId, shortHash: 'abcdef1', body: 'no link', parentId: null, createdAtMs: NOW, starsCount: 0, repliesCount: 0, username: USERNAME },
            { id: commitId(1), shortHash: shortHashOf(commitId(1)), body: 'linked', parentId: null, createdAtMs: NOW, starsCount: 0, repliesCount: 0, username: USERNAME },
          ],
        },
        pane: { kind: 'ready', username: USERNAME, page: [badId, commitId(1)] },
      })
      paneWorld(on, { account: ACCOUNT })
      await start($)

      const ui = await mountPane($, surface)
      const links = await ui.findAll({ type: 'Link' })
      expect(links.map(link => link.props.href)).toEqual([linkTo(commitId(1))])
      expect(rowsOf(await ui.drawn())).toEqual([
        `${HEADER} \u00b7 updated now`,
        'abcdef1 now \u00b7 \u2605 0 \u00b7 \u21b3 0',
        'no link',
        `${shortHashOf(commitId(1))} now \u00b7 \u2605 0 \u00b7 \u21b3 0`,
        'linked',
        'open \u2197',
      ])
      await ui.unmount()
    })
  }

  test('draws on vscode and mobile too, where it has no control that posts', async ($, on) => {
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([apiCommit(1)]) })
    await start($)
    await openPane($, world)

    for (const surface of ['vscode', 'mobile'] as const) {
      const ui = await mountPane($, surface)
      expect(await ui.findAll({ type: 'Input' })).toHaveLength(0)
      expect(await ui.find({ type: 'Text', text: 'invented commit number 1' })).toBeDefined()
      expect((await ui.findAll({ type: 'Link' })).map(link => link.props.href)).toEqual([linkTo(commitId(1))])
      await ui.unmount()
    }
  })
})

describe('refreshing', () => {
  for (const surface of SURFACES) {
    test(`r fetches the list again and draws the new counts, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { account: ACCOUNT, answer: ok([apiCommit(1)]) })
      await start($)
      await openPane($, world)
      world.answer(ok([apiCommit(1, { replies_count: 4 })]))
      await world.clock.advance(5 * 60_000)

      const ui = await mountPane($, surface)
      expect((await ui.find({ type: 'Text', text: /updated/ }))?.text).toBe(' \u00b7 updated 5m')
      await ui.press({ key: 'refresh' })
      await world.clock.settle()

      expect(world.requests).toHaveLength(2)
      expect((await ui.find({ type: 'Text', text: /^ .*\u21b3/ }))?.text).toBe(' 6h \u00b7 \u2605 3 \u00b7 \u21b3 4')
      expect((await ui.find({ type: 'Text', text: /updated/ }))?.text).toBe(' \u00b7 updated now')
      await ui.unmount()
    })

    test(`r loads once setup has been done, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { answer: ok([apiCommit(1)]) })
      await start($)
      await openPane($, world)
      expect(world.requests).toHaveLength(0)

      world.setAccount(ACCOUNT)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'refresh' })
      await world.clock.settle()
      expect(world.requests).toHaveLength(1)
      expect(rowsOf(await ui.drawn())).toContain('invented commit number 1')
      await ui.unmount()
    })

    test(`keeps one request in flight: r and a reopen meanwhile send nothing, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { account: ACCOUNT, answer: 'held' })
      await start($)
      await openPane($, world)

      const ui = await mountPane($, surface)
      await ui.press({ key: 'refresh' })
      await ui.press({ key: 'refresh' })
      await ui.unmount()
      await closePane($, world)
      await openPane($, world)
      expect(world.requests).toHaveLength(1)

      world.answer(ok([apiCommit(1)]))
      world.release(ok([apiCommit(1)]))
      await world.clock.settle()
      const again = await mountPane($, surface)
      await again.press({ key: 'refresh' })
      await again.unmount()
      expect(world.requests).toHaveLength(2)
    })

    test(`starts over when a load never came back, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { account: ACCOUNT, answer: 'held' })
      await start($)
      await openPane($, world)
      // A reload under the load would lose its answer; 35 s on, it is let go.
      await world.clock.advance(34_999)
      const ui = await mountPane($, surface)
      await ui.press({ key: 'refresh' })
      expect(world.requests).toHaveLength(1)

      await world.clock.advance(1)
      world.answer(ok([apiCommit(1)]))
      await ui.press({ key: 'refresh' })
      await world.clock.settle()
      expect(world.requests).toHaveLength(2)
      expect(rowsOf(await ui.drawn())).toContain('invented commit number 1')

      // The first load's late answer changes nothing.
      world.release({ status: 500, text: '' })
      await world.clock.settle()
      expect(rowsOf(await ui.drawn())).toContain('invented commit number 1')
      expect(rowsOf(await ui.drawn())).not.toContain(statusText(500))
      await ui.unmount()
    })

    test(`waits as long as a 429 asks before fetching again, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { account: ACCOUNT, answer: { status: 429, text: SERVER_TEXT, headers: { 'retry-after': '120' } } })
      await start($)
      await openPane($, world)

      const ui = await mountPane($, surface)
      expect(rowsOf(await ui.drawn())).toEqual([HEADER, statusText(429), waitText(120)])
      await ui.press({ key: 'refresh' })
      await closePane($, world)
      await openPane($, world)
      await world.clock.advance(119_999)
      await ui.press({ key: 'refresh' })
      expect(world.requests).toHaveLength(1)

      world.answer(ok([apiCommit(1)]))
      await world.clock.advance(1)
      await ui.press({ key: 'refresh' })
      await world.clock.settle()
      expect(world.requests).toHaveLength(2)
      expect(rowsOf(await ui.drawn())).toContain('invented commit number 1')
      await ui.unmount()
    })

    test(`retries at once after a 429 with no usable Retry-After, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { account: ACCOUNT, answer: { status: 429, text: '', headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } } })
      await start($)
      await openPane($, world)

      const ui = await mountPane($, surface)
      expect(rowsOf(await ui.drawn())).toEqual([HEADER, statusText(429)])
      await ui.press({ key: 'refresh' })
      await world.clock.settle()
      expect(world.requests).toHaveLength(2)
      await ui.unmount()
    })
  }
})

describe('the recent list', () => {
  test('gets each fetched list through storeRecent, in $.state', async ($, on) => {
    const writes: unknown[] = []
    on('state.set', (_, e, next) => {
      if (e.plugin === 'devnull' && e.key === 'recent') writes.push(e.value)

      return next(e)
    })
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([apiCommit(1), apiCommit(2)]) })
    await start($)
    await openPane($, world)

    world.answer(ok([apiCommit(3, { created_at: '2026-10-20T11:00:00Z' })]))
    await world.clock.advance(60_000)
    await closePane($, world)
    await openPane($, world)

    const summary = (n: number, createdAtMs: number) => ({
      id: commitId(n),
      shortHash: shortHashOf(commitId(n)),
      body: `invented commit number ${n}`,
      parentId: null,
      createdAtMs,
      starsCount: 3,
      repliesCount: 1,
      username: USERNAME,
    })
    const early = Date.UTC(2026, 9, 20, 6, 0, 4)
    expect(writes).toEqual([
      { username: USERNAME, fetchedAtMs: NOW, commits: [summary(2, early), summary(1, early)] },
      {
        username: USERNAME,
        fetchedAtMs: NOW + 60_000,
        commits: [summary(3, Date.UTC(2026, 9, 20, 11, 0, 0)), summary(2, early), summary(1, early)],
      },
    ])
  })

  test('draws the top-level commits only: replies kept there are left out', async ($, on) => {
    const world = paneWorld(on, {
      account: ACCOUNT,
      answer: ok([apiCommit(9, { parent_id: commitId(1), body: 'a reply' }), apiCommit(1, { body: 'top level' })]),
    })
    await start($)
    await openPane($, world)

    const drawn = await rows($, 'terminal')
    expect(drawn).toContain('top level')
    expect(drawn).not.toContain('a reply')
  })

  test('draws nothing of a list kept for another username', async ($, on) => {
    stateReadsAs(on, {
      recent: {
        username: 'someone-else',
        fetchedAtMs: NOW,
        commits: [
          { id: commitId(1), shortHash: shortHashOf(commitId(1)), body: 'theirs', parentId: null, createdAtMs: NOW, starsCount: 0, repliesCount: 0, username: 'someone-else' },
        ],
      },
      pane: { kind: 'ready', username: USERNAME, page: [commitId(1)] },
    })
    paneWorld(on, { account: ACCOUNT })
    await start($)

    expect(await rows($, 'terminal')).toEqual([HEADER, EMPTY_TEXT])
  })

  test('draws only the page last fetched: a commit gone upstream leaves the pane', async ($, on) => {
    const writes: RecentCommits[] = []
    on('state.set', (_, e, next) => {
      if (e.plugin === 'devnull' && e.key === 'recent' && e.value !== null) writes.push(e.value)

      return next(e)
    })
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([apiCommit(2), apiCommit(1)]) })
    await start($)
    await openPane($, world)
    const ui = await mountPane($, 'terminal')
    expect(rowsOf(await ui.drawn()).filter(row => row.startsWith('invented'))).toEqual([
      'invented commit number 2',
      'invented commit number 1',
    ])

    // Commit 1 is deleted upstream; the next fetch no longer holds it.
    world.answer(ok([apiCommit(2, { replies_count: 5 })]))
    await ui.press({ key: 'refresh' })
    await world.clock.settle()

    const drawn = rowsOf(await ui.drawn())
    expect(drawn.filter(row => row.startsWith('invented'))).toEqual(['invented commit number 2'])
    expect(drawn).toContain(`${shortHashOf(commitId(2))} 5h \u00b7 \u2605 3 \u00b7 \u21b3 5`)
    expect((await ui.findAll({ type: 'Link' })).map(link => link.props.href)).toEqual([linkTo(commitId(2))])
    await ui.unmount()
    // The recent list, which completes `/devnull reply`, still keeps it.
    expect(writes.at(-1)?.commits.map(commit => commit.id)).toEqual([commitId(2), commitId(1)])
  })
})

describe('the ages drawn', () => {
  for (const surface of SURFACES) {
    test(`move on while the pane stays open, with no other redraw, on ${surface}`, async ($, on) => {
      const world = paneWorld(on, { account: ACCOUNT, answer: ok([apiCommit(1)]) })
      await start($)
      await openPane($, world)

      const ui = await mountPane($, surface)
      expect(rowsOf(await ui.drawn()).slice(0, 2)).toEqual([
        `${HEADER} \u00b7 updated now`,
        `${shortHashOf(commitId(1))} 5h \u00b7 \u2605 3 \u00b7 \u21b3 1`,
      ])
      await world.clock.advance(3 * 3_600_000 + 10 * 60_000)

      expect(rowsOf(await ui.drawn()).slice(0, 2)).toEqual([
        `${HEADER} \u00b7 updated 3h`,
        `${shortHashOf(commitId(1))} 9h \u00b7 \u2605 3 \u00b7 \u21b3 1`,
      ])
      expect(world.requests).toHaveLength(1)
      await ui.unmount()
    })
  }

  test('are redrawn by one timer a minute, however often the pane was opened', async ($, on) => {
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([]) })
    await start($)
    await openPane($, world)
    await closePane($, world)
    await openPane($, world)
    world.closeByPerson()
    await openPane($, world)

    const asked = world.panesAsked()
    await world.clock.advance(5 * TICK_MS)
    expect(world.panesAsked() - asked).toBe(5)
  })

  test('stop with /devnull closing the pane', async ($, on) => {
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([]) })
    await start($)
    await openPane($, world)
    await closePane($, world)

    const asked = world.panesAsked()
    await world.clock.advance(10 * TICK_MS)
    expect(world.panesAsked()).toBe(asked)
  })

  test('stop at the first tick after the person closed the pane', async ($, on) => {
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([]) })
    await start($)
    await openPane($, world)
    world.closeByPerson()

    const asked = world.panesAsked()
    await world.clock.advance(TICK_MS)
    expect(world.panesAsked()).toBe(asked + 1)
    await world.clock.advance(10 * TICK_MS)
    expect(world.panesAsked()).toBe(asked + 1)
  })

  test('stop when the session ends', async ($, on) => {
    const world = paneWorld(on, { account: ACCOUNT, answer: ok([]) })
    await start($)
    await openPane($, world)
    await $.session.end({ reason: 'other', sessionId: 'test-session', resume: { id: 'test-session' } })

    const asked = world.panesAsked()
    await world.clock.advance(10 * TICK_MS)
    expect(world.panesAsked()).toBe(asked)
  })
})

describe('a failure inside the load', () => {
  test('is drawn as a fixed line when the store cannot be read', async ($, on) => {
    const world = paneWorld(on, { isStoreBroken: true, answer: ok([apiCommit(1)]) })
    await start($)
    await openPane($, world)

    expect(world.requests).toHaveLength(0)
    expect(await rows($, 'terminal')).toEqual(['/dev/nullr: refresh', LOCAL_TEXT])
    expect(world.toasts).toEqual([])
  })

  test('is a toast when even the state cannot be written', async ($, on) => {
    on('state.set', () => ({ deny: 'state refused' }))
    const world = paneWorld(on, { isStoreBroken: true, answer: ok([apiCommit(1)]) })
    await start($)
    await openPane($, world)

    expect(world.requests).toHaveLength(0)
    expect(world.toasts).toEqual([LOAD_FAILED_TOAST])
  })
})
