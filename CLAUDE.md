# devnull-claude-plugin

An unofficial Claude Code mod for /dev/null (https://dev-null.sh): post and reply from a Claude Code session, see your newest commits in a pane, and get told when someone replies. Public and open source at https://github.com/humunuk/devnull-claude-plugin. It is not made by or affiliated with dev-null.sh, and the README and the plugin description say so.

People install this into their own Claude Code sessions, where it runs `ssh-keygen` against their SSH agent and talks to the network for them. Every rule below exists to keep that safe. Where a rule and a convenience conflict, the rule wins. Where something is not covered here, stop and ask instead of choosing.

## Layout

The repository root is the mod and its own marketplace:

- `.claude-plugin/plugin.json` (`"name": "devnull"`) and `.claude-plugin/marketplace.json` (one entry, `"source": "./"`)
- `hooks/hooks.json` (`{ "modules": ["./register.tsx"] }`) and `hooks/register.tsx`, which only wires the feature modules
- One module per feature (`hooks/setup.ts`, and later posting, the pane and the alerts), each exporting `registerX(on)`: it hooks `command.run` on `{ command: 'devnull' }`, takes its own subcommand and passes every other run on with `next(e)`. `hooks/commands.ts` is the innermost hook and answers whatever no feature took with the usage text, so `register.tsx` registers every feature before it (a plugin's hooks on one event nest in registration order, first outermost). A feature's logic gets closures over its `$` calls, so it is tested without the engine. On 2.1.304, `claude plugin validate` accepts `$` handed to a directly called, imported function, and refused it handed to a function picked at run time from a table.
- `hooks/lib/`: pure helpers that never touch `$`
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

1. `/devnull setup`: pick the signing key from the SSH agent's Ed25519 keys and RSA keys of at least 2048 bits (shown by SHA-256 fingerprint) and enter the /dev/null username. Both are kept in `$.store`. After a commit, if the username in the returned link differs from the stored one, tell the person.
2. `/devnull commit <text>` and `/devnull reply <hash or link> <text>`: post, signed with the chosen key. `/devnull reply` completes hashes in the prompt box: a `prompt.autocomplete` hook answers from the session's recent commits (`hooks/lib/recent.ts`), never from the network, and a row writes nothing but a validated hash; its description is cleaned text and the age. The same hook completes the subcommand names.
3. `/devnull`, registered with `immediate: true`: toggles the pane. Opening it always fetches a fresh list of the person's newest commits (public API, 20 per page), and the pane has an input to write a new commit.
   - Look, in a `git log` style: a header `/dev/null · @<username>` with `r refresh · updated <age>` on the right; per commit, one line with the short hash in the `warning` theme colour, then the age, `★ <stars>` and `↳ <replies>` in `subtle`, `+N new` in `success` bold and `pending review` in `inactive`; under it up to 3 cleaned body lines, `…` when cut, and an `open ↗` link; at the bottom a rule and the input (`commit ›`, Enter posts). Theme keys only, so light and dark themes both work; no borders inside the engine's frame. Non-ASCII characters are `\u` escapes in the source.
   - States, all fixed texts: not set up (`Run /devnull setup to choose your key and username.`), loading, empty (`No commits yet. Type below, or /devnull commit <text>.`), and error (`Couldn't load commits (HTTP <status>). Press r to retry.`).
   - Keys while the pane has focus (`ctrl+x tab`): `r` refreshes, Tab moves to the input, the arrows scroll, `ctrl+x x` closes. Placement is the engine's: docked beside the transcript in fullscreen from 110 columns, else inline above the prompt.
   - The Following, Latest and Trending tabs stay hidden until phase 2. The layout leaves room for a tab row (`1 Mine  2 Following  3 Latest  4 Trending`, switched with the number keys).
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
| `POST /api/cli/key-lookups` | Body: the one chosen public key line (`<type> <base64>`), `text/plain; charset=utf-8`. Answers that key line when it is on the GitHub account of a /dev/null user, else 404 with a plain-text reason; also 404 for an RSA key under 2048 bits (`SshPublicKey::MinimumRsaBits`). Throttled at 60 a minute. | `app/Http/Controllers/Cli/KeyLookupController.php`, `app/Http/Requests/CreateKeyLookupRequest.php` |
| `POST /api/cli/commits` | Body: the signed payload, `text/plain; charset=utf-8`, with the `X-SSH-Signature` header. Answers 201 `Committed: <url>`, followed by ` (pending review, only you can see it until it is approved)` when pending. Errors are plain text. Shares the 10 attempts a minute per user with every other way of posting. | `app/Http/Controllers/Cli/CommitController.php`, `app/Http/Middleware/AuthenticateSshSignature.php` |
| `GET /api/v1/users/{username}` | A public profile. | README, "Public API" |
| `GET /api/v1/users/{username}/commits` | The user's top-level commits, newest first, 20 a page; `?replies=1` for their replies. Each has `id`, `short_hash`, `body`, `parent_id`, `created_at`, `stars_count`, `replies_count` and `author`. | README, "Public API" |
| `GET /api/v1/commits/{id}` | One commit with its counts. | README, "Public API" |

The public API allows 60 requests a minute per IP address, shared with everything else on that address. Honour 429 and `Retry-After`; back off on 5xx and network errors.

Never call the website's own routes (`/log/*`, `/commits/{id}/replies`, `/search/*`, anything Inertia), even where they answer guests. They are the site's internals, and the maintainers declined a client built on them (PR #92).

All of the above was read from nunomaduro/dev-null.sh at `production` commit `3e55ca6` (2026-10-20). When upstream changes, read the source again before changing the mod.

## Signing a commit (verified with OpenSSH 8.9p1 on 2026-10-20)

- Payload: `<unix seconds>\n<nonce>\n<reply reference, or empty>\n<body>`, with no trailing newline. The nonce is 32 lowercase hex characters from `crypto.getRandomValues`, used once. The server accepts a timestamp within 300 s of its clock and spends each nonce (`app/Services/SignedCommits.php`, `app/Services/SshSignatures.php`).
- Body: 1 to 4000 characters (`Commit::MIN_BODY_LENGTH`, `MAX_BODY_LENGTH`), counted as code points (`mb_strlen`) after the server's `CommitBodies::normalize` (line endings to `\n`, runs of blank lines in prose collapsed) and `mb_trim`. Before signing, the mod refuses a body that is empty after trimming or over 4000 code points. Normalising only shortens a body, so the server never refuses one the mod sent for its length; the mod may refuse a padded body that normalising would have brought under 4000. Reply reference: a 7 to 12 character hex hash, or a `https://dev-null.sh/` commit link that holds the commit's UUID; validate it against those two forms before signing (`app/Queries/CommitByReferenceQuery.php`).
- Sign only through the SSH agent:
  1. `ssh-add -L` lists the agent's keys; keep the `ssh-ed25519` lines and the `ssh-rsa` lines of at least 2048 bits. Exit 1 means an empty agent only when stdout is exactly `The agent has no identities.`; with any other stdout it means the agent failed. Only the key whose fingerprint the person chose in setup is used. If the agent no longer holds it, stop and say so.
  2. Make a fresh directory with `mktemp -d` and write that one public key line to `<dir>/signing.pub`.
  3. Run `ssh-keygen -Y sign -n devnull-commit -f <dir>/signing.pub` with the payload on stdin; the signature comes back on stdout. No private key file exists next to `signing.pub`, so ssh-keygen can only use the agent: with the key missing from the agent it fails with "No such file or directory" and never prompts for a passphrase. Do not rely on `-U` for this: on OpenSSH 8.9 it still falls back to a private key file and asks for its passphrase.
  4. Remove `<dir>/signing.pub` by name, then `rmdir <dir>`. Never delete recursively.
  5. `X-SSH-Signature` is the signature's base64 lines (everything between the armour lines) joined without newlines. Refuse anything that is not `[A-Za-z0-9+/=]+`.
- The mod never reads `~/.ssh`, never handles a private key, and never sends any public key but the chosen one.
- The README states the requirements: Claude Code in a terminal (`$.process` is CLI only), OpenSSH 8.1 or later (`ssh-keygen -Y sign`), and an Ed25519 key, or an RSA key of at least 2048 bits, that is on the person's GitHub account and loaded in their SSH agent.

## Security rules

1. Only the person posts, from their own local session.
   - `/devnull setup`, `/devnull commit` and `/devnull reply` run only when `e.origin.kind === 'composer'`. Every other origin is refused, `bridge` (Remote Control) included.
   - The pane draws its input, and any other control that posts, only on the `terminal` and `desktop` surfaces. On any other surface it shows the list without them.
   - The mod drops every prompt suggestion whose trimmed text starts with `/devnull` (`prompt.suggest`, answered `{ isShown: false }` without `next`), so a suggestion the model wrote is never a Tab and an Enter away from a post.
   - The mod registers no tool the model can call.
   - Accepted limits, written in the README: keystrokes another program sends to the terminal (`tmux send-keys`, computer-use tools) look like the person's typing, and still go through the person's tool permissions; other installed plugins are trusted code (Checked behaviour).
2. Nothing from dev-null.sh reaches the model. Other people's text (commit bodies, usernames, server error text) is drawn only in the pane, the band, the status line and toasts. A command's `text` and `context`, `prompt.compose`, `prompt.submit`, `session.append` and tool results carry only the mod's own fixed messages and the person's own text.
3. All outside text is cleaned before it is drawn: strip C0 and C1 control characters except newline, ANSI and OSC escape sequences, and bidi controls (U+202A to U+202E, U+2066 to U+2069); cap the length; draw it as `Text`, never as `Markdown`.
4. Every link is built from validated parts: `https://dev-null.sh/@<username>/commits/<uuid>`, the username matching `^[A-Za-z0-9-]{1,39}$` and the id a UUID. A URL from a response is never passed on.
5. Every response is `unknown` until a hand-written guard accepts its exact shape. Anything else is an error shown to the person, never a guess. Success is only the exact expected answer: for a commit, a 201 whose body parses as `Committed: …`; for a key lookup, a 2xx whose first line is the key line sent. `$.http.fetch` follows redirects without telling, turns a redirected POST into a GET on 301 to 303, and drops `X-SSH-Signature` on a cross-origin redirect (Checked behaviour), so nothing else may be read as success.
6. `$.process.run` gets an argv array, a `timeoutMs`, and no outside text in any argument.
7. No secrets anywhere; phase 1 has none. `$.store` holds the chosen key's fingerprint and public line, the username, the seen counts and the on/off flag, and nothing else.
8. Poll politely: the interval floor above, back-off on errors, one request in flight per poller (a fetch that gets no answer takes 30 s to reject), every timer stopped when the mod is off or the session ends.

## Checked behaviour (Claude Code 2.1.304, 2026-10-20)

Checked with a throwaway probe mod run headless (`claude -p --plugin-dir <probe> "/probe ..."`), python3 servers on 127.0.0.x, a scratch Ed25519 key and a scratch `ssh-agent` on a relative socket, and the engine's types (`claude-code/index.d.ts` of 2.1.304; symbols named below). The fetch is Bun's (`User-Agent: Bun/1.4.4`).

- **`$.http.fetch` redirects, timeout, refused connection.** It follows 3xx by itself, to another host and to another port, and there is no option to turn that off: `HttpInit` has only `method`, `headers`, `body`, `auth` and `socketPath`, and `HttpResponse` has no final URL, so the mod cannot tell that a redirect happened. 307 and 308 keep the method and the body (a POST arrived as a POST with all 83 body bytes). 301, 302 and 303 turn a POST into a GET with no body. A custom header (`X-Probe`, so also `X-SSH-Signature`) is kept on a same-origin redirect and dropped when the origin changes (another host, or the same host on another port). `Content-Type` is kept either way. A server that accepts the connection and never answers makes the call reject after 30 s (30005 ms): `HooksError: <plugin>: $.http.fetch(<url>) aborted: no complete answer within 30000ms`. A refused connection rejects at once (3 ms) and gives no status: `HooksError: <plugin>: $.http.fetch(<url>) failed: ECONNREFUSED: ...`. Checked by a redirect server on 127.0.0.1 sending each code with a `Location` on 127.0.0.2 or another port, plus a server that reads and never replies and a closed port. Not checked: an https to http redirect, and how many redirects are followed. So the mod can never assume a request reached dev-null.sh as sent, or that `X-SSH-Signature` reached the host that answered: only the exact expected answer counts as success (rule 5).
- **A command's `text` reaches the model, for normal and `immediate: true` commands.** Run headless, `/probe tok <random token>` and `/probe-now <random token>` (registered `immediate: true`) each stored their text as a `<local-command-stdout>` row. The next request of a `claude -p --continue` run sent it as a user text block: the token is in that run's `api-request-blob` transcript entry. Asked to quote the output without running anything, the model gave the token back word for word, with the probe not loaded in that run. The types say the same: `text` is "the row the model also reads", and `context` is notes only the model reads (`CommandRunResult`, and reference.md on `CommandOutput`). An immediate command typed mid-turn was not seen running mid-turn, because a headless stream-json session queued it until the turn ended. `CommandSpec.immediate` says its `{ text }` "prints as an idle run's does". So rule 2 is needed as written.
- **`$.process.run` environment and the terminal.** The child inherits the whole session environment, `PATH`, `HOME` and `SSH_AUTH_SOCK` included (a dummy `SSH_AUTH_SOCK` and a marker variable given to `claude` both showed up in the child's `env`). `init.env` is merged over it, not a replacement: `HOME` was overridden, a new variable was added, and `PATH` and the rest stayed (`ProcessRunInit.env`: "Variables set over the host process's own environment"). The child can reach the person's terminal: its stdin and stdout are pipes, but it has the session's controlling terminal, in the foreground process group, and `exec 3<>/dev/tty` succeeded (run under `script` so `claude` had a pty). A prompting `ssh-keygen` could therefore read from the person's terminal, so the lone-`.pub` design is what prevents a prompt, not the sandbox. With that design, through `$.process.run` and with a pty present: with the key in the scratch agent, `ssh-keygen -Y sign -n devnull-commit -f <dir>/signing.pub` (payload on stdin) exits 0 in 16 ms with the armoured signature on stdout and `Signing data on standard input` on stderr. With the key missing from the agent, or with `SSH_AUTH_SOCK` naming no socket, it exits 255 in under 10 ms with no prompt and the same stderr in both cases: `Load key "<dir>/signing": No such file or directory`, ending in `\r\n`. Those two causes cannot be told apart from the output.
- **Byte equality of `stdin` and the fetch body: yes, both UTF-8, byte for byte.** Payload `1760000000\n<32 hex>\n\ntere õhtust 👋 test\n🎉\nlõpp` (78 UTF-8 bytes, no trailing newline). `sha256sum` run through `$.process.run` with it as `stdin` printed the same hash as Python's UTF-8 encoding of the text. The probe signed it through `$.process.run`, then POSTed it with `$.http.fetch` (`text/plain; charset=utf-8`, signature in `X-SSH-Signature`) to a local server that saved the raw body. The saved body was those 78 bytes exactly (`Content-Length: 78`), with no BOM and no added newline. `ssh-keygen -Y check-novalidate -n devnull-commit` on the saved body with the signature rebuilt from the header answered `Good "devnull-commit" signature`. The same check failed with one bit flipped at the same length, with a newline added, and on the body's UTF-16 encoding (the bit flip and the newline re-run in review).
- **Who can press the pane's `Button` or submit its `Input`: no plugin call and no model tool raises those events directly.** `ui.press`, `ui.input` and `ui.select` fire when a surface reports a press, an edit or Enter on an element a render hook drew (their docs under the events map). Nothing on `$` raises them: `EventCalls.ui` has only `render`, `resolve`, `scroll` and `focus`, and the `$.ui` noun has no press, input or select call. So no plugin can call them, and neither can the model, whose tools reach `$` only through a plugin's code. `$.ui.focus` and `$.ui.scroll` press nothing (`focus` acts only on the calling plugin's own sites; `scroll` also moves a transcript row while it answers the person's own input). A prompt from the bridge, a channel, a peer session or a scheduled trigger is a `prompt.submit` turn (`PromptOrigin`) and reaches the pane only through what the model then does. Surfaces report presses and edits too: a Remote Control client (`bridge`) is the person's own account, and a client attached over the session protocol (`session.attach`: the desktop app, an SDK host) sends them over the wire; the types do not say whether the engine checks an incoming `ui_input` against an element it drew for that client. `mobile` has no `Input` today, which the types call a limit of its element table, not of the protocol. Rule 1 says which surfaces get the controls that post. The testing kit's `press` and `input` exist only under `claude plugin test`. Outside the engine, and not tested here: a tool that sends keystrokes to the terminal looks like the person's typing, for the pane and for a typed `/devnull commit` alike. Examples are the model's Bash running `tmux send-keys` when the session runs inside tmux, or the computer-use tools this build lists (`request_computer`). Such a call still goes through the person's tool permissions. Other installed plugins: the types confirm they share the chain and can see, rewrite or take over everything here. `UiInputArgument` says another plugin addresses a field by matcher and may rewrite `value` before our `onSubmit` sees it. A `ui.press` hook can answer `{ element }` and take the press. Any plugin can hook the pane's `ui.render`. `OpEventOf` makes every `$` call (`http.fetch`, `process.run`, `store.*`) hookable by any plugin above the caller, to rewrite, refuse or answer. So other plugins are trusted code and are outside this threat model.

## Open checks

- `PromptOrigin` stamps `composer` on "a click on a transcript link" as well as on Enter at the prompt. What draws such a link, and can text the model writes produce one that submits a `/devnull` command? The types do not say. Answer this before the posting unit ships; if a model-written link can submit `/devnull commit`, posting needs a confirmation step the link cannot give.

## Working on it

- Tests mock `$.http` and `$.process` through `claude-code/testing` and cover the refusals as well as the happy path: wrong origin, malformed or hostile responses, 4xx, 429, timeouts, hostile text, a key missing from the agent. UI tests run on `terminal` and `desktop`.
- Experiments use a throwaway key and a scratch `ssh-agent` on a relative socket path. Never a contributor's own keys or agent, and never a real post to dev-null.sh from a test or an experiment.
- Comments explain why, for the next reader; nothing about how the code used to be.
- Source files are ASCII only; write any other character as a `\u` escape. File-writing tools have turned escaped bidi characters into real ones before, which hides code from a reader (Trojan Source). `grep -rnP '[^\x00-\x7F]' hooks tests types` prints nothing.
