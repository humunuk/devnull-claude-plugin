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

/**
 * One Following round as it ended (hooks/lib/following.ts): the follow list
 * of `username`, then the commit lists of the first people on it. Commits in
 * it are each by the person whose list they came from; text in them is raw
 * and cleaned when drawn. No other text from dev-null.sh is kept, only a
 * status number.
 */
export type FollowingRound = {
  /** Whose follow list it read; null when it failed before the account was read. */
  username: string | null
  startedAtMs: number
  /** When it ended: the tab's "updated" age. */
  endedAtMs: number
  /**
   * No round starts before this: a minute after this one started, longer
   * after rounds a 5xx or a network failure stopped, or later when a 429
   * asked to wait longer.
   */
  nextAtMs: number
  /** Rounds in a row, this one included, that a 5xx or a network failure stopped; 0 for a round that was not. */
  failures: number
  outcome:
    | {
        kind: 'list'
        /** How many people the round set out to load: the first 20 followed, or fewer. */
        people: number
        /** How many of their lists failed and were left out. */
        failed: number
        /** Whether a 429 stopped the round before every list was asked for. */
        isCut: boolean
        /** Newest first, at most 30. */
        commits: CommitSummary[]
      }
    | {
        kind: 'failed'
        /** The follow list itself could not be read. */
        problem:
          | { kind: 'status'; status: number; retryAfterSeconds: number | null }
          | { kind: 'network' }
          | { kind: 'unreadable' }
          | { kind: 'local' }
      }
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
      /** The pane's tab (hooks/pane.tsx), kept so a reopen shows the last one. */
      paneTab: 'mine' | 'following'
      /**
       * Where the Following tab's round stands (hooks/pane-core.ts). `token`
       * names the one round in flight, and `steppedAtMs` is when it last
       * moved on, so a round a reload lost is let go. `last` is the round
       * before, drawn meanwhile and holding the next one back for a minute.
       * `waitUntilMs` is when the next round is due, set when an r came too
       * soon, to say how long to wait.
       */
      following:
        | { kind: 'idle' }
        | { kind: 'not-set-up' }
        | {
            kind: 'loading'
            username: string
            token: string
            startedAtMs: number
            steppedAtMs: number
            last: FollowingRound | null
          }
        | { kind: 'ended'; last: FollowingRound; waitUntilMs: number | null }
      /**
       * No request of the pane goes out before this, in `$.clock.now()`
       * milliseconds: set by a 429 with Retry-After on any of them, the load's
       * or a round's, since both share the lane and the per-IP limit
       * (hooks/pane-core.ts). 0 when nothing asked to wait.
       */
      paneNotBeforeMs: number
    }
  }
}
