// The text a commit is signed over, and the checks its parts pass before
// anything is signed. Pure: the caller draws the random bytes, reads the clock
// and runs ssh-keygen.
//
// Upstream (nunomaduro/dev-null.sh at 3e55ca6): SignedCommits reads
// `<unix seconds>\n<nonce>\n<reply reference or empty>\n<body>`, accepts a
// time within 300 s of its clock and spends each nonce once. Commit measures
// the body with mb_strlen after CommitBodies::normalize and mb_trim, and allows
// 1 to 4000 characters. CommitByReferenceQuery takes a 7 to 12 character hex
// hash, or anything holding one UUID.

import { SHORT_HASH } from './commits'
import { ORIGIN, UUID } from './links'

export const NONCE_BYTES = 16

export const BODY_MAX = 4000

const NONCE = /^[0-9a-f]{32}$/

// What PHP's mb_trim strips by default, from both ends (enumerated on PHP
// 8.4.22 over every code point). Not String.prototype.trim: that keeps
// U+0000, U+0085 and U+180E, and strips U+FEFF, which mb_trim keeps.
const MB_TRIM =
  /^[\u0000\u0009-\u000d\u0020\u0085\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0000\u0009-\u000d\u0020\u0085\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g

/** The nonce for one commit: 16 bytes from `crypto.getRandomValues` as 32 lowercase hex characters. */
export function newNonce(bytes: Uint8Array): string {
  if (bytes.length !== NONCE_BYTES) throw new Error(`newNonce needs ${NONCE_BYTES} random bytes, got ${bytes.length}`)

  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export type BodyCheck = { kind: 'ok' } | { kind: 'empty' } | { kind: 'too-long'; length: number }

/**
 * Whether dev-null.sh can take this body: something left after trimming, and
 * at most 4000 characters, counted in code points as PHP's mb_strlen counts
 * them (an emoji is one, not two UTF-16 units). The server trims before it
 * measures, so the body is trimmed as mb_trim trims it and then measured; it
 * is sent as typed.
 */
export function checkBody(text: string): BodyCheck {
  const trimmed = text.replace(MB_TRIM, '')
  if (trimmed === '') return { kind: 'empty' }
  const length = Array.from(trimmed).length
  if (length > BODY_MAX) return { kind: 'too-long', length }

  return { kind: 'ok' }
}

// A UUID anywhere in a link, bounded the way CommitByReferenceQuery bounds it.
const UUID_IN_TEXT = /(?<![a-z0-9-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![a-z0-9-])/gi

// What a pasted link may hold: visible ASCII only, so no space, control or
// bidi character can ride along.
const LINK = /^[!-~]+$/

/**
 * What a reply names, as the reference that goes into the payload: a 7 to 12
 * character hex hash (lowercased), or the one UUID in a link on
 * `https://dev-null.sh/` (lowercased); undefined for anything else.
 */
export function parseReplyReference(input: string): string | undefined {
  if (/^[0-9a-f]{7,12}$/i.test(input)) return input.toLowerCase()
  if (!input.startsWith(`${ORIGIN}/`) || !LINK.test(input)) return undefined

  const uuids = input.match(UUID_IN_TEXT) ?? []
  const [uuid] = uuids
  if (uuids.length !== 1 || uuid === undefined) return undefined

  return uuid.toLowerCase()
}

export type PayloadParts = {
  unixSeconds: number
  nonce: string
  /** A reference parseReplyReference returned, or undefined for a top-level commit. */
  replyTo: string | undefined
  body: string
}

/**
 * `<seconds>\n<nonce>\n<reply or empty>\n<body>`, with no trailing newline. The
 * body goes in as typed; the server normalises it itself. Throws when a part
 * that frames the payload is malformed, since that is the caller's mistake.
 */
export function buildPayload({ unixSeconds, nonce, replyTo, body }: PayloadParts): string {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0) throw new Error('buildPayload needs whole unix seconds')
  if (!NONCE.test(nonce)) throw new Error('buildPayload needs a nonce of 32 lowercase hex characters')
  if (replyTo !== undefined && !SHORT_HASH.test(replyTo) && !UUID.test(replyTo)) {
    throw new Error('buildPayload needs a reply reference from parseReplyReference')
  }

  return `${unixSeconds}\n${nonce}\n${replyTo ?? ''}\n${body}`
}
