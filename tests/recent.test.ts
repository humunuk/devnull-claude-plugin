import { describe, expect, test } from 'claude-code/testing'

import { MATCH_LINE_MAX, RECENT_MAX, matchHashes, mergeRecent } from '../hooks/lib/recent'
import type { CommitSummary, RecentCommits } from '../types'
import { USERNAME, commitId, shortHashOf } from './fixtures/commits'

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0)
const MINUTE = 60_000

/** Invented commit `n`, `n` minutes old. */
function summary(n: number, overrides: Partial<CommitSummary> = {}): CommitSummary {
  const id = commitId(n)

  return {
    id,
    shortHash: shortHashOf(id),
    body: `invented commit number ${n}`,
    parentId: null,
    createdAtMs: NOW - n * MINUTE,
    starsCount: 0,
    repliesCount: 0,
    username: USERNAME,
    ...overrides,
  }
}

const list = (commits: CommitSummary[], fetchedAtMs = NOW, username = USERNAME): RecentCommits => ({
  username,
  fetchedAtMs,
  commits,
})

const ids = (recent: RecentCommits) => recent.commits.map(commit => commit.id)

describe('merging a fetched list', () => {
  test('into nothing gives the list, newest first', () => {
    const merged = mergeRecent(null, list([summary(3), summary(1), summary(2)]))
    expect(ids(merged)).toEqual([commitId(1), commitId(2), commitId(3)])
    expect(merged.username).toBe(USERNAME)
    expect(merged.fetchedAtMs).toBe(NOW)
  })

  test('keeps each commit once, with the counts that arrived last', () => {
    const current = list([summary(1, { repliesCount: 1 }), summary(5)], NOW - MINUTE)
    const incoming = list([summary(1, { repliesCount: 4, starsCount: 2 }), summary(2)])

    const merged = mergeRecent(current, incoming)

    expect(ids(merged)).toEqual([commitId(1), commitId(2), commitId(5)])
    expect(merged.commits[0]?.repliesCount).toBe(4)
    expect(merged.commits[0]?.starsCount).toBe(2)
    expect(merged.fetchedAtMs).toBe(NOW)
  })

  test('drops what was kept for another username', () => {
    const current = list([summary(1), summary(2)], NOW, 'old-name')
    const merged = mergeRecent(current, list([summary(3)]))
    expect(ids(merged)).toEqual([commitId(3)])
    expect(merged.username).toBe(USERNAME)
  })

  test('keeps only commits by the username the list is for', () => {
    const current = list([summary(1), summary(2, { username: 'someone-else' })])
    const incoming = list([summary(3), summary(4, { username: 'Some-User' }), summary(5, { username: 'someone-else' })])
    expect(ids(mergeRecent(current, incoming))).toEqual([commitId(1), commitId(3)])
    expect(ids(mergeRecent(null, incoming))).toEqual([commitId(3)])
  })

  test('orders commits of the same second by id, newest id first', () => {
    const at = NOW - MINUTE
    const merged = mergeRecent(null, list([summary(1, { createdAtMs: at }), summary(2, { createdAtMs: at })]))
    expect(ids(merged)).toEqual([commitId(2), commitId(1)])
  })

  test('keeps the newest 100', () => {
    const many = Array.from({ length: 150 }, (_, index) => summary(index + 1))
    const merged = mergeRecent(list(many.slice(0, 80)), list(many.slice(60)))
    expect(RECENT_MAX).toBe(100)
    expect(merged.commits).toHaveLength(100)
    expect(merged.commits[0]?.id).toBe(commitId(1))
    expect(merged.commits[99]?.id).toBe(commitId(100))
  })
})

describe('hash completion', () => {
  test('lists the hashes that start with what was typed, in any case', () => {
    const letters = summary(2, { id: '0190a1b2-c3d4-7e5f-8a9b-0000abcdef12', shortHash: 'bcdef12' })
    const recent = mergeRecent(null, list([summary(1), letters]))

    expect(matchHashes(recent, 'BCD', NOW).map(row => row.text)).toEqual(['bcdef12'])
    expect(matchHashes(recent, 'bcdef12', NOW).map(row => row.text)).toEqual(['bcdef12'])
    expect(matchHashes(recent, '00000', NOW).map(row => row.text)).toEqual([shortHashOf(commitId(1))])
    expect(matchHashes(recent, 'bcdef123', NOW)).toEqual([])
    expect(matchHashes(recent, 'zz', NOW)).toEqual([])
    expect(matchHashes(null, 'abc', NOW)).toEqual([])
  })

  test('gives the hash, then the first line of the body and its age', () => {
    const recent = mergeRecent(null, list([summary(3, { body: 'first line\nsecond line' })]))
    const hash = shortHashOf(commitId(3))
    expect(matchHashes(recent, hash.slice(0, 3), NOW)).toEqual([
      { text: hash, label: hash, description: 'first line\u2026 \u00b7 3m' },
    ])
  })

  test('offers at most 10, newest first', () => {
    const recent = mergeRecent(null, list(Array.from({ length: 30 }, (_, index) => summary(index + 1))))
    const rows = matchHashes(recent, '0', NOW)
    expect(rows).toHaveLength(10)
    expect(rows[0]?.text).toBe(shortHashOf(commitId(1)))
    expect(rows[9]?.text).toBe(shortHashOf(commitId(10)))
  })

  test('cleans and caps a hostile body, and writes nothing but the hash', () => {
    const body = `\n\n  \u001b]8;;https://evil.example\u0007\u202e${'A'.repeat(200)}\u001b[2J\nsecond`
    const recent = mergeRecent(null, list([summary(1, { body })]))
    const [row] = matchHashes(recent, '0', NOW)
    const description = row?.description ?? ''

    expect(row?.text).toBe(shortHashOf(commitId(1)))
    expect(row?.label).toBe(shortHashOf(commitId(1)))
    expect(description).toBe(`${'A'.repeat(MATCH_LINE_MAX - 1)}\u2026 \u00b7 1m`)
    expect(description).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
  })

  test('skips an entry whose hash is not a valid hash', () => {
    const broken = summary(1, { shortHash: '0000001\n/devnull commit x' })
    const recent: RecentCommits = list([broken, summary(2)])
    expect(matchHashes(recent, '0', NOW).map(row => row.text)).toEqual([shortHashOf(commitId(2))])
  })

  test('shows only the age for a body with no visible text', () => {
    const recent = mergeRecent(null, list([summary(1, { body: '\u202e\u001b[0m' })]))
    expect(matchHashes(recent, '0', NOW)[0]?.description).toBe('1m')
  })
})
