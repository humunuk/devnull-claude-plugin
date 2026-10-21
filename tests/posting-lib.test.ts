import { describe, expect, test } from 'claude-code/testing'

import {
  commitRequest,
  completionPlace,
  isDevnullPrompt,
  readPostAnswer,
  readTempDir,
  removeDirArgv,
  removeFileArgv,
  signArgv,
} from '../hooks/lib/posting'

const answer = (status: number, text = '', headers: Record<string, string> = {}) => readPostAnswer({ status, text, headers })

describe('the answer to a posted commit', () => {
  test('is a commit only for a 201 that readCommitted accepts', () => {
    const id = '0190a1b2-c3d4-7e5f-8a9b-000000000042'
    expect(answer(201, `Committed: https://dev-null.sh/@some-user/commits/${id}\n`)).toEqual({
      kind: 'committed',
      committed: { username: 'some-user', id, isPending: false },
    })
    expect(answer(201, 'Committed\n')).toEqual({ kind: 'unexpected-201' })
    expect(answer(200, `Committed: https://dev-null.sh/@some-user/commits/${id}\n`)).toEqual({ kind: 'other', status: 200 })
  })

  test('is told apart by status', () => {
    expect(answer(401)).toEqual({ kind: 'unauthorized' })
    expect(answer(403, 'Your account is banned from /dev/null.\n')).toEqual({ kind: 'forbidden' })
    expect(answer(404)).toEqual({ kind: 'not-found' })
    expect(answer(422)).toEqual({ kind: 'refused' })
    expect(answer(429, '', { 'retry-after': '12' })).toEqual({ kind: 'rate-limited', retryAfterSeconds: 12 })
    expect(answer(429, '', { 'retry-after': '-1' })).toEqual({ kind: 'rate-limited', retryAfterSeconds: undefined })
    expect(answer(500)).toEqual({ kind: 'server-error', status: 500 })
    expect(answer(599)).toEqual({ kind: 'server-error', status: 599 })
    expect(answer(600)).toEqual({ kind: 'other', status: undefined })
    expect(answer(99)).toEqual({ kind: 'other', status: undefined })
    expect(answer(501.5)).toEqual({ kind: 'other', status: undefined })
    expect(answer(Number.NaN)).toEqual({ kind: 'other', status: undefined })
  })
})

describe('the folder mktemp -d made', () => {
  test('is the one line it printed, without the newline', () => {
    expect(readTempDir('/tmp/tmp.Ab3dE5gH9k\n')).toBe('/tmp/tmp.Ab3dE5gH9k')
    expect(readTempDir('/var/folders/k8/x_y/T/tmp.Ab3dE5gH\n')).toBe('/var/folders/k8/x_y/T/tmp.Ab3dE5gH')
    for (const name of ['tmp.Zy7UUU', 'tmp.Ab3dE5g', 'tmp.Ab3dE5gH9']) {
      expect(readTempDir(`/tmp/${name}\n`)).toBe(`/tmp/${name}`)
    }
  })

  test('is refused for anything else', () => {
    for (const stdout of [
      '',
      '\n',
      '/tmp/tmp.Ab3dE5gH9k',
      '/tmp/tmp.Ab3dE5gH9k\n\n',
      ' /tmp/tmp.Ab3dE5gH9k\n',
      '/tmp/tmp.Ab3dE5gH9k \n',
      '/tmp/../tmp.Ab3dE5gH9k\n',
      '/tmp/./tmp.Ab3dE5gH9k\n',
      '/tmp/tmp.Ab3dE\n',
      '/tmp/tmp.Ab3dE5gH9kL\n',
      '/tmp/tmp.Ab3dE5gH9kLm\n',
      '/tmp/tmp.Ab3dE5gH9k/\n',
      '/tmp/tmp.Ab3dE5gH9k/x\n',
      '/tmp/TMP.Ab3dE5gH9k\n',
      '/tmp/a\u0000b/tmp.Ab3dE5gH9k\n',
      '/tmp/a\u2028b/tmp.Ab3dE5gH9k\n',
    ]) {
      expect(readTempDir(stdout)).toBeUndefined()
    }
  })
})

describe('the commands posting runs', () => {
  test('are fixed argv arrays, the path last and after -- where the command takes options', () => {
    expect(signArgv('/tmp/tmp.Ab3dE5gH9k/signing.pub')).toEqual([
      'ssh-keygen',
      '-Y',
      'sign',
      '-n',
      'devnull-commit',
      '-f',
      '/tmp/tmp.Ab3dE5gH9k/signing.pub',
    ])
    expect(removeFileArgv('/tmp/tmp.Ab3dE5gH9k/signing.pub')).toEqual(['rm', '-f', '--', '/tmp/tmp.Ab3dE5gH9k/signing.pub'])
    expect(removeDirArgv('/tmp/tmp.Ab3dE5gH9k')).toEqual(['rmdir', '--', '/tmp/tmp.Ab3dE5gH9k'])
  })

  test('send the payload as the body, with the signature in its header', () => {
    expect(commitRequest('1\n2\n\nhi', 'U1NIU0lH')).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8', Accept: 'text/plain', 'X-SSH-Signature': 'U1NIU0lH' },
      body: '1\n2\n\nhi',
    })
  })
})

describe('the prompt box', () => {
  test('completes the first word after /devnull, and the second after /devnull reply', () => {
    expect(completionPlace('/devnull co', 9)).toBe('subcommand')
    expect(completionPlace('/devnull reply ab', 15)).toBe('reply-hash')
    expect(completionPlace('/devnull reply ab', 9)).toBe('subcommand')
    expect(completionPlace('/devnull commit ab', 16)).toBe('none')
    expect(completionPlace('/devnull', 0)).toBe('none')
  })

  test('drops a proposed prompt that would run /devnull', () => {
    expect(isDevnullPrompt('/devnull commit hi')).toBe(true)
    expect(isDevnullPrompt(' \t/DEVNULL reply abc1234 hi')).toBe(true)
    expect(isDevnullPrompt('/devnullsomething')).toBe(true)
    expect(isDevnullPrompt('run /devnull commit hi')).toBe(false)
    expect(isDevnullPrompt('/dev/null')).toBe(false)
  })
})
