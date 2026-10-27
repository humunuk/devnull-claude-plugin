// Commit list bodies in the shape `GET /api/v1/users/{username}/commits`
// answered on 2026-10-20 (read once, without ?replies=1 and with it), with the
// author's name under `handle` as answered on 2026-10-27 (upstream #1179
// removed `username`). Every value is invented; no real person's data is kept
// here.

export const USERNAME = 'some-user'

/** The id of invented commit `n`: a lowercase UUIDv7-like id ending in `n`. */
export function commitId(n: number): string {
  return `0190a1b2-c3d4-7e5f-8a9b-${String(n).padStart(12, '0')}`
}

/** The last 7 hex characters of the id, as dev-null.sh shortens it. */
export function shortHashOf(id: string): string {
  return id.replace(/-/g, '').slice(-7)
}

/** One list item with every field the API sends, read or not. */
export function apiCommit(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const id = commitId(n)

  return {
    id,
    short_hash: shortHashOf(id),
    body: `invented commit number ${n}`,
    parent_id: null,
    html_url: `https://dev-null.sh/@${USERNAME}/commits/${id}`,
    created_at: '2026-10-20T06:00:04Z',
    stars_count: 3,
    replies_count: 1,
    link_preview: null,
    images: [],
    author: {
      id: '0190a1b2-0000-7000-8000-000000000001',
      handle: USERNAME,
      name: 'Some User',
      avatar_url: 'https://avatars.example.invalid/some-user.png',
      bio: 'an invented bio',
      company: '',
      location: '',
      website: 'https://example.invalid',
      github_url: `https://github.com/${USERNAME}`,
      html_url: `https://dev-null.sh/@${USERNAME}`,
      feed_url: `https://dev-null.sh/@${USERNAME}/feed`,
      created_at: '2026-01-02T03:04:05Z',
    },
    ...overrides,
  }
}

/** A whole response body around `items`, with the pagination fields the API adds. */
export function apiList(items: readonly unknown[]): Record<string, unknown> {
  return {
    data: items,
    links: { first: null, last: null, prev: null, next: `https://dev-null.sh/api/v1/users/${USERNAME}/commits?cursor=abc` },
    meta: {
      path: `https://dev-null.sh/api/v1/users/${USERNAME}/commits`,
      per_page: 20,
      next_cursor: 'abc',
      prev_cursor: null,
    },
  }
}
