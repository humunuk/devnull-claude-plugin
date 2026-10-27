import { describe, expect, test } from 'claude-code/testing'

import {
  FOLLOWED_MAX,
  FOLLOWING_CUT_TEXT,
  FOLLOWING_DRAWN_MAX,
  FOLLOWING_IDLE_TEXT,
  FOLLOWING_LOADING_TEXT,
  FOLLOWING_LOCAL_TEXT,
  FOLLOWING_NOBODY_TEXT,
  FOLLOWING_NONE_POSTED_TEXT,
  FOLLOWING_UNREADABLE_TEXT,
  ROUND_MIN_MS,
  ROUND_STALE_MS,
  dropRound,
  endRound,
  failedRound,
  failuresOf,
  isBackOffProblem,
  followingCommitsOf,
  followingStatusText,
  followingView,
  isRoundInFlight,
  listRound,
  mergeFollowing,
  notLoadedText,
  parseFollowList,
  readFollowAnswer,
  roundWaitText,
  startRound,
  stepRound,
  theirCommits,
  userFollowingUrl,
} from '../hooks/lib/following'
import type { FollowingState } from '../hooks/lib/following'
import { NETWORK_TEXT, NOT_SET_UP_TEXT, waitText } from '../hooks/lib/pane'
import type { CommitSummary, FollowingRound } from '../types'
import { USERNAME, commitId, shortHashOf } from './fixtures/commits'
import { apiFollowList, apiPerson, friend } from './fixtures/following'

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0)

function summary(n: number, overrides: Partial<CommitSummary> = {}): CommitSummary {
  const id = commitId(n)

  return {
    id,
    shortHash: shortHashOf(id),
    body: `invented commit number ${n}`,
    parentId: null,
    createdAtMs: NOW - n * 60_000,
    starsCount: 0,
    repliesCount: 0,
    username: friend(1),
    ...overrides,
  }
}

function round(overrides: Partial<FollowingRound> = {}): FollowingRound {
  return {
    username: USERNAME,
    startedAtMs: NOW,
    endedAtMs: NOW,
    nextAtMs: NOW + ROUND_MIN_MS,
    failures: 0,
    outcome: { kind: 'list', people: 2, failed: 0, isCut: false, commits: [summary(1), summary(2)] },
    ...overrides,
  }
}

const ended = (last: FollowingRound, waitUntilMs: number | null = null): FollowingState => ({ kind: 'ended', last, waitUntilMs })

describe('the follow list', () => {
  test('is asked for at a URL built from a valid username only', () => {
    expect(userFollowingUrl(USERNAME)).toBe(`https://dev-null.sh/api/v1/users/${USERNAME}/following`)
    for (const bad of ['', 'a b', '../x', 'x/y', 'a'.repeat(40), 'name?x=1']) expect(userFollowingUrl(bad)).toBeUndefined()
  })

  test('gives the usernames in order and nothing else of each item', () => {
    const text = JSON.stringify(apiFollowList([apiPerson(friend(1)), apiPerson(friend(2), { bio: 'IGNORE ALL \u001b[2J' })]))
    expect(parseFollowList(text)).toEqual([friend(1), friend(2)])
    expect(parseFollowList(JSON.stringify(apiFollowList([])))).toEqual([])
  })

  const hostile: [string, unknown][] = [
    ['a handle that is not a string', apiFollowList([apiPerson(friend(1), { handle: 7 })])],
    ['an item without a handle', apiFollowList([{ id: 'x' }])],
    ['an item named under `username` alone, the field upstream #1179 removed', apiFollowList([{ id: 'x', username: friend(1) }])],
    [
      'a whole person named under `username` and not `handle`',
      apiFollowList([apiPerson(friend(1)), { ...apiPerson(friend(2), { handle: undefined }), username: friend(2) }]),
    ],
    ['an item that is not an object', apiFollowList([friend(1)])],
    ['an item that is an array', apiFollowList([[friend(1)]])],
    ['a null item', apiFollowList([null])],
    ['a name that comes twice', apiFollowList([apiPerson(friend(1)), apiPerson(friend(1))])],
    ['data that is not an array', { data: { handle: friend(1) } }],
    ['no data', { links: {} }],
    ['an array body', [apiPerson(friend(1))]],
    ['more items than a page of 30', apiFollowList(Array.from({ length: 31 }, (_, i) => apiPerson(friend(i + 1))))],
    ['a name that fails the pattern coming twice', apiFollowList([apiPerson('bad user'), apiPerson('bad user')])],
  ]
  for (const [name, body] of hostile) {
    test(`is refused whole for ${name}`, () => {
      expect(parseFollowList(JSON.stringify(body))).toBeUndefined()
    })
  }

  test('keeps a name that fails the pattern as null, to be counted and never asked for', () => {
    const text = JSON.stringify(
      apiFollowList([
        apiPerson(friend(1)),
        apiPerson('_renamed-123'),
        apiPerson('bad user'),
        apiPerson('../../evil'),
        apiPerson('a'.repeat(40)),
        apiPerson('evil\u202e'),
        apiPerson(''),
        apiPerson(friend(2)),
      ]),
    )
    expect(parseFollowList(text)).toEqual([friend(1), null, null, null, null, null, null, friend(2)])
  })

  test('takes a full page of 30', () => {
    const page = Array.from({ length: 30 }, (_, i) => friend(i + 1))
    expect(parseFollowList(JSON.stringify(apiFollowList(page.map(name => apiPerson(name)))))).toEqual(page)
  })

  test('is read in time linear in its length', () => {
    // A long body of distinct names fails on its length at once.
    const long = JSON.stringify(apiFollowList(Array.from({ length: 50_000 }, (_, i) => apiPerson(`p${i}`))))
    expect(parseFollowList(long)).toBeUndefined()
  })

  test('is refused for a body that is not JSON', () => {
    expect(parseFollowList('<html>')).toBeUndefined()
    expect(parseFollowList('')).toBeUndefined()
  })

  test('answers by its status number alone, and its Retry-After on a 429', () => {
    const list = JSON.stringify(apiFollowList([apiPerson(friend(1))]))
    expect(readFollowAnswer({ status: 200, headers: {}, text: list })).toEqual({ kind: 'list', usernames: [friend(1)] })
    expect(readFollowAnswer({ status: 200, headers: {}, text: 'nope' })).toEqual({ kind: 'problem', problem: { kind: 'unreadable' } })
    expect(readFollowAnswer({ status: 404, headers: {}, text: list })).toEqual({
      kind: 'problem',
      problem: { kind: 'status', status: 404, retryAfterSeconds: null },
    })
    expect(readFollowAnswer({ status: 429, headers: { 'retry-after': '90' }, text: '' })).toEqual({
      kind: 'problem',
      problem: { kind: 'status', status: 429, retryAfterSeconds: 90 },
    })
    expect(readFollowAnswer({ status: 429, headers: { 'retry-after': 'soon' }, text: '' })).toEqual({
      kind: 'problem',
      problem: { kind: 'status', status: 429, retryAfterSeconds: null },
    })
    expect(readFollowAnswer({ status: 0, headers: {}, text: '' })).toEqual({ kind: 'problem', problem: { kind: 'unreadable' } })
  })
})

describe('a round claim', () => {
  test('starts a round from nothing, keeping no last round', () => {
    expect(startRound({ kind: 'idle' }, USERNAME, 't1', NOW, 'show', 0)).toEqual({
      kind: 'loading',
      username: USERNAME,
      token: 't1',
      startedAtMs: NOW,
      steppedAtMs: NOW,
      last: null,
    })
    expect(startRound({ kind: 'not-set-up' }, USERNAME, 't1', NOW, 'refresh', 0).kind).toBe('loading')
  })

  test('changes nothing while a round is in flight, until it has been still for ROUND_STALE_MS', () => {
    const loading = startRound({ kind: 'idle' }, USERNAME, 't1', NOW, 'show', 0)
    expect(isRoundInFlight(loading, NOW + ROUND_STALE_MS - 1)).toBe(true)
    expect(startRound(loading, USERNAME, 't2', NOW + ROUND_STALE_MS - 1, 'refresh', 0)).toBe(loading)
    expect(isRoundInFlight(loading, NOW + ROUND_STALE_MS)).toBe(false)
    expect(startRound(loading, USERNAME, 't2', NOW + ROUND_STALE_MS, 'refresh', 0)).toMatchObject({ kind: 'loading', token: 't2' })
    // A step moves the still time on.
    const stepped = stepRound(loading, 't1', NOW + 50_000)
    expect(startRound(stepped, USERNAME, 't2', NOW + ROUND_STALE_MS, 'refresh', 0)).toBe(stepped)
  })

  test('within the minute keeps the last round, marking an r so the tab says how long to wait', () => {
    const last = ended(round())
    expect(startRound(last, USERNAME, 't2', NOW + ROUND_MIN_MS - 1, 'show', 0)).toBe(last)
    expect(startRound(last, USERNAME, 't2', NOW + 1000, 'refresh', 0)).toEqual(ended(round(), NOW + ROUND_MIN_MS))
    expect(startRound(last, USERNAME, 't2', NOW + ROUND_MIN_MS, 'show', 0)).toMatchObject({ kind: 'loading', token: 't2', last: round() })
  })

  test('waits while a 429 on any of the pane\'s requests holds it back', () => {
    const held = NOW + 120_000
    expect(startRound({ kind: 'idle' }, USERNAME, 't1', held - 1, 'refresh', held)).toEqual({ kind: 'idle' })
    const last = ended(round())
    expect(startRound(last, USERNAME, 't2', NOW + ROUND_MIN_MS, 'show', held)).toBe(last)
    expect(startRound(last, USERNAME, 't2', NOW + ROUND_MIN_MS, 'refresh', held)).toEqual(ended(round(), held))
    expect(startRound(last, USERNAME, 't2', held, 'show', held).kind).toBe('loading')
  })

  test('drops a round stopped before it asked for anything, back to the round before', () => {
    const fresh = startRound({ kind: 'idle' }, USERNAME, 't1', NOW, 'show', 0)
    expect(dropRound(fresh, 't1')).toEqual({ kind: 'idle' })
    const again = startRound(ended(round()), USERNAME, 't2', NOW + ROUND_MIN_MS, 'show', 0)
    expect(dropRound(again, 't2')).toEqual(ended(round()))
    expect(dropRound(again, 'other')).toBe(again)
  })

  test('waits for the minute whatever username the last round was for', () => {
    const last = ended(round({ username: 'someone-else' }))
    expect(startRound(last, USERNAME, 't2', NOW + 1, 'show', 0)).toBe(last)
  })

  test('steps and ends only the round named by the token', () => {
    const loading = startRound({ kind: 'idle' }, USERNAME, 't1', NOW, 'show', 0)
    expect(stepRound(loading, 'other', NOW + 5)).toBe(loading)
    expect(stepRound(loading, 't1', NOW + 5)).toMatchObject({ steppedAtMs: NOW + 5 })
    expect(endRound(loading, 'other', round())).toBe(loading)
    expect(endRound(loading, 't1', round())).toEqual(ended(round()))
    expect(endRound(ended(round()), 't1', round({ endedAtMs: 1 }))).toEqual(ended(round()))
  })
})

describe('a round', () => {
  test('counts only the top-level commits whose author is the person the list is of', () => {
    const list = [summary(1), summary(2, { username: friend(2) }), summary(3, { parentId: commitId(9) }), summary(4, { username: 'Friend-1' })]
    expect(theirCommits(friend(1), list).map(commit => commit.id)).toEqual([commitId(1)])
  })

  test('merges newest first, each commit once, at most 30', () => {
    const many = Array.from({ length: 40 }, (_, i) => summary(i + 1, { createdAtMs: NOW - ((i * 7) % 40) * 60_000 }))
    const merged = mergeFollowing([...many, summary(1, { body: 'a later copy' })])
    expect(merged).toHaveLength(FOLLOWING_DRAWN_MAX)
    expect(merged.map(commit => commit.createdAtMs)).toEqual([...merged.map(commit => commit.createdAtMs)].sort((a, b) => b - a))
    expect(merged[0]?.createdAtMs).toBe(NOW)
    expect(merged.filter(commit => commit.id === commitId(1))).toHaveLength(1)
    expect(merged.find(commit => commit.id === commitId(1))?.body).toBe('invented commit number 1')
    // The same second goes by id, newest id first.
    expect(mergeFollowing([summary(1, { createdAtMs: NOW }), summary(2, { createdAtMs: NOW })]).map(c => c.id)).toEqual([commitId(2), commitId(1)])
  })

  test('holds the next round back a minute, or longer when a 429 asked', () => {
    const base = { username: USERNAME, startedAtMs: NOW, endedAtMs: NOW + 5000, people: 3, failed: 1, failures: 0, commits: [] }
    expect(listRound({ ...base, cut: undefined }).nextAtMs).toBe(NOW + ROUND_MIN_MS)
    expect(listRound({ ...base, cut: { retryAfterSeconds: 10 } }).nextAtMs).toBe(NOW + ROUND_MIN_MS)
    expect(listRound({ ...base, cut: { retryAfterSeconds: 120 } }).nextAtMs).toBe(NOW + 5000 + 120_000)
    expect(listRound({ ...base, cut: { retryAfterSeconds: undefined } }).outcome).toEqual({
      kind: 'list',
      people: 3,
      failed: 1,
      isCut: true,
      commits: [],
    })
    expect(failedRound(USERNAME, { kind: 'status', status: 429, retryAfterSeconds: 300 }, NOW, NOW + 1000, 0).nextAtMs).toBe(NOW + 301_000)
    expect(failedRound(USERNAME, { kind: 'network' }, NOW, NOW + 1000, 0).nextAtMs).toBe(NOW + ROUND_MIN_MS)
  })

  test('backs off after rounds a 5xx or no answer stopped: doubling from the minute, at most 15 minutes', () => {
    const base = { username: USERNAME, startedAtMs: NOW, endedAtMs: NOW + 5000, people: 3, failed: 3, cut: undefined, commits: [] }
    expect([0, 1, 2, 3, 4, 5, 10].map(failures => listRound({ ...base, failures }).nextAtMs - NOW)).toEqual([
      60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000,
    ])
    expect(failedRound(USERNAME, { kind: 'network' }, NOW, NOW, 2).nextAtMs).toBe(NOW + 240_000)
    expect(listRound({ ...base, failures: 2 }).failures).toBe(2)
    // A Retry-After longer than the back-off still wins.
    expect(listRound({ ...base, failures: 1, cut: { retryAfterSeconds: 600 } }).nextAtMs).toBe(NOW + 5000 + 600_000)
  })

  test('reads the count of failed rounds only when it is a count', () => {
    expect(failuresOf(null)).toBe(0)
    expect(failuresOf(round({ failures: 3 }))).toBe(3)
    const { failures, ...older } = round()
    void failures
    expect(failuresOf({ ...older, failures: Number.NaN })).toBe(0)
    expect(failuresOf({ ...older, failures: -1 })).toBe(0)
  })

  test('tells the failures to back off on from the rest', () => {
    expect(isBackOffProblem({ kind: 'network' })).toBe(true)
    for (const status of [500, 502, 503, 599]) expect(isBackOffProblem({ kind: 'status', status, retryAfterSeconds: null })).toBe(true)
    for (const status of [404, 410, 429, 403]) expect(isBackOffProblem({ kind: 'status', status, retryAfterSeconds: null })).toBe(false)
    expect(isBackOffProblem({ kind: 'unreadable' })).toBe(false)
    expect(isBackOffProblem({ kind: 'local' })).toBe(false)
  })

  test('lends its commits to the completion, and none before it ended or when it failed', () => {
    expect(followingCommitsOf({ kind: 'idle' })).toEqual([])
    expect(followingCommitsOf(ended(round()))).toEqual([summary(1), summary(2)])
    expect(followingCommitsOf({ kind: 'loading', username: USERNAME, token: 't', startedAtMs: NOW, steppedAtMs: NOW, last: round() })).toEqual([
      summary(1),
      summary(2),
    ])
    expect(followingCommitsOf(ended(failedRound(USERNAME, { kind: 'network' }, NOW, NOW, 1)))).toEqual([])
  })
})

describe('the Following view', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`draws each commit with its author and its link, on ${surface}`, () => {
      const view = followingView(ended(round()), NOW, surface)
      const at = surface === 'terminal' ? '@' : '%40'
      expect(view.commits).toEqual([
        {
          id: commitId(1),
          author: friend(1),
          hash: shortHashOf(commitId(1)),
          meta: '1m \u00b7 \u2605 0 \u00b7 \u21b3 0',
          lines: ['invented commit number 1'],
          href: `https://dev-null.sh/${at}${friend(1)}/commits/${commitId(1)}`,
        },
        expect.objectContaining({ id: commitId(2) }),
      ])
      expect(view.freshness).toBe('updated now')
      expect(view.message).toBeUndefined()
      expect(view.notes).toEqual([])
      expect(view.wait).toBeUndefined()
    })
  }

  test('says each state in a fixed text', () => {
    expect(followingView({ kind: 'idle' }, NOW, 'terminal').message).toBe(FOLLOWING_IDLE_TEXT)
    expect(followingView({ kind: 'not-set-up' }, NOW, 'terminal').message).toBe(NOT_SET_UP_TEXT)
    const loading: FollowingState = { kind: 'loading', username: USERNAME, token: 't', startedAtMs: NOW, steppedAtMs: NOW, last: null }
    expect(followingView(loading, NOW, 'terminal')).toMatchObject({ message: FOLLOWING_LOADING_TEXT, freshness: 'loading\u2026' })
    // A reload keeps the last round on screen.
    const reloading = followingView({ ...loading, last: round() }, NOW, 'terminal')
    expect(reloading.message).toBeUndefined()
    expect(reloading.commits).toHaveLength(2)
    const list = (people: number, failed: number, isCut: boolean, commits: CommitSummary[]) =>
      followingView(ended(round({ outcome: { kind: 'list', people, failed, isCut, commits } })), NOW, 'terminal')
    expect(list(0, 0, false, []).message).toBe(FOLLOWING_NOBODY_TEXT)
    expect(list(3, 0, false, []).message).toBe(FOLLOWING_NONE_POSTED_TEXT)
    expect(list(3, 3, false, [])).toMatchObject({ message: undefined, notes: [notLoadedText(3, 3)] })
    expect(list(3, 1, true, [summary(1)])).toMatchObject({ message: undefined, notes: [notLoadedText(1, 3), FOLLOWING_CUT_TEXT] })
    const failed = (problem: Parameters<typeof failedRound>[1]) => followingView(ended(failedRound(USERNAME, problem, NOW, NOW, 0)), NOW, 'terminal')
    expect(failed({ kind: 'status', status: 404, retryAfterSeconds: null })).toMatchObject({
      message: followingStatusText(404),
      isProblem: true,
      notes: [],
      commits: [],
    })
    expect(failed({ kind: 'status', status: 429, retryAfterSeconds: 90 }).notes).toEqual([waitText(90)])
    expect(failed({ kind: 'network' }).message).toBe(NETWORK_TEXT)
    expect(failed({ kind: 'unreadable' }).message).toBe(FOLLOWING_UNREADABLE_TEXT)
    expect(failed({ kind: 'local' }).message).toBe(FOLLOWING_LOCAL_TEXT)
  })

  test('says how long to wait after an r too soon, until the next round is due', () => {
    const asked = ended(round(), NOW + ROUND_MIN_MS)
    expect(followingView(asked, NOW + 1000, 'terminal').wait).toBe(roundWaitText(59))
    expect(followingView(asked, NOW + 59_500, 'terminal').wait).toBe(roundWaitText(1))
    expect(followingView(asked, NOW + ROUND_MIN_MS, 'terminal').wait).toBeUndefined()
    expect(followingView(ended(round()), NOW + 1000, 'terminal').wait).toBeUndefined()
  })

  test('draws no commit whose author fails the username pattern', () => {
    const view = followingView(ended(round({ outcome: { kind: 'list', people: 1, failed: 0, isCut: false, commits: [summary(1, { username: 'bad user' })] } })), NOW, 'terminal')
    expect(view.commits).toEqual([])
  })

  test('caps the round at 20 people', () => {
    expect(FOLLOWED_MAX).toBe(20)
  })
})
