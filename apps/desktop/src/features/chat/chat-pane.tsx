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
import { useEffect, useMemo, useState } from 'react'
import { networkName, useChat, useChatActions, useScheduled, type Chat, type ChatId } from '~/data/chats.ts'
import { useBridgeKey, useMessages, useReactions, useSendMutations, useTyping, type Message } from '~/data/messages.ts'
import { formatWhen, snoozeOptions } from '~/data/snooze.ts'
import { errorMessage } from '~/lib/errors.ts'
import { newClientId, sealText, tryOpen, type MessagePlaintext } from '~/lib/sealed.ts'
import { useSession } from '~/lib/session.tsx'
import { Composer } from './composer.tsx'
import { DetailsPanel } from './details-panel.tsx'
import { MessageList } from './message-list.tsx'

// Drafts live in memory only, per chat: they are plaintext, so they never touch the disk.
const drafts = new Map<string, string>()

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
        {chatId && chat === undefined ? '' : 'No chat open. Pick one from the list.'}
      </main>
    )
  }
  return <OpenChat key={chat.id} chat={chat} act={act} />
}

function OpenChat({ chat, act }: { chat: Chat; act: ChatPaneProps['act'] }) {
  const session = useSession()
  const actions = useChatActions()
  const { messages, loading, canLoadMore, loadMore } = useMessages(chat.id)
  const reactions = useReactions(
    chat.id,
    messages.map((m) => m.id),
  )
  const typing = useTyping(chat.id)
  const scheduledRows = useScheduled(chat.id)
  const bridgeKey = useBridgeKey()
  const { send, discard, schedule, cancelScheduled, sendScheduledNow } = useSendMutations()
  const [draft, setDraftState] = useState(() => drafts.get(chat.id) ?? '')
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [details, setDetails] = useState(true)

  const setDraft = (text: string) => {
    setDraftState(text)
    if (text) drafts.set(chat.id, text)
    else drafts.delete(chat.id)
  }

  const scheduled = useMemo(
    () =>
      (scheduledRows ?? []).map((s) => ({
        id: s._id,
        sendAt: s.sendAt,
        body:
          tryOpen<MessagePlaintext>(s.copy, session.keyPair, 'message', session.userId, s.clientMessageId)?.body ?? '',
      })),
    [scheduledRows, session],
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
    const text = draft.trim()
    if (!text) return
    const reply = replyTo?.eventId
    setDraft('')
    setReplyTo(null)
    // Put the text back if the send didn't reach the server, so nothing typed is lost.
    await sendText(text, reply).catch(() => setDraft(text))
  }

  async function onSchedule(sendAt: number) {
    const text = draft.trim()
    if (!text || !bridgeKey) return
    const clientMessageId = newClientId()
    const sealed = sealText(text, clientMessageId, session.userId, session.keyPair.publicKey, bridgeKey)
    try {
      await schedule({
        chatId: chat.id,
        clientMessageId,
        sendAt,
        ...sealed,
        ...(replyTo ? { replyTo: replyTo.eventId } : {}),
      })
      setDraft('')
      setReplyTo(null)
      toast(`Scheduled for ${formatWhen(sendAt)}`)
    } catch (e) {
      toast(errorMessage(e, 'That message couldn’t be scheduled.'))
    }
  }

  const name = chat.name
  const muted = chat.muted
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col bg-surface-2">
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-border bg-surface pr-3.5 pl-5">
          <Avatar
            name={name}
            size={38}
            shape={chat.row.kind === 'dm' ? 'circle' : 'square'}
            badge={<NetworkBadge network={chat.network} label={networkName(chat.network)} size={16} />}
            className="[--avatar-ring:var(--surface)]"
          />
          <div className="min-w-0">
            <h1 className="truncate text-md font-bold">{name}</h1>
            <p className="flex items-center gap-1.5 truncate text-sm text-subtle-foreground">
              {networkName(chat.network)}
              {chat.row.kind !== 'dm' ? ' · group' : ''}
              {chat.row.snoozedUntil && !chat.row.woke ? ` · snoozed until ${formatWhen(chat.row.snoozedUntil)}` : ''}
            </p>
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
          scheduled={scheduled}
          group={chat.row.kind !== 'dm'}
          typing={typing.length}
          canLoadMore={canLoadMore}
          onLoadMore={loadMore}
          onReply={setReplyTo}
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
            void cancelScheduled({ scheduledId: id }).then(
              () => {
                // Keep anything already in the composer; add the cancelled text below it.
                setDraft(draft.trim() ? `${draft}\n${body}` : body)
                toast(
                  draft.trim()
                    ? 'Cancelled. The message was added below your draft.'
                    : 'Cancelled. The message is back in the composer.',
                )
              },
              (e: unknown) => toast(errorMessage(e, 'That scheduled message couldn’t be cancelled.')),
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
          disabled={
            chat.row.blocked ? 'You blocked this chat' : chat.row.isRequest ? 'Accept the request to reply' : null
          }
        />
      </main>
      {details ? <DetailsPanel chat={chat} act={act} /> : null}
    </>
  )
}
