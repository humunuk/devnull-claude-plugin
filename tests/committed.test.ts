import { describe, expect, test } from 'claude-code/testing'

import { readCommitted } from '../hooks/lib/committed'
import { commitId } from './fixtures/commits'

const PENDING = ' (pending review, only you can see it until it is approved)'

describe('the commit answer', () => {
  const id = commitId(5)
  const url = `https://dev-null.sh/@some-user/commits/${id}`

  test('gives the username and id of a published commit', () => {
    expect(readCommitted(`Committed: ${url}\n`)).toEqual({ username: 'some-user', id, isPending: false })
  })

  test('says when the commit waits for review', () => {
    expect(readCommitted(`Committed: ${url}${PENDING}\n`)).toEqual({ username: 'some-user', id, isPending: true })
  })

  test('is refused in any other form', () => {
    for (const bad of [
      '',
      `Committed: ${url}`,
      `Committed: ${url}\n\n`,
      `Committed: ${url}\r\n`,
      `committed: ${url}\n`,
      `Committed:  ${url}\n`,
      ` Committed: ${url}\n`,
      `Committed: ${url} and more\n`,
      `Committed: ${url}${PENDING}`,
      `Committed: ${url} (pending review)\n`,
      `Committed: ${url}\nCommitted: ${url}\n`,
      `Committed: ${url}?x=1\n`,
      `Committed: ${url}/\n`,
      `Committed: http://dev-null.sh/@some-user/commits/${id}\n`,
      `Committed: https://evil.example/@some-user/commits/${id}\n`,
      `Committed: https://dev-null.sh.evil.example/@some-user/commits/${id}\n`,
      `Committed: https://dev-null.sh/@some_user/commits/${id}\n`,
      `Committed: https://dev-null.sh/@${'x'.repeat(40)}/commits/${id}\n`,
      `Committed: https://dev-null.sh/@some-user/commits/${id.toUpperCase()}\n`,
      `Committed: https://dev-null.sh/@some-user/commits/${'-'.repeat(36)}\n`,
      `Committed: https://dev-null.sh/@some-user/commits/${id.replace(/-/g, '0')}\n`,
      `Committed: https://dev-null.sh/@some\u202euser/commits/${id}\n`,
      `\u001b[2JCommitted: ${url}\n`,
      'The signature is invalid.\n',
      '<html>maintenance</html>',
    ]) {
      expect(readCommitted(bad)).toBeUndefined()
    }
  })
})
