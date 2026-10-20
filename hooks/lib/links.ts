// The only way the mod makes a link to dev-null.sh (security rule 4): from a
// username and a commit id that pass the patterns here, on the fixed host. A
// URL from a response is never passed on; the caller rebuilds it from the
// parts the guards accepted. Pure.

import type { RenderSurface } from 'claude-code'

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

/**
 * The commit's link as a `Link` on `surface` takes it: commitUrl's on the
 * terminal, and with the `@` before the username written `%40` on every other
 * surface. The engine (2.1.304) holds a link's href on every surface but the
 * terminal to printable ASCII, https, canonical form and no raw `@`, and draws
 * one that fails as plain text ("its href holds a raw @, and the <surface>
 * surface is sent no other link"); dev-null.sh serves
 * `/%40<username>/commits/<id>` as the same page (200, checked live). A
 * terminal without OSC 8 links prints the address itself, so there the `@`
 * that reads normally stays.
 */
export function commitLink(username: string, id: string, surface: RenderSurface): string | undefined {
  const url = commitUrl(username, id)
  if (url === undefined || surface === 'terminal') return url

  return `${ORIGIN}/%40${url.slice(`${ORIGIN}/@`.length)}`
}
