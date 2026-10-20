// Profile bodies in the shape `GET /api/v1/users/{username}` answered on
// 2026-10-20 (read once, for a public profile). Every value is invented; no
// real person's data is kept here.

/** A whole response body: the profile of `username`, with every field the API sends. */
export function apiProfile(username: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data: {
      id: '0190a1b2-0000-7000-8000-000000000001',
      username,
      name: 'Some User',
      avatar_url: 'https://avatars.example.invalid/some-user.png',
      bio: 'an invented bio',
      company: '',
      location: '',
      website: 'https://example.invalid',
      github_url: `https://github.com/${username}`,
      html_url: `https://dev-null.sh/@${username}`,
      feed_url: `https://dev-null.sh/@${username}/feed`,
      created_at: '2026-01-02T03:04:05Z',
      commits_count: 12,
      followers_count: 3,
      following_count: 4,
      ...overrides,
    },
  }
}
