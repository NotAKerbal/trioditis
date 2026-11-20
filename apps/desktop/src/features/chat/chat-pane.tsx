import { Avatar } from '@trioditis/ui/avatar'
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
  Info,
  MoreHorizontal,
  Pin,
  PinOff,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  networkName,
  useChat,
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
  restoreDraft,
  setDraftReply,
  setDraftText,
  takeDraft,
  useDraft,
  whileSending,
} from '~/data/drafts.ts'
import { checkWithinAYear, formatWhen, snoozeOptions } from '~/data/snooze.ts'
import { errorMessage } from '~/lib/errors.ts'
import { newClientId, sealText } from '~/lib/sealed.ts'
import { useSession } from '~/lib/session.tsx'
import { Composer } from './composer.tsx'
import { DetailsPanel } from './details-panel.tsx'
import { MessageList } from './message-list.tsx'

interface ChatPaneProps {
  chatId: ChatId | undefined
  /** The open chat no longer exists (deleted, or not the person's). */
  onGone: () => void
  /** Runs an action that may take the chat off the list; the shell opens the next one if so. */
  act: (chatId: ChatId, run: () => Promise<boolean>) => Promise<void>
}

export function ChatPane({ chatId, onGone, act }: ChatPaneProps) {
  const chat = useChat(chatId)
  useEffect(() => {
    if (chatId && chat === null) onGone()
  }, [chatId, chat, onGone])
  if (!chatId || !chat) {
    return (
      <main className="flex min-w-0 flex-1 items-center justify-center bg-surface-2 text-sm text-subtle-foreground">
        {chatId && chat === undefined ? '' : 'No chat open'}
      </main>
    )
  }
  return <OpenChat key={chat.id} chat={chat} act={act} />
}

function OpenChat({ chat, act }: { chat: Chat; act: ChatPaneProps['act'] }) {
  const session = useSession()
  const actions = useChatActions()
  const { messages, loading, canLoadMore, loadingMore, loadMore } = useMessages(chat.id)
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
  const bridge = useBridge()
  const bridgeKey = bridge.key
  const { send, discard, schedule, cancelScheduled, sendScheduledNow } = useSendMutations()
  // The draft and reply live in the per-chat draft store (drafts.ts), so an action that finishes
  // after this pane was left and opened again still changes what's on screen.
  const { text: draft, reply: replyTo } = useDraft<Message>(chat.id)
  const setDraft = (text: string) => setDraftText(chat.id, text)
  const setReplyTo = (message: Message | null) => setDraftReply(chat.id, message)
  // Closed whenever a chat opens; the pane is remade for each chat.
  const [details, setDetails] = useState(false)

  // Only those still to go: a failed one's chat was gone, and the sidebar lists it to dismiss.
  const pending = useMemo(() => (scheduledRows ?? []).filter((s) => s.state !== 'failed'), [scheduledRows])
  const scheduledTexts = useScheduledTexts(pending.map((s) => s._id))
  const scheduled = useMemo(
    () => pending.map((s) => ({ id: s._id, sendAt: s.sendAt, body: scheduledTexts.get(s._id) })),
    [pending, scheduledTexts],
  )

  async function sendText(text: string, reply?: string) {
    if (!bridgeKey) return toast('This server has no bridge key yet, so nothing can be sent.')
    const clientMessageId = newClientId()
    const sealed = sealText(text, clientMessageId, session.userId, session.keyPair.publicKey, bridgeKey)
    try {
      await send({ chatId: chat.id, clientMessageId, ...sealed, ...(reply ? { replyTo: reply } : {}) })
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
    const taken = takeDraft<Message>(chatId)
    if (!taken) return
    // Put the text and reply back if the send didn't reach the server, keeping anything newer.
    await whileSending(() =>
      sendText(taken.text, taken.reply?.eventId).catch(() => restoreDraft(chatId, taken.text, taken.reply)),
    )
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
    const taken = takeDraft<Message>(chatId)
    if (!taken) return
    await whileSending(async () => {
      try {
        const clientMessageId = newClientId()
        const sealed = sealText(taken.text, clientMessageId, session.userId, session.keyPair.publicKey, bridgeKey)
        await schedule({
          chatId,
          clientMessageId,
          sendAt,
          ...sealed,
          ...(taken.reply ? { replyTo: taken.reply.eventId } : {}),
        })
        toast(`Scheduled for ${formatWhen(sendAt)}`)
      } catch (e) {
        restoreDraft(chatId, taken.text, taken.reply)
        toast(errorMessage(e, 'That message couldn’t be scheduled.'))
      }
    })
  }

  const name = chat.name
  const muted = chat.muted
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col bg-surface-2">
        <header className="flex h-(--bar-h) shrink-0 items-center gap-3 border-b border-border bg-surface pr-3.5 pl-5">
          <Avatar
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
              onClick={() =>
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
              }
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
          messages={messages}
          loading={loading}
          reactions={reactions}
          group={group}
          senders={senders}
          scheduled={scheduled}
          typing={typing.length}
          canLoadMore={canLoadMore}
          loadingMore={loadingMore}
          onLoadMore={loadMore}
          onReply={setReplyTo}
          onReact={(m, key) => toggleReaction(m.id, key)}
          onSendAgain={(m) => {
            // A new send with a new client message ID: the person chose to risk a duplicate.
            if (m.body?.body) void sendText(m.body.body, m.replyTo).catch(() => undefined)
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
          onCancelScheduled={(id, body) =>
            // Counted like a send until its text is back in the composer: the server's copy is
            // gone once the cancel goes through, so a reload in between would lose it.
            void whileSending(() =>
              cancelScheduled({ scheduledId: id }).then(
                () => {
                  // Keep anything in the composer by now; add the cancelled text below it. A copy
                  // this device couldn't open, or that hadn't come yet, has nothing to put back.
                  if (body === null) return toast('Cancelled. It won’t be sent.')
                  if (body === undefined)
                    return toast('Cancelled. Its text hadn’t loaded, so it isn’t in the composer.')
                  toast(
                    appendToDraft(chat.id, body)
                      ? 'Cancelled. The message was added below your draft.'
                      : 'Cancelled. The message is back in the composer.',
                  )
                },
                (e: unknown) => toast(errorMessage(e, 'That scheduled message couldn’t be cancelled.')),
              ),
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
      {details ? <DetailsPanel chat={chat} act={act} /> : null}
    </>
  )
}
