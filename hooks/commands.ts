// The innermost `/devnull` hook: a run no subcommand took (none, or an
// unknown word) gets the usage text, which lists only the subcommands the mod
// has. Each subcommand's module registers its own `command.run` hook, outside
// this one, and passes a run on with `next(e)` when it is not its own.

import type { On } from 'claude-code'

import { SETUP_USAGE } from './setup'

const USAGE: readonly string[] = [...SETUP_USAGE]

export function usageText(): string {
  return ['Usage:', ...USAGE.map(line => `  ${line}`)].join('\n')
}

export function registerUsage(on: On): void {
  on('command.run', { command: 'devnull' }, () => ({ text: usageText() }))
}
