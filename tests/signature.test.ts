import { describe, expect, test } from 'claude-code/testing'

import { readSignature } from '../hooks/lib/signature'
import { ED25519_SIGNATURE, RSA_SIGNATURE } from './fixtures/signatures'

const BEGIN = '-----BEGIN SSH SIGNATURE-----'
const END = '-----END SSH SIGNATURE-----'

/** The base64 lines between the armour of a fixture. */
const inner = (armoured: string) => armoured.split('\n').filter(line => line !== '' && !line.startsWith('-----'))

describe('the signature header', () => {
  test('is the base64 lines of real ssh-keygen output, joined', () => {
    const ed = readSignature(ED25519_SIGNATURE)
    expect(ed).toBe(inner(ED25519_SIGNATURE).join(''))
    expect(ed).toStartWith('U1NIU0lH')
    expect(readSignature(RSA_SIGNATURE)).toBe(inner(RSA_SIGNATURE).join(''))
  })

  test('reads Windows line ends and output with no final newline', () => {
    const joined = inner(ED25519_SIGNATURE).join('')
    expect(readSignature(ED25519_SIGNATURE.replace(/\n/g, '\r\n'))).toBe(joined)
    expect(readSignature(ED25519_SIGNATURE.trimEnd())).toBe(joined)
  })

  test('is refused with any other armour', () => {
    const lines = inner(ED25519_SIGNATURE)
    for (const bad of [
      '',
      `${END}\n`,
      `${BEGIN}\n${END}\n`,
      lines.join('\n'),
      `${BEGIN}\n${lines.join('\n')}\n`,
      `${lines.join('\n')}\n${END}\n`,
      `-----BEGIN SSH SIGNATURE----\n${lines.join('\n')}\n${END}\n`,
      `-----BEGIN PGP SIGNATURE-----\n${lines.join('\n')}\n-----END PGP SIGNATURE-----\n`,
      ` ${BEGIN}\n${lines.join('\n')}\n${END}\n`,
      `Signing data on standard input\n${ED25519_SIGNATURE}`,
      `${ED25519_SIGNATURE}${ED25519_SIGNATURE}`,
      `${ED25519_SIGNATURE}\n`,
      `${ED25519_SIGNATURE}trailing`,
    ]) {
      expect(readSignature(bad)).toBeUndefined()
    }
  })

  test('is refused with anything but base64 between the armour lines', () => {
    const lines = inner(ED25519_SIGNATURE)
    const armour = (body: readonly string[]) => [BEGIN, ...body, END, ''].join('\n')
    const first = lines[0] ?? ''
    for (const body of [
      [`${first}\r\nX-Injected: yes`, ...lines.slice(1)],
      [`${first} `, ...lines.slice(1)],
      [`${first}\u202e`, ...lines.slice(1)],
      [`${first}\u001b[31m`, ...lines.slice(1)],
      [first.replace('U', '-'), ...lines.slice(1)],
      [first, '', ...lines.slice(1)],
      [first, ...lines.slice(2)],
      ['AAAA'],
      ['QUFBQUFBQUFB'],
      [`${'A'.repeat(70)}\n`.repeat(300)],
    ]) {
      expect(readSignature(armour(body))).toBeUndefined()
    }
  })

  test('is refused over 16384 characters, even with exact armour and an SSH signature blob', () => {
    // 'SSHSIG' then zero bytes, as canonical base64 in lines of 70.
    const armour = (base64: string) => [BEGIN, ...(base64.match(/.{1,70}/g) ?? []), END, ''].join('\n')
    const binary = `SSHSIG${'\u0000'.repeat(12300)}`
    const over = btoa(binary)
    const under = btoa(binary.slice(0, 12285))

    expect(over).toStartWith('U1NIU0lH')
    expect(over).toHaveLength(16408)
    expect(under).toHaveLength(16380)
    // The same shape under the cap is read, so only the length refuses the longer one.
    expect(readSignature(armour(under))).toBe(under)
    expect(readSignature(armour(over))).toBeUndefined()
  })
})
