import { describe, expect, test } from 'claude-code/testing'

import {
  SEEN_MAX,
  alertLine,
  commitListUrls,
  dismissAlerts,
  intervalSecondsOf,
  isAlertsOn,
  parseSeen,
  readListResponse,
  reconcile,
  statusText,
  storedSeen,
} from '../hooks/lib/alerts'
import type { SeenReplies } from '../hooks/lib/alerts'
import type { CommitSummary, ReplyAlert } from '../types'
import { USERNAME, apiCommit, apiList, commitId, shortHashOf } from './fixtures/commits'

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0)

function summary(n: number, repliesCount: number): CommitSummary {
  const id = commitId(n)

  return { id, shortHash: shortHashOf(id), body: `body ${n}`, parentId: null, createdAtMs: NOW - n, starsCount: 0, repliesCount, username: USERNAME }
}

function alert(n: number, repliesCount: number, newReplies: number): ReplyAlert {
  const id = commitId(n)

  return { id, shortHash: shortHashOf(id), username: USERNAME, repliesCount, newReplies }
}

type Pair = number | readonly [number, number]

const pairOf = (count: Pair): [number, number] => (typeof count === 'number' ? [count, count] : [count[0], count[1]])

/** A seen record for the invented commits, by number: `[seen, toasted]`, a lone number both. */
const record = (counts: Record<number, Pair>, username = USERNAME): SeenReplies => ({
  username,
  entries: Object.fromEntries(
    Object.entries(counts).map(([n, count]) => {
      const [seen, toasted] = pairOf(count)

      return [commitId(Number(n)), { seen, toasted }]
    }),
  ),
})

/** The same as the store keeps it. */
const stored = (counts: Record<number, Pair>) => ({
  username: USERNAME,
  counts: Object.fromEntries(Object.entries(counts).map(([n, count]) => [commitId(Number(n)), pairOf(count)])),
})

describe('the polled URLs', () => {
  test('are the two public lists of a valid username, on the fixed host', () => {
    expect(commitListUrls('Some-User-1')).toEqual({
      commits: 'https://dev-null.sh/api/v1/users/Some-User-1/commits',
      replies: 'https://dev-null.sh/api/v1/users/Some-User-1/commits?replies=1',
    })
  })

  test('are refused for anything that is not a username', () => {
    for (const username of ['', '../admin', 'a/b', 'a?b', 'x'.repeat(40), 'evil.example', 'a b', 'a\u202e']) {
      expect(commitListUrls(username)).toBeUndefined()
    }
  })
})

describe('the interval setting', () => {
  test('is the number set, and 60 when it is not a number', () => {
    expect(intervalSecondsOf(90)).toBe(90)
    expect(intervalSecondsOf(5)).toBe(5)
    for (const value of [undefined, '90', true, Number.NaN, Number.POSITIVE_INFINITY, ['90']]) {
      expect(intervalSecondsOf(value)).toBe(60)
    }
  })
})

describe('the on/off flag', () => {
  test('is on unless the store holds exactly false', () => {
    expect(isAlertsOn(undefined)).toBe(true)
    expect(isAlertsOn(true)).toBe(true)
    expect(isAlertsOn(false)).toBe(false)
    for (const value of ['false', 0, null, {}]) expect(isAlertsOn(value)).toBe(true)
  })
})

describe('a list response', () => {
  const body = JSON.stringify(apiList([apiCommit(1)]))

  test('gives the commits of a 200 with exactly such a list', () => {
    const result = readListResponse({ status: 200, ok: true, headers: {}, text: body })
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') expect(result.commits.map(commit => commit.id)).toEqual([commitId(1)])
  })

  test('fails on any other status, with the status and Retry-After kept', () => {
    expect(readListResponse({ status: 429, ok: false, headers: { 'retry-after': '120' }, text: body })).toEqual({
      kind: 'failed',
      status: 429,
      retryAfter: '120',
    })
    for (const status of [201, 204, 301, 404, 500, 503]) {
      expect(readListResponse({ status, ok: status < 300, headers: {}, text: body }).kind).toBe('failed')
    }
  })

  test('fails on a 200 that is not exactly a list', () => {
    for (const text of ['', 'null', '{"data":{}}', JSON.stringify(apiList([apiCommit(1), { id: 'x' }]))]) {
      expect(readListResponse({ status: 200, ok: true, headers: {}, text }).kind).toBe('failed')
    }
  })
})

describe('the seen record in the store', () => {
  test('is read back as written', () => {
    const written = record({ 1: 0, 2: [3, 7] })
    expect(storedSeen(written)).toEqual(stored({ 1: [0, 0], 2: [3, 7] }))
    expect(parseSeen(storedSeen(written))).toEqual(written)
  })

  test('keeps the order of its commits', () => {
    // Built from a list: an object literal with number keys would sort them.
    const ids = [commitId(3), commitId(1), commitId(2)]
    const value = { username: USERNAME, counts: Object.fromEntries(ids.map(id => [id, [0, 0]])) }
    expect(Object.keys(parseSeen(value)?.entries ?? {})).toEqual(ids)
  })

  test('is refused unless exactly such a record', () => {
    const id = commitId(1)
    for (const value of [
      undefined,
      null,
      'seen',
      [],
      { username: USERNAME },
      { counts: {} },
      { ...stored({ 1: [1, 1] }), more: true },
      { ...stored({ 1: [1, 1] }), username: 'not a username' },
      { username: USERNAME, counts: { [id]: 1 } },
      { username: USERNAME, counts: { [id]: [1] } },
      { username: USERNAME, counts: { [id]: [1, 1, 1] } },
      { username: USERNAME, counts: { [id]: [1.5, 2] } },
      { username: USERNAME, counts: { [id]: ['1', 1] } },
      { username: USERNAME, counts: { [id]: [1, -1] } },
      { username: USERNAME, counts: { [id]: { seen: 1, toasted: 1 } } },
      { username: USERNAME, counts: { [id.toUpperCase()]: [1, 1] } },
      { username: USERNAME, counts: { [id]: [Number.MAX_SAFE_INTEGER + 1, 0] } },
      { username: USERNAME, counts: [[1, 1]] },
    ]) {
      expect(parseSeen(value)).toBeUndefined()
    }
  })

  test(`holds at most ${SEEN_MAX} commits`, () => {
    const many = Array.from({ length: SEEN_MAX + 1 }, (_, i) => i + 1)
    expect(parseSeen(stored(Object.fromEntries(many.slice(0, SEEN_MAX).map(n => [n, [0, 0]]))))).toBeDefined()
    expect(parseSeen(stored(Object.fromEntries(many.map(n => [n, [0, 0]]))))).toBeUndefined()
  })
})

describe('comparing the counts with the seen record', () => {
  test('takes every count as seen and told on the first poll for an account', () => {
    expect(reconcile(undefined, USERNAME, [summary(1, 4), summary(2, 0)])).toEqual({
      seen: record({ 1: 4, 2: 0 }),
      alerts: [],
      rises: [],
      isChanged: true,
    })
    const other = reconcile(record({ 1: 0, 9: 2 }, 'someone-else'), USERNAME, [summary(1, 4)])
    expect(other.alerts).toEqual([])
    expect(other.seen).toEqual(record({ 1: 4 }))
  })

  test('alerts for each count above its seen value, and toasts once per rise', () => {
    const first = reconcile(record({ 1: 1, 2: 3 }), USERNAME, [summary(1, 4), summary(2, 3)])
    expect(first).toEqual({
      seen: record({ 1: [1, 4], 2: 3 }),
      alerts: [alert(1, 4, 3)],
      rises: [alert(1, 4, 3)],
      isChanged: true,
    })

    // The same counts again, as after a restart or an off and on: the alert
    // stands, the toast is not raised again, and nothing is written.
    const again = reconcile(first.seen, USERNAME, [summary(1, 4), summary(2, 3)])
    expect(again).toEqual({ seen: first.seen, alerts: [alert(1, 4, 3)], rises: [], isChanged: false })

    // Another reply: toasted again.
    expect(reconcile(first.seen, USERNAME, [summary(1, 5), summary(2, 3)]).rises).toEqual([alert(1, 5, 4)])
  })

  test('counts every reply of a commit it has never seen', () => {
    const result = reconcile(record({ 1: 1 }), USERNAME, [summary(2, 2), summary(1, 1)])
    expect(result.alerts).toEqual([alert(2, 2, 2)])
    expect(result.rises).toEqual([alert(2, 2, 2)])
    expect(result.seen).toEqual(record({ 2: [0, 2], 1: 1 }))
  })

  test('lowers both counts when a count fell, so the next reply alerts and toasts', () => {
    const fell = reconcile(record({ 1: [2, 5] }), USERNAME, [summary(1, 1)])
    expect(fell.alerts).toEqual([])
    expect(fell.seen).toEqual(record({ 1: 1 }))
    expect(fell.isChanged).toBe(true)
    expect(reconcile(fell.seen, USERNAME, [summary(1, 2)]).rises).toEqual([alert(1, 2, 1)])
  })

  test('keeps the counts of a commit that left the lists, so it does not alert when it comes back', () => {
    const left = reconcile(record({ 4: 6 }), USERNAME, [summary(2, 0), summary(3, 0)])
    expect(left.seen).toEqual(record({ 2: 0, 3: 0, 4: 6 }))
    expect(Object.keys(left.seen.entries)).toEqual([commitId(2), commitId(3), commitId(4)])

    const back = reconcile(left.seen, USERNAME, [summary(3, 0), summary(4, 6)])
    expect(back.alerts).toEqual([])
    expect(back.rises).toEqual([])
    expect(Object.keys(back.seen.entries)).toEqual([commitId(3), commitId(4), commitId(2)])
  })

  test('takes each commit once, the first time it is listed', () => {
    const result = reconcile(record({ 1: 1 }), USERNAME, [summary(1, 1), summary(1, 9)])
    expect(result.seen).toEqual(record({ 1: 1 }))
    expect(result.isChanged).toBe(false)
  })

  test(`keeps at most ${SEEN_MAX} commits, the listed ones first and the oldest kept ones dropped`, () => {
    const listed = Array.from({ length: SEEN_MAX + 20 }, (_, i) => summary(i + 1, 0))
    const fromLists = reconcile(undefined, USERNAME, listed)
    expect(Object.keys(fromLists.seen.entries)).toHaveLength(SEEN_MAX)
    expect(parseSeen(storedSeen(fromLists.seen))).toEqual(fromLists.seen)

    const kept = record(Object.fromEntries(Array.from({ length: SEEN_MAX }, (_, i) => [i + 1, 0])))
    const carried = reconcile(kept, USERNAME, [summary(200, 0), summary(201, 0)])
    const ids = Object.keys(carried.seen.entries)
    expect(ids).toHaveLength(SEEN_MAX)
    expect(ids.slice(0, 3)).toEqual([commitId(200), commitId(201), commitId(1)])
    expect(ids).not.toContain(commitId(SEEN_MAX))
    expect(ids).not.toContain(commitId(SEEN_MAX - 1))
  })
})

describe('dismissing', () => {
  test('marks each alert seen and told at its count, keeping the rest', () => {
    expect(dismissAlerts(record({ 1: [1, 4], 2: 0 }), [alert(1, 4, 3)])).toEqual(record({ 1: 4, 2: 0 }))
  })

  test('never lowers what was told', () => {
    expect(dismissAlerts(record({ 1: [1, 6] }), [alert(1, 4, 3)])).toEqual(record({ 1: [4, 6] }))
  })
})

describe('toasts', () => {
  test('name the count and the hash, with the noun for one', () => {
    expect(alertLine(alert(1, 3, 3))).toBe(`\u21b3 3 new replies on ${shortHashOf(commitId(1))}`)
    expect(alertLine(alert(1, 3, 1))).toBe(`\u21b3 1 new reply on ${shortHashOf(commitId(1))}`)
  })
})

describe('the status line', () => {
  test('is the total of new replies, cleared at none', () => {
    expect(statusText([alert(1, 3, 2), alert(2, 1, 1)])).toBe('devnull \u21b33')
    expect(statusText([])).toBeUndefined()
  })
})
