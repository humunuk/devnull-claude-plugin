// The session's list of the person's own recent commits and replies: merging
// a fetched list into it, and the hash completion of `/devnull reply` read
// from it. Pure: hooks/recent.ts keeps the list in `$.state`.

import type { PromptAutocompleteSuggestion } from 'claude-code'

import type { CommitSummary, RecentCommits } from '../../types'
import { SHORT_HASH } from './commits'
import { BODY_MAX } from './payload'
import { cleanBody, cleanLine, relativeAge } from './text'

export const RECENT_MAX = 100

export const MATCH_MAX = 10

/** How much of a commit's first line a completion row shows. */
export const MATCH_LINE_MAX = 50

/**
 * The list after `incoming` arrived: each commit once by id (the incoming copy,
 * with its newer counts, wins), newest first, at most 100. A list for another
 * username replaces the current one instead of joining it, and only commits
 * whose author is the incoming username are kept, from either list.
 */
export function mergeRecent(current: RecentCommits | null, incoming: RecentCommits): RecentCommits {
  const { username } = incoming
  const byId = new Map<string, CommitSummary>()
  const add = (commit: CommitSummary) => {
    if (commit.username === username) byId.set(commit.id, commit)
  }
  if (current !== null && current.username === username) current.commits.forEach(add)
  incoming.commits.forEach(add)

  const commits = [...byId.values()].sort(newestFirst).slice(0, RECENT_MAX)

  return { username, fetchedAtMs: incoming.fetchedAtMs, commits }
}

// Newest first; the same second goes by id, as dev-null.sh orders its lists
// (its ids are UUIDv7, which sort by time).
function newestFirst(a: CommitSummary, b: CommitSummary): number {
  if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs
  if (a.id === b.id) return 0

  return a.id < b.id ? 1 : -1
}

/**
 * Completion rows for the hashes in the list that start with `prefix` (any
 * case), newest first, at most 10. Taking a row writes its hash and nothing
 * else; the description is the first line of the body, cleaned and capped,
 * then its age.
 */
export function matchHashes(recent: RecentCommits | null, prefix: string, nowMs: number): PromptAutocompleteSuggestion[] {
  if (recent === null) return []
  const wanted = prefix.toLowerCase()

  return recent.commits
    .filter(commit => SHORT_HASH.test(commit.shortHash) && commit.shortHash.startsWith(wanted))
    .slice(0, MATCH_MAX)
    .map(commit => ({ text: commit.shortHash, label: commit.shortHash, description: describe(commit, nowMs) }))
}

function describe(commit: CommitSummary, nowMs: number): string {
  // The first line with text, an ellipsis on it when more follows, then trimmed and capped.
  const [line = ''] = cleanBody(commit.body, { maxLines: 1, maxCodePoints: BODY_MAX }).lines
  const first = cleanLine(line, MATCH_LINE_MAX)
  const age = relativeAge(commit.createdAtMs, nowMs)

  return [first, age].filter(part => part !== '').join(' \u00b7 ')
}
