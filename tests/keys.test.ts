import { describe, expect, test } from 'claude-code/testing'

import { readAgentList } from '../hooks/lib/agent'
import { COMMENT_MAX, decodeBase64, findKey, parseAgentKeys, parseKeyChoice, parseKeyLine } from '../hooks/lib/keys'
import { ECDSA, ED25519, RSA, RSA_1024, RSA_2048 } from './fixtures/keys'
import { agentList } from './helpers'

describe('fingerprints', () => {
  test('match what ssh-keygen -lf prints for an Ed25519 key', async () => {
    const key = await parseKeyLine(`${ED25519.line} ${ED25519.comment}`)
    expect(key?.fingerprint).toBe(ED25519.fingerprint)
    expect(key?.type).toBe('ssh-ed25519')
    expect(key?.publicKey).toBe(ED25519.line)
    expect(key?.comment).toBe(ED25519.comment)
  })

  test('match what ssh-keygen -lf prints for an RSA key', async () => {
    const key = await parseKeyLine(`${RSA.line} ${RSA.comment}`)
    expect(key?.fingerprint).toBe(RSA.fingerprint)
    expect(key?.type).toBe('ssh-rsa')
  })
})

describe('ssh-add -L output', () => {
  test('keeps Ed25519 and RSA keys in the agent order and passes over the rest', async () => {
    const [, edBase64 = ''] = ED25519.line.split(' ')
    const output = agentList(
      `${ECDSA.line} ${ECDSA.comment}`,
      `${RSA.line} ${RSA.comment}`,
      `sk-ssh-ed25519@openssh.com ${edBase64} security key`,
      `ssh-ed25519-cert-v01@openssh.com ${edBase64} a certificate`,
      'The agent has no identities.',
      '',
      'ssh-ed25519 not-base64!! junk',
      'ssh-ed25519',
      `ssh-rsa ${edBase64} an Ed25519 blob named RSA`,
      `ssh-ed25519 ${edBase64.slice(0, -4)} cut short`,
      `  ${ED25519.line} leading spaces`,
      `${ED25519.line} ${ED25519.comment}`,
      `${ED25519.line} the same key again`,
    )

    const keys = await parseAgentKeys(output)

    expect(keys.map(key => key.fingerprint)).toEqual([RSA.fingerprint, ED25519.fingerprint])
    expect(keys.map(key => key.comment)).toEqual([RSA.comment, ED25519.comment])
  })

  test('leaves out an RSA key under 2048 bits, which dev-null.sh refuses', async () => {
    expect(await parseKeyLine(`${RSA_1024.line} ${RSA_1024.comment}`)).toBeUndefined()
    const keys = await parseAgentKeys(agentList(`${RSA_1024.line} ${RSA_1024.comment}`, `${ED25519.line} ${ED25519.comment}`))
    expect(keys.map(key => key.fingerprint)).toEqual([ED25519.fingerprint])
    expect(await readAgentList(0, agentList(`${RSA_1024.line} ${RSA_1024.comment}`))).toEqual({ kind: 'no-usable-key' })
  })

  test('keeps an RSA key of exactly 2048 bits', async () => {
    const key = await parseKeyLine(`${RSA_2048.line} ${RSA_2048.comment}`)
    expect(key?.fingerprint).toBe(RSA_2048.fingerprint)
    expect(key?.type).toBe('ssh-rsa')
  })

  test('reads a key with no comment', async () => {
    const keys = await parseAgentKeys(`${ED25519.line}\n`)
    expect(keys).toHaveLength(1)
    expect(keys[0]?.comment).toBe('')
  })

  test('reads Windows line ends', async () => {
    const keys = await parseAgentKeys(`${ED25519.line} ${ED25519.comment}\r\n`)
    expect(keys[0]?.comment).toBe(ED25519.comment)
  })

  test('an empty agent, an unreachable one and a failing ssh-add are told apart', async () => {
    expect(await readAgentList(1, 'The agent has no identities.\n')).toEqual({ kind: 'no-usable-key' })
    expect(await readAgentList(1, '')).toEqual({ kind: 'failed' })
    expect(await readAgentList(1, 'something else\n')).toEqual({ kind: 'failed' })
    expect(await readAgentList(2, '')).toEqual({ kind: 'unreachable' })
    expect(await readAgentList(127, '')).toEqual({ kind: 'failed' })
    expect(await readAgentList(0, agentList(`${ECDSA.line} ${ECDSA.comment}`))).toEqual({ kind: 'no-usable-key' })
    const listed = await readAgentList(0, agentList(`${ED25519.line} ${ED25519.comment}`))
    expect(listed.kind).toBe('keys')
  })

  test('a hostile comment is cleaned of escape sequences and bidi controls, and capped', async () => {
    const comment = [
      '\u001b[31mred\u001b[0m',
      '\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007',
      '\u001b]0;title\u001b\\',
      '\u202egnp.exe\u202c',
      '\u2066iso\u2069',
      '\u009b31m',
      '\u0007bell\u0000nul\u007fdel',
      '\u2028sep',
      'A'.repeat(500),
    ].join(' ')

    const key = await parseKeyLine(`${ED25519.line} ${comment}`)
    const cleaned = key?.comment ?? ''

    expect(key?.fingerprint).toBe(ED25519.fingerprint)
    expect(cleaned).toStartWith('red link  gnp.exe iso 31m bellnuldel  sep AAA')
    expect(cleaned).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
    expect(cleaned).not.toContain('evil.example')
    expect(Array.from(cleaned)).toHaveLength(COMMENT_MAX)
    expect(cleaned).toEndWith('\u2026')
  })

  test('refuses a line too long to be a key', async () => {
    expect(await parseKeyLine(`ssh-rsa ${'A'.repeat(4100)}`)).toBeUndefined()
  })
})

describe('base64', () => {
  test('only the canonical spelling decodes', () => {
    expect(decodeBase64('AAAA')).toEqual(new Uint8Array([0, 0, 0]))
    expect(decodeBase64('AAB=')).toBeUndefined()
    expect(decodeBase64('AAA')).toBeUndefined()
    expect(decodeBase64('AA AA')).toBeUndefined()
    expect(decodeBase64('')).toBeUndefined()
  })
})

describe('choosing a key', () => {
  test('by number or by fingerprint, and nothing else', async () => {
    const keys = await parseAgentKeys(agentList(`${ED25519.line} a`, `${RSA.line} b`))

    const second = parseKeyChoice('2')
    const byFingerprint = parseKeyChoice(ED25519.fingerprint)
    expect(second === undefined ? undefined : findKey(keys, second)?.fingerprint).toBe(RSA.fingerprint)
    expect(byFingerprint === undefined ? undefined : findKey(keys, byFingerprint)?.fingerprint).toBe(ED25519.fingerprint)

    const third = parseKeyChoice('3')
    expect(third === undefined ? 'unparsed' : findKey(keys, third)).toBeUndefined()

    for (const bad of ['0', '01', '-1', '1000', 'one', 'SHA256:short', `${ED25519.fingerprint}=`, `MD5:${ED25519.fingerprint.slice(7)}`]) {
      expect(parseKeyChoice(bad)).toBeUndefined()
    }
  })
})
