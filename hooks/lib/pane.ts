// The pane's pure parts: the request for the person's newest commits, what
// its answer means, the one load allowed in flight, what the pane draws from
// the recent list, and its input's one post in flight. Pure: hooks/pane.tsx
// and hooks/pane-core.ts fetch, post, keep and draw.

import type { HttpInit, PluginState, RenderSurface } from 'claude-code'

import type { CommitSummary, RecentCommits, ReplyAlert } from '../../types'
import { USERNAME } from './account'
import { retryAfterSeconds } from './backoff'
import { parseCommitList } from './commits'
import { ORIGIN, commitLink } from './links'
import type { PostResult } from './posting'
import { cleanBody, relativeAge } from './text'

/** Where the pane's load stands, as the `$.state` contract declares it. */
export type PaneLoad = PluginState['devnull']['pane']

export type PaneProblem = Extract<PaneLoad, { kind: 'failed' }>['problem']

/** The list endpoint answers 20 a page; the pane shows one page. */
export const PAGE_SIZE = 20

export const BODY_LINES = 3

/** The most of a body the pane draws, in code points, the ellipsis included. */
export const BODY_DRAWN_MAX = 600

/**
 * A load that started this long ago is taken as lost: $.http.fetch rejects
 * after 30 s, so only a load whose answer never came back (the mod reloaded
 * under it) is this old.
 */
export const LOAD_STALE_MS = 35_000

export const NOT_SET_UP_TEXT = 'Run /devnull setup to choose your key and username.'
export const LOADING_TEXT = 'Loading your commits\u2026'
export const EMPTY_TEXT = 'No commits yet. Type below, or /devnull commit <text>.'
export const IDLE_TEXT = 'Press r to load your commits.'
export const NETWORK_TEXT = "Couldn't reach dev-null.sh. Press r to retry."
export const UNREADABLE_TEXT = "dev-null.sh answered with a list the mod could not read. Press r to retry."
export const LOCAL_TEXT = "Couldn't load commits: Claude Code refused a step. Press r to retry."

export function statusText(status: number): string {
  return `Couldn't load commits (HTTP ${status}). Press r to retry.`
}

export function waitText(seconds: number): string {
  return `dev-null.sh asked to wait ${seconds} seconds before the next try.`
}

export const COMMITS_REQUEST: HttpInit = { method: 'GET', headers: { Accept: 'application/json' } }

/** `https://dev-null.sh/api/v1/users/<username>/commits`, or undefined when the username is not valid. */
export function userCommitsUrl(username: string): string | undefined {
  if (!USERNAME.test(username)) return undefined

  return `${ORIGIN}/api/v1/users/${username}/commits`
}

export type CommitsResponse = { status: number; headers: Readonly<Record<string, string>>; text: string }

export type CommitsAnswer = { kind: 'list'; commits: CommitSummary[] } | { kind: 'problem'; problem: PaneProblem }

/**
 * What the list's answer means. Only a 200 whose body is exactly a commit list
 * is a list; any other status is shown by its number alone, never its text.
 */
export function readCommitsAnswer(response: CommitsResponse): CommitsAnswer {
  const { status } = response
  if (status === 200) {
    const commits = parseCommitList(response.text)

    return commits === undefined ? { kind: 'problem', problem: { kind: 'unreadable' } } : { kind: 'list', commits }
  }
  if (!Number.isInteger(status) || status < 100 || status > 599) return { kind: 'problem', problem: { kind: 'unreadable' } }
  const retryAfter = status === 429 ? retryAfterSeconds(response.headers['retry-after']) : undefined

  return { kind: 'problem', problem: { kind: 'status', status, retryAfterSeconds: retryAfter ?? null } }
}

/**
 * The load after one is asked for: a new load named `token`, or the current
 * one unchanged while a load is in flight, or while dev-null.sh asked to wait.
 */
export function startLoad(current: PaneLoad, username: string, token: string, nowMs: number): PaneLoad {
  if (current.kind === 'loading' && nowMs >= current.startedAtMs && nowMs - current.startedAtMs < LOAD_STALE_MS) {
    return current
  }
  if (current.kind === 'failed' && current.retryAtMs !== null && nowMs < current.retryAtMs) return current

  return {
    kind: 'loading',
    username,
    token,
    startedAtMs: nowMs,
    page: pageOf(current, username),
    fetchedAtMs: fetchedAtOf(current, username),
  }
}

/**
 * The load after the one named `token` ended. A load that is no longer the
 * current one (a newer one took over after it went stale) changes nothing.
 * A list becomes the page drawn; a failure keeps the page drawn before it.
 */
export function finishLoad(current: PaneLoad, token: string, answer: CommitsAnswer, nowMs: number): PaneLoad {
  if (current.kind !== 'loading' || current.token !== token) return current
  const { username } = current
  if (answer.kind === 'list') {
    return { kind: 'ready', username, page: answer.commits.map(commit => commit.id), fetchedAtMs: nowMs }
  }

  return failedLoad(username, answer.problem, nowMs, current.page, current.fetchedAtMs)
}

export function failedLoad(
  username: string | null,
  problem: PaneProblem,
  nowMs: number,
  page: readonly string[],
  fetchedAtMs: number | null,
): PaneLoad {
  const waitSeconds = problem.kind === 'status' ? problem.retryAfterSeconds : null

  return {
    kind: 'failed',
    username,
    page: [...page],
    fetchedAtMs,
    problem,
    retryAtMs: waitSeconds === null ? null : nowMs + waitSeconds * 1000,
  }
}

/** The page `load` draws, when it is one for `username`; else none. */
export function pageOf(load: PaneLoad, username: string | null): string[] {
  if (load.kind === 'idle' || load.kind === 'not-set-up' || load.username !== username) return []

  return [...load.page]
}

/** When the page `load` draws arrived, when it is one for `username`; else null. */
export function fetchedAtOf(load: PaneLoad, username: string | null): number | null {
  if (load.kind === 'idle' || load.kind === 'not-set-up' || load.username !== username) return null

  return load.fetchedAtMs
}

/** One commit as the pane draws it; every text in it is cleaned or the mod's own. */
export type PaneCommit = {
  id: string
  hash: string
  /** `2h \u00b7 \u2605 3 \u00b7 \u21b3 1` */
  meta: string
  /** How many of its replies the reply alerts hold as new; 0 for none. */
  newReplies: number
  /** Up to three cleaned body lines, the last ending in an ellipsis when the body was cut. */
  lines: string[]
  /** The commit's page, or undefined when its id or username fails the link patterns. */
  href: string | undefined
}

/** What the pane shows besides its header buttons. */
export type PaneView = {
  /** `/dev/null \u00b7 @<username>`, or `/dev/null` with no account known. */
  title: string
  /** `updated 5m`, `loading\u2026`, or empty. */
  freshness: string
  /** A fixed state line, when there is one. */
  message: string | undefined
  /** A second fixed line under it (how long dev-null.sh asked to wait). */
  hint: string | undefined
  commits: PaneCommit[]
}

/**
 * The pane's content on `surface` for the load, the recent list and the reply
 * alerts as they stand at `nowMs`. The `updated` age is the load's own last
 * page, not the recent list's, which the reply alerts move too.
 */
export function paneView(
  load: PaneLoad,
  recent: RecentCommits | null,
  alerts: readonly ReplyAlert[],
  nowMs: number,
  surface: RenderSurface,
): PaneView {
  const username = load.kind === 'idle' || load.kind === 'not-set-up' ? null : load.username
  const title = username === null ? '/dev/null' : `/dev/null \u00b7 @${username}`
  const list = username !== null && recent !== null && recent.username === username ? recent : null
  const commits = list === null ? [] : paneCommits(list, pageOf(load, username), alerts, nowMs, surface)
  const fetchedAtMs = fetchedAtOf(load, username)
  const freshness =
    load.kind === 'loading' ? 'loading\u2026' : fetchedAtMs === null ? '' : `updated ${relativeAge(fetchedAtMs, nowMs)}`
  const view = { title, freshness, hint: undefined, commits }

  switch (load.kind) {
    case 'idle':
      return { ...view, message: IDLE_TEXT }
    case 'not-set-up':
      return { ...view, message: NOT_SET_UP_TEXT }
    case 'loading':
      return { ...view, message: commits.length === 0 ? LOADING_TEXT : undefined }
    case 'ready':
      return { ...view, message: commits.length === 0 ? EMPTY_TEXT : undefined }
    case 'failed': {
      const { problem } = load
      const wait = problem.kind === 'status' ? problem.retryAfterSeconds : null

      return { ...view, message: problemText(problem), hint: wait === null ? undefined : waitText(wait) }
    }
    default: {
      const unknownLoad: never = load

      return unknownLoad
    }
  }
}

function problemText(problem: PaneProblem): string {
  switch (problem.kind) {
    case 'status':
      return statusText(problem.status)
    case 'network':
      return NETWORK_TEXT
    case 'unreadable':
      return UNREADABLE_TEXT
    case 'local':
      return LOCAL_TEXT
    default: {
      const unknownProblem: never = problem

      return unknownProblem
    }
  }
}

/**
 * The commits of the page last fetched, in its order, as the recent list holds
 * them (its counts may be newer, from the reply alerts), with the new replies
 * the alerts hold for each and its link on `surface`. A commit no longer on
 * that page is left out, though the recent list keeps it for completion; so
 * are replies, and anything not by the list's username.
 */
export function paneCommits(
  recent: RecentCommits,
  page: readonly string[],
  alerts: readonly ReplyAlert[],
  nowMs: number,
  surface: RenderSurface,
): PaneCommit[] {
  const byId = new Map(recent.commits.map(commit => [commit.id, commit]))
  const newById = new Map(
    alerts.filter(alert => alert.username === recent.username).map(alert => [alert.id, alert.newReplies]),
  )

  return page
    .flatMap(id => {
      const commit = byId.get(id)

      return commit === undefined ? [] : [commit]
    })
    .filter(commit => commit.parentId === null && commit.username === recent.username)
    .slice(0, PAGE_SIZE)
    .map(commit => {
      const age = relativeAge(commit.createdAtMs, nowMs)
      const counts = `\u2605 ${commit.starsCount} \u00b7 \u21b3 ${commit.repliesCount}`
      const { lines } = cleanBody(commit.body, { maxLines: BODY_LINES, maxCodePoints: BODY_DRAWN_MAX })

      return {
        id: commit.id,
        hash: commit.shortHash,
        meta: age === '' ? counts : `${age} \u00b7 ${counts}`,
        newReplies: newById.get(commit.id) ?? 0,
        lines,
        href: commitLink(commit.username, commit.id, surface),
      }
    })
}

/** `+3 new`, after a commit's counts. */
export function newRepliesText(newReplies: number): string {
  return `+${newReplies} new`
}

/** The pane's input, as the `$.state` contract declares it. */
export type PanePost = PluginState['devnull']['panePost']

export const NO_POST: PanePost = { round: 0, draft: '', sending: null, outcome: null }

/**
 * A post that started this long ago is taken as lost: every step of one has
 * its own timeout (ssh-add 5 s, mktemp, rm and rmdir 5 s each, ssh-keygen
 * 60 s, the request 30 s), so only a post whose answer never came back (the
 * mod reloaded under it) is this old.
 */
export const POST_STALE_MS = 150_000

export const COMMITTED_TEXT = 'Committed.'
export const POSTING_TEXT = 'posting\u2026'
export const PANE_EMPTY_TEXT = 'Nothing to post: type your commit, then press Enter.'
export const STALE_POST_TEXT =
  'Your last post did not report back, so it may or may not have been posted. Check your profile on dev-null.sh before posting it again.'
export const POST_FAILED_TEXT = 'Claude Code refused a step, so nothing was posted. Press Enter to try again.'

/** Whether a post is in flight at `nowMs`: one started, not finished, and not yet stale. */
export function isSending(post: PanePost, nowMs: number): boolean {
  const { sending } = post

  return sending !== null && nowMs >= sending.startedAtMs && nowMs - sending.startedAtMs < POST_STALE_MS
}

/**
 * The input after a submit of `body` asked to post: a post named `token`, or
 * the current one unchanged while another is in flight. The body is kept as
 * the draft until the post went through. What the last submit came to is
 * shown until this one: closing and opening the pane keeps it, so a post that
 * ended while the pane was closed still says how.
 */
export function startPost(current: PanePost, token: string, body: string, nowMs: number): PanePost {
  if (isSending(current, nowMs)) return current

  return { round: current.round + 1, draft: body, sending: { token, startedAtMs: nowMs }, outcome: null }
}

/** The input after the post named `token` came to `result`; any other post's end changes nothing. */
export function finishPost(current: PanePost, token: string, result: PostResult): PanePost {
  if (current.sending === null || current.sending.token !== token) return current
  const outcome = { committed: result.committed, lines: [...result.lines] }

  return { round: current.round + 1, draft: result.committed === null ? current.draft : '', sending: null, outcome }
}

/** The input after a submit refused before anything ran: `lines` say why, `draft` is what the field holds again. */
export function refusePost(current: PanePost, draft: string, lines: readonly string[], nowMs: number): PanePost {
  if (isSending(current, nowMs)) return current

  return { round: current.round + 1, draft, sending: null, outcome: { committed: null, lines: [...lines] } }
}

/** What the pane draws under its rule, on the surface that posts. */
export type PostView =
  | { kind: 'sending' }
  | {
      kind: 'field'
      /** The field's key: a new one after each submit, so it starts from `draft`. */
      key: string
      draft: string
      /** When the last post went through: its link on the surface, undefined when its parts fail the patterns. */
      committed: { href: string | undefined } | undefined
      /** The mod's own lines about the last submit, one row each. */
      lines: string[]
      /** Whether the lines tell of a submit that did not post. */
      isProblem: boolean
    }

export function postView(post: PanePost, nowMs: number, surface: RenderSurface): PostView {
  if (isSending(post, nowMs)) return { kind: 'sending' }
  const field = { kind: 'field', key: `commit-${post.round}`, draft: post.draft } as const
  // A post still marked as sending is one that never reported back.
  if (post.sending !== null) return { ...field, committed: undefined, lines: [STALE_POST_TEXT], isProblem: true }
  const { outcome } = post
  if (outcome === null) return { ...field, committed: undefined, lines: [], isProblem: false }
  const lines = outcome.lines.flatMap(line => line.split('\n'))
  const { committed } = outcome
  if (committed === null) return { ...field, committed: undefined, lines, isProblem: true }

  return { ...field, committed: { href: commitLink(committed.username, committed.id, surface) }, lines, isProblem: false }
}
