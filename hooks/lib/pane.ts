// The pane's pure parts: the request for the person's newest commits, what
// its answer means, the one load allowed in flight, and what the pane draws
// from the recent list. Pure: hooks/pane.tsx fetches, keeps and draws.

import type { HttpInit, PluginState } from 'claude-code'

import type { CommitSummary, RecentCommits } from '../../types'
import { USERNAME } from './account'
import { retryAfterSeconds } from './backoff'
import { parseCommitList } from './commits'
import { ORIGIN, commitUrl } from './links'
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

  return { kind: 'loading', username, token, startedAtMs: nowMs, page: pageOf(current, username) }
}

/**
 * The load after the one named `token` ended. A load that is no longer the
 * current one (a newer one took over after it went stale) changes nothing.
 * A list becomes the page drawn; a failure keeps the page drawn before it.
 */
export function finishLoad(current: PaneLoad, token: string, answer: CommitsAnswer, nowMs: number): PaneLoad {
  if (current.kind !== 'loading' || current.token !== token) return current
  const { username } = current
  if (answer.kind === 'list') return { kind: 'ready', username, page: answer.commits.map(commit => commit.id) }

  return failedLoad(username, answer.problem, nowMs, current.page)
}

export function failedLoad(username: string | null, problem: PaneProblem, nowMs: number, page: readonly string[]): PaneLoad {
  const waitSeconds = problem.kind === 'status' ? problem.retryAfterSeconds : null

  return {
    kind: 'failed',
    username,
    page: [...page],
    problem,
    retryAtMs: waitSeconds === null ? null : nowMs + waitSeconds * 1000,
  }
}

/** The page `load` draws, when it is one for `username`; else none. */
export function pageOf(load: PaneLoad, username: string | null): string[] {
  if (load.kind === 'idle' || load.kind === 'not-set-up' || load.username !== username) return []

  return [...load.page]
}

/** One commit as the pane draws it; every text in it is cleaned or the mod's own. */
export type PaneCommit = {
  id: string
  hash: string
  /** `2h \u00b7 \u2605 3 \u00b7 \u21b3 1` */
  meta: string
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

/** The pane's content for the load and the recent list as they stand at `nowMs`. */
export function paneView(load: PaneLoad, recent: RecentCommits | null, nowMs: number): PaneView {
  const username = load.kind === 'idle' || load.kind === 'not-set-up' ? null : load.username
  const title = username === null ? '/dev/null' : `/dev/null \u00b7 @${username}`
  const list = username !== null && recent !== null && recent.username === username ? recent : null
  const commits = list === null ? [] : paneCommits(list, pageOf(load, username), nowMs)
  const freshness = load.kind === 'loading' ? 'loading\u2026' : list === null ? '' : `updated ${relativeAge(list.fetchedAtMs, nowMs)}`
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
 * them (its counts may be newer, from the reply alerts). A commit no longer on
 * that page is left out, though the recent list keeps it for completion; so
 * are replies, and anything not by the list's username.
 */
export function paneCommits(recent: RecentCommits, page: readonly string[], nowMs: number): PaneCommit[] {
  const byId = new Map(recent.commits.map(commit => [commit.id, commit]))

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
        lines,
        href: commitHref(commit.username, commit.id),
      }
    })
}

/**
 * The commit's link as a `Link` takes it: commitUrl's, with the `@` before the
 * username written `%40`. The engine (2.1.304) draws a link whose href holds a
 * raw `@` as plain text on the desktop surface; dev-null.sh is Laravel, which
 * matches routes on the decoded path, so both spellings open the same page.
 */
export function commitHref(username: string, id: string): string | undefined {
  const url = commitUrl(username, id)
  if (url === undefined) return undefined

  return `${ORIGIN}/%40${url.slice(`${ORIGIN}/@`.length)}`
}
