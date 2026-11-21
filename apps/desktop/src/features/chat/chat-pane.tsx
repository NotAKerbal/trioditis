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
import {
  networkName,
  useChat,
  useCancelledScheduled,
  useChatActions,
  useScheduled,
  useScheduledTexts,
  type Chat,
  type ChatId,
} from '~/data/chats.ts'
import { composerBlocked } from '~/data/bridge-ready.ts'
import { useContacts } from '~/data/contacts.ts'
import {
  useBridge,
  useMessages,
  useReactions,
  useReactionToggle,
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
import { errorMessage } from '~/lib/errors.ts'
import { newClientId, sealText, tryOpen, type MessagePlaintext } from '~/lib/sealed.ts'
import { useSession } from '~/lib/session.tsx'
import { Composer } from './composer.tsx'
import { DetailsPanel } from './details-panel.tsx'
import { MediaAvatar } from './attachments.tsx'
import { MessageList } from './message-list.tsx'
import { draftSendId } from '~/data/saved-drafts.ts'
import { beatenBySend, usedOutcome, type AlreadyUsed } from './already-used.ts'
import { restoreConflict } from './cancel-scheduled.ts'
import { sendAgain, type SendAgainState } from './send-again.ts'

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
  const chat = useChat(chatId)
  useEffect(() => {
    if (chatId && chat === null) onGone()
  }, [chatId, chat, onGone])
  if (!chatId || !chat) {
    return (
      // On a narrow screen the list has the whole width until a chat opens.
      <main
        className={cn(
          'flex min-w-0 flex-1 items-center justify-center bg-surface-2 text-sm text-subtle-foreground',
          !chatId && 'max-md:hidden',
        )}
      >
        {chatId && chat === undefined ? '' : 'No chat open'}
      </main>
    )
  }
  return <OpenChat key={chat.id} chat={chat} act={act} onBack={onBack} />
}

function OpenChat({ chat, act, onBack }: { chat: Chat; act: ChatPaneProps['act']; onBack: () => void }) {
  const session = useSession()
  const actions = useChatActions()
  const { messages, loading, canLoadMore, loadingMore, loadMore } = useMessages(chat.id)
  // Where focus goes back to when the details sheet closes.
  const detailsButton = useRef<HTMLButtonElement>(null)
  // Deleted messages and pending copies have no reactions: leaving them out saves requests for
  // nothing, and keeps the reaction groups steady (a pending copy's place can still move).
  const serverReactions = useReactions(
    chat.id,
    messages.filter((m) => !m.deleted && !m.pending),
  )
  const network = networkName(chat.network)
  const { reactions, toggle: toggleReaction } = useReactionToggle(
    chat.id,
    serverReactions,
    useCallback(() => toast(`${network} hasn’t confirmed that reaction yet.`), [network]),
    useCallback((e: unknown) => toast(errorMessage(e, 'That reaction couldn’t be sent.')), []),
  )
  const group = chat.row.kind === 'group'
  // Only a group's senders are shown, so only a group asks who they are.
  const senders = useContacts(
    chat.network,
    group ? messages.flatMap((m) => (m.ghostId && !m.self ? [m.ghostId] : [])) : [],
  )
  const typing = useTyping(chat.id)
  const scheduledRows = useScheduled(chat.id)
  const cancelledRows = useCancelledScheduled(chat.id)
  // Scheduled messages whose cancel is on its way: Cancel is off for them meanwhile.
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set())
  const bridge = useBridge()
  const bridgeKey = bridge.key
  const { send, discard, schedule, cancelScheduled, forgetScheduled, sendScheduledNow } = useSendMutations()
  // The draft and reply live in the per-chat draft store (drafts.ts), so an action that finishes
  // after this pane was left and opened again still changes what's on screen.
  const { text: draft, reply: replyTo } = useDraft<Message>(chat.id)
  // Cancelled messages restored to the composer from this pane, to say so. Restore stays.
  const [restored, setRestored] = useState<ReadonlySet<string>>(new Set())
  const setDraft = (text: string) => setDraftText(chat.id, text)
  const setReplyTo = (message: Message | null) => setDraftReply(chat.id, message)
  // Closed whenever a chat opens; the pane is remade for each chat.
  const [details, setDetails] = useState(false)

  // Only those still to go: a failed one's chat was gone, and the sidebar lists it to dismiss.
  const pending = useMemo(() => (scheduledRows ?? []).filter((s) => s.state !== 'failed'), [scheduledRows])
  const scheduledTexts = useScheduledTexts([...pending, ...(cancelledRows ?? [])].map((s) => s._id))
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
        <header className="flex h-(--bar-h) shrink-0 items-center gap-3 border-b border-border bg-surface pr-3.5 pl-5 max-md:gap-2 max-md:pr-1.5 max-md:pl-1.5">
          <Button variant="ghost" size="icon" aria-label="Back to chats" className="md:hidden" onClick={onBack}>
            <ChevronLeft className="size-5" />
          </Button>
          <MediaAvatar
            network={chat.network}
            picture={chat.avatar}
            name={name}
            size={38}
            shape={chat.row.kind === 'dm' ? 'circle' : 'square'}
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
            // One attempt per link of the chain, whatever the clicks: the person chose to risk a
            // duplicate on the network, once each time (send-again.ts).
            const text = m.body?.body
            if (!text || !m.clientMessageId) return
            const listed = new Map(
              messages.flatMap((x) => (x.clientMessageId ? [[x.clientMessageId, x.delivery] as const] : [])),
            )
            void sendAgain(m.clientMessageId, listed, (id) => sendText(text, m.replyTo, id)).then((state) => {
              const say = state ? SEND_AGAIN_SAYS[state] : undefined
              if (say) toast(say)
            })
          }}
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

/** What to say when sending again found its replacement's ID used already. */
const SEND_AGAIN_SAYS: Partial<Record<SendAgainState, string>> = {
  maybe: 'It may already have been sent again. Check the chat before sending it once more.',
  failed: 'Sending it again failed. You can try once more.',
}

const sendIdOfTaken = (t: { id: string; text: string; reply: Message | null }) =>
  draftSendId(t.id, t.text, t.reply?.eventId)
