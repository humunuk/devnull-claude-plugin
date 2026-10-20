import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY_TEXT,
  LOADING_TEXT,
  IDLE_TEXT,
  LOAD_STALE_MS,
  PAGE_SIZE,
  commitHref,
  failedLoad,
  finishLoad,
  pageOf,
  paneCommits,
  paneView,
  readCommitsAnswer,
  startLoad,
  userCommitsUrl,
} from '../hooks/lib/pane'
import type { CommitsAnswer, PaneLoad } from '../hooks/lib/pane'
import type { CommitSummary, RecentCommits } from '../types'
import { USERNAME, apiCommit, apiList, commitId, shortHashOf } from './fixtures/commits'

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
    username: USERNAME,
    ...overrides,
  }
}

const recent = (commits: CommitSummary[], username = USERNAME): RecentCommits => ({ username, fetchedAtMs: NOW, commits })

const LOADING: PaneLoad = { kind: 'loading', username: USERNAME, token: 'mine', startedAtMs: NOW, page: [commitId(5)] }

describe('the list request', () => {
  test('names the account on the fixed host, and nothing else', () => {
    expect(userCommitsUrl(USERNAME)).toBe(`https://dev-null.sh/api/v1/users/${USERNAME}/commits`)
    for (const bad of ['', 'a/b', '../x', 'a?b', 'x'.repeat(40), 'evil.example@x']) expect(userCommitsUrl(bad)).toBeUndefined()
  })
})

describe('the list answer', () => {
  test('is a list only for a 200 holding exactly one', () => {
    const answer = readCommitsAnswer({ status: 200, headers: {}, text: JSON.stringify(apiList([apiCommit(1)])) })
    expect(answer.kind).toBe('list')
    expect(readCommitsAnswer({ status: 200, headers: {}, text: 'nope' })).toEqual({ kind: 'problem', problem: { kind: 'unreadable' } })
    expect(readCommitsAnswer({ status: 201, headers: {}, text: JSON.stringify(apiList([])) })).toEqual({
      kind: 'problem',
      problem: { kind: 'status', status: 201, retryAfterSeconds: null },
    })
  })

  test('keeps a 429 Retry-After only as whole seconds', () => {
    expect(readCommitsAnswer({ status: 429, headers: { 'retry-after': '30' }, text: '' })).toEqual({
      kind: 'problem',
      problem: { kind: 'status', status: 429, retryAfterSeconds: 30 },
    })
    for (const value of ['1.5', '-3', 'soon', 'Wed, 21 Oct 2026 07:28:00 GMT', '1234567']) {
      expect(readCommitsAnswer({ status: 429, headers: { 'retry-after': value }, text: '' })).toEqual({
        kind: 'problem',
        problem: { kind: 'status', status: 429, retryAfterSeconds: null },
      })
    }
    // Only a 429 holds the next load back.
    expect(readCommitsAnswer({ status: 503, headers: { 'retry-after': '30' }, text: '' })).toEqual({
      kind: 'problem',
      problem: { kind: 'status', status: 503, retryAfterSeconds: null },
    })
  })

  test('is unreadable with a status no answer has', () => {
    for (const status of [0, 99, 600, 200.5, Number.NaN]) {
      expect(readCommitsAnswer({ status, headers: {}, text: '' })).toEqual({ kind: 'problem', problem: { kind: 'unreadable' } })
    }
  })
})

describe('one load in flight', () => {
  test('starts from any state but a load under 35 s old or a wait dev-null.sh asked for', () => {
    expect(startLoad({ kind: 'idle' }, USERNAME, 't', NOW)).toEqual({
      kind: 'loading',
      username: USERNAME,
      token: 't',
      startedAtMs: NOW,
      page: [],
    })
    expect(startLoad({ kind: 'not-set-up' }, USERNAME, 't', NOW).kind).toBe('loading')
    expect(startLoad({ kind: 'ready', username: USERNAME, page: [] }, USERNAME, 't', NOW).kind).toBe('loading')

    expect(startLoad(LOADING, USERNAME, 't', NOW + LOAD_STALE_MS - 1)).toBe(LOADING)
    expect(startLoad(LOADING, USERNAME, 't', NOW + LOAD_STALE_MS)).toMatchObject({ token: 't' })
    // A load that seems to start in the future (a clock set back) is let go.
    expect(startLoad(LOADING, USERNAME, 't', NOW - 1)).toMatchObject({ token: 't' })

    const held = failedLoad(USERNAME, { kind: 'status', status: 429, retryAfterSeconds: 60 }, NOW, [])
    expect(held).toMatchObject({ retryAtMs: NOW + 60_000 })
    expect(startLoad(held, USERNAME, 't', NOW + 59_999)).toBe(held)
    expect(startLoad(held, USERNAME, 't', NOW + 60_000).kind).toBe('loading')
    expect(startLoad(failedLoad(USERNAME, { kind: 'network' }, NOW, []), USERNAME, 't', NOW).kind).toBe('loading')
  })

  test('carries the page drawn into the next load, for the same username only', () => {
    const ready: PaneLoad = { kind: 'ready', username: USERNAME, page: [commitId(2), commitId(1)] }
    expect(startLoad(ready, USERNAME, 't', NOW)).toMatchObject({ page: [commitId(2), commitId(1)] })
    expect(startLoad(ready, 'someone-else', 't', NOW)).toMatchObject({ username: 'someone-else', page: [] })
    expect(pageOf({ kind: 'idle' }, USERNAME)).toEqual([])
    expect(pageOf(ready, null)).toEqual([])
  })

  test('ends only the load it names, a list becoming the page drawn', () => {
    const list: CommitsAnswer = { kind: 'list', commits: [summary(2), summary(1)] }
    expect(finishLoad(LOADING, 'mine', list, NOW)).toEqual({ kind: 'ready', username: USERNAME, page: [commitId(2), commitId(1)] })
    expect(finishLoad(LOADING, 'other', list, NOW)).toBe(LOADING)
    const ready: PaneLoad = { kind: 'ready', username: USERNAME, page: [] }
    expect(finishLoad(ready, 'mine', list, NOW)).toBe(ready)
    expect(finishLoad(LOADING, 'mine', { kind: 'problem', problem: { kind: 'network' } }, NOW)).toEqual({
      kind: 'failed',
      username: USERNAME,
      page: [commitId(5)],
      problem: { kind: 'network' },
      retryAtMs: null,
    })
  })
})

describe('the commits drawn', () => {
  test('are those of the page last fetched, in its order, with the counts the list holds', () => {
    const kept = recent([summary(1, { repliesCount: 9 }), summary(2), summary(3)])
    const drawn = paneCommits(kept, [commitId(3), commitId(1)], NOW)
    expect(drawn.map(commit => commit.id)).toEqual([commitId(3), commitId(1)])
    expect(drawn[1]).toEqual({
      id: commitId(1),
      hash: shortHashOf(commitId(1)),
      meta: '1m \u00b7 \u2605 0 \u00b7 \u21b3 9',
      lines: ['invented commit number 1'],
      href: `https://dev-null.sh/%40${USERNAME}/commits/${commitId(1)}`,
    })
    // A page id the list no longer holds is passed over.
    expect(paneCommits(kept, [commitId(7), commitId(2)], NOW).map(commit => commit.id)).toEqual([commitId(2)])
    expect(paneCommits(kept, [], NOW)).toEqual([])
  })

  test('leave out replies and other authors, and hold one page', () => {
    const many = Array.from({ length: 30 }, (_, i) => summary(10 + i))
    const commits = [summary(1), summary(2, { parentId: commitId(1) }), summary(3, { username: 'someone-else' }), ...many]
    const page = commits.map(commit => commit.id)
    const drawn = paneCommits(recent(commits), page, NOW)
    expect(drawn).toHaveLength(PAGE_SIZE)
    expect(drawn.map(commit => commit.id)).not.toContain(commitId(2))
    expect(drawn.map(commit => commit.id)).not.toContain(commitId(3))
  })

  test('get no link when the id or the username fails its pattern', () => {
    expect(commitHref('bad user', commitId(1))).toBeUndefined()
    expect(commitHref(USERNAME, 'not-a-uuid')).toBeUndefined()
    expect(commitHref(USERNAME, commitId(1).toUpperCase())).toBeUndefined()
    const drawn = paneCommits(recent([summary(1, { username: 'bad user' })], 'bad user'), [commitId(1)], NOW)
    expect(drawn[0]?.href).toBeUndefined()
  })

  test('show at most three cleaned lines, the last cut with an ellipsis', () => {
    const body = ['one', '', '\u001b[31mthree\u001b[0m\u202e', 'four'].join('\r\n')
    expect(paneCommits(recent([summary(1, { body })]), [commitId(1)], NOW)[0]?.lines).toEqual(['one', '', 'three\u2026'])
  })
})

describe('the pane view', () => {
  test('says what each state needs saying', () => {
    expect(paneView({ kind: 'idle' }, null, NOW)).toEqual({ title: '/dev/null', freshness: '', message: IDLE_TEXT, hint: undefined, commits: [] })
    expect(paneView({ kind: 'ready', username: USERNAME, page: [] }, recent([summary(1)]), NOW)).toEqual({
      title: `/dev/null \u00b7 @${USERNAME}`,
      freshness: 'updated now',
      message: EMPTY_TEXT,
      hint: undefined,
      commits: [],
    })
    // Replies alone leave the pane empty.
    const replyOnly = recent([summary(2, { parentId: commitId(1) })])
    expect(paneView({ kind: 'ready', username: USERNAME, page: [commitId(2)] }, replyOnly, NOW).message).toBe(EMPTY_TEXT)
    // A load with nothing drawn yet says it is loading; with a page, it shows the page.
    expect(paneView({ ...LOADING, page: [] }, recent([summary(1)]), NOW).message).toBe(LOADING_TEXT)
    expect(paneView({ ...LOADING, page: [commitId(1)] }, recent([summary(1)]), NOW).message).toBeUndefined()
  })
})
