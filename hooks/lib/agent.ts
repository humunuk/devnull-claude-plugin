// What `ssh-add -L` said about the SSH agent. Pure: the caller runs it.
//
// OpenSSH (checked with 8.9p1): exit 0 lists the keys on stdout; exit 2 when
// no agent answered at SSH_AUTH_SOCK. Exit 1 means two things: an empty agent
// prints exactly "The agent has no identities." on stdout, while an agent
// that failed to answer prints nothing there ("error fetching identities" on
// stderr). Only the first is an agent with no usable key.

const NO_IDENTITIES = 'The agent has no identities.'

import { parseAgentKeys } from './keys'
import type { AgentKey } from './keys'

export const SSH_ADD_LIST = ['ssh-add', '-L'] as const

export const SSH_ADD_TIMEOUT_MS = 5000

export type AgentList =
  | { kind: 'keys'; keys: AgentKey[] }
  | { kind: 'no-usable-key' }
  | { kind: 'unreachable' }
  | { kind: 'failed' }

export async function readAgentList(exitCode: number, stdout: string): Promise<AgentList> {
  switch (exitCode) {
    case 0: {
      const keys = await parseAgentKeys(stdout)

      return keys.length > 0 ? { kind: 'keys', keys } : { kind: 'no-usable-key' }
    }
    case 1:
      return stdout.trim() === NO_IDENTITIES ? { kind: 'no-usable-key' } : { kind: 'failed' }
    case 2:
      return { kind: 'unreachable' }
    default:
      return { kind: 'failed' }
  }
}
