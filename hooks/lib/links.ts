// The only way the mod makes a link to dev-null.sh (security rule 4): from a
// username and a commit id that pass the patterns here, on the fixed host. A
// URL from a response is never passed on; the caller rebuilds it from the
// parts the guards accepted. Pure.

import { USERNAME } from './account'

export const ORIGIN = 'https://dev-null.sh'

/** A commit id as dev-null.sh writes it: a UUID in lowercase hex. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** `https://dev-null.sh/@<username>/commits/<id>`, or undefined when either part is not valid. */
export function commitUrl(username: string, id: string): string | undefined {
  if (!USERNAME.test(username) || !UUID.test(id)) return undefined

  return `${ORIGIN}/@${username}/commits/${id}`
}

/** `https://dev-null.sh/@<username>`, or undefined when the username is not valid. */
export function profileUrl(username: string): string | undefined {
  if (!USERNAME.test(username)) return undefined

  return `${ORIGIN}/@${username}`
}
