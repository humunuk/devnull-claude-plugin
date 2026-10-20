import { describe, expect, test } from 'claude-code/testing'

import {
  EMPTY_TEXT,
  LOADING_TEXT,
  IDLE_TEXT,
  LOAD_STALE_MS,
  NO_POST,
  PAGE_SIZE,
  POST_STALE_MS,
  STALE_POST_TEXT,
  dropLoad,
  failedLoad,
  fetchedAtOf,
  finishLoad,
  finishPost,
  isSending,
  newReplyRows,
  pageOf,
  paneCommits,
  paneView,
  postView,
  readCommitsAnswer,
  refusePost,
  startLoad,
  startPost,
  userCommitsUrl,
} from '../hooks/lib/pane'
import type { CommitsAnswer, PaneLoad, PanePost } from '../hooks/lib/pane'
import type { CommitSummary, RecentCommits, ReplyAlert } from '../types'
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

const LOADING: PaneLoad = {
  kind: 'loading',
  username: USERNAME,
  token: 'mine',
  startedAtMs: NOW,
  page: [commitId(5)],
  fetchedAtMs: NOW - 60_000,
}

const alert = (n: number, newReplies: number, username = USERNAME): ReplyAlert => ({
  id: commitId(n),
  shortHash: shortHashOf(commitId(n)),
  username,
  repliesCount: newReplies,
  newReplies,
})

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
      fetchedAtMs: null,
    })
    expect(startLoad({ kind: 'not-set-up' }, USERNAME, 't', NOW).kind).toBe('loading')
    expect(startLoad({ kind: 'ready', username: USERNAME, page: [], fetchedAtMs: NOW }, USERNAME, 't', NOW).kind).toBe('loading')

    expect(startLoad(LOADING, USERNAME, 't', NOW + LOAD_STALE_MS - 1)).toBe(LOADING)
    expect(startLoad(LOADING, USERNAME, 't', NOW + LOAD_STALE_MS)).toMatchObject({ token: 't' })
    // A load that seems to start in the future (a clock set back) is let go.
    expect(startLoad(LOADING, USERNAME, 't', NOW - 1)).toMatchObject({ token: 't' })

    const held = failedLoad(USERNAME, { kind: 'status', status: 429, retryAfterSeconds: 60 }, NOW, [], null)
    expect(held).toMatchObject({ retryAtMs: NOW + 60_000 })
    expect(startLoad(held, USERNAME, 't', NOW + 59_999)).toBe(held)
    expect(startLoad(held, USERNAME, 't', NOW + 60_000).kind).toBe('loading')
    expect(startLoad(failedLoad(USERNAME, { kind: 'network' }, NOW, [], null), USERNAME, 't', NOW).kind).toBe('loading')
  })

  test('carries the page drawn and when it came into the next load, for the same username only', () => {
    const ready: PaneLoad = { kind: 'ready', username: USERNAME, page: [commitId(2), commitId(1)], fetchedAtMs: NOW - 5 }
    expect(startLoad(ready, USERNAME, 't', NOW)).toMatchObject({ page: [commitId(2), commitId(1)], fetchedAtMs: NOW - 5 })
    expect(startLoad(ready, 'someone-else', 't', NOW)).toMatchObject({ username: 'someone-else', page: [], fetchedAtMs: null })
    expect(pageOf({ kind: 'idle' }, USERNAME)).toEqual([])
    expect(pageOf(ready, null)).toEqual([])
    expect(fetchedAtOf({ kind: 'not-set-up' }, USERNAME)).toBeNull()
    expect(fetchedAtOf(ready, USERNAME)).toBe(NOW - 5)
    expect(fetchedAtOf(ready, 'someone-else')).toBeNull()
  })

  test('ends only the load it names, a list becoming the page drawn as of then', () => {
    const list: CommitsAnswer = { kind: 'list', commits: [summary(2), summary(1)] }
    expect(finishLoad(LOADING, 'mine', list, NOW + 7)).toEqual({
      kind: 'ready',
      username: USERNAME,
      page: [commitId(2), commitId(1)],
      fetchedAtMs: NOW + 7,
    })
    expect(finishLoad(LOADING, 'other', list, NOW)).toBe(LOADING)
    const ready: PaneLoad = { kind: 'ready', username: USERNAME, page: [], fetchedAtMs: NOW }
    expect(finishLoad(ready, 'mine', list, NOW)).toBe(ready)
    // A failure keeps the page drawn and when it came.
    expect(finishLoad(LOADING, 'mine', { kind: 'problem', problem: { kind: 'network' } }, NOW)).toEqual({
      kind: 'failed',
      username: USERNAME,
      page: [commitId(5)],
      fetchedAtMs: NOW - 60_000,
      problem: { kind: 'network' },
      retryAtMs: null,
    })
  })
})

describe('the commits drawn', () => {
  test('are those of the page last fetched, in its order, with the counts the list holds', () => {
    const kept = recent([summary(1, { repliesCount: 9 }), summary(2), summary(3)])
    const drawn = paneCommits(kept, [commitId(3), commitId(1)], [], NOW, 'terminal')
    expect(drawn.map(commit => commit.id)).toEqual([commitId(3), commitId(1)])
    expect(drawn[1]).toEqual({
      id: commitId(1),
      hash: shortHashOf(commitId(1)),
      meta: '1m \u00b7 \u2605 0 \u00b7 \u21b3 9',
      newReplies: 0,
      lines: ['invented commit number 1'],
      href: `https://dev-null.sh/@${USERNAME}/commits/${commitId(1)}`,
    })
    // A page id the list no longer holds is passed over.
    expect(paneCommits(kept, [commitId(7), commitId(2)], [], NOW, 'terminal').map(commit => commit.id)).toEqual([commitId(2)])
    expect(paneCommits(kept, [], [], NOW, 'terminal')).toEqual([])
  })

  test('link each commit as its surface takes it: the raw @ on the terminal alone', () => {
    const kept = recent([summary(1)])
    expect(paneCommits(kept, [commitId(1)], [], NOW, 'terminal')[0]?.href).toBe(`https://dev-null.sh/@${USERNAME}/commits/${commitId(1)}`)
    for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
      expect(paneCommits(kept, [commitId(1)], [], NOW, surface)[0]?.href).toBe(`https://dev-null.sh/%40${USERNAME}/commits/${commitId(1)}`)
    }
  })

  test('carry the new replies the alerts hold for them, for the list username only', () => {
    const kept = recent([summary(1), summary(2), summary(3)])
    const alerts = [alert(1, 2), alert(2, 5, 'someone-else'), alert(9, 1)]
    const drawn = paneCommits(kept, [commitId(1), commitId(2), commitId(3)], alerts, NOW, 'terminal')
    expect(drawn.map(commit => commit.newReplies)).toEqual([2, 0, 0])
  })

  test('add up a mark held since the pane opened and an alert that came since, on one commit', () => {
    const kept = recent([summary(1), summary(2)])
    const held = [alert(1, 2), alert(2, 1)]
    const since = [alert(1, 3)]
    const drawn = paneCommits(kept, [commitId(1), commitId(2)], [...held, ...since], NOW, 'terminal')
    expect(drawn.map(commit => commit.newReplies)).toEqual([5, 1])
  })

  test('leave out replies and other authors, and hold one page', () => {
    const many = Array.from({ length: 30 }, (_, i) => summary(10 + i))
    const commits = [summary(1), summary(2, { parentId: commitId(1) }), summary(3, { username: 'someone-else' }), ...many]
    const page = commits.map(commit => commit.id)
    const drawn = paneCommits(recent(commits), page, [], NOW, 'terminal')
    expect(drawn).toHaveLength(PAGE_SIZE)
    expect(drawn.map(commit => commit.id)).not.toContain(commitId(2))
    expect(drawn.map(commit => commit.id)).not.toContain(commitId(3))
  })

  test('get no link when the id or the username fails its pattern', () => {
    for (const surface of ['terminal', 'desktop'] as const) {
      const drawn = paneCommits(recent([summary(1, { username: 'bad user' })], 'bad user'), [commitId(1)], [], NOW, surface)
      expect(drawn[0]?.href).toBeUndefined()
    }
  })

  test('show at most three cleaned lines, the last cut with an ellipsis', () => {
    const body = ['one', '', '\u001b[31mthree\u001b[0m\u202e', 'four'].join('\r\n')
    expect(paneCommits(recent([summary(1, { body })]), [commitId(1)], [], NOW, 'terminal')[0]?.lines).toEqual(['one', '', 'three\u2026'])
  })
})

describe('the New replies rows', () => {
  const kept = recent([
    summary(1),
    summary(2, { parentId: commitId(1), body: '\u001b[31mmy\u202e reply\nsecond line' }),
    summary(3, { parentId: commitId(1) }),
    summary(4, { parentId: commitId(1), username: 'someone-else' }),
  ])

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`hold the person's own replies only, added up, cleaned to one line, on ${surface}`, () => {
      // 1 is a top-level commit, 4 is not theirs, 9 is not in the list.
      const rows = newReplyRows(kept, [alert(1, 1), alert(2, 2), alert(4, 1), alert(9, 1), alert(2, 1), alert(3, 1, 'someone-else')], surface)
      const at = surface === 'terminal' ? '@' : '%40'
      expect(rows).toEqual([
        {
          id: commitId(2),
          hash: shortHashOf(commitId(2)),
          line: 'my reply\u2026',
          newReplies: 3,
          href: `https://dev-null.sh/${at}${USERNAME}/commits/${commitId(2)}`,
        },
      ])
    })
  }

  test('are none with no alerts', () => {
    expect(newReplyRows(kept, [], 'terminal')).toEqual([])
  })
})

describe('a load the pane stopped', () => {
  test('gives up its claim: the page before it is ready again, or nothing', () => {
    expect(dropLoad(LOADING, 'mine')).toEqual({ kind: 'ready', username: USERNAME, page: [commitId(5)], fetchedAtMs: NOW - 60_000 })
    expect(dropLoad({ ...LOADING, page: [], fetchedAtMs: null }, 'mine')).toEqual({ kind: 'idle' })
  })

  test("changes nothing for another load's claim", () => {
    expect(dropLoad(LOADING, 'other')).toBe(LOADING)
    const ready: PaneLoad = { kind: 'ready', username: USERNAME, page: [], fetchedAtMs: NOW }
    expect(dropLoad(ready, 'mine')).toBe(ready)
  })
})

describe('the pane view', () => {
  test('says what each state needs saying', () => {
    expect(paneView({ kind: 'idle' }, null, [], NOW, 'terminal')).toEqual({
      title: '/dev/null',
      freshness: '',
      message: IDLE_TEXT,
      hint: undefined,
      newReplies: [],
      commits: [],
    })
    expect(paneView({ kind: 'ready', username: USERNAME, page: [], fetchedAtMs: NOW }, recent([summary(1)]), [], NOW, 'terminal')).toEqual({
      title: `/dev/null \u00b7 @${USERNAME}`,
      freshness: 'updated now',
      message: EMPTY_TEXT,
      hint: undefined,
      newReplies: [],
      commits: [],
    })
    // Replies alone leave the pane empty.
    const replyOnly = recent([summary(2, { parentId: commitId(1) })])
    expect(paneView({ kind: 'ready', username: USERNAME, page: [commitId(2)], fetchedAtMs: NOW }, replyOnly, [], NOW, 'terminal').message).toBe(EMPTY_TEXT)
    // A load with nothing drawn yet says it is loading; with a page, it shows the page.
    expect(paneView({ ...LOADING, page: [] }, recent([summary(1)]), [], NOW, 'terminal').message).toBe(LOADING_TEXT)
    expect(paneView({ ...LOADING, page: [commitId(1)] }, recent([summary(1)]), [], NOW, 'terminal').message).toBeUndefined()
  })

  test('dates "updated" by the load\'s own last page, not the recent list the alerts move', () => {
    // The alerts kept a list a minute ago; the pane's own page is an hour old.
    const kept: RecentCommits = { username: USERNAME, fetchedAtMs: NOW - 60_000, commits: [summary(1)] }
    const ready: PaneLoad = { kind: 'ready', username: USERNAME, page: [commitId(1)], fetchedAtMs: NOW - 3_600_000 }
    expect(paneView(ready, kept, [], NOW, 'terminal').freshness).toBe('updated 1h')
    const failed = failedLoad(USERNAME, { kind: 'network' }, NOW, [commitId(1)], NOW - 3_600_000)
    expect(paneView(failed, kept, [], NOW, 'terminal').freshness).toBe('updated 1h')
    expect(paneView(failedLoad(USERNAME, { kind: 'network' }, NOW, [], null), kept, [], NOW, 'terminal').freshness).toBe('')
    expect(paneView(LOADING, kept, [], NOW, 'terminal').freshness).toBe('loading\u2026')
  })
})

const RESULT_OK = { committed: { username: USERNAME, id: commitId(1) }, lines: [] }
const RESULT_REFUSED = { committed: null, lines: ['refused, first line\nsecond line'] }

describe('the input\'s one post in flight', () => {
  test('starts a post from a new field, or none while one is in flight and not stale', () => {
    const started = startPost(NO_POST, 't', 'hello', NOW)
    expect(started).toEqual({ round: 1, draft: 'hello', sending: { token: 't', startedAtMs: NOW }, outcome: null })
    expect(isSending(started, NOW + POST_STALE_MS - 1)).toBe(true)
    expect(startPost(started, 'u', 'again', NOW + POST_STALE_MS - 1)).toBe(started)
    expect(refusePost(started, 'x', ['no'], NOW)).toBe(started)
    // One that never reported back is let go.
    expect(isSending(started, NOW + POST_STALE_MS)).toBe(false)
    expect(startPost(started, 'u', 'again', NOW + POST_STALE_MS)).toMatchObject({ round: 2, sending: { token: 'u' } })
    // A clock set back does not hold the input forever.
    expect(isSending(started, NOW - 1)).toBe(false)
  })

  test('ends only the post it names: the draft cleared when it went through, kept when not', () => {
    const started = startPost(NO_POST, 't', 'hello', NOW)
    expect(finishPost(started, 'other', RESULT_OK)).toBe(started)
    expect(finishPost(NO_POST, 't', RESULT_OK)).toBe(NO_POST)
    expect(finishPost(started, 't', RESULT_OK)).toEqual({ round: 2, draft: '', sending: null, outcome: RESULT_OK })
    expect(finishPost(started, 't', RESULT_REFUSED)).toEqual({ round: 2, draft: 'hello', sending: null, outcome: RESULT_REFUSED })
  })

  test('a refusal draws a new field holding the draft', () => {
    const refused = refusePost(NO_POST, 'too long', ['no'], NOW)
    expect(refused).toEqual({ round: 1, draft: 'too long', sending: null, outcome: { committed: null, lines: ['no'] } })
  })

  test('an outcome stays until the next submit, which replaces it', () => {
    const ended = finishPost(startPost(NO_POST, 't', 'hello', NOW), 't', RESULT_REFUSED)
    expect(startPost(ended, 'u', 'hello', NOW)).toMatchObject({ outcome: null, sending: { token: 'u' } })
    expect(refusePost(ended, '', ['empty'], NOW)).toMatchObject({ outcome: { committed: null, lines: ['empty'] } })
  })
})

describe('the input drawn', () => {
  const posted = (result: { committed: { username: string; id: string } | null; lines: string[] }): PanePost =>
    finishPost(startPost(NO_POST, 't', 'hello', NOW), 't', result)

  test('is no field while a post is in flight', () => {
    expect(postView(startPost(NO_POST, 't', 'hello', NOW), NOW, 'terminal')).toEqual({ kind: 'sending' })
  })

  test('is a field with no lines before any submit', () => {
    expect(postView(NO_POST, NOW, 'terminal')).toEqual({
      kind: 'field',
      key: 'commit-0',
      draft: '',
      committed: undefined,
      lines: [],
      isProblem: false,
    })
  })

  test('links the commit that went through as the surface takes it', () => {
    expect(postView(posted(RESULT_OK), NOW, 'terminal')).toMatchObject({
      key: 'commit-2',
      draft: '',
      committed: { href: `https://dev-null.sh/@${USERNAME}/commits/${commitId(1)}` },
      isProblem: false,
    })
    expect(postView(posted(RESULT_OK), NOW, 'desktop')).toMatchObject({
      committed: { href: `https://dev-null.sh/%40${USERNAME}/commits/${commitId(1)}` },
    })
    // Parts that fail the patterns get no link (only the mod writes them; this shows the drawing holds).
    expect(postView(posted({ committed: { username: 'bad user', id: commitId(1) }, lines: [] }), NOW, 'terminal')).toMatchObject({
      committed: { href: undefined },
    })
  })

  test('says why a submit did not post, a line a row, and keeps the draft', () => {
    expect(postView(posted(RESULT_REFUSED), NOW, 'terminal')).toEqual({
      kind: 'field',
      key: 'commit-2',
      draft: 'hello',
      committed: undefined,
      lines: ['refused, first line', 'second line'],
      isProblem: true,
    })
  })

  test('says a post that never reported back may have gone through, and gives the field back', () => {
    const lost = startPost(NO_POST, 't', 'hello', NOW)
    expect(postView(lost, NOW + POST_STALE_MS, 'terminal')).toEqual({
      kind: 'field',
      key: 'commit-1',
      draft: 'hello',
      committed: undefined,
      lines: [STALE_POST_TEXT],
      isProblem: true,
    })
  })
})
