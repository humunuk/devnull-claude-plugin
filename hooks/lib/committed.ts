// dev-null.sh's answer to a posted commit. Pure: the caller sends the commit.
//
// Upstream (nunomaduro/dev-null.sh at 3e55ca6): Cli\CommitController answers
// 201, `text/plain`, with `Committed: <url>`, then ` (pending review, only you
// can see it until it is approved)` when the commit waits for review, then a
// newline. The url is the `commit.show` route, `@{user:username}/commits/{commit}`
// on the app's host, the commit by its UUID. Only the username and the id are
// kept from it; the link shown is rebuilt with commitUrl.

import { commitUrl } from './links'

export type Committed = { username: string; id: string; isPending: boolean }

const COMMITTED =
  /^Committed: https:\/\/dev-null\.sh\/@([A-Za-z0-9-]{1,39})\/commits\/([0-9a-f-]{36})( \(pending review, only you can see it until it is approved\))?\n$/

/** The username and commit id in a 201 body, or undefined when the body is anything else. */
export function readCommitted(text: string): Committed | undefined {
  const match = COMMITTED.exec(text)
  if (match === null) return undefined
  const [, username, id, pending] = match
  if (username === undefined || id === undefined || commitUrl(username, id) === undefined) return undefined

  return { username, id, isPending: pending !== undefined }
}
