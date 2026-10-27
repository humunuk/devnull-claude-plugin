import { describe, expect, test } from 'claude-code/testing'

import { parseCommitList, readCommitList, zuluTimeMs } from '../hooks/lib/commits'
import { USERNAME, apiCommit, apiList, commitId, shortHashOf } from './fixtures/commits'

const json = (value: unknown) => JSON.stringify(value)

// An id whose hash has letters, to show case matters.
const LETTER_ID = '0190a1b2-c3d4-7e5f-8a9b-0000abcdef12'

describe('the commit list', () => {
  test('keeps only the fields the mod uses, in the order sent', () => {
    const reply = apiCommit(2, {
      parent_id: commitId(1),
      created_at: '2026-10-20T10:04:18Z',
      stars_count: 0,
      replies_count: 0,
      link_preview: { url: 'https://example.invalid' },
      images: [{ url: 'https://example.invalid/a.png' }],
    })

    expect(parseCommitList(json(apiList([apiCommit(1), reply])))).toEqual([
      {
        id: commitId(1),
        shortHash: shortHashOf(commitId(1)),
        body: 'invented commit number 1',
        parentId: null,
        createdAtMs: Date.UTC(2026, 9, 20, 6, 0, 4),
        starsCount: 3,
        repliesCount: 1,
        username: USERNAME,
      },
      {
        id: commitId(2),
        shortHash: shortHashOf(commitId(2)),
        body: 'invented commit number 2',
        parentId: commitId(1),
        createdAtMs: Date.UTC(2026, 9, 20, 10, 4, 18),
        starsCount: 0,
        repliesCount: 0,
        username: USERNAME,
      },
    ])
  })

  test('reads an empty page', () => {
    expect(parseCommitList(json(apiList([])))).toEqual([])
    expect(parseCommitList('{"data":[]}')).toEqual([])
  })

  test('takes a hash of up to 12 characters when it ends the id', () => {
    expect(parseCommitList(json(apiList([apiCommit(1, { id: LETTER_ID, short_hash: 'bcdef12' })])))?.[0]?.shortHash).toBe('bcdef12')
    const id = commitId(42)
    const long = id.replace(/-/g, '').slice(-12)
    expect(parseCommitList(json(apiList([apiCommit(42, { short_hash: long })])))?.[0]?.shortHash).toBe(long)
  })

  test('keeps a hostile body as it came: it is cleaned where it is drawn', () => {
    const body = '\u001b]8;;https://evil.example\u0007click\u001b]8;;\u0007 \u202egnp.exe \u0000'
    expect(parseCommitList(json(apiList([apiCommit(1, { body })])))?.[0]?.body).toBe(body)
  })

  test('is refused whole when one item is wrong', () => {
    const author = apiCommit(1)['author']
    const withAuthor = (fields: Record<string, unknown>) => ({ author: { ...(typeof author === 'object' ? author : {}), ...fields } })
    const withoutField = (field: string) => {
      const item = apiCommit(1)
      delete item[field]

      return item
    }

    const badItems: unknown[] = [
      null,
      'commit',
      [apiCommit(1)],
      apiCommit(1, { id: commitId(1).toUpperCase(), short_hash: shortHashOf(commitId(1)).toUpperCase() }),
      apiCommit(1, { id: commitId(1).toUpperCase() }),
      apiCommit(1, { id: `${commitId(1)}\u0000` }),
      apiCommit(1, { id: 42 }),
      apiCommit(1, { short_hash: 'abcdef' }),
      apiCommit(1, { short_hash: '0000000000001' }),
      apiCommit(1, { id: LETTER_ID, short_hash: 'BCDEF12' }),
      apiCommit(1, { short_hash: 'abcdef1' }),
      apiCommit(1, { short_hash: `${shortHashOf(commitId(1))}\u202e` }),
      apiCommit(1, { body: null }),
      apiCommit(1, { body: 42 }),
      apiCommit(1, { parent_id: '' }),
      apiCommit(1, { parent_id: 'not-a-uuid' }),
      apiCommit(1, { parent_id: commitId(2).toUpperCase() }),
      apiCommit(1, { created_at: '2026-10-20T06:00:04.000000Z' }),
      apiCommit(1, { created_at: '2026-10-20T06:00:04+00:00' }),
      apiCommit(1, { created_at: '2026-10-20 06:00:04' }),
      apiCommit(1, { created_at: '2026-02-30T06:00:04Z' }),
      apiCommit(1, { created_at: 1792490914 }),
      apiCommit(1, { stars_count: -1 }),
      apiCommit(1, { stars_count: 1.5 }),
      apiCommit(1, { stars_count: '3' }),
      apiCommit(1, { replies_count: -3 }),
      apiCommit(1, { replies_count: null }),
      apiCommit(1, { replies_count: 2 ** 60 }),
      apiCommit(1, { author: null }),
      apiCommit(1, { author: 'some-user' }),
      apiCommit(1, withAuthor({ handle: 'some user' })),
      apiCommit(1, withAuthor({ handle: 'some\u202euser' })),
      apiCommit(1, withAuthor({ handle: '\u001b[31msome-user' })),
      apiCommit(1, withAuthor({ handle: 'x'.repeat(40) })),
      apiCommit(1, withAuthor({ handle: undefined })),
      apiCommit(1, withAuthor({ handle: 7 })),
      withoutField('id'),
      withoutField('short_hash'),
      withoutField('body'),
      withoutField('parent_id'),
      withoutField('created_at'),
      withoutField('stars_count'),
      withoutField('replies_count'),
      withoutField('author'),
    ]

    for (const bad of badItems) {
      expect(parseCommitList(json(apiList([apiCommit(2), bad])))).toBeUndefined()
      expect(readCommitList(apiList([bad]))).toBeUndefined()
    }
  })

  test('is refused when an author names itself under `username` and not `handle`, the field upstream #1179 removed', () => {
    const author = apiCommit(1)['author']
    // JSON leaves the undefined `handle` out, as the old answer had none.
    const oldAuthor = apiCommit(1, { author: { ...(typeof author === 'object' ? author : {}), handle: undefined, username: USERNAME } })

    expect(json(oldAuthor)).not.toContain('"handle"')
    expect(parseCommitList(json(apiList([oldAuthor])))).toBeUndefined()
    expect(readCommitList(apiList([oldAuthor]))).toBeUndefined()
    expect(parseCommitList(json(apiList([apiCommit(2), oldAuthor])))).toBeUndefined()
    // Both fields, `handle` valid: `handle` alone is read.
    expect(parseCommitList(json(apiList([apiCommit(1, { author: { handle: USERNAME, username: 'other user' } })])))?.[0]?.username).toBe(USERNAME)
  })

  test('is refused when the body is not a list', () => {
    for (const text of ['', 'not json', '<html>maintenance</html>', 'null', '[]', '{}', '{"data":{}}', '{"data":null}', '"data"']) {
      expect(parseCommitList(text)).toBeUndefined()
    }
  })
})

describe('timestamps', () => {
  test('are read only in the exact form the API writes', () => {
    expect(zuluTimeMs('2026-10-20T06:00:04Z')).toBe(Date.UTC(2026, 9, 20, 6, 0, 4))
    expect(zuluTimeMs('2024-02-29T23:59:59Z')).toBe(Date.UTC(2024, 1, 29, 23, 59, 59))
    for (const bad of ['2026-13-01T00:00:00Z', '2025-02-29T00:00:00Z', '2026-10-20T24:00:00Z', '2026-10-20T06:00:04z', '2026-10-20T06:00:04Z ', '+02026-10-20T06:00:04Z']) {
      expect(zuluTimeMs(bad)).toBeUndefined()
    }
  })
})
