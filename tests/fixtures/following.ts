// Follow list bodies in the shape `GET /api/v1/users/{username}/following`
// answered on 2026-10-20 (read once), with each name under `handle` as
// answered on 2026-10-27 (upstream #1179 removed `username`), and commit lists
// of the people followed. Every value is invented; no real person's data is
// kept here.

import { USERNAME, apiCommit } from './commits'

export const FOLLOWING_URL = `https://dev-null.sh/api/v1/users/${USERNAME}/following`

/** The invented username of followed person `n`. */
export function friend(n: number): string {
  return `friend-${n}`
}

/** `https://dev-null.sh/api/v1/users/<username>/commits` */
export function commitsUrlOf(username: string): string {
  return `https://dev-null.sh/api/v1/users/${username}/commits`
}

/** One follow list item with every field the API sends, read or not. */
export function apiPerson(username: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handle: username,
    id: '0190a1b2-0000-7000-8000-0000000000aa',
    name: 'An Invented Person',
    avatar_url: 'https://avatars.example.invalid/person.png',
    bio: 'an invented bio',
    company: '',
    location: '',
    website: 'https://example.invalid',
    github_url: `https://github.com/${username}`,
    html_url: `https://dev-null.sh/@${username}`,
    feed_url: `https://dev-null.sh/@${username}/feed`,
    created_at: '2026-01-02T03:04:05Z',
    ...overrides,
  }
}

/** A whole follow list body around `items`, with the pagination fields the API adds. */
export function apiFollowList(items: readonly unknown[]): Record<string, unknown> {
  return {
    data: items,
    links: { first: null, last: null, prev: null, next: null },
    meta: { path: FOLLOWING_URL, per_page: 30, next_cursor: null, prev_cursor: null },
  }
}

/** Commit `n` of the list item shape, by `username`. */
export function apiCommitBy(username: string, n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return apiCommit(n, { author: { handle: username, name: 'An Invented Person' }, ...overrides })
}
