// The public commit list, `GET /api/v1/users/{username}/commits` and the same
// with `?replies=1`: its body is checked field by field and reduced to what the
// mod uses (security rule 5). Pure: the caller fetches it.
//
// Upstream (dev-null-sh/dev-null.sh at 3e55ca6): UserCommitController answers
// a guest with CommitResource items under `data`. `short_hash` is the last 7
// hex characters of the id; `created_at` is `toIso8601ZuluString()`, so
// `YYYY-MM-DDTHH:MM:SSZ`; `parent_id` is the parent's id, or null. Fields the
// mod does not read (`html_url`, `link_preview`, `images`, the rest of
// `author`, `links`, `meta`) are passed over and never copied.

import type { CommitSummary } from '../../types'
import { USERNAME } from './account'
import { UUID } from './links'

export const SHORT_HASH = /^[0-9a-f]{7,12}$/

const ZULU_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/

/** The list in a response body, or undefined when the body is not exactly such a list. */
export function parseCommitList(text: string): CommitSummary[] | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }

  return readCommitList(value)
}

/**
 * The commits in a parsed body, in its order, or undefined when the body or
 * any one item is not what the mod expects: there is no partial list.
 */
export function readCommitList(value: unknown): CommitSummary[] | undefined {
  if (!isRecord(value)) return undefined
  const data: unknown = Reflect.get(value, 'data')
  if (!Array.isArray(data)) return undefined

  const commits: CommitSummary[] = []
  for (const item of data) {
    const commit = readCommit(item)
    if (commit === undefined) return undefined
    commits.push(commit)
  }

  return commits
}

function readCommit(item: unknown): CommitSummary | undefined {
  if (!isRecord(item)) return undefined
  const id: unknown = Reflect.get(item, 'id')
  const shortHash: unknown = Reflect.get(item, 'short_hash')
  const body: unknown = Reflect.get(item, 'body')
  const parentId: unknown = Reflect.get(item, 'parent_id')
  const createdAt: unknown = Reflect.get(item, 'created_at')
  const starsCount: unknown = Reflect.get(item, 'stars_count')
  const repliesCount: unknown = Reflect.get(item, 'replies_count')
  const author: unknown = Reflect.get(item, 'author')
  if (!isRecord(author)) return undefined
  const username: unknown = Reflect.get(author, 'username')

  if (typeof id !== 'string' || !UUID.test(id)) return undefined
  // The hash is what a reply names, so it must be the end of this id.
  if (typeof shortHash !== 'string' || !SHORT_HASH.test(shortHash) || !id.replace(/-/g, '').endsWith(shortHash)) {
    return undefined
  }
  if (typeof body !== 'string') return undefined
  if (parentId !== null && (typeof parentId !== 'string' || !UUID.test(parentId))) return undefined
  if (typeof createdAt !== 'string') return undefined
  const createdAtMs = zuluTimeMs(createdAt)
  if (createdAtMs === undefined) return undefined
  if (!isCount(starsCount) || !isCount(repliesCount)) return undefined
  if (typeof username !== 'string' || !USERNAME.test(username)) return undefined

  return { id, shortHash, body, parentId, createdAtMs, starsCount, repliesCount, username }
}

/** Milliseconds since the epoch of `YYYY-MM-DDTHH:MM:SSZ`, or undefined for any other text or a day that does not exist. */
export function zuluTimeMs(text: string): number | undefined {
  if (!ZULU_TIME.test(text)) return undefined
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) return undefined
  // Date.parse rolls 2026-02-30 over to March; writing it back shows that.
  if (new Date(ms).toISOString() !== text.replace('Z', '.000Z')) return undefined

  return ms
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
