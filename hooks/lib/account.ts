// What setup keeps in `$.store`: the chosen key and the /dev/null username.
// Nothing else about the person is kept (security rule 7).

import { FINGERPRINT, decodeBase64 } from './keys'

export const ACCOUNT_KEY = 'account'

export type Account = {
  /** `SHA256:...`, as `ssh-keygen -lf` prints it. */
  fingerprint: string
  /** `<type> <base64>`, the line sent to the key lookup and used to sign. */
  publicKey: string
  username: string
}

export const USERNAME = /^[A-Za-z0-9-]{1,39}$/

const PUBLIC_KEY = /^(ssh-ed25519|ssh-rsa) ([A-Za-z0-9+/]+={0,2})$/

/**
 * The account `$.store` holds, or undefined when what it holds is not exactly
 * one: the store can be edited by hand, so it is checked like any outside data.
 */
export function parseAccount(value: unknown): Account | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== 'fingerprint,publicKey,username') return undefined

  const fingerprint: unknown = Reflect.get(value, 'fingerprint')
  const publicKey: unknown = Reflect.get(value, 'publicKey')
  const username: unknown = Reflect.get(value, 'username')
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) return undefined
  if (typeof username !== 'string' || !USERNAME.test(username)) return undefined
  if (typeof publicKey !== 'string') return undefined
  const base64 = PUBLIC_KEY.exec(publicKey)?.[2]
  if (base64 === undefined || decodeBase64(base64) === undefined) return undefined

  return { fingerprint, publicKey, username }
}
