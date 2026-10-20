// The `X-SSH-Signature` header value from what `ssh-keygen -Y sign` printed.
// Pure: the caller runs ssh-keygen.
//
// OpenSSH (checked with 8.9p1, Ed25519 and RSA keys through an agent) prints
// `-----BEGIN SSH SIGNATURE-----`, the base64 of the signature in lines of 70,
// and `-----END SSH SIGNATURE-----`, each ending in a newline. The header
// carries the base64 lines joined, so only base64 characters may reach it.

import { decodeBase64 } from './keys'

const BEGIN = '-----BEGIN SSH SIGNATURE-----'
const END = '-----END SSH SIGNATURE-----'

// Far above what OpenSSH's largest key, RSA 16384, signs to: its public key and
// its signature, about 4,200 bytes, are about 5,600 base64 characters.
const SIGNATURE_MAX = 16384

const BASE64_LINE = /^[A-Za-z0-9+/=]+$/

// Every SSH signature blob starts with these six bytes (PROTOCOL.sshsig).
const MAGIC = 'SSHSIG'

/**
 * The signature's base64, joined into one line, or undefined unless `stdout`
 * is exactly the armour lines with base64 lines between them (`\r\n` allowed)
 * that decode to an SSH signature.
 */
export function readSignature(stdout: string): string | undefined {
  const lines = stdout.split('\n').map(line => line.replace(/\r$/, ''))
  if (lines[lines.length - 1] === '') lines.pop()
  if (lines.length < 3 || lines[0] !== BEGIN || lines[lines.length - 1] !== END) return undefined

  const body = lines.slice(1, -1)
  if (!body.every(line => BASE64_LINE.test(line))) return undefined
  const joined = body.join('')
  if (joined.length > SIGNATURE_MAX || !BASE64_LINE.test(joined)) return undefined

  const blob = decodeBase64(joined)
  if (blob === undefined || blob.length < MAGIC.length) return undefined
  if (String.fromCharCode(...blob.subarray(0, MAGIC.length)) !== MAGIC) return undefined

  return joined
}
