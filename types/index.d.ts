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

/** A commit of the person's with replies they have not seen. See hooks/lib/alerts.ts. */
export type ReplyAlert = {
  /** A lowercase UUID. */
  id: string
  /** 7 to 12 lowercase hex characters, the end of the id. */
  shortHash: string
  /** The author's /dev/null username, for the link. */
  username: string
  /** The commit's `replies_count` now. */
  repliesCount: number
  /** How many of those the person has not seen, at least 1. */
  newReplies: number
}

/**
 * The reply alerts' session state: what the band and the status line show,
 * and what the poller needs to go on politely after a hot reload.
 */
export type ReplyAlerts = {
  alerts: ReplyAlert[]
  /** Polls that failed in a row, for back-off. */
  failures: number
  /** When the next poll is due, in `$.clock.now()` milliseconds; null before the first. */
  nextPollAtMs: number | null
}

// Written out in place, not as a named type: `claude plugin validate` reads
// the keys from this declaration itself.
declare module 'claude-code' {
  interface PluginState {
    devnull: {
      /** null until the first list arrives. */
      recent: RecentCommits | null
      /**
       * Where the pane's load of the person's commits stands (hooks/pane-core.ts).
       * The commits themselves are in `recent`; `page` is the ids of the last
       * page fetched, newest first, which are the ones the pane draws, and
       * `fetchedAtMs` when that page arrived (both kept through a reload and a
       * failure; null before any page). The reply alerts also keep `recent`
       * current, so the pane's "updated" age is its own fetch's, from here.
       * `token` names the one load in flight; `retryAtMs` holds the next load
       * back after a 429 with Retry-After. No text from dev-null.sh is kept
       * here, only a status number.
       */
      pane:
        | { kind: 'idle' }
        | { kind: 'not-set-up' }
        | { kind: 'loading'; username: string; token: string; startedAtMs: number; page: string[]; fetchedAtMs: number | null }
        | { kind: 'ready'; username: string; page: string[]; fetchedAtMs: number }
        | {
            kind: 'failed'
            username: string | null
            page: string[]
            fetchedAtMs: number | null
            problem:
              | { kind: 'status'; status: number; retryAfterSeconds: number | null }
              | { kind: 'network' }
              | { kind: 'unreadable' }
              | { kind: 'local' }
            retryAtMs: number | null
          }
      /**
       * The pane's input (hooks/pane.tsx). `round` counts the submits: the
       * field is drawn as `commit-<round>`, so the one drawn after a submit is
       * a new field that starts from `draft`, the person's own text, kept when
       * a post fails and '' after one went through. `sending` is the one post
       * in flight. `outcome` is what the last submit came to: the mod's own
       * lines, and the commit dev-null.sh confirmed (its username and id
       * checked by the patterns links are built from), or null. No text from
       * dev-null.sh is kept here.
       */
      panePost: {
        round: number
        draft: string
        sending: { token: string; startedAtMs: number } | null
        outcome: { committed: { username: string; id: string } | null; lines: string[] } | null
      }
      /** The reply alerts; see hooks/alerts.tsx. */
      replyAlerts: ReplyAlerts
    }
  }
}
