// Reply alerts, the pure half: the two commit lists polled, the seen counts
// kept in `$.store`, and what rose since the person last looked. Pure:
// hooks/alerts.tsx fetches, keeps and draws.
//
// The store holds, besides the account, only the seen counts and the on/off
// flag (security rule 7). The seen counts are, per commit id and for one
// username, the `replies_count` the person has seen and the one they were
// last toasted for, so a restart neither forgets nor toasts again.

import type { HttpResponse } from 'claude-code'

import type { CommitSummary, ReplyAlert } from '../../types'
import { USERNAME } from './account'
import { parseCommitList } from './commits'
import { ORIGIN, UUID } from './links'

export const SEEN_KEY = 'seenReplies'

export const ALERTS_ON_KEY = 'alertsOn'

/** The interval when the setting is not a number. */
export const DEFAULT_INTERVAL_SECONDS = 60

/** The two lists polled for `username`: their top-level commits, and their replies. */
export function commitListUrls(username: string): { commits: string; replies: string } | undefined {
  if (!USERNAME.test(username)) return undefined
  const commits = `${ORIGIN}/api/v1/users/${username}/commits`

  return { commits, replies: `${commits}?replies=1` }
}

export type ListResult =
  | { kind: 'ok'; commits: CommitSummary[]; retryAfter: string | undefined }
  | { kind: 'failed'; status: number | undefined; retryAfter: string | undefined }

/**
 * One list's answer: its commits only from a 200 whose body is exactly such a
 * list (security rule 5). Anything else is a failure, kept with its status and
 * `Retry-After` for the back-off.
 */
export function readListResponse(response: HttpResponse): ListResult {
  const retryAfter = response.headers['retry-after']
  if (response.status !== 200) return { kind: 'failed', status: response.status, retryAfter }
  const commits = parseCommitList(response.text)
  if (commits === undefined) return { kind: 'failed', status: response.status, retryAfter }

  return { kind: 'ok', commits, retryAfter }
}

/** The interval setting in seconds; pollDelayMs holds it to the 30 s floor. */
export function intervalSecondsOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_INTERVAL_SECONDS
}

/**
 * Whether alerts are on, from what the store holds under ALERTS_ON_KEY: on
 * unless it holds exactly `false`. Unset is the default, on; a value the mod
 * never writes is read as unset.
 */
export function isAlertsOn(value: unknown): boolean {
  return value !== false
}

/**
 * How many commits the seen record holds at most: more than the two lists of
 * 20 bring, so commits that left the lists are kept for a while, and a longer
 * page upstream is cut here rather than make the record unreadable.
 */
export const SEEN_MAX = 100

/** What the person has seen of one commit, and what they were told of it. */
export type SeenEntry = {
  /** The `replies_count` the person has seen (on show when they opened the pane, or found on the first poll). */
  seen: number
  /** The highest `replies_count` a toast was raised for, so a rise is toasted once. */
  toasted: number
}

export type SeenReplies = {
  username: string
  /**
   * Commit id to its entry, newest first: the commits of the latest lists,
   * then those kept from before, so the oldest are dropped first.
   */
  entries: Record<string, SeenEntry>
}

/**
 * The seen record `$.store` holds, or undefined when what it holds is not
 * exactly such a record: the store can be edited by hand, so it is checked
 * like any outside data. In the store each entry is `[seen, toasted]`.
 */
export function parseSeen(value: unknown): SeenReplies | undefined {
  if (!isRecord(value)) return undefined
  if (Object.keys(value).sort().join(',') !== 'counts,username') return undefined
  const username: unknown = Reflect.get(value, 'username')
  const counts: unknown = Reflect.get(value, 'counts')
  if (typeof username !== 'string' || !USERNAME.test(username)) return undefined
  if (!isRecord(counts)) return undefined

  const ids = Object.keys(counts)
  if (ids.length > SEEN_MAX) return undefined
  const entries: Record<string, SeenEntry> = {}
  for (const id of ids) {
    const pair: unknown = Reflect.get(counts, id)
    if (!UUID.test(id) || !Array.isArray(pair) || pair.length !== 2) return undefined
    const [seen, toasted]: unknown[] = pair
    if (!isCount(seen) || !isCount(toasted)) return undefined
    entries[id] = { seen, toasted }
  }

  return { username, entries }
}

/** The record as `$.store` keeps it: each entry `[seen, toasted]`, in order. */
export function storedSeen(record: SeenReplies): { username: string; counts: Record<string, [number, number]> } {
  const counts: Record<string, [number, number]> = {}
  for (const [id, entry] of Object.entries(record.entries)) counts[id] = [entry.seen, entry.toasted]

  return { username: record.username, counts }
}

export type Reconciled = {
  /** The record to keep now. */
  seen: SeenReplies
  /** The commits with replies the person has not seen, in list order. */
  alerts: ReplyAlert[]
  /** The alerts that rose above what was last toasted: one toast each. */
  rises: ReplyAlert[]
  /** Whether `seen` differs from what was kept, so it needs writing. */
  isChanged: boolean
}

/**
 * Compares the counts in the latest lists with the seen record.
 *
 * With nothing kept for `username` (the first poll for this account), every
 * count is taken as seen and nothing alerts. Otherwise a commit whose count is
 * above its seen value has that many new replies, and it rises (one toast)
 * when its count is above the one last toasted, which then becomes its count.
 * A commit the record does not hold was never seen, so all its replies are
 * new. A count that fell (a reply was deleted) lowers both values with it, so
 * the next reply alerts and toasts.
 *
 * The commits of the lists come first, each once by id; the entries kept for
 * commits not in the lists follow in their order, so a commit that drops out
 * of the 20 and comes back keeps its counts. At most SEEN_MAX are kept, the
 * oldest dropped first.
 */
export function reconcile(
  kept: SeenReplies | undefined,
  username: string,
  commits: readonly CommitSummary[],
): Reconciled {
  const isFirst = kept === undefined || kept.username !== username
  const entries: Record<string, SeenEntry> = {}
  const alerts: ReplyAlert[] = []
  const rises: ReplyAlert[] = []
  for (const commit of commits) {
    if (Object.hasOwn(entries, commit.id)) continue
    if (Object.keys(entries).length === SEEN_MAX) break
    const count = commit.repliesCount
    const before = isFirst ? { seen: count, toasted: count } : (kept.entries[commit.id] ?? { seen: 0, toasted: 0 })
    const seen = Math.min(before.seen, count)
    const toasted = Math.max(seen, Math.min(before.toasted, count))
    entries[commit.id] = { seen, toasted }
    if (count > seen) {
      const alert = {
        id: commit.id,
        shortHash: commit.shortHash,
        username: commit.username,
        repliesCount: count,
        newReplies: count - seen,
      }
      alerts.push(alert)
      if (count > toasted) {
        rises.push(alert)
        entries[commit.id] = { seen, toasted: count }
      }
    }
  }
  if (!isFirst) {
    for (const [id, entry] of Object.entries(kept.entries)) {
      if (Object.keys(entries).length === SEEN_MAX) break
      if (!Object.hasOwn(entries, id)) entries[id] = entry
    }
  }

  const seen = { username, entries }

  return { seen, alerts, rises, isChanged: isFirst || !sameEntries(kept.entries, entries) }
}

/** The record after the person saw `alerts` (they opened the pane): each one's count is seen (and counts as told). */
export function seeAlerts(kept: SeenReplies, alerts: readonly ReplyAlert[]): SeenReplies {
  const entries: Record<string, SeenEntry> = { ...kept.entries }
  for (const alert of alerts) {
    const before = entries[alert.id]
    if (before === undefined && Object.keys(entries).length === SEEN_MAX) continue
    entries[alert.id] = { seen: alert.repliesCount, toasted: Math.max(before?.toasted ?? 0, alert.repliesCount) }
  }

  return { username: kept.username, entries }
}

/** The toast, `\u21b3 3 new replies on 1a2b3c4`, or `\u21b3 1 new reply on 1a2b3c4`. */
export function alertLine(alert: ReplyAlert): string {
  const noun = alert.newReplies === 1 ? 'reply' : 'replies'

  return `\u21b3 ${alert.newReplies} new ${noun} on ${alert.shortHash}`
}

/** The status line, `devnull \u21b3N` with the total of new replies, or undefined (cleared) at 0. */
export function statusText(alerts: readonly ReplyAlert[]): string | undefined {
  const total = alerts.reduce((sum, alert) => sum + alert.newReplies, 0)

  return total > 0 ? `devnull \u21b3${total}` : undefined
}

function sameEntries(a: Readonly<Record<string, SeenEntry>>, b: Readonly<Record<string, SeenEntry>>): boolean {
  const aIds = Object.keys(a)
  if (aIds.length !== Object.keys(b).length) return false

  return aIds.every(id => {
    const x = a[id]
    const y = b[id]

    return x !== undefined && y !== undefined && x.seen === y.seen && x.toasted === y.toasted
  })
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
