// The key lookup: asking dev-null.sh whether a public key is on the GitHub
// account of a /dev/null user. Pure: the request is built and the answer read
// here, and the caller sends it.
//
// Upstream (nunomaduro/dev-null.sh at 3e55ca6): KeyLookupController answers
// 200 with the key's canonical `<type> <base64>` and a newline;
// CreateKeyLookupRequest answers 404 when no line it was sent is a known key;
// the route is throttled to 60 a minute.

import type { HttpInit } from 'claude-code'

export const KEY_LOOKUP_URL = 'https://dev-null.sh/api/cli/key-lookups'

export function keyLookupRequest(publicKey: string): HttpInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'text/plain' },
    body: publicKey,
  }
}

export type LookupResponse = { status: number; headers: Readonly<Record<string, string>>; text: string }

export type LookupOutcome =
  | { kind: 'found' }
  | { kind: 'mismatch' }
  | { kind: 'not-found' }
  | { kind: 'rate-limited'; retryAfterSeconds: number | undefined }
  | { kind: 'failed'; status: number | undefined }

/**
 * What the lookup's answer means for the key line that was sent. The body is
 * compared, never shown: only a 2xx whose first line is exactly that key
 * line counts as found.
 */
export function readLookup(sent: string, response: LookupResponse): LookupOutcome {
  const { status } = response
  if (status >= 200 && status < 300) {
    const firstLine = response.text.split('\n')[0]

    return firstLine === sent ? { kind: 'found' } : { kind: 'mismatch' }
  }
  if (status === 404) return { kind: 'not-found' }
  if (status === 429) return { kind: 'rate-limited', retryAfterSeconds: retryAfter(response.headers) }

  return { kind: 'failed', status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined }
}

/** `Retry-After` in seconds, only when it is a plain whole number. */
function retryAfter(headers: Readonly<Record<string, string>>): number | undefined {
  const value = headers['retry-after']
  if (value === undefined || !/^[0-9]{1,6}$/.test(value)) return undefined

  return Number(value)
}
