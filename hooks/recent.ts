// Where the recent list lives: `$.state`, so it outlives a hot reload of the
// mod. The pane and the reply alerts store each list they fetch here, and the
// hash completion of `/devnull reply` reads it. The merging itself is pure, in
// lib/recent.ts.
//
// `claude plugin validate` (2.1.304) lists the values a module reads and
// writes from references and atoms written in that same file: it refuses an
// exported reference, and a `read` or `update` of an atom another file made.
// So every read and write of devnull.recent goes through the two functions
// here, which a hook calls directly with its own `$`.

import { atom, read, update } from 'claude-code'
import type { StateDollar } from 'claude-code'

import type { CommitSummary, RecentCommits } from '../types'
import { mergeRecent } from './lib/recent'

const RECENT_REF = { plugin: 'devnull', key: 'recent' } as const

const RECENT = atom(RECENT_REF, null)

/** The list as it stands, or null before the first one arrived. */
export function readRecent($: StateDollar): Promise<RecentCommits | null> {
  return read($, RECENT)
}

/**
 * Merges a fetched list of `username`'s commits into the one kept (see
 * mergeRecent: a list kept for another username is replaced, and commits by
 * anyone else are left out), and answers what is kept now.
 */
export function storeRecent(
  $: StateDollar,
  username: string,
  commits: readonly CommitSummary[],
  nowMs: number,
): Promise<RecentCommits | null> {
  return update($, RECENT, current => mergeRecent(current ?? null, { username, fetchedAtMs: nowMs, commits: [...commits] }))
}
