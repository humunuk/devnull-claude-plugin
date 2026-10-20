// The devnull mod's hooks module: it declares `/devnull` and wires each
// feature's hooks. A plugin's hooks on one event nest in the order they are
// registered, first outermost, so every subcommand comes before the usage
// fallback.

import type { Register } from 'claude-code'

import { endAlerts, registerAlerts } from './alerts'
import { registerUsage } from './commands'
import { endPane, registerPane } from './pane'
import { registerPosting } from './posting'
import { registerSetup } from './setup'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'devnull',
      description: 'Unofficial /dev/null (dev-null.sh) client: choose your signing key and username',
      argumentHint: '[setup]',
      immediate: true,
    })

    return next(e)
  })

  // The mod's one `session.end` hook (validate allows a single unmatched hook
  // per event across the mod): each feature stops what it runs.
  on('session.end', ($, e, next) => {
    endPane()
    endAlerts(e.reason)

    return next(e)
  })

  registerSetup(on)
  registerPosting(on)
  registerPane(on)
  registerAlerts(on, options)
  registerUsage(on)
}
