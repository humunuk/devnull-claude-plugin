import { describe, expect, test } from 'claude-code/testing'

import { commitUrl, profileUrl } from '../hooks/lib/links'
import { commitId } from './fixtures/commits'

describe('links', () => {
  test('are built on the fixed host from a valid username and id', () => {
    expect(commitUrl('some-user', commitId(1))).toBe(`https://dev-null.sh/@some-user/commits/${commitId(1)}`)
    expect(profileUrl('Some-User-9')).toBe('https://dev-null.sh/@Some-User-9')
    expect(profileUrl('x'.repeat(39))).toBe(`https://dev-null.sh/@${'x'.repeat(39)}`)
  })

  test('are not built from any other username', () => {
    for (const bad of ['', 'x'.repeat(40), 'some user', 'some_user', 'a/b', '../admin', 'evil.example', '@some', 'some\u202euser', 'some\nuser']) {
      expect(profileUrl(bad)).toBeUndefined()
      expect(commitUrl(bad, commitId(1))).toBeUndefined()
    }
  })

  test('are not built from any other id', () => {
    for (const bad of [
      '',
      commitId(1).toUpperCase(),
      commitId(1).replace(/-/g, ''),
      `${commitId(1)}/../x`,
      `${commitId(1)}?x=1`,
      ` ${commitId(1)}`,
      '0190a1b2-c3d4-7e5f-8a9b-00000000000g',
      'a1b2c3d',
    ]) {
      expect(commitUrl('some-user', bad)).toBeUndefined()
    }
  })
})
