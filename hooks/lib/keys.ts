// The SSH agent's public keys, as `ssh-add -L` lists them, and the fingerprints
// the person knows them by. Pure: the caller runs `ssh-add` and hands over its
// output.

import { cleanLine } from './text'

export type KeyType = 'ssh-ed25519' | 'ssh-rsa'

export type AgentKey = {
  type: KeyType
  /** `<type> <base64>`: the line the server is sent, with no comment. */
  publicKey: string
  /** `SHA256:` and the unpadded base64 of the blob's SHA-256, as `ssh-keygen -lf` prints it. */
  fingerprint: string
  /** The key's comment, cleaned for drawing and capped; `''` when it has none. */
  comment: string
}

export const COMMENT_MAX = 60

// The longest key line kept: a 16384-bit RSA key, OpenSSH's largest, is about
// 2,800 base64 characters.
const BASE64_MAX = 4096

// `ssh-add -L` writes `<type> <base64> <comment>`, one space apart. Only the two
// types the server accepts are kept; ECDSA, security keys (`sk-`) and
// certificates (`-cert-v01@openssh.com`) never match the exact type.
// The comment is matched with [\s\S] so a line separator inside it (U+2028)
// does not drop the key; cleanLine flattens it.
const KEY_LINE = /^(ssh-ed25519|ssh-rsa) ([A-Za-z0-9+/]+={0,2})(?: ([\s\S]*))?$/

export const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/

/**
 * Reads `ssh-add -L`'s standard output into the agent's Ed25519 and RSA keys,
 * in the agent's order, each once. Any other line is passed over.
 */
export async function parseAgentKeys(stdout: string): Promise<AgentKey[]> {
  const keys: AgentKey[] = []
  for (const raw of stdout.split('\n')) {
    const key = await parseKeyLine(raw.replace(/\r$/, ''))
    if (key !== undefined && !keys.some(one => one.fingerprint === key.fingerprint)) keys.push(key)
  }

  return keys
}

/**
 * One `ssh-add -L` line as an Ed25519 or RSA key, or undefined when the line
 * is anything else or its blob does not hold a key of the type it names.
 */
export async function parseKeyLine(line: string): Promise<AgentKey | undefined> {
  const match = KEY_LINE.exec(line)
  if (match === null) return undefined
  const [, typeText, base64, comment = ''] = match
  if (typeText === undefined || base64 === undefined) return undefined
  const type = asKeyType(typeText)
  if (type === undefined || base64.length > BASE64_MAX) return undefined

  const blob = decodeBase64(base64)
  if (blob === undefined || !isKeyBlob(type, blob)) return undefined

  return {
    type,
    publicKey: `${type} ${base64}`,
    fingerprint: await fingerprintOf(blob),
    comment: cleanLine(comment, COMMENT_MAX),
  }
}

function asKeyType(text: string): KeyType | undefined {
  switch (text) {
    case 'ssh-ed25519':
    case 'ssh-rsa':
      return text
    default:
      return undefined
  }
}

/** The SHA-256 fingerprint of a key blob, in `ssh-keygen -lf`'s format. */
export async function fingerprintOf(blob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', blob))

  return `SHA256:${encodeBase64(digest).replace(/=+$/, '')}`
}

/**
 * Strict base64: the canonical encoding of some bytes, or undefined. A string
 * `btoa` would not write back the same way (bad padding, stray bits) is refused,
 * so one key has one spelling.
 */
export function decodeBase64(text: string): Uint8Array | undefined {
  if (text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    return undefined
  }
  let binary: string
  try {
    binary = atob(text)
  } catch {
    return undefined
  }
  if (btoa(binary) !== text) return undefined

  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary)
}

// dev-null.sh refuses RSA keys under 2048 bits (SshPublicKey::MinimumRsaBits
// at 3e55ca6) with the same 404 as an unknown key, so such a key is not usable.
const RSA_MIN_BITS = 2048

/**
 * Whether `blob` is the SSH wire encoding of a public key of `type` (RFC 4253
 * section 6.6, RFC 8709) that dev-null.sh accepts: the type as an SSH string,
 * then an Ed25519 key's 32 bytes, or an RSA key's exponent and a modulus of at
 * least 2048 bits, and nothing after.
 */
function isKeyBlob(type: KeyType, blob: Uint8Array): boolean {
  const reader = new BlobReader(blob)
  const name = reader.string()
  if (name === undefined || new TextDecoder().decode(name) !== type) return false

  switch (type) {
    case 'ssh-ed25519': {
      const point = reader.string()

      return point !== undefined && point.length === 32 && reader.isAtEnd()
    }
    case 'ssh-rsa': {
      const exponent = reader.string()
      const modulus = reader.string()

      return (
        exponent !== undefined &&
        exponent.length > 0 &&
        modulus !== undefined &&
        reader.isAtEnd() &&
        mpintBits(modulus) >= RSA_MIN_BITS
      )
    }
    default: {
      const unknownType: never = type

      return unknownType
    }
  }
}

/** The bit length of an SSH mpint's magnitude: leading zero bytes skipped, then the top byte's bits. */
function mpintBits(mpint: Uint8Array): number {
  let start = 0
  while (start < mpint.length && mpint[start] === 0) start += 1
  const top = mpint[start]
  if (top === undefined) return 0

  return (mpint.length - start - 1) * 8 + (32 - Math.clz32(top))
}

class BlobReader {
  private offset = 0

  constructor(private readonly bytes: Uint8Array) {}

  /** The next SSH string (a big-endian uint32 length, then that many bytes). */
  string(): Uint8Array | undefined {
    const at = this.offset
    if (at + 4 > this.bytes.length) return undefined
    const length = new DataView(this.bytes.buffer, this.bytes.byteOffset + at, 4).getUint32(0)
    if (at + 4 + length > this.bytes.length) return undefined
    this.offset = at + 4 + length

    return this.bytes.subarray(at + 4, at + 4 + length)
  }

  isAtEnd(): boolean {
    return this.offset === this.bytes.length
  }
}

export type KeyChoice = { kind: 'number'; number: number } | { kind: 'fingerprint'; fingerprint: string }

/**
 * What the person typed to pick a key: its number in the list setup printed
 * (1 to 999), or its fingerprint; undefined for anything else.
 */
export function parseKeyChoice(text: string): KeyChoice | undefined {
  if (/^[1-9][0-9]{0,2}$/.test(text)) return { kind: 'number', number: Number(text) }
  if (FINGERPRINT.test(text)) return { kind: 'fingerprint', fingerprint: text }

  return undefined
}

/** The agent key the choice names, or undefined when the agent holds none such. */
export function findKey(keys: readonly AgentKey[], choice: KeyChoice): AgentKey | undefined {
  switch (choice.kind) {
    case 'number':
      return keys[choice.number - 1]
    case 'fingerprint':
      return keys.find(key => key.fingerprint === choice.fingerprint)
    default: {
      const unknownChoice: never = choice

      return unknownChoice
    }
  }
}
