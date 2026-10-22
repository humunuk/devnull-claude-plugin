// The text a commit is signed over, and the checks its parts pass before
// anything is signed. Pure: the caller draws the random bytes, reads the clock
// and runs ssh-keygen.
//
// Upstream (dev-null-sh/dev-null.sh at 3e55ca6, the body rule at 230c004):
// SignedCommits reads `<unix seconds>\n<nonce>\n<reply reference or
// empty>\n<body>`, accepts a time within 300 s of its clock and spends each
// nonce once. After CommitBodies::normalize and mb_trim, CreateCommitRequest's
// bodyRules take a body of 1 to 40000 code points raw
// (CommitBodyLength::MAX_RAW_LENGTH), with no prose link over 2048 characters
// (Urls::MAX_LENGTH) and at most 4000 characters counted with each prose link
// as at most 23 (Commit::MAX_BODY_LENGTH, Urls::characterCount); a link in
// code counts at full length and is not held to 2048 (withoutCode). The mod
// checks the raw length alone: the link-aware count and the link length
// depend on the server's URL parsing, which a copy here would drift from, so
// a body over them is the server's 422. CommitByReferenceQuery takes a 7 to 12
// character hex hash, or anything holding one UUID.

import { SHORT_HASH } from './commits'
import { ORIGIN, UUID } from './links'

export const NONCE_BYTES = 16

/** The most code points a body may hold raw, before links are counted short (CommitBodyLength::MAX_RAW_LENGTH). */
export const BODY_RAW_MAX = 40000

/** The most characters a body may count, each link as at most LINK_COUNTED_MAX (Commit::MAX_BODY_LENGTH); the server's to judge. */
export const BODY_COUNT_MAX = 4000

/** What one link outside code in a body counts as at most (Urls::characterCount); a link in code counts in full. */
export const LINK_COUNTED_MAX = 23

/** The longest link a body may hold outside code (Urls::MAX_LENGTH). */
export const LINK_MAX = 2048

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
 * Whether the body is worth signing: something left after trimming, and at
 * most BODY_RAW_MAX code points, counted as PHP's mb_strlen counts them (an
 * emoji is one, not two UTF-16 units). The server trims before it measures,
 * so the body is trimmed as mb_trim trims it and then measured; it is sent as
 * typed. A body that passes may still count over BODY_COUNT_MAX, or hold a
 * link over LINK_MAX: the server refuses that with a 422.
 */
export function checkBody(text: string): BodyCheck {
  const trimmed = text.replace(MB_TRIM, '')
  if (trimmed === '') return { kind: 'empty' }
  const length = Array.from(trimmed).length
  if (length > BODY_RAW_MAX) return { kind: 'too-long', length }

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
