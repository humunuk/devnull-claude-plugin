import { describe, expect, test } from 'claude-code/testing'

import { parseAccount } from '../hooks/lib/account'
import { KEY_LOOKUP_URL, keyLookupRequest, readLookup } from '../hooks/lib/lookup'
import { ED25519 } from './fixtures/keys'

const answer = (status: number, text: string, headers: Record<string, string> = {}) => ({ status, headers, text })

describe('the key lookup', () => {
  test('is a plain-text POST of the one key line to the fixed host', () => {
    expect(KEY_LOOKUP_URL).toBe('https://dev-null.sh/api/cli/key-lookups')
    expect(keyLookupRequest(ED25519.line)).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'text/plain' },
      body: ED25519.line,
    })
  })

  test('counts as found only when a 2xx answer starts with exactly the line sent', () => {
    expect(readLookup(ED25519.line, answer(200, `${ED25519.line}\n`))).toEqual({ kind: 'found' })
    expect(readLookup(ED25519.line, answer(201, ED25519.line))).toEqual({ kind: 'found' })
    expect(readLookup(ED25519.line, answer(200, `${ED25519.line} comment\n`))).toEqual({ kind: 'mismatch' })
    expect(readLookup(ED25519.line, answer(200, `${ED25519.line}\r\n`))).toEqual({ kind: 'mismatch' })
    expect(readLookup(ED25519.line, answer(200, ` ${ED25519.line}\n`))).toEqual({ kind: 'mismatch' })
    expect(readLookup(ED25519.line, answer(200, '<html>maintenance</html>'))).toEqual({ kind: 'mismatch' })
    expect(readLookup(ED25519.line, answer(200, ''))).toEqual({ kind: 'mismatch' })
  })

  test('reads 404, 429 and any other status', () => {
    expect(readLookup(ED25519.line, answer(404, 'None of your SSH keys...'))).toEqual({ kind: 'not-found' })
    expect(readLookup(ED25519.line, answer(429, '', { 'retry-after': '42' }))).toEqual({
      kind: 'rate-limited',
      retryAfterSeconds: 42,
    })
    for (const value of ['Wed, 21 Oct 2026 07:28:00 GMT', '1.5', '-1', ' 42', '42s', '9999999']) {
      expect(readLookup(ED25519.line, answer(429, '', { 'retry-after': value }))).toEqual({
        kind: 'rate-limited',
        retryAfterSeconds: undefined,
      })
    }
    expect(readLookup(ED25519.line, answer(500, 'oops'))).toEqual({ kind: 'failed', status: 500 })
    expect(readLookup(ED25519.line, answer(302, ''))).toEqual({ kind: 'failed', status: 302 })
    expect(readLookup(ED25519.line, answer(0, ''))).toEqual({ kind: 'failed', status: undefined })
  })
})

describe('the stored account', () => {
  const account = { fingerprint: ED25519.fingerprint, publicKey: ED25519.line, username: 'some-user' }

  test('is read back when it is exactly an account', () => {
    expect(parseAccount(account)).toEqual(account)
  })

  test('is refused in any other shape', () => {
    for (const bad of [
      undefined,
      null,
      'account',
      [account],
      { ...account, extra: true },
      { fingerprint: account.fingerprint, publicKey: account.publicKey },
      { ...account, username: 'bad name' },
      { ...account, username: 'x'.repeat(40) },
      { ...account, fingerprint: 'SHA256:short' },
      { ...account, publicKey: `${ED25519.line} comment` },
      { ...account, publicKey: 'ecdsa-sha2-nistp256 AAAA' },
      { ...account, publicKey: 'ssh-ed25519 AAB=' },
    ]) {
      expect(parseAccount(bad)).toBeUndefined()
    }
  })
})
