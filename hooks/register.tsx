// The devnull mod's hooks module: it declares `/devnull` and wires each
// feature's hooks. A plugin's hooks on one event nest in the order they are
// registered, first outermost, so every subcommand comes before the usage
// fallback.

import type { Register } from 'claude-code'

import { registerUsage } from './commands'
import { registerPane } from './pane'
import { registerPosting } from './posting'
import { registerSetup } from './setup'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'devnull',
      description: 'Unofficial /dev/null (dev-null.sh) client: choose your signing key and username',
      argumentHint: '[setup]',
      immediate: true,
    })

    return next(e)
  })

  registerSetup(on)
  registerPosting(on)
  registerPane(on)
  registerUsage(on)
}
