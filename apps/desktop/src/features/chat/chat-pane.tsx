import type { Id } from '@trioditis/backend/dataModel'
import { NETWORK_INFO } from '@trioditis/core'
import { Button } from '@trioditis/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrail,
  DropdownMenuTrigger,
} from '@trioditis/ui/dropdown-menu'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { toast } from '@trioditis/ui/toast'
import { cn } from '@trioditis/ui/lib/utils'
import {
  AlarmClock,
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  Check,
  ChevronLeft,
  Info,
  MoreHorizontal,
  Pin,
  PinOff,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { networkName, useChatActions, useOpenChat, type Chat, type ChatId } from '~/data/chats.ts'
import { composerBlocked } from '~/data/bridge-ready.ts'
import { useChatContent, useSettled } from '~/data/chat-content.ts'
import {
  useBridge,
  useReactionToggle,
  useRetryStates,
  useSendMutations,
  useTyping,
  type Message,
} from '~/data/messages.ts'
import {
  appendToDraft,
  endSend,
  getDraft,
  restoreDraft,
  setDraftReply,
  setDraftText,
  takeForSend,
  useDraft,
  whileSending,
} from '~/data/drafts.ts'
import { checkWithinAYear, formatWhen, snoozeOptions } from '~/data/snooze.ts'
import { LoadError, RetryBoundary } from '~/features/shell/retry-boundary.tsx'
import { SyncBar, useConnected } from '~/features/shell/sync-bar.tsx'
import { errorMessage } from '~/lib/errors.ts'
import { newClientId, sealText, tryOpen, type MessagePlaintext } from '~/lib/sealed.ts'
import { useSession } from '~/lib/session.tsx'
import { Composer } from './composer.tsx'
import { DetailsPanel } from './details-panel.tsx'
import { ChatAvatar } from './chat-avatar.tsx'
import { MessageList, MessagesSkeleton } from './message-list.tsx'
import { draftSendId } from '~/data/saved-drafts.ts'
import { beatenBySend, usedOutcome, type AlreadyUsed } from './already-used.ts'
import { restoreConflict } from './cancel-scheduled.ts'
import { againView, sendAgain, useSendingAgain } from './send-again.ts'

interface ChatPaneProps {
  chatId: ChatId | undefined
  /** The open chat no longer exists (deleted, or not the person's). */
  onGone: () => void
  /** Back to the list, on a narrow screen where the chat covers it. */
  onBack: () => void
  /** Runs an action that may take the chat off the list; the shell opens the next one if so. */
  act: (chatId: ChatId, run: () => Promise<boolean>) => Promise<void>
}

export function ChatPane({ chatId, onGone, onBack, act }: ChatPaneProps) {
  const session = useSession()
  // A chat the sidebar has shown opens at once with its row from there; the server's own answer
  // takes its place when it comes (useOpenChat).
  const { chat, confirmed } = useOpenChat(chatId)
  useEffect(() => {
    if (chatId && chat === null) onGone()
  }, [chatId, chat, onGone])
  if (chatId && chat === undefined) return <OpeningChat onBack={onBack} />
  if (!chatId || !chat) {
    return (
      // On a narrow screen the list has the whole width until a chat opens.
      <main
        className={cn(
          'flex min-w-0 flex-1 items-center justify-center bg-surface-2 text-sm text-subtle-foreground',
          !chatId && 'max-md:hidden',
        )}
      >
        No chat open
      </main>
    )
  }
  // A page of messages the server couldn't answer in time (a busy server, or every query asked
  // again at once after the computer wakes) takes down only this pane, which then tries again.
  // The draft lives in the draft store, so it's still there when the chat comes back.
  return (
    <RetryBoundary
      key={chat.id}
      offline={session.offline}
      fallback={(say, retry) => (
        <main className="flex min-w-0 flex-1 flex-col bg-surface-2">
          <Button variant="ghost" size="icon" aria-label="Back to chats" className="m-1.5 md:hidden" onClick={onBack}>
            <ChevronLeft className="size-5" />
          </Button>
          <LoadError say={say('Couldn’t load this chat.')} onRetry={retry} />
        </main>
      )}
    >
      {(attempt) => <OpenChat chat={chat} confirmed={confirmed} attempt={attempt} act={act} onBack={onBack} />}
    </RetryBoundary>
  )
}

/**
 * A chat opened before anything is known of it (a link, or one the sidebar hasn't loaded): its
 * header's shape while it loads, so the chat fills it in rather than pushing in.
 */
function OpeningChat({ onBack }: { onBack: () => void }) {
  return (
    <main className="flex min-w-0 flex-1 flex-col bg-surface-2" aria-busy="true" aria-label="Opening chat">
      <header className="relative flex h-(--bar-h) shrink-0 items-center gap-3 border-b border-border bg-surface pr-3.5 pl-5 max-md:gap-2 max-md:pr-1.5 max-md:pl-1.5">
        <Button variant="ghost" size="icon" aria-label="Back to chats" className="md:hidden" onClick={onBack}>
          <ChevronLeft className="size-5" />
        </Button>
        <span className="size-[38px] shrink-0 rounded-full bg-muted" />
        <span className="h-3.5 w-40 rounded bg-muted" />
        <SyncBar active />
      </header>
      <MessagesSkeleton />
      {/* The composer's place, its one line (50px), so it doesn't push the list up when it comes. */}
      <div className="mx-3.5 mb-3.5 h-[50px] shrink-0 rounded-[14px] bg-surface shadow-[0_0_0_1px_var(--border)]" />
    </main>
  )
}

function OpenChat({
  chat,
  confirmed,
  attempt,
  act,
  onBack,
}: {
  chat: Chat
  /** False while the header shows the sidebar's copy of the chat, not yet the server's. */
  confirmed: boolean
  attempt: number
  act: ChatPaneProps['act']
  onBack: () => void
}) {
  const session = useSession()
  const actions = useChatActions()
  const content = useChatContent(chat, attempt)
  const { messages, canLoadMore, loadingMore, loadMore, serverReactions, senders } = content
  // The messages show once what goes with them has come too, so nothing pops in after.
  const loading = !useSettled(!content.loading, content.extrasPending)
  const connected = useConnected()
  // Where focus goes back to when the details sheet closes.
  const detailsButton = useRef<HTMLButtonElement>(null)
  const network = networkName(chat.network)
  const { reactions, toggle: toggleReaction } = useReactionToggle(
    chat.id,
    serverReactions,
    useCallback(() => toast(`${network} hasn’t confirmed that reaction yet.`), [network]),
    useCallback((e: unknown) => toast(errorMessage(e, 'That reaction couldn’t be sent.')), []),
  )
  const group = chat.row.kind === 'group'
  const typing = useTyping(chat.id)
  const { pendingScheduled: pending, cancelledRows, scheduledTexts } = content
  // Scheduled messages whose cancel is on its way: Cancel is off for them meanwhile.
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set())
  const bridge = useBridge()
  const bridgeKey = bridge.key
  const {
    send,
    sendAgain: sendAgainMutation,
    discard,
    schedule,
    cancelScheduled,
    forgetScheduled,
    sendScheduledNow,
  } = useSendMutations()
  // The draft and reply live in the per-chat draft store (drafts.ts), so an action that finishes
  // after this pane was left and opened again still changes what's on screen.
  const { text: draft, reply: replyTo } = useDraft<Message>(chat.id)
  // Cancelled messages restored to the composer from this pane, to say so. Restore stays.
  const [restored, setRestored] = useState<ReadonlySet<string>>(new Set())
  const setDraft = (text: string) => setDraftText(chat.id, text)
  const setReplyTo = (message: Message | null) => setDraftReply(chat.id, message)
  // Closed whenever a chat opens; the pane is remade for each chat.
  const [details, setDetails] = useState(false)

  const scheduled = useMemo(
    () =>
      pending.map((s) => ({
        id: s._id,
        sendAt: s.sendAt,
        body: scheduledTexts.get(s._id),
        replyTo: s.replyTo,
        cancelling: cancelling.has(s._id),
      })),
    [pending, scheduledTexts, cancelling],
  )
  const cancelled = (cancelledRows ?? []).map((c) => ({
    id: c._id,
    body: scheduledTexts.get(c._id),
    replyTo: c.replyTo,
    restored: restored.has(c._id),
  }))

  async function sendText(text: string, reply?: string, clientMessageId = newClientId()) {
    // Thrown, not only said, so a send again that couldn't go can be tried again.
    if (!bridgeKey) {
      toast('This server has no bridge key yet, so nothing can be sent.')
      throw new Error('No bridge key')
    }
    const sealed = sealText(text, clientMessageId, session.userId, session.keyPair.publicKey, bridgeKey)
    try {
      return await send({ chatId: chat.id, clientMessageId, ...sealed, ...(reply ? { replyTo: reply } : {}) })
    } catch (e) {
      toast(errorMessage(e, 'That message couldn’t be sent.'))
      throw e
    }
  }

  async function onSend() {
    if (!draft.trim()) return
    // Nothing leaves the composer until it can be sent.
    if (!bridgeKey) return toast('This server has no bridge key yet, so nothing can be sent.')
    const chatId = chat.id
    // The draft's own send ID: the same draft sent again, from another tab or after a reload,
    // is the same send. Noted as under way, and saved so, before the composer is cleared (I2).
    const taken = takeForSend<Message>(chatId, sendIdOfTaken)
    if (!taken) return
    await whileSending(() =>
      sendText(taken.text, taken.reply?.eventId, taken.clientMessageId).then(
        (outcome) => settle(chatId, taken, outcome === 'queued' ? null : outcome),
        () => {
          // Back first, then the copy under way goes.
          restoreDraft(chatId, taken.text, taken.reply, taken.id)
          endSend(taken.clientMessageId, false)
        },
      ),
    )
  }

  /**
   * Settles a send or schedule the server took as new (`used` null), or found its ID used
   * already (already-used.ts): done, and not sent again; may have gone, so the person checks
   * the chat first; or never went, so its text comes back as a new draft.
   */
  function settle(
    chatId: ChatId,
    taken: { text: string; reply: Message | null; clientMessageId: string },
    used: AlreadyUsed | null,
  ) {
    const outcome = used ? usedOutcome(used) : null
    if (outcome?.action === 'again') {
      // No identity given: a new draft, so sending it again is a new message.
      restoreDraft(chatId, taken.text, taken.reply)
      endSend(taken.clientMessageId, false)
    } else endSend(taken.clientMessageId, true)
    if (outcome) toast(outcome.say)
  }

  async function onSchedule(sendAt: number) {
    if (!draft.trim()) return
    if (!bridgeKey) return toast('This server has no bridge key yet, so nothing can be scheduled.')
    try {
      checkWithinAYear(sendAt)
    } catch (e) {
      return toast(errorMessage(e, 'That time can’t be used.'))
    }
    const chatId = chat.id
    // Taken out of the composer as it goes, like a send: it can't be sent or scheduled twice, and
    // it comes back, ahead of anything typed since, only if it doesn't go.
    const taken = takeForSend<Message>(chatId, sendIdOfTaken)
    if (!taken) return
    await whileSending(async () => {
      try {
        const sealed = sealText(taken.text, taken.clientMessageId, session.userId, session.keyPair.publicKey, bridgeKey)
        const outcome = await schedule({
          chatId,
          clientMessageId: taken.clientMessageId,
          sendAt,
          ...sealed,
          ...(taken.reply ? { replyTo: taken.reply.eventId } : {}),
        })
        if (typeof outcome === 'object') settle(chatId, taken, outcome)
        else {
          settle(chatId, taken, null)
          toast(`Scheduled for ${formatWhen(sendAt)}`)
        }
      } catch (e) {
        restoreDraft(chatId, taken.text, taken.reply, taken.id)
        endSend(taken.clientMessageId, false)
        toast(errorMessage(e, 'That message couldn’t be scheduled.'))
      }
    })
  }

  /**
   * Copies a cancelled message's text, and the message it replies to, into the composer as an
   * ordinary new draft: into an empty one, or one replying to the same message. The row stays,
   * kept on the server, until the person discards it (or 30 days pass); nothing goes by itself.
   */
  function restoreCancelled(id: Id<'scheduledSends'>, body: string, replyTo: string | null) {
    const chatId = chat.id
    if (restoreConflict(getDraft<Message>(chatId), replyTo)) return toast('Clear or send your draft first.')
    // A reply goes back as one, to the message it answered, even one not loaded.
    const reply = replyTo ? (byEvent(replyTo) ?? replyStub(replyTo)) : null
    const added = appendToDraft(chatId, body, reply)
    setRestored((now) => new Set(now).add(id))
    toast(added ? 'Restored below your draft.' : 'Restored to your draft.')
  }

  const byEvent = (eventId: string) => messages.find((m) => m.eventId === eventId)

  // Sending again (send-again.ts): the server says, for each send that failed or may not have
  // gone, where its chain stands and whether another attempt may be made. Asked in batches of
  // at most 100, newest first.
  const troubled = messages
    .flatMap((m) =>
      m.clientMessageId && (m.delivery === 'failed' || m.delivery === 'unknown') ? [m.clientMessageId] : [],
    )
    .reverse()
  const retryBatches: string[][] = []
  for (let i = 0; i < troubled.length; i += 100) retryBatches.push(troubled.slice(i, i + 100))
  const retryStates = new Map(
    [useRetryStates(retryBatches[0] ?? []), useRetryStates(retryBatches[1] ?? [])]
      .flatMap((batch) => batch ?? [])
      .map((r) => [r.clientMessageId, r.state] as const),
  )
  const sendingAgain = useSendingAgain()

  const name = chat.name
  const muted = chat.muted
  const toggleArchived = () =>
    void act(chat.id, async () => {
      const archiving = !chat.row.archived
      const ok = await actions.setArchived(chat.id, archiving)
      if (ok && archiving)
        toast(`Archived ${name}`, {
          label: 'Undo',
          onClick: () => void actions.setArchived(chat.id, false),
        })
      return ok
    })
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col bg-surface-2">
        <header className="relative flex h-(--bar-h) shrink-0 items-center gap-3 border-b border-border bg-surface pr-3.5 pl-5 max-md:gap-2 max-md:pr-1.5 max-md:pl-1.5">
          <Button variant="ghost" size="icon" aria-label="Back to chats" className="md:hidden" onClick={onBack}>
            <ChevronLeft className="size-5" />
          </Button>
          <ChatAvatar
            chat={chat}
            name={name}
            size={38}
            badge={<NetworkBadge network={chat.network} label={networkName(chat.network)} size={16} />}
            className="[--avatar-ring:var(--surface)]"
          />
          <div className="min-w-0">
            <h1 className="truncate text-md font-bold">{name}</h1>
            {/* The avatar's badge says the network; only a snooze needs saying here. */}
            {chat.row.snoozedUntil && !chat.row.woke ? (
              <p className="truncate text-sm text-subtle-foreground">
                Snoozed until {formatWhen(chat.row.snoozedUntil)}
              </p>
            ) : null}
          </div>
          <div className="ml-auto flex items-center gap-0.5">
            {chat.row.isRequest ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() => void act(chat.id, () => actions.acceptRequest(chat.id))}
              >
                <Check className="size-3.5" /> Accept request
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              aria-label={chat.row.pinned ? 'Unpin' : 'Pin'}
              title={chat.row.pinned ? 'Unpin' : 'Pin'}
              className="max-sm:hidden"
              onClick={() => void act(chat.id, () => actions.setPinned(chat.id, !chat.row.pinned))}
            >
              {chat.row.pinned ? <PinOff className="size-[18px]" /> : <Pin className="size-[18px]" />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="Snooze" title="Snooze">
                  <AlarmClock className="size-[18px]" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
                {snoozeOptions().map((o) => (
                  <DropdownMenuItem
                    key={o.label}
                    onSelect={() =>
                      void act(chat.id, async () => {
                        const ok = await actions.snooze(chat.id, o.until)
                        if (ok)
                          toast(`Snoozed until ${formatWhen(o.until)}`, {
                            label: 'Undo',
                            onClick: () => void actions.wake(chat.id),
                          })
                        return ok
                      })
                    }
                  >
                    <AlarmClock /> {o.label} <DropdownMenuTrail>{formatWhen(o.until)}</DropdownMenuTrail>
                  </DropdownMenuItem>
                ))}
                {chat.row.snoozedUntil && !chat.row.woke ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={() => void act(chat.id, () => actions.wake(chat.id))}>
                      <Bell /> Wake now
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon"
              aria-label={chat.row.archived ? 'Move to inbox' : 'Archive'}
              title={chat.row.archived ? 'Move to inbox' : 'Archive'}
              className="max-sm:hidden"
              onClick={toggleArchived}
            >
              {chat.row.archived ? <ArchiveRestore className="size-[18px]" /> : <Archive className="size-[18px]" />}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label="More">
                  <MoreHorizontal className="size-[18px]" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* On a narrow screen, where the header has no room for their buttons. */}
                <DropdownMenuItem
                  className="sm:hidden"
                  onSelect={() => void act(chat.id, () => actions.setPinned(chat.id, !chat.row.pinned))}
                >
                  {chat.row.pinned ? <PinOff /> : <Pin />} {chat.row.pinned ? 'Unpin' : 'Pin'}
                </DropdownMenuItem>
                <DropdownMenuItem className="sm:hidden" onSelect={toggleArchived}>
                  {chat.row.archived ? <ArchiveRestore /> : <Archive />}{' '}
                  {chat.row.archived ? 'Move to inbox' : 'Archive'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void act(chat.id, () => actions.markUnread(chat.id))}>
                  <Bell /> Mark unread
                </DropdownMenuItem>
                {muted ? (
                  <DropdownMenuItem onSelect={() => void act(chat.id, () => actions.setMuted(chat.id, false))}>
                    <Bell /> Unmute
                  </DropdownMenuItem>
                ) : (
                  <>
                    <DropdownMenuItem
                      onSelect={() =>
                        void act(chat.id, () => actions.setMuted(chat.id, true, Date.now() + 8 * 3600_000))
                      }
                    >
                      <BellOff /> Mute for 8 hours
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void act(chat.id, () => actions.setMuted(chat.id, true))}>
                      <BellOff /> Mute until I unmute
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon"
              ref={detailsButton}
              aria-label="Chat details"
              aria-pressed={details}
              className={cn(details && 'bg-primary-soft text-primary')}
              onClick={() => setDetails(!details)}
            >
              <Info className="size-[18px]" />
            </Button>
          </div>
          {/* What's shown is the cache's until the server has answered, or while it can't be
              reached: a line along the header's edge says so, without moving anything. */}
          <SyncBar active={!confirmed || loading || !connected} offline={!connected} />
        </header>
        <MessageList
          network={chat.network}
          messages={messages}
          loading={loading}
          reactions={reactions}
          group={group}
          canReact={NETWORK_INFO[chat.network]?.reactions === true}
          senders={senders}
          scheduled={scheduled}
          cancelled={cancelled}
          typing={typing.length}
          canLoadMore={canLoadMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          onReply={setReplyTo}
          onReact={(m, key) => toggleReaction(m.id, key)}
          onSendAgain={(m) => {
            // One attempt per link of the chain, whatever the clicks and from whichever row: the
            // person chose to risk a duplicate on the network, once each time (send-again.ts).
            const text = m.body?.body
            const state = m.clientMessageId ? retryStates.get(m.clientMessageId) : undefined
            if (!text || !state) return
            // The retry state can load before the bridge key on a cold start: say why nothing
            // happened rather than ignore the click.
            if (!bridgeKey)
              return toast(
                bridge.status === 'loading'
                  ? 'Still connecting to the server. Try again in a moment.'
                  : bridge.status === 'error'
                    ? 'The server’s bridge key couldn’t be loaded, so nothing can be sent. Reload to try again.'
                    : 'This server has no bridge key yet, so nothing can be sent.',
              )
            void sendAgain(state, (nextId) => {
              const sealed = sealText(text, nextId, session.userId, session.keyPair.publicKey, bridgeKey)
              return sendAgainMutation({
                clientMessageId: m.clientMessageId!,
                nextId,
                ...sealed,
                ...(m.replyTo ? { replyTo: m.replyTo } : {}),
              })
            }).then(
              (created) => {
                if (!created) toast('That message was sent again already, or can’t be now.')
              },
              (e: unknown) => toast(errorMessage(e, 'That message couldn’t be sent again.')),
            )
          }}
          againOf={(m) => againView(m.clientMessageId ? retryStates.get(m.clientMessageId) : undefined, sendingAgain)}
          onDiscard={(m) => {
            if (m.clientMessageId)
              void discard({ clientMessageId: m.clientMessageId }).catch((e: unknown) =>
                toast(errorMessage(e, 'That message couldn’t be discarded.')),
              )
          }}
          onSendScheduledNow={(id) =>
            void sendScheduledNow({ scheduledId: id }).catch((e: unknown) =>
              toast(errorMessage(e, 'That message couldn’t be sent.')),
            )
          }
          onCancelScheduled={({ id }) => {
            if (cancelling.has(id)) return
            setCancelling((now) => new Set(now).add(id))
            void cancelScheduled({ scheduledId: id })
              .then(
                (answer) => {
                  if (answer.outcome === 'sent') return toast(beatenBySend(answer.delivery))
                  if (answer.outcome === 'dismissed') return
                  // Cancelled by an earlier call (another tab, or this pane before it was reopened):
                  // that one put its text in the composer. This leaves it to an explicit Restore.
                  if (!answer.first) return toast('Already cancelled. It’s kept below to restore or discard.')
                  // Cancelled: its copy stays on the server, listed below. The text is the one the
                  // server returned, not what this list showed.
                  const text = answer.copy
                    ? tryOpen<MessagePlaintext>(
                        answer.copy,
                        session.keyPair,
                        'message',
                        session.userId,
                        answer.clientMessageId,
                      )?.body
                    : undefined
                  if (typeof text === 'string') restoreCancelled(id, text, answer.replyTo)
                  else toast('Cancelled. It’s kept below until you restore or discard it.')
                },
                (e: unknown) => toast(errorMessage(e, 'That scheduled message couldn’t be cancelled.')),
              )
              .finally(() =>
                setCancelling((now) => {
                  const next = new Set(now)
                  next.delete(id)
                  return next
                }),
              )
          }}
          onRestoreCancelled={(c) => {
            if (typeof c.body === 'string') restoreCancelled(c.id, c.body, c.replyTo)
          }}
          onDiscardCancelled={(c) =>
            void forgetScheduled({ scheduledId: c.id }).then(
              () => toast('Discarded. It won’t be sent.'),
              (e: unknown) => toast(errorMessage(e, 'That message couldn’t be discarded.')),
            )
          }
        />
        <Composer
          network={chat.network}
          draft={draft}
          onDraft={setDraft}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onSend={() => void onSend()}
          onSchedule={(at) => void onSchedule(at)}
          disabled={composerBlocked(chat.row, bridge.status)}
        />
      </main>
      {details ? (
        <DetailsPanel chat={chat} act={act} onClose={() => setDetails(false)} returnFocus={detailsButton} />
      ) : null}
    </>
  )
}

/**
 * The message a restored reply answers, when it isn't loaded: the composer shows "a message",
 * and the send needs only its event ID.
 */
function replyStub(eventId: string): Message {
  return {
    id: '' as Message['id'],
    eventId,
    pending: false,
    self: false,
    ghostId: undefined,
    at: 0,
    body: null,
    edited: false,
    deleted: false,
    replyTo: undefined,
    clientMessageId: undefined,
    delivery: undefined,
  }
}

const sendIdOfTaken = (t: { id: string; text: string; reply: Message | null }) =>
  draftSendId(t.id, t.text, t.reply?.eventId)
