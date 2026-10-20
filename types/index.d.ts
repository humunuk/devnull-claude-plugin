// The devnull mod's `$.state` contract: drawing state, kept for the session
// and across hot reloads. What setup chooses lives in `$.store` instead (see
// hooks/lib/account.ts), which survives sessions.

/**
 * One of the person's commits or replies, as the public commit list gave it
 * and hooks/lib/commits.ts checked it: only the fields the mod uses. Text in
 * it is raw; it is cleaned when drawn.
 */
export type CommitSummary = {
  /** A lowercase UUID. */
  id: string
  /** 7 to 12 lowercase hex characters, the end of the id. */
  shortHash: string
  body: string
  /** The commit it replies to, or null for a top-level commit (or a parent the public may not see). */
  parentId: string | null
  createdAtMs: number
  starsCount: number
  repliesCount: number
  /** The author's /dev/null username. */
  username: string
}

/**
 * The session's list of the person's own recent commits and replies, newest
 * first: the pane and the reply alerts fill it, and the hash completion of
 * `/devnull reply` reads it. See hooks/lib/recent.ts.
 */
export type RecentCommits = {
  username: string
  fetchedAtMs: number
  commits: CommitSummary[]
}

// Written out in place, not as a named type: `claude plugin validate` reads
// the keys from this declaration itself.
declare module 'claude-code' {
  interface PluginState {
    devnull: {
      /** null until the first list arrives. */
      recent: RecentCommits | null
    }
  }
}
