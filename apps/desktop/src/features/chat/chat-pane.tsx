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
  mergedChat,
  networkName,
  onEach,
  useOpenChat,
  useCancelledIn,
  useChatActions,
  useAccounts,
  useChatsById,
  useScheduled,
  useScheduledTexts,
  type Chat,
  type ChatId,
} from '~/data/chats.ts'
import { accountLabels } from '~/data/account-label.ts'
import { composerBlocked } from '~/data/bridge-ready.ts'
import { useSettled } from '~/data/chat-content.ts'
import { useContactProfiles, useContactsAcross } from '~/data/contacts.ts'
import {
  cardIndex,
  cardOfChat,
  stableSlots,
  takeSendRequest,
  uniqueLabels,
  useSendRequest,
} from '~/data/conversations.ts'
import { usePeople } from '~/data/people.ts'
import {
  useBridge,
  useMessages,
  useReactions,
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
import { DetailsPanel, type PanelView } from './details-panel.tsx'
import { ChatAvatar } from './chat-avatar.tsx'
import { MessageList, MessagesSkeleton } from './message-list.tsx'
import { ReadWhileOpen } from './read-while-open.tsx'
import type { ReadOnOpen } from '~/data/read-on-open.ts'
import { draftSendId } from '~/data/saved-drafts.ts'
import { beatenBySend, usedOutcome, type AlreadyUsed } from './already-used.ts'
import { restoreConflict } from './cancel-scheduled.ts'
import { againView, sendAgain, useSendingAgain } from './send-again.ts'

interface ChatPaneProps {
  chatId: ChatId | undefined
  /**
   * The open chat and the rest of its conversation (conversations.ts): a person's direct chats
   * on other networks, shown and acted on together.
   */
  chatIds: readonly ChatId[]
  /** The open chat no longer exists (deleted, or not the person's). */
  onGone: () => void
  /** Back to the list, on a narrow screen where the chat covers it. */
  onBack: () => void
  /** Runs an action that may take the chat off the list; the shell opens the next one if so. */
  act: (chatId: ChatId, run: () => Promise<boolean>) => Promise<void>
  /** Opens a People card in the People window. */
  onOpenPerson: (personKey: string) => void
  /** Opens a chat, one a profile names or just started. */
  onOpenChat: (chatId: ChatId) => void
}

export function ChatPane({ chatId, chatIds, onGone, onBack, act, onOpenPerson, onOpenChat }: ChatPaneProps) {
  const session = useSession()
  // A chat the sidebar has shown opens at once with its row from there; the server's own answer
  // takes its place when it comes (useOpenChat).
  const { chat, confirmed } = useOpenChat(chatId)
  // What each read tracker has done, kept above the retry boundary: a retry isn't a new opening,
  // which would clear the person's own "marked unread". Opening another chat starts again.
  const readStates = useMemo(() => new Map<string, ReadOnOpen>(), [chatId])
  // The chat chosen to send on, kept above it too, so a retry opens the composer where it was.
  const chosen = useMemo(() => ({ current: null as ChatId | null }), [chatId])
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
      {(attempt) => (
        <OpenChat
          chat={chat}
          confirmed={confirmed}
          chatIds={chatIds}
          attempt={attempt}
          readStates={readStates}
          chosen={chosen}
          act={act}
          onBack={onBack}
          onOpenPerson={onOpenPerson}
          onOpenChat={onOpenChat}
        />
      )}
    </RetryBoundary>
  )
}

/**
 * A chat opened before anything is known of it (a link, or one the sidebar hasn't loaded): its
 * header's and composer's shapes while it loads, so the chat fills them in rather than pushing in.
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
      {/* The composer's one line (50px), so it doesn't push the list up when it comes. */}
      <div className="mx-3.5 mb-3.5 h-[50px] shrink-0 rounded-[14px] bg-surface shadow-[0_0_0_1px_var(--border)]" />
    </main>
  )
}

function OpenChat({
  chat,
  confirmed,
  chatIds,
  attempt,
  readStates,
  chosen,
  act,
  onBack,
  onOpenPerson,
  onOpenChat,
}: Pick<ChatPaneProps, 'chatIds' | 'act' | 'onBack' | 'onOpenPerson' | 'onOpenChat'> & {
  chat: Chat
  /** False while the header shows the sidebar's copy of the chat, not yet the server's. */
  confirmed: boolean
  attempt: number
  readStates: Map<string, ReadOnOpen>
  chosen: { current: ChatId | null }
}) {
  const session = useSession()
  const actions = useChatActions()
  // The person's direct chats on other networks, shown with this one as one conversation.
  const together = chatIds.length > 1 && chatIds.includes(chat.id)
  const looked = useChatsById(together ? chatIds : [])
  // While a newly linked chat's row is on its way, the chats already here stay (with their page
  // slots and read trackers), less any no longer in the conversation; the opened one always is.
  const lastLive = useRef<Chat[] | undefined>(undefined)
  if (looked) lastLive.current = looked
  const live = together ? (looked ?? lastLive.current?.filter((m) => chatIds.includes(m.id))) : undefined
  // Only chats the person's cards link to the same person as the opened one, as they are now:
  // a chat moved to another card on another device is out at once, whatever the sidebar said.
  const people = usePeople()
  const cards = useMemo(() => cardIndex(people), [people])
  const opened = cardOfChat(chat, cards)
  const members = useMemo(() => {
    const same = live?.filter(
      (m) => m.id === chat.id || (!!opened && cardOfChat(m, cards)?.personKey === opened.personKey),
    )
    return same && same.length > 1 && same.some((m) => m.id === chat.id) ? same : [chat]
  }, [live, chat, cards, opened])
  const accounts = useAccounts()
  const accountNames = useMemo(
    () => accountLabels((accounts ?? []).map((a) => ({ id: a._id as string, network: a.network, hint: a.hint }))),
    [accounts],
  )
  const memberIds = members.map((m) => m.id)
  const merged = members.length > 1
  const person = opened
  // Named and pictured after the person; acted on as the chat that was opened.
  const shown = { ...mergedChat(members, person), id: chat.id }
  const each = (run: (chatId: ChatId) => Promise<boolean>) => onEach(members, run)
  // Each chat keeps its page slot while the conversation's order changes with new messages.
  const slotsRef = useRef<(string | undefined)[]>([])
  slotsRef.current = stableSlots(slotsRef.current, memberIds)
  const { messages, hidden, loading, canLoadMore, loadingMore, loadMore } = useMessages(
    slotsRef.current as (ChatId | undefined)[],
    attempt,
  )
  // A conversation's chats and their first pages are still on their way: until they're in, what
  // it shows of each (and so what it marks read) isn't known.
  const waiting = together && (!looked || !people || loading)
  const networkOfChat = new Map(members.map((m) => [m.id as string, m.network]))
  // Where focus goes back to when the side panel's sheet closes: what opened it.
  const detailsButton = useRef<HTMLButtonElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  // Deleted messages and pending copies have no reactions: leaving them out saves requests for
  // nothing, and keeps the reaction groups steady (a pending copy's place can still move).
  const { reactions: serverReactions, pending: reactionsPending } = useReactions(
    messages.filter((m) => !m.deleted && !m.pending),
  )
  const network = merged ? 'The network' : networkName(chat.network)
  const chatOfMessage = (id: Message['id']) => messages.find((m) => m.id === id)?.chatId
  const { reactions, toggle: toggleReaction } = useReactionToggle(
    chatOfMessage,
    serverReactions,
    useCallback(() => toast(`${network} hasn’t confirmed that reaction yet.`), [network]),
    useCallback((e: unknown) => toast(errorMessage(e, 'That reaction couldn’t be sent.')), []),
  )
  const group = chat.row.kind === 'group'
  // Only a group's senders are shown, so only a group asks who they are.
  const { profiles: senders, pending: sendersPending } = useContactProfiles(
    chat.network,
    group ? messages.flatMap((m) => (m.ghostId && !m.self ? [m.ghostId] : [])) : [],
  )
  const typing = useTyping(memberIds)
  // A conversation's scheduled messages are those of any of its chats.
  const scheduledRows = useScheduled(merged ? undefined : chat.id)
  // Each chat's own, so none is cut off by a limit on everyone's.
  const cancelledRows = useCancelledIn(memberIds)
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
  // Which of a conversation's chats a message goes by: the one chosen last (in the composer, or
  // by replying to a message in it), or the one a profile's Message or Open came here to send on;
  // else, once the messages are in, one with a draft already, then where they last wrote from,
  // then the chat that was opened. Kept until the person changes it.
  const [sendId, setSendIdState] = useState<ChatId | null>(() => chosen.current)
  const setSendId = (id: ChatId) => {
    chosen.current = id
    setSendIdState(id)
  }
  // The chat the composer is on now, for an action that finishes later.
  const sendIdRef = useRef<ChatId>(chat.id)
  // Asked for this chat: only the pane opened on it takes it, not one it's leaving.
  const request = useSendRequest()
  const requested = request === chat.id
  useEffect(() => {
    const id = takeSendRequest([chat.id])
    if (id) setSendId(id as ChatId)
  }, [request, chat.id])
  useEffect(() => {
    if (sendId !== null || waiting || loading || requested) return
    const drafted = memberIds.find((id) => getDraft(id).text.trim() || getDraft(id).reply)
    const theirs = [...messages].reverse().find((m) => !m.self && memberIds.includes(m.chatId))?.chatId
    setSendId(drafted ?? theirs ?? chat.id)
  }, [sendId, waiting, loading, requested, messages, memberIds, chat.id])
  // A chosen chat that's no longer in the conversation (its link moved, or the list it came from
  // failed) isn't swapped for another under the person's fingers: nothing sends until they
  // choose again, and its own draft stays on screen meanwhile.
  const lost = sendId !== null && !members.some((m) => m.id === sendId)
  const sendChat = members.find((m) => m.id === sendId) ?? chat
  sendIdRef.current = sendChat.id
  // What the network chooser (and a scheduled message) calls each chat: its network, and its
  // account when there are two; then, for two chats on one account (two numbers of one
  // person), who each is with; and a number for any still alike, the same one each time.
  const sameAccount = members.filter((m) =>
    members.some((o) => o !== m && o.network === m.network && o.row.networkAccountId === m.row.networkAccountId),
  )
  const whoOf = useContactsAcross(
    sameAccount.flatMap((m) => (m.dmGhostId ? [{ network: m.network, ghostId: m.dmGhostId }] : [])),
  )
  const sendLabels = uniqueLabels(
    members.map((m) => {
      const base =
        (m.row.networkAccountId ? accountNames.get(m.row.networkAccountId)?.full : undefined) ?? networkName(m.network)
      if (!sameAccount.includes(m)) return { key: m.id, label: base }
      const who = m.dmGhostId ? whoOf.get(`${m.network}/${m.dmGhostId}`) : undefined
      return { key: m.id, label: `${base} · ${who?.handle || who?.name || m.name}` }
    }),
  )
  const labelOf = (chatId: string) => (merged ? sendLabels[memberIds.indexOf(chatId as ChatId)] : undefined)
  // The draft and reply live in the per-chat draft store (drafts.ts), so an action that finishes
  // after this pane was left and opened again still changes what's on screen. Each chat of a
  // conversation keeps its own: the composer shows the draft of the chat it sends on, so what's
  // typed for one network only ever goes on that one, and choosing another moves nothing.
  // The chat whose draft is on screen, which every change to it goes to.
  const draftId = lost ? sendId! : sendChat.id
  const { text: draft, reply: replyTo } = useDraft<Message>(draftId)
  // Cancelled messages restored to the composer from this pane, to say so. Restore stays.
  const [restored, setRestored] = useState<ReadonlySet<string>>(new Set())
  const setDraft = (text: string) => setDraftText(draftId, text)
  // A reply goes in the chat of the message it answers, and the composer goes there with it.
  const setReplyTo = (message: Message | null) => {
    if (message) setSendId(message.chatId)
    setDraftReply(message?.chatId ?? draftId, message)
  }
  // Closed whenever a chat opens; the pane is remade for each chat.
  const [panel, setPanel] = useState<PanelView | null>(null)
  const toggleDetails = (from: HTMLElement) => {
    opener.current = from
    setPanel(panel?.kind === 'chat' ? null : { kind: 'chat' })
  }

  const inHere = (s: { chatId: string }) => memberIds.includes(s.chatId as ChatId)
  // Only those still to go: a failed one's chat was gone, and the sidebar lists it to dismiss.
  const pending = useMemo(
    () => (scheduledRows ?? []).filter((s) => s.state !== 'failed' && inHere(s)),
    // `inHere` follows the members.
    [scheduledRows, memberIds.join()],
  )
  const cancelledHere = useMemo(() => (cancelledRows ?? []).filter(inHere), [cancelledRows, memberIds.join()])
  const chatOfScheduled = new Map<string, ChatId>([...pending, ...cancelledHere].map((s) => [s._id, s.chatId]))
  const scheduledIds = [...pending, ...cancelledHere].map((s) => s._id)
  const scheduledTexts = useScheduledTexts(scheduledIds)
  // The messages show once what goes with them has come too (or SETTLE_MS after them), so
  // nothing pops in to move the list. Until then the list holds a skeleton, and nothing is marked
  // read: the person hasn't seen the messages yet.
  const held = !useSettled(
    !loading && !waiting,
    reactionsPending ||
      sendersPending ||
      scheduledRows === undefined ||
      cancelledRows === undefined ||
      // A copy that can't be opened or fetched is there too, as null; only one on its way is missing.
      scheduledIds.some((id) => !scheduledTexts.has(id)),
  )
  const connected = useConnected()
  const scheduled = useMemo(
    () =>
      pending.map((s) => ({
        id: s._id,
        sendAt: s.sendAt,
        body: scheduledTexts.get(s._id),
        replyTo: s.replyTo,
        cancelling: cancelling.has(s._id),
        via: labelOf(s.chatId),
      })),
    // `labelOf` follows the members' labels.
    [pending, scheduledTexts, cancelling, sendLabels.join()],
  )
  const cancelled = cancelledHere.map((c) => ({
    id: c._id,
    body: scheduledTexts.get(c._id),
    replyTo: c.replyTo,
    restored: restored.has(c._id),
    via: labelOf(c.chatId),
  }))

  async function sendText(chatId: ChatId, text: string, reply?: string, clientMessageId = newClientId()) {
    // Thrown, not only said, so a send again that couldn't go can be tried again.
    if (!bridgeKey) {
      toast('This server has no bridge key yet, so nothing can be sent.')
      throw new Error('No bridge key')
    }
    const sealed = sealText(text, clientMessageId, session.userId, session.keyPair.publicKey, bridgeKey)
    try {
      return await send({ chatId, clientMessageId, ...sealed, ...(reply ? { replyTo: reply } : {}) })
    } catch (e) {
      toast(errorMessage(e, 'That message couldn’t be sent.'))
      throw e
    }
  }

  async function onSend() {
    if (!draft.trim() || lost) return
    // Nothing leaves the composer until it can be sent.
    if (!bridgeKey) return toast('This server has no bridge key yet, so nothing can be sent.')
    const to = sendChat.id
    // The draft's own send ID: the same draft sent again, from another tab or after a reload,
    // is the same send. Noted as under way, and saved so, before the composer is cleared (I2).
    const taken = takeForSend<Message>(to, sendIdOfTaken)
    if (!taken) return
    await whileSending(() =>
      sendText(to, taken.text, replyIn(taken.reply, to), taken.clientMessageId).then(
        (outcome) => settle(to, taken, outcome === 'queued' ? null : outcome),
        () => {
          // Back first, then the copy under way goes.
          restoreDraft(to, taken.text, taken.reply, taken.id)
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
    if (!draft.trim() || lost) return
    if (!bridgeKey) return toast('This server has no bridge key yet, so nothing can be scheduled.')
    try {
      checkWithinAYear(sendAt)
    } catch (e) {
      return toast(errorMessage(e, 'That time can’t be used.'))
    }
    const to = sendChat.id
    // Taken out of the composer as it goes, like a send: it can't be sent or scheduled twice, and
    // it comes back, ahead of anything typed since, only if it doesn't go.
    const taken = takeForSend<Message>(to, sendIdOfTaken)
    if (!taken) return
    await whileSending(async () => {
      try {
        const sealed = sealText(taken.text, taken.clientMessageId, session.userId, session.keyPair.publicKey, bridgeKey)
        const reply = replyIn(taken.reply, to)
        const outcome = await schedule({
          chatId: to,
          clientMessageId: taken.clientMessageId,
          sendAt,
          ...sealed,
          ...(reply ? { replyTo: reply } : {}),
        })
        if (typeof outcome === 'object') settle(to, taken, outcome)
        else {
          settle(to, taken, null)
          toast(`Scheduled for ${formatWhen(sendAt)}`)
        }
      } catch (e) {
        restoreDraft(to, taken.text, taken.reply, taken.id)
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
    // Into the draft of the chat it was for, in a conversation, whichever the composer is on now
    // (this can run after the cancel's answer comes back): it only ever goes on that chat.
    const chatId = chatOfScheduled.get(id) ?? sendChat.id
    if (restoreConflict(getDraft<Message>(chatId), replyTo)) return toast('Clear or send your draft first.')
    // A reply goes back as one, to the message it answered, even one not loaded.
    const reply = replyTo ? (byEvent(replyTo) ?? replyStub(replyTo, chatId)) : null
    const added = appendToDraft(chatId, body, reply)
    setRestored((now) => new Set(now).add(id))
    // The composer shows it, unless it's on another chat with something in that one's draft.
    const current = sendIdRef.current
    const busy = current !== chatId && (getDraft(current).text.trim() || getDraft(current).reply)
    if (!busy) setSendId(chatId)
    const where = busy
      ? ` on ${networkOfChat.get(chatId) ? networkName(networkOfChat.get(chatId)!) : 'its network'}`
      : ''
    toast(added ? `Restored below your draft${where}.` : `Restored to your draft${where}.`)
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

  const name = shown.name
  const muted = shown.muted
  const pinned = shown.row.pinned
  const toggleArchived = () =>
    void act(chat.id, async () => {
      const archiving = !chat.row.archived
      const ok = await each((c) => actions.setArchived(c, archiving))
      if (ok && archiving)
        toast(`Archived ${name}`, {
          label: 'Undo',
          onClick: () => void each((c) => actions.setArchived(c, false)),
        })
      return ok
    })
  const togglePinned = () => void act(chat.id, () => each((c) => actions.setPinned(c, !pinned)))
  return (
    <>
      <main className="flex min-w-0 flex-1 flex-col bg-surface-2">
        <header className="relative flex h-(--bar-h) shrink-0 items-center gap-3 border-b border-border bg-surface pr-3.5 pl-5 max-md:gap-2 max-md:pr-1.5 max-md:pl-1.5">
          <Button variant="ghost" size="icon" aria-label="Back to chats" className="md:hidden" onClick={onBack}>
            <ChevronLeft className="size-5" />
          </Button>
          {/* The avatar and name open the profile: who a direct chat is with, or the group's details. */}
          <Button
            variant="bare"
            type="button"
            aria-label={chat.row.kind === 'dm' ? `Profile of ${name}` : `Details of ${name}`}
            className="shrink-0 rounded-full"
            onClick={(e) => toggleDetails(e.currentTarget)}
          >
            <ChatAvatar
              chat={shown}
              size={38}
              badge={
                lost ? undefined : (
                  <NetworkBadge network={sendChat.network} label={networkName(sendChat.network)} size={16} />
                )
              }
              className="[--avatar-ring:var(--surface)]"
            />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-md font-bold">
              <Button
                variant="bare"
                type="button"
                className="max-w-full truncate text-left hover:underline"
                onClick={(e) => toggleDetails(e.currentTarget)}
              >
                {name}
              </Button>
            </h1>
            {/* The avatar's badge says the network; only a snooze needs saying here. */}
            {chat.row.snoozedUntil && !chat.row.woke ? (
              <p className="truncate text-sm text-subtle-foreground">
                Snoozed until {formatWhen(chat.row.snoozedUntil)}
              </p>
            ) : null}
          </div>
          <div className="ml-auto flex items-center gap-0.5">
            {members.some((m) => m.row.isRequest) ? (
              <Button
                variant="primary"
                size="sm"
                onClick={() =>
                  void act(chat.id, () =>
                    onEach(
                      members.filter((m) => m.row.isRequest),
                      (c) => actions.acceptRequest(c),
                    ),
                  )
                }
              >
                <Check className="size-3.5" /> Accept request
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              aria-label={pinned ? 'Unpin' : 'Pin'}
              title={pinned ? 'Unpin' : 'Pin'}
              className="max-sm:hidden"
              onClick={togglePinned}
            >
              {pinned ? <PinOff className="size-[18px]" /> : <Pin className="size-[18px]" />}
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
                        const ok = await each((c) => actions.snooze(c, o.until))
                        if (ok)
                          toast(`Snoozed until ${formatWhen(o.until)}`, {
                            label: 'Undo',
                            onClick: () => void each((c) => actions.wake(c)),
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
                    <DropdownMenuItem onSelect={() => void act(chat.id, () => each((c) => actions.wake(c)))}>
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
                <DropdownMenuItem className="sm:hidden" onSelect={togglePinned}>
                  {pinned ? <PinOff /> : <Pin />} {pinned ? 'Unpin' : 'Pin'}
                </DropdownMenuItem>
                <DropdownMenuItem className="sm:hidden" onSelect={toggleArchived}>
                  {chat.row.archived ? <ArchiveRestore /> : <Archive />}{' '}
                  {chat.row.archived ? 'Move to inbox' : 'Archive'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void act(chat.id, () => actions.markUnread(sendChat.id))}>
                  <Bell /> Mark unread
                </DropdownMenuItem>
                {muted ? (
                  <DropdownMenuItem onSelect={() => void act(chat.id, () => each((c) => actions.setMuted(c, false)))}>
                    <Bell /> Unmute
                  </DropdownMenuItem>
                ) : (
                  <>
                    <DropdownMenuItem
                      onSelect={() =>
                        void act(chat.id, () => {
                          const until = Date.now() + 8 * 3600_000
                          return each((c) => actions.setMuted(c, true, until))
                        })
                      }
                    >
                      <BellOff /> Mute for 8 hours
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => void act(chat.id, () => each((c) => actions.setMuted(c, true)))}>
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
              aria-pressed={panel?.kind === 'chat'}
              className={cn(panel?.kind === 'chat' && 'bg-primary-soft text-primary')}
              onClick={(e) => toggleDetails(e.currentTarget)}
            >
              <Info className="size-[18px]" />
            </Button>
          </div>
          {/* What's shown is the cache's until the server has answered, or while it can't be
              reached: a line along the header's edge says so, without moving anything. */}
          <SyncBar active={!confirmed || held || !connected} offline={!connected} />
        </header>
        <MessageList
          network={chat.network}
          networkOf={merged ? (m) => networkOfChat.get(m.chatId) ?? chat.network : undefined}
          messages={messages}
          loading={held}
          reactions={reactions}
          group={group}
          canReact={(m) => NETWORK_INFO[networkOfChat.get(m.chatId) ?? chat.network]?.reactions === true}
          senders={senders}
          onOpenSender={(ghostId, sender, from) => {
            opener.current = from
            setPanel({ kind: 'person', contact: { network: chat.network, ghostId }, name: sender })
          }}
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
          network={sendChat.network}
          destination={lost ? '' : sendChat.id}
          via={
            merged || lost
              ? {
                  options: members.map((m, i) => ({ id: m.id, network: m.network, label: sendLabels[i]! })),
                  current: lost ? '' : sendChat.id,
                  onChange: (id) => setSendId(id as ChatId),
                }
              : undefined
          }
          draft={draft}
          onDraft={setDraft}
          replyTo={replyTo}
          onCancelReply={() => setReplyTo(null)}
          onSend={() => void onSend()}
          onSchedule={(at) => void onSchedule(at)}
          disabled={lost ? 'Choose where to send this.' : composerBlocked(sendChat.row, bridge.status)}
        />
      </main>
      {/* Opening a chat marks it read, as does a new message while it's open and on screen: each
          of a conversation's chats once its messages are shown (a quieter one's may be from before
          what the others have loaded so far). Each keeps its tracker while it waits, so a wait
          isn't a new opening, which would clear the person's own "marked unread". */}
      {members.map((m) => (
        <ReadWhileOpen
          key={m.id}
          chatId={m.id}
          paused={held || waiting || hidden.includes(m.id)}
          states={readStates}
          markRead={actions.markRead}
        />
      ))}
      {panel ? (
        <DetailsPanel
          key={panel.kind === 'person' ? `${panel.contact.network}/${panel.contact.ghostId}` : 'chat'}
          chat={shown}
          members={members}
          view={panel}
          act={act}
          onClose={() => setPanel(null)}
          returnFocus={opener.current ? opener : detailsButton}
          onOpenChat={onOpenChat}
          onOpenPerson={onOpenPerson}
        />
      ) : null}
    </>
  )
}

/**
 * The message a restored reply answers, when it isn't loaded: the composer shows "a message",
 * and the send needs only its event ID.
 */
function replyStub(eventId: string, chatId: ChatId): Message {
  return {
    id: '' as Message['id'],
    chatId,
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

/** A reply's event ID, when it's to a message in the chat it goes to: a network can't reply across chats. */
const replyIn = (reply: Message | null, chatId: ChatId) =>
  reply && (reply.chatId === chatId || !reply.chatId) ? reply.eventId : undefined

const sendIdOfTaken = (t: { id: string; text: string; reply: Message | null }) =>
  draftSendId(t.id, t.text, t.reply?.eventId)
