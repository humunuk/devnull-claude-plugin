# devnull-claude-plugin

An unofficial Claude Code mod for /dev/null (https://dev-null.sh): post and reply from a Claude Code session, see your newest commits in a pane, and get told when someone replies. Public and open source at https://github.com/humunuk/devnull-claude-plugin. It is not made by or affiliated with dev-null.sh, and the README and the plugin description say so.

People install this into their own Claude Code sessions, where it runs `ssh-keygen` against their SSH agent and talks to the network for them. Every rule below exists to keep that safe. Where a rule and a convenience conflict, the rule wins. Where something is not covered here, stop and ask instead of choosing.

## Layout

The repository root is the mod and its own marketplace:

- `.claude-plugin/plugin.json` (`"name": "devnull"`) and `.claude-plugin/marketplace.json` (one entry, `"source": "./"`)
- `hooks/hooks.json` (`{ "modules": ["./register.tsx"] }`), `hooks/register.tsx` and the modules it imports
- `types/index.d.ts`: the `$.state` contract, named in `plugin.json` as `"types"`
- `tests/*.test.ts(x)`
- `tsconfig.json`: the one the engine writes on first load (it extends `.claude-plugin/types/tsconfig.json`); committed
- `package.json` and `package-lock.json`: development tooling only, TypeScript pinned to exactly 7.0.2. The mod has no runtime dependencies and never gains one.
- `.claude-plugin/types/` is written by the engine and git-ignored by it. Never edit or commit it.

## Commands

- `npm ci --ignore-scripts` installs the tooling.
- `npm run validate` runs `claude plugin validate .`
- `npm run typecheck` runs `tsc -p .` (it needs `.claude-plugin/types/`, which exists once Claude Code has loaded the mod from this folder).
- `npm test` runs `claude plugin test .`
- `claude --plugin-dir <this folder>` runs a session with the mod loaded; the folder is watched and the mod reloads on save.

## Scope

### Phase 1: now, on the allowed endpoints only

1. `/devnull setup`: pick the signing key from the SSH agent's keys (shown by SHA-256 fingerprint) and enter the /dev/null username. Both are kept in `$.store`. After a commit, if the username in the returned link differs from the stored one, tell the person.
2. `/devnull commit <text>` and `/devnull reply <hash or link> <text>`: post, signed with the chosen key.
3. `/devnull`, registered with `immediate: true`: toggles the pane. Opening it always fetches a fresh list of the person's newest commits (public API, 20 per page), each with its short hash, age, reply and star counts and a link. The pane also has an input to write a new commit.
4. Reply alerts: poll the person's newest commits and replies (`?replies=1`) every 60 s by default, never more often than every 30 s. When a `replies_count` rises, show "N new replies on <hash>" with a link in the band above the prompt, a count in the status line and a toast. Seen counts are kept in `$.store`, so a restart does not alert again. Reply text needs sign-in (phase 2), so phase 1 shows counts only.
5. `/devnull off` and `/devnull on`: stop and resume polling and alerts, and close the pane. Kept in `$.store`.

### Phase 2: blocked upstream

Sign-in as a device, reply text, mentions, the unread count from `GET /api/v1/me`, and the Latest, Trending and Following logs. Phase 2 starts only once nunomaduro/dev-null.sh PR #585 (device authorization grant, RFC 8628) is merged and documented in that repository's README. Build no part of it before then. Never use the `/mobile/authorize` flow with a `devnull://` redirect: that scheme belongs to the official mobile app.

### Not in scope

Images (the official script supports them, but `$.http.fetch` takes a string body, so a binary multipart upload is unverified), quotes, stars, follows, and any tool the model can call.

### Keyboard shortcut: not possible cleanly (checked on Claude Code 2.1.304)

A mod cannot register a key binding, and `~/.claude/keybindings.json` binds only built-in actions, none of which runs a plugin command. A `Button`'s `action` prop can borrow a built-in action's chord, but only while that button is on screen, and it would mean telling users to bind an unrelated engine action. Do not do that. The pane toggles with `/devnull`; inside a focused pane the built-in `ctrl+x x` closes it, and `ctrl+x tab` focuses the band or the pane.

## Allowed endpoints, and nothing else

The base URL is the constant `https://dev-null.sh`. No setting, environment variable or response changes it.

| Endpoint | Use | Source |
|---|---|---|
| `POST /api/cli/key-lookups` | Body: the one chosen public key line (`<type> <base64>`), `text/plain; charset=utf-8`. Answers that key line when it is on the GitHub account of a /dev/null user, else 404 with a plain-text reason. | `app/Http/Controllers/Cli/KeyLookupController.php`, `app/Http/Requests/CreateKeyLookupRequest.php` |
| `POST /api/cli/commits` | Body: the signed payload, `text/plain; charset=utf-8`, with the `X-SSH-Signature` header. Answers 201 `Committed: <url>`, followed by ` (pending review, only you can see it until it is approved)` when pending. Errors are plain text. Shares the 10 attempts a minute per user with every other way of posting. | `app/Http/Controllers/Cli/CommitController.php`, `app/Http/Middleware/AuthenticateSshSignature.php` |
| `GET /api/v1/users/{username}` | A public profile. | README, "Public API" |
| `GET /api/v1/users/{username}/commits` | The user's top-level commits, newest first, 20 a page; `?replies=1` for their replies. Each has `id`, `short_hash`, `body`, `parent_id`, `created_at`, `stars_count`, `replies_count` and `author`. | README, "Public API" |
| `GET /api/v1/commits/{id}` | One commit with its counts. | README, "Public API" |

The public API allows 60 requests a minute per IP address, shared with everything else on that address. Honour 429 and `Retry-After`; back off on 5xx and network errors.

Never call the website's own routes (`/log/*`, `/commits/{id}/replies`, `/search/*`, anything Inertia), even where they answer guests. They are the site's internals, and the maintainers declined a client built on them (PR #92).

All of the above was read from nunomaduro/dev-null.sh at `production` commit `3e55ca6` (2026-10-20). When upstream changes, read the source again before changing the mod.

## Signing a commit (verified with OpenSSH 8.9p1 on 2026-10-20)

- Payload: `<unix seconds>\n<nonce>\n<reply reference, or empty>\n<body>`, with no trailing newline. The nonce is 32 lowercase hex characters from `crypto.getRandomValues`, used once. The server accepts a timestamp within 300 s of its clock and spends each nonce (`app/Services/SignedCommits.php`, `app/Services/SshSignatures.php`).
- Body: 3 to 4000 characters (the server collapses blank lines before measuring); check it before signing. Reply reference: a 7 to 12 character hex hash, or a `https://dev-null.sh/` commit link that holds the commit's UUID; validate it against those two forms before signing (`app/Queries/CommitByReferenceQuery.php`).
- Sign only through the SSH agent:
  1. `ssh-add -L` lists the agent's keys; keep the `ssh-ed25519` and `ssh-rsa` lines. Only the key whose fingerprint the person chose in setup is used. If the agent no longer holds it, stop and say so.
  2. Make a fresh directory with `mktemp -d` and write that one public key line to `<dir>/signing.pub`.
  3. Run `ssh-keygen -Y sign -n devnull-commit -f <dir>/signing.pub` with the payload on stdin; the signature comes back on stdout. No private key file exists next to `signing.pub`, so ssh-keygen can only use the agent: with the key missing from the agent it fails with "No such file or directory" and never prompts for a passphrase. Do not rely on `-U` for this: on OpenSSH 8.9 it still falls back to a private key file and asks for its passphrase.
  4. Remove `<dir>/signing.pub` by name, then `rmdir <dir>`. Never delete recursively.
  5. `X-SSH-Signature` is the signature's base64 lines (everything between the armour lines) joined without newlines. Refuse anything that is not `[A-Za-z0-9+/=]+`.
- The mod never reads `~/.ssh`, never handles a private key, and never sends any public key but the chosen one.
- The README states the requirements: Claude Code in a terminal (`$.process` is CLI only), OpenSSH 8.1 or later (`ssh-keygen -Y sign`), and an Ed25519 or RSA key that is on the person's GitHub account and loaded in their SSH agent.

## Security rules

1. Only the person posts. `/devnull commit` and `/devnull reply` run only when `e.origin.kind === 'composer'`; every other origin is refused. The pane's input posts from its own submit handler. The mod registers no tool the model can call.
2. Nothing from dev-null.sh reaches the model. Other people's text (commit bodies, usernames, server error text) is drawn only in the pane, the band, the status line and toasts. A command's `text` and `context`, `prompt.compose`, `prompt.submit`, `session.append` and tool results carry only the mod's own fixed messages and the person's own text.
3. All outside text is cleaned before it is drawn: strip C0 and C1 control characters except newline, ANSI and OSC escape sequences, and bidi controls (U+202A to U+202E, U+2066 to U+2069); cap the length; draw it as `Text`, never as `Markdown`.
4. Every link is built from validated parts: `https://dev-null.sh/@<username>/commits/<uuid>`, the username matching `^[A-Za-z0-9-]{1,39}$` and the id a UUID. A URL from a response is never passed on.
5. Every response is `unknown` until a hand-written guard accepts its exact shape. Anything else is an error shown to the person, never a guess.
6. `$.process.run` gets an argv array, a `timeoutMs`, and no outside text in any argument.
7. No secrets anywhere; phase 1 has none. `$.store` holds the chosen key's fingerprint and public line, the username, the seen counts and the on/off flag, and nothing else.
8. Poll politely: the interval floor above, back-off on errors, every timer stopped when the mod is off or the session ends.

## Open checks (phase 0, before the units that depend on them)

Record each answer here once checked.

- Does `$.http.fetch` follow redirects, and to other hosts? The posting code must not depend on it either way.
- Does a slash command's `text` reach the model? Rule 2 holds either way.
- Can a `ssh-keygen` started through `$.process.run` reach the person's terminal (a passphrase prompt)? The lone-`.pub` design should make this moot; confirm it.
- Are `$.process.run` stdin and the `$.http.fetch` body sent as UTF-8, byte for byte the same text? The signature covers bytes, so a commit with non-ASCII text must verify; test one with `ssh-keygen -Y check-novalidate`.
- Can anything but the person's own keystrokes reach the pane input's submit handler (another plugin, the model)?

## Working on it

- Tests mock `$.http` and `$.process` through `claude-code/testing` and cover the refusals as well as the happy path: wrong origin, malformed or hostile responses, 4xx, 429, timeouts, hostile text, a key missing from the agent. UI tests run on `terminal` and `desktop`.
- Experiments use a throwaway key and a scratch `ssh-agent` on a relative socket path. Never a contributor's own keys or agent, and never a real post to dev-null.sh from a test or an experiment.
- Comments explain why, for the next reader; nothing about how the code used to be.
