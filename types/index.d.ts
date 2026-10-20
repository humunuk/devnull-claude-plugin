// The devnull mod's `$.state` contract: drawing state, kept for the session
// and across hot reloads. Setup keeps nothing here; what it chooses lives in
// `$.store` (see hooks/lib/account.ts), which survives sessions. The pane and
// reply alerts declare their values here when they arrive.

export type DevnullState = Record<never, never>

declare module 'claude-code' {
  interface PluginState {
    devnull: DevnullState
  }
}
