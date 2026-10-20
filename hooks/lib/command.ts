// What every `/devnull` subcommand shares: splitting what was typed after
// `/devnull`, who may run it, and the fixed lines it answers with when it
// cannot run. Pure.
//
// A command's `text` is its output row, which the model reads too, so it
// carries only the mod's fixed messages and the person's own local data,
// never text from dev-null.sh (security rule 2).

import type { PromptOrigin } from 'claude-code'

export const FAILED_TEXT = '/devnull failed unexpectedly. Run it again; if it keeps failing, restart Claude Code.'

export function notTypedText(name: string): string {
  return `/devnull ${name} runs only when you type it at the prompt yourself.`
}

/** Whether the run came from the person's own Enter at the prompt. */
export function isTypedByPerson(origin: PromptOrigin): boolean {
  return origin.kind === 'composer'
}

/** The first word of the arguments (the subcommand), and what follows it. */
export function splitSubcommand(args: string): { name: string; rest: string } {
  const trimmed = args.replace(/^\s+/, '')
  const end = trimmed.search(/\s/)
  if (end === -1) return { name: trimmed, rest: '' }

  return { name: trimmed.slice(0, end), rest: trimmed.slice(end).replace(/^\s+/, '') }
}

/** Arguments as whitespace-separated words. */
export function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(word => word.length > 0)
}
