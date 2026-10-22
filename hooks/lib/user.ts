// The profile lookup: whether a /dev/null user has the username typed in
// setup. Pure: the request is built and the answer read here, and the caller
// sends it.
//
// The public API (dev-null-sh/dev-null.sh KNOWLEDGE_BASE.md, "Public read API
// and Atom feeds"):
// `GET /api/v1/users/{username}` answers 200 with the profile under `data`,
// `username` among its fields (shape read live on 2026-10-20), and 404 when
// no user has that username. The username is matched exactly, case
// included (checked live on 2026-10-20: a public profile answered 200 under
// its username as written and 404 under the same name in another case, as
// `Some-User` and `some-user` would). Fields the mod does not read are passed
// over and never copied; nothing of the body is shown.

import type { HttpInit } from 'claude-code'

import { USERNAME } from './account'
import { retryAfterSeconds } from './backoff'
import { ORIGIN } from './links'

export const PROFILE_REQUEST: HttpInit = { method: 'GET', headers: { Accept: 'application/json' } }

/** `https://dev-null.sh/api/v1/users/<username>`, or undefined when the username is not valid. */
export function userProfileUrl(username: string): string | undefined {
  if (!USERNAME.test(username)) return undefined

  return `${ORIGIN}/api/v1/users/${username}`
}

export type ProfileResponse = { status: number; headers: Readonly<Record<string, string>>; text: string }

export type ProfileOutcome =
  | { kind: 'found' }
  | { kind: 'other-user' }
  | { kind: 'not-found' }
  | { kind: 'rate-limited'; retryAfterSeconds: number | undefined }
  | { kind: 'failed'; status: number | undefined }

/**
 * What the profile's answer means for the username typed. Only a 200 whose
 * body is a profile with exactly that username counts as found; a profile of
 * another username (another case of it included) is not that user.
 */
export function readProfile(typed: string, response: ProfileResponse): ProfileOutcome {
  const { status } = response
  if (status === 200) {
    const username = profileUsername(response.text)
    if (username === undefined) return { kind: 'failed', status: undefined }

    return username === typed ? { kind: 'found' } : { kind: 'other-user' }
  }
  if (status === 404) return { kind: 'not-found' }
  if (status === 429) return { kind: 'rate-limited', retryAfterSeconds: retryAfterSeconds(response.headers['retry-after']) }

  return { kind: 'failed', status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined }
}

/** The username of the profile in a response body, or undefined when the body is not such a profile. */
function profileUsername(text: string): string | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value)) return undefined
  const data: unknown = Reflect.get(value, 'data')
  if (!isRecord(data)) return undefined
  const username: unknown = Reflect.get(data, 'username')

  return typeof username === 'string' ? username : undefined
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
