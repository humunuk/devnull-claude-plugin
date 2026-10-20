import { describe, expect, test } from 'claude-code/testing'

import { BODY_MAX, buildPayload, checkBody, newNonce, parseReplyReference } from '../hooks/lib/payload'
import { commitId } from './fixtures/commits'

describe('the nonce', () => {
  test('is the 16 bytes as 32 lowercase hex characters', () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index * 17)
    expect(newNonce(bytes)).toBe('00112233445566778899aabbccddeeff')
    expect(newNonce(new Uint8Array(16))).toBe('0'.repeat(32))
    expect(newNonce(new Uint8Array(16).fill(255))).toBe('f'.repeat(32))
    expect(newNonce(crypto.getRandomValues(new Uint8Array(16)))).toMatch(/^[0-9a-f]{32}$/)
  })

  test('needs exactly 16 bytes', () => {
    expect(() => newNonce(new Uint8Array(15))).toThrow('16 random bytes')
    expect(() => newNonce(new Uint8Array(32))).toThrow('16 random bytes')
  })
})

describe('the body', () => {
  // U+1F389, two UTF-16 units and one code point, as mb_strlen counts it.
  const party = '\u{1f389}'

  test('may be one to 4000 code points', () => {
    expect(BODY_MAX).toBe(4000)
    expect(checkBody('x')).toEqual({ kind: 'ok' })
    expect(checkBody(party.repeat(4000))).toEqual({ kind: 'ok' })
    expect(party.repeat(4000).length).toBe(8000)
    expect(checkBody(`${'a'.repeat(3999)}${party}`)).toEqual({ kind: 'ok' })
  })

  test('is refused over 4000 code points', () => {
    expect(checkBody(party.repeat(4001))).toEqual({ kind: 'too-long', length: 4001 })
    expect(checkBody(`${'a'.repeat(4000)}${party}`)).toEqual({ kind: 'too-long', length: 4001 })
  })

  test('is measured after trimming, as the server trims it', () => {
    expect(checkBody(`  ${party.repeat(4000)}\n\n`)).toEqual({ kind: 'ok' })
  })

  test('is refused when only whitespace is left', () => {
    for (const blank of ['', ' ', '\n\n', '\t \r\n', '\u00a0\u3000']) {
      expect(checkBody(blank)).toEqual({ kind: 'empty' })
    }
  })

  test('is trimmed as PHP mb_trim trims, not as String.prototype.trim', () => {
    // mb_trim strips U+0000, U+0085 and U+180E, which trim keeps.
    for (const blank of ['\u0085', '\u180e', '\u0000', '\u0000 \u0085\u180e\u2028\u202f\u205f']) {
      expect(checkBody(blank)).toEqual({ kind: 'empty' })
    }
    expect(checkBody(`\u0085${'a'.repeat(4000)}\u180e\u0000`)).toEqual({ kind: 'ok' })
    // trim strips U+FEFF, which mb_trim keeps and counts.
    expect(checkBody('\ufeff')).toEqual({ kind: 'ok' })
    expect(checkBody(`${'a'.repeat(4000)}\ufeff`)).toEqual({ kind: 'too-long', length: 4001 })
    // U+200B is not whitespace to either.
    expect(checkBody('\u200b')).toEqual({ kind: 'ok' })
  })
})

describe('the reply reference', () => {
  const id = commitId(7)

  test('takes a 7 to 12 character hex hash, lowercased', () => {
    expect(parseReplyReference('abc1234')).toBe('abc1234')
    expect(parseReplyReference('ABC1234')).toBe('abc1234')
    expect(parseReplyReference('0123456789ab')).toBe('0123456789ab')
  })

  test('takes a dev-null.sh link with one UUID, reduced to the UUID', () => {
    expect(parseReplyReference(`https://dev-null.sh/@some-user/commits/${id}`)).toBe(id)
    expect(parseReplyReference(`https://dev-null.sh/@some-user/commits/${id.toUpperCase()}`)).toBe(id)
    expect(parseReplyReference(`https://dev-null.sh/@some-user/commits/${id}?ref=x#top`)).toBe(id)
    expect(parseReplyReference(`https://dev-null.sh/${id}`)).toBe(id)
  })

  test('refuses anything else', () => {
    for (const bad of [
      '',
      'abc123',
      'abc1234567890',
      'abc123g',
      ' abc1234',
      'abc1234\n',
      id,
      'https://dev-null.sh/',
      'https://dev-null.sh/@some-user',
      'https://dev-null.sh/@some-user/commits/not-a-uuid',
      `https://dev-null.sh/@some-user/commits/${id}/photos/${commitId(8)}`,
      `https://dev-null.sh/@some-user/commits/${id}?again=${id}`,
      `https://dev-null.sh/@some-user/commits/${id}0`,
      `https://dev-null.sh/@some-user/commits/x${id}`,
      `http://dev-null.sh/@some-user/commits/${id}`,
      `https://evil.example/@some-user/commits/${id}`,
      `https://dev-null.sh.evil.example/@some-user/commits/${id}`,
      `https://dev-null.sh@evil.example/commits/${id}`,
      `HTTPS://DEV-NULL.SH/@some-user/commits/${id}`,
      `https://dev-null.sh/@some-user/commits/${id} extra`,
      `https://dev-null.sh/@some-user/commits/${id}\u202e`,
      `https://dev-null.sh/@some-user/\u001b[31mcommits/${id}`,
    ]) {
      expect(parseReplyReference(bad)).toBeUndefined()
    }
  })
})

describe('the payload', () => {
  const nonce = '0123456789abcdef0123456789abcdef'

  test('is seconds, nonce, reply and body on their lines, with no newline after', () => {
    expect(buildPayload({ unixSeconds: 1760000000, nonce, replyTo: undefined, body: 'hello' })).toBe(
      `1760000000\n${nonce}\n\nhello`,
    )
    expect(buildPayload({ unixSeconds: 1760000000, nonce, replyTo: 'abc1234', body: 'hello' })).toBe(
      `1760000000\n${nonce}\nabc1234\nhello`,
    )
    expect(buildPayload({ unixSeconds: 1760000000, nonce, replyTo: commitId(7), body: 'hi' })).toBe(
      `1760000000\n${nonce}\n${commitId(7)}\nhi`,
    )
  })

  test('carries the body as typed', () => {
    const body = '  line one\r\n\n\n\nline two \u{1f44b}\n'
    expect(buildPayload({ unixSeconds: 1, nonce, replyTo: undefined, body })).toBe(`1\n${nonce}\n\n${body}`)
  })

  test('refuses parts that would break its lines', () => {
    const parts = { unixSeconds: 1760000000, nonce, replyTo: undefined, body: 'x' }
    expect(() => buildPayload({ ...parts, unixSeconds: 1760000000.5 })).toThrow('unix seconds')
    expect(() => buildPayload({ ...parts, unixSeconds: -1 })).toThrow('unix seconds')
    expect(() => buildPayload({ ...parts, unixSeconds: Number.NaN })).toThrow('unix seconds')
    expect(() => buildPayload({ ...parts, nonce: nonce.toUpperCase() })).toThrow('nonce')
    expect(() => buildPayload({ ...parts, nonce: `${nonce}\n` })).toThrow('nonce')
    expect(() => buildPayload({ ...parts, replyTo: 'abc1234\nxyz' })).toThrow('reply reference')
    expect(() => buildPayload({ ...parts, replyTo: '' })).toThrow('reply reference')
    expect(() => buildPayload({ ...parts, replyTo: 'ABC1234' })).toThrow('reply reference')
  })
})
