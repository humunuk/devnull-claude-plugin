// The pane: bare `/devnull` opens it, or closes it when it is open. Under its
// header, a tab row: Mine, the person's newest commits (hooks/pane-core.ts
// loads them on every open), drawn in a `git log` style with the reply
// alerts' `+N new` marks; and Following, the newest commits of the people the
// person follows, from a round hooks/pane-core.ts runs when the tab is opened,
// switched to or refreshed, at most once a minute. The tab lives in `$.state`,
// so a reopen shows the last one. Latest and Trending join the row in phase 2.
//
// Under Mine, below a rule at the bottom, the input: Enter posts a new commit
// through the same postCommit `/devnull commit` uses, signed by the person's
// SSH agent. It is drawn only on the terminal surface, and a submit from any
// other surface is refused (security rule 1): a client attached over the
// session protocol declares its own surface ("a rendering fact and not a
// trust signal", RenderInputOf.surface) but can never name `terminal`, so
// only the person's own local session posts. An Input's handler gets the
// text and the event, no `$` and no abort signal of its own (InputProps,
// UiInputArgument): it uses the `$` of the drawing that made it, as the
// buttons do, and a post from it cannot be interrupted. One post is in flight
// at a time, and the field is not drawn meanwhile.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderSurface, UiInputArgument } from 'claude-code'

import { FAILED_TEXT, splitSubcommand } from './lib/command'
import { followingView } from './lib/following'
import { checkBody } from './lib/payload'
import {
  COMMITTED_TEXT,
  NO_POST,
  PANE_EMPTY_TEXT,
  POSTING_TEXT,
  POST_FAILED_TEXT,
  finishPost,
  newRepliesText,
  paneView,
  postView,
  refusePost,
  startPost,
} from './lib/pane'
import type { PostResult } from './lib/posting'
import { readReplyAlerts } from './alerts'
import {
  PANE_ID,
  followRound,
  isPaneOpen,
  keepTicking,
  load,
  paneClosed,
  readFollowing,
  readLoad,
  reloadPaneIfOpen,
  shutPane,
  startTicker,
} from './pane-core'
import { postCommit, postingIo, tooLongText } from './posting'
import { readRecent } from './recent'

const PANE_TITLE = '/dev/null'

export const PANE_USAGE: readonly string[] = ['/devnull                          open or close the /dev/null pane']

export const NOT_PLACED_TEXT = 'The /dev/null pane is open, and shows once a screen that draws panes is attached.'

export const POST_LOST_TOAST =
  '/devnull could not show what became of your post: Claude Code refused a step. Check your profile on dev-null.sh before posting again.'

export const TAB_FAILED_TOAST = '/devnull could not switch tabs: Claude Code refused a step.'

export const INPUT_LABEL = 'commit \u203a'

const INPUT_PLACEHOLDER = 'a new commit; Enter posts it'

/** The rule above the input is drawn at most this wide, whatever the pane's width. */
const RULE_MAX = 400

export type PaneTab = 'mine' | 'following'

/** The tab row, in order, each pressed by its digit while the pane has the focus. `3 Latest` and `4 Trending` join it in phase 2. */
export const TABS: readonly { tab: PaneTab; hotkey: string; label: string }[] = [
  { tab: 'mine', hotkey: '1', label: 'Mine' },
  { tab: 'following', hotkey: '2', label: 'Following' },
]

const POST = atom({ plugin: 'devnull', key: 'panePost' } as const, NO_POST)

const TAB = atom({ plugin: 'devnull', key: 'paneTab' } as const, 'mine')

/**
 * Whether `e` (a drawing, or a submit) is on the surface the input, and
 * anything else that posts, is drawn on: the terminal alone. A remote client
 * names its own surface and can never name `terminal`; an absent one is
 * `desktop`.
 */
export function isPostingSurface<E extends { surface: RenderSurface }>(e: E): e is Extract<E, { surface: 'terminal' }> {
  return e.surface === 'terminal'
}

export function registerPane(on: On): void {
  on('command.run', { command: 'devnull' }, async ($, e, next) => {
    if (splitSubcommand(e.args).name !== '') return next(e)

    // Opening or closing a pane posts nothing, so any origin may toggle it.
    if (await isPaneOpen($)) {
      await shutPane($)

      return {}
    }

    const tab = await read($, TAB)
    const opened = await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
    startTicker($)
    // Not awaited: a fetch that gets no answer takes 30 s to fail, and the
    // pane says it is loading meanwhile. On Following, the round's requests
    // come after the load's.
    const loaded = load($)
    if (tab === 'following') void followRound($, 'show', loaded)

    return opened.isPlaced ? {} : { text: NOT_PLACED_TEXT }
  }).catch(($, e, next) => (next.called ? next(e) : { text: FAILED_TEXT }))

  on('ui.close', { id: PANE_ID }, ($, e, next) => {
    paneClosed()

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    keepTicking($)
    const tab = await read($, TAB)
    const loadNow = await readLoad($)
    const nowMs = await $.clock.now()
    const view = paneView(loadNow, await readRecent($), await readReplyAlerts($), nowMs, e.surface)
    const following = tab === 'following' ? followingView(await readFollowing($), nowMs, e.surface) : undefined
    const freshness = following === undefined ? view.freshness : following.freshness
    const refresh = () => (tab === 'following' ? followRound($, 'refresh') : load($))

    const header = (
      <Box key="header" flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Text weight="bold" wrap="truncate-end">
            {view.title}
          </Text>
          <Box flexDirection="row" flexShrink={0}>
            <Button key="refresh" label="refresh" hotkey="r" plain dimColor onPress={refresh} />
            {freshness !== '' && <Text color="subtle"> {'\u00b7'} {freshness}</Text>}
            {following?.wait !== undefined && <Text color="warning"> {'\u00b7'} {following.wait}</Text>}
          </Box>
        </Box>
        <Box key="tabs" flexDirection="row" columnGap={2}>
          {TABS.map(each =>
            each.tab === tab ? (
              <Button key={`tab-${each.tab}`} label={each.label} hotkey={each.hotkey} plain variant="primary" onPress={() => showTab($, each.tab)} />
            ) : (
              <Button key={`tab-${each.tab}`} label={each.label} hotkey={each.hotkey} plain dimColor onPress={() => showTab($, each.tab)} />
            ),
          )}
        </Box>
      </Box>
    )

    if (following !== undefined) {
      return (
        <Box key="list" flexDirection="column">
          {header}
          {following.message !== undefined && (
            <Text color={following.isProblem ? 'error' : 'subtle'}>{following.message}</Text>
          )}
          {following.notes.map(note => (
            <Text color="subtle">{note}</Text>
          ))}
          {following.commits.map(commit => (
            <Box key={`commit-${commit.id}`} flexDirection="column" marginTop={1}>
              <Text wrap="truncate-end">
                <Text color="suggestion">{`@${commit.author}`}</Text>
                <Text color="warning"> {commit.hash}</Text>
                <Text color="subtle"> {commit.meta}</Text>
              </Text>
              {commit.lines.map(line => (
                <Text wrap="truncate-end">{line === '' ? ' ' : line}</Text>
              ))}
              {commit.href !== undefined && (
                <Text>
                  <Link href={commit.href} label={'open \u2197'} />
                </Text>
              )}
            </Box>
          ))}
        </Box>
      )
    }

    const list = (
      <Box key="list" flexDirection="column">
        {header}
        {view.message !== undefined && (
          <Text color={loadNow.kind === 'failed' ? 'error' : 'subtle'}>{view.message}</Text>
        )}
        {view.hint !== undefined && <Text color="subtle">{view.hint}</Text>}
        {view.commits.map(commit => (
          <Box key={`commit-${commit.id}`} flexDirection="column" marginTop={1}>
            <Text wrap="truncate-end">
              <Text color="warning">{commit.hash}</Text>
              <Text color="subtle"> {commit.meta}</Text>
              {commit.newReplies > 0 && (
                <Text color="success" weight="bold">
                  {' '}
                  {newRepliesText(commit.newReplies)}
                </Text>
              )}
            </Text>
            {commit.lines.map(line => (
              <Text wrap="truncate-end">{line === '' ? ' ' : line}</Text>
            ))}
            {commit.href !== undefined && (
              <Text>
                <Link href={commit.href} label={'open \u2197'} />
              </Text>
            )}
          </Box>
        ))}
      </Box>
    )
    if (!isPostingSurface(e)) return list
    const { Input } = $.ui.resolve(e)
    const post = postView(await read($, POST), nowMs, e.surface)
    const ruleWidth = Number.isSafeInteger(e.props.bodyColumns) ? Math.min(Math.max(e.props.bodyColumns, 1), RULE_MAX) : 1
    const onSubmit = (value: string, input: UiInputArgument) => {
      void submit($, value, input)
    }

    return (
      <Box flexDirection="column">
        {list}
        <Box key="compose" flexDirection="column" marginTop={1}>
          <Text color="subtle" wrap="truncate-end">
            {'\u2500'.repeat(ruleWidth)}
          </Text>
          {post.kind === 'sending' ? (
            <Text color="subtle">
              {INPUT_LABEL} {POSTING_TEXT}
            </Text>
          ) : (
            <Box flexDirection="column">
              <Input
                key={post.key}
                label={INPUT_LABEL}
                placeholder={INPUT_PLACEHOLDER}
                value={post.draft}
                submitLabel="post"
                onSubmit={onSubmit}
              />
              {post.committed !== undefined && (
                <Box flexDirection="row" columnGap={1}>
                  <Text color="success">{COMMITTED_TEXT}</Text>
                  {post.committed.href === undefined ? [] : [<Link key="posted" href={post.committed.href} label={'open \u2197'} />]}
                </Box>
              )}
              {post.lines.map(line => (
                <Text color={post.isProblem ? 'error' : 'subtle'}>{line}</Text>
              ))}
            </Box>
          )}
        </Box>
      </Box>
    )
  })
}

/**
 * Enter in the input: refuses an empty or too long body before anything runs,
 * else posts it as `/devnull commit` would, shows what that came to, and
 * loads the list again after a commit. Never rejects.
 */
async function submit($: EngineInterface, value: string, input: UiInputArgument): Promise<void> {
  // The field is drawn only on the terminal; a submit from any other surface
  // is not one the person made in their own local session.
  if (!isPostingSurface(input)) return

  try {
    const nowMs = await $.clock.now()
    const check = checkBody(value)
    switch (check.kind) {
      case 'ok':
        break
      case 'empty':
        await update($, POST, current => refusePost(current, '', [PANE_EMPTY_TEXT], nowMs))
        return
      case 'too-long':
        await update($, POST, current => refusePost(current, value, [tooLongText(check.length)], nowMs))
        return
      default: {
        const unknownCheck: never = check
        void unknownCheck
        return
      }
    }

    const token = crypto.randomUUID()
    const claimed = await update($, POST, current => startPost(current, token, value, nowMs))
    // Another post is in flight: the pane says so, and this one is not sent.
    if (claimed.sending?.token !== token) return

    let result: PostResult
    try {
      result = await postCommit(postingIo($, () => false), 'commit', value)
    } catch {
      // Only steps before the request can throw ($.store, $.clock, building
      // the payload); every later one is caught inside: nothing was sent.
      result = { committed: null, lines: [POST_FAILED_TEXT] }
    }
    await update($, POST, current => finishPost(current, token, result))
    if (result.committed !== null) await reloadPaneIfOpen($)
  } catch {
    $.ui.toast(POST_LOST_TOAST)
  }
}

/**
 * A press on a tab: shows it, and on Following starts a round, which does
 * nothing within a minute of the last one, when the pane draws that one.
 * Never rejects.
 */
async function showTab($: EngineInterface, tab: PaneTab): Promise<void> {
  try {
    await update($, TAB, () => tab)
  } catch {
    $.ui.toast(TAB_FAILED_TOAST)

    return
  }
  if (tab === 'following') await followRound($, 'show')
}
