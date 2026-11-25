import type { Id } from '@trioditis/backend/dataModel'
import type { ContactPlaintext, Network } from '@trioditis/core'
import { Button } from '@trioditis/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@trioditis/ui/dropdown-menu'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { cn } from '@trioditis/ui/lib/utils'
import { AlertCircle, ArrowDown, Check, CheckCheck, Clock, MoreHorizontal, Pencil, Reply, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { messageTime } from '~/data/format.ts'
import { captionOf, summarize } from '~/data/last-message.ts'
import { isImage } from '~/data/media.ts'
import type { Message, Reaction } from '~/data/messages.ts'
import { shownKey } from '~/data/reaction-toggle.ts'
import { formatWhen } from '~/data/snooze.ts'
import { networkName } from '~/data/chats.ts'
import { Attachments, MediaAvatar } from './attachments.tsx'
import { LinkCards } from './link-card.tsx'
import { cardReplacesText, linkCards } from './link-preview.ts'
import { isBigEmoji, linkParts, sameRun, sameTime } from './message-text.ts'
import { ReactionPicker } from './reaction-picker.tsx'
import type { SendAgainState } from './send-again.ts'

export interface ScheduledItem {
  id: Id<'scheduledSends'>
  /** Its text once its copy is opened here; null if the copy doesn't open here; undefined until then. */
  body: string | null | undefined
  sendAt: number
  /** The event ID of the message it replies to, if it's a reply. */
  replyTo: string | null
  /** Its cancel is on its way: Cancel is off until the server answers. */
  cancelling: boolean
  /** In a conversation of several chats, the one it goes on, as the network chooser names it. */
  via?: string | undefined
}

/** A cancelled scheduled message the server keeps until it's restored or discarded. */
export interface CancelledItem {
  id: Id<'scheduledSends'>
  body: string | null | undefined
  replyTo: string | null
  /** Restored to the composer from here: it says so, and Restore stays. */
  restored: boolean
  /** In a conversation of several chats, the one it was for. */
  via?: string | undefined
}

interface MessageListProps {
  network: Network
  messages: Message[]
  loading: boolean
  reactions: Map<string, Reaction[]>
  /** A group's messages from others carry their sender's name and avatar. */
  group: boolean
  /** The network has reactions; without them there's nothing to pick, and chips only show. */
  canReact: boolean | ((m: Message) => boolean)
  /**
   * In a conversation of a person's chats on several networks, the network each message came
   * or went by: a run of messages starts again where it changes, and says which.
   */
  networkOf?: ((m: Message) => Network) | undefined
  /** Opens the profile of someone in the chat, from their avatar or name. */
  onOpenSender?: ((ghostId: string, name: string, opener: HTMLElement) => void) | undefined
  /** Senders' opened profiles, by ghost ID (contacts.ts). */
  senders: Map<string, ContactPlaintext>
  /** Outside a group, the other person's name: who a reply to one of their messages quotes. */
  peerName?: string | undefined
  scheduled: ScheduledItem[]
  cancelled: CancelledItem[]
  typing: number
  canLoadMore: boolean
  /** An earlier page is on its way. */
  loadingMore: boolean
  onLoadMore: () => void
  onReply: (m: Message) => void
  /** Adds the person's reaction with this key, or takes it away if it's theirs already. */
  onReact: (m: Message, key: string) => void
  /** Whether the person can change this message's text now, and delete it (their own, on a network that can). */
  canEdit: (m: Message) => boolean
  canDelete: (m: Message) => boolean
  /** Puts the message's text in the composer to change. */
  onEdit: (m: Message) => void
  /** Asks to delete the message, then does. */
  onDelete: (m: Message) => void
  /** Makes the next attempt to send it again (send-again.ts). */
  onSendAgain: (m: Message) => void
  /** Where sending it again stands for this row's chain, and whether another attempt may be made. */
  againOf: (m: Message) => { state: SendAgainState | undefined; canTry: boolean }
  onDiscard: (m: Message) => void
  onSendScheduledNow: (id: Id<'scheduledSends'>) => void
  /** Cancels it, putting its text (when here) and reply back in the composer. */
  onCancelScheduled: (item: ScheduledItem) => void
  onRestoreCancelled: (item: CancelledItem) => void
  onDiscardCancelled: (item: CancelledItem) => void
}

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
function dayLabel(ms: number) {
  const d = new Date(ms)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return 'Yesterday'
  return dayFormat.format(d)
}

const fromBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight

const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const fullTime = (ms: number) => fullFormat.format(new Date(ms))

export function MessageList(props: MessageListProps) {
  const { messages, reactions, scheduled } = props
  const scroller = useRef<HTMLDivElement>(null)
  const top = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
  // Far enough up that getting back to the newest message takes a button.
  const [away, setAway] = useState(false)
  // Whether this chat opened with nothing to show yet. The list is remade for each chat.
  const [openedLoading] = useState(props.loading)
  // Set while earlier messages load: the top-most message in view and how far down it sat, to
  // put it back there. Anchoring on a message, not the list's height, keeps it still even if a
  // new message arrives at the bottom meanwhile.
  const before = useRef<{ anchorId: string; offset: number; seenLoading: boolean } | null>(null)

  const loadEarlier = () => {
    const el = scroller.current
    if (el) {
      const top = el.getBoundingClientRect().top
      const anchor = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (m) => m.getBoundingClientRect().bottom > top,
      )
      if (anchor) {
        before.current = {
          anchorId: anchor.dataset.messageId!,
          offset: anchor.getBoundingClientRect().top - top,
          seenLoading: false,
        }
      }
    }
    props.onLoadMore()
  }
  const loadEarlierRef = useRef(loadEarlier)
  loadEarlierRef.current = loadEarlier

  // Stay pinned to the newest message unless the person has scrolled up to read. When earlier
  // messages come in above, move down by what they added, so what was on screen stays put.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    // The view is put back when the page that was asked for has come (or come back empty), not
    // when some row changes: live updates, above or below, can come first. Back at the bottom,
    // the person isn't reading earlier messages any more, so the list pins there as ever.
    const was = before.current
    if (was && atBottom.current) before.current = null
    else if (was) {
      if (props.loadingMore) was.seenLoading = true
      else if (was.seenLoading) {
        const anchor = el.querySelector<HTMLElement>(`[data-message-id="${was.anchorId}"]`)
        if (anchor) el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top - was.offset
        before.current = null
      }
    } else if (atBottom.current) el.scrollTop = el.scrollHeight
    // New messages below grow the distance to the newest without a scroll: measure it again.
    setAway(fromBottom(el) > 300)
    // `loading` too: the messages can be here a moment before they're shown (useSettled).
  }, [messages, scheduled.length, props.typing, props.loadingMore, props.loading])

  // Earlier messages load as the top of the list scrolls near; the button stays as a fallback.
  // A page can end early under the server's byte budget, so only the cursor says it's the start.
  useEffect(() => {
    const el = top.current
    // Not while the first page is held back (useSettled): nobody has scrolled up yet.
    if (!el || !props.canLoadMore || props.loading) return
    const observer = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadEarlierRef.current(), {
      root: scroller.current,
      rootMargin: '300px 0px 0px 0px',
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [props.canLoadMore, props.loading])
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = () => {
      atBottom.current = fromBottom(el) < 40
      setAway(fromBottom(el) > 300)
    }
    el.addEventListener('scroll', onScroll)
    // The composer growing (a reply, a long draft) shrinks the list: keep the newest in view.
    const resized = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight
      setAway(fromBottom(el) > 300)
    })
    resized.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      resized.disconnect()
    }
  }, [])

  const byEvent = new Map(messages.map((m) => [m.eventId, m]))
  const authorOf = (m: Message) => {
    if (m.self) return 'You'
    const profile = m.ghostId ? props.senders.get(m.ghostId) : undefined
    return profile?.name || profile?.handle || props.peerName
  }
  // Brings the message a reply quotes into view and outlines it a moment, so the eye finds it.
  const showMessage = (target: Message) => {
    const el = scroller.current
    const row = el?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(target.id)}"]`)
    const bubble = row?.firstElementChild
    if (!el || !row || !(bubble instanceof HTMLElement)) return
    // The person chose where to look: an earlier page still on its way mustn't put the view back
    // where it was. Where the row will be centred decides, before the first scroll event, whether
    // the list still follows new messages: a render meanwhile mustn't pull it back to the bottom,
    // and a jump that doesn't move it from there mustn't stop it following.
    before.current = null
    const box = el.getBoundingClientRect()
    const at = row.getBoundingClientRect()
    const most = el.scrollHeight - el.clientHeight
    const landing = Math.min(most, Math.max(0, el.scrollTop + at.top + at.height / 2 - (box.top + el.clientHeight / 2)))
    atBottom.current = most - landing < 40
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches
    row.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' })
    // Focus goes with the view, so the next Tab carries on from the original, not the reply.
    bubble.tabIndex = -1
    bubble.focus({ preventScroll: true })
    const ring = getComputedStyle(bubble).getPropertyValue('--accent-ring').trim()
    bubble.animate(
      [
        { outline: `3px solid ${ring}`, outlineOffset: '2px' },
        { outline: '3px solid transparent', outlineOffset: '2px' },
      ],
      { duration: 1800, easing: 'ease-in', delay: still ? 0 : 250 },
    )
  }
  // Held back until what goes with them has come too (useSettled), so they show at once.
  const shownMessages = props.loading ? [] : messages
  const shownScheduled = props.loading ? [] : scheduled
  const shownCancelled = props.loading ? [] : props.cancelled
  // Each of the person's sends in the list, by client message ID: how sending again stands.
  let lastDay = ''

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        // Pictures load as they come near this scroller's view (attachments.tsx).
        data-scroll-root
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-3',
          // Messages that had to be fetched ease in; a chat shown from the cache is just there.
          openedLoading && !props.loading && 'animate-fade-in motion-reduce:animate-none',
        )}
        aria-live="polite"
      >
        {props.canLoadMore && !props.loading ? (
          <div ref={top} className="mb-3 flex justify-center">
            <Button size="sm" variant="ghost" onClick={loadEarlier}>
              Load earlier messages
            </Button>
          </div>
        ) : null}
        {props.loading ? (
          <BubblesSkeleton />
        ) : messages.length === 0 && scheduled.length === 0 ? (
          <p className="py-16 text-center text-sm text-subtle-foreground">No messages here yet.</p>
        ) : null}
        {shownMessages.map((m, i) => {
          const day = dayLabel(m.at)
          const showDay = day !== lastDay
          lastDay = day
          const prev = messages[i - 1]
          const next = messages[i + 1]
          // Messages around the same time share one time label above them, the day with it
          // when the day changes, as iMessage and Signal do. Each bubble's own is its tooltip.
          const showTime = !sameTime(prev, m)
          const network = props.networkOf?.(m) ?? props.network
          // Each network's messages are their own run, said at its start when the network changes.
          const sameChat = (a: Message | undefined, b: Message | undefined) => !a || !b || a.chatId === b.chatId
          const first = !sameRun(prev, m) || !sameChat(prev, m)
          const last = !sameRun(m, next) || !sameChat(m, next)
          const via = props.networkOf && (!prev || props.networkOf(prev) !== network) ? network : undefined
          const canReact = typeof props.canReact === 'function' ? props.canReact(m) : props.canReact
          const quoted = m.replyTo ? byEvent.get(m.replyTo) : undefined
          const files = (!m.deleted && m.body?.attachments) || []
          const text = m.body ? captionOf(m.body) : ''
          const big = !m.deleted && !quoted && !m.replyTo && !files.length && isBigEmoji(text)
          const cards = !m.deleted && m.body ? linkCards(m.body, text) : []
          // A message that is only a link the network previewed shows the card alone.
          const shownText = cardReplacesText(cards, text) ? '' : text
          // Pictures on their own are shown without a bubble around them, the time over a corner.
          // A file or a player keeps its bubble, so the time never sits on its controls.
          const bare =
            !m.deleted && files.length > 0 && files.every(isImage) && !text && !cards.length && !quoted && !m.replyTo
          const settled = m.delivery === undefined || SETTLED.has(m.delivery)
          // Delivery once per run of the person's own, at its end; a message still going, edited or
          // in trouble shows its own.
          const meta = (m.self && (last || !settled)) || m.edited || m.deleting ? <Meta m={m} /> : null
          const editable = props.canEdit(m)
          const deletable = props.canDelete(m)
          const reacted = reactions.get(m.id)
          // In a group, someone else's run starts with their name and ends beside their avatar.
          const fromOther = props.group && !m.self
          const profile = m.ghostId ? props.senders.get(m.ghostId) : undefined
          const sender = profile?.name || profile?.handle
          return (
            <div
              key={m.id}
              className={cn(
                // Joined bubbles sit close; another sender on the same side a little further off.
                !showTime && (!first ? 'mt-0.5' : prev?.self === m.self ? 'mt-1.5' : 'mt-3'),
              )}
            >
              {showTime ? (
                <p
                  className={cn(
                    'mb-2 text-center text-xs font-medium text-subtle-foreground',
                    i === 0 ? 'mt-1' : 'mt-5',
                  )}
                >
                  {showDay ? `${day} ` : null}
                  {messageTime(m.at)}
                </p>
              ) : null}
              {via ? (
                <p
                  className={cn(
                    'mb-1 flex items-center gap-1 text-xs font-medium text-subtle-foreground',
                    m.self && 'justify-end',
                  )}
                >
                  <NetworkBadge network={via} label={networkName(via)} size={12} />
                  {networkName(via)}
                </p>
              ) : null}
              {fromOther && first && sender ? (
                props.onOpenSender && m.ghostId ? (
                  <Button
                    variant="bare"
                    type="button"
                    className="mb-0.5 ml-12 block max-w-[calc(100%-3rem)] truncate text-xs font-medium text-subtle-foreground hover:text-foreground"
                    onClick={(e) => props.onOpenSender!(m.ghostId!, sender, e.currentTarget)}
                  >
                    {sender}
                  </Button>
                ) : (
                  <p className="mb-0.5 ml-12 truncate text-xs font-medium text-subtle-foreground">{sender}</p>
                )
              ) : null}
              <div className={cn(fromOther && 'flex items-end gap-2')}>
                {fromOther ? (
                  last ? (
                    // Level with the bubble's bottom, above any reactions under it (18px chips, 6px of
                    // them overlapping the bubble).
                    props.onOpenSender && m.ghostId ? (
                      <Button
                        variant="bare"
                        type="button"
                        aria-label={sender ? `Profile of ${sender}` : 'Profile'}
                        className={cn('shrink-0 rounded-full', reacted?.length ? 'mb-[13px]' : 'mb-px')}
                        onClick={(e) => props.onOpenSender!(m.ghostId!, sender ?? '', e.currentTarget)}
                      >
                        <MediaAvatar network={props.network} picture={profile?.avatar} name={sender ?? ''} size={28} />
                      </Button>
                    ) : (
                      <MediaAvatar
                        network={props.network}
                        picture={profile?.avatar}
                        name={sender ?? ''}
                        size={28}
                        className={reacted?.length ? 'mb-[13px]' : 'mb-px'}
                      />
                    )
                  ) : (
                    <span aria-hidden className="w-7 shrink-0" />
                  )
                ) : null}
                {/* The anchor for loading earlier messages is the message itself, not its time or
                  sender label: those can go when the page above brings more of the same run. */}
                <div
                  data-message-id={m.id}
                  className={cn(
                    // Always leaving room beside it for its actions (4.5rem; 6.5rem for the person's
                    // own, which have a third), however narrow the pane, and in a group for the
                    // avatar's gutter (2.25rem) too.
                    'group relative flex w-fit flex-col',
                    fromOther
                      ? 'max-w-[min(78%,38rem,calc(100%-6.75rem))]'
                      : m.self
                        ? 'max-w-[min(78%,38rem,calc(100%-6.5rem))]'
                        : 'max-w-[min(78%,38rem,calc(100%-4.5rem))]',
                    m.self ? 'ml-auto items-end' : 'items-start',
                  )}
                >
                  <div
                    title={fullTime(m.at)}
                    className={cn(
                      'relative rounded-[18px] px-3 py-[7px] leading-[1.42] whitespace-pre-wrap [overflow-wrap:anywhere]',
                      m.self ? 'bg-primary text-primary-foreground' : 'bg-surface shadow-[0_0_0_1px_var(--border)]',
                      // Joined bubbles meet with tighter corners on the sender's side.
                      m.self
                        ? [!first && 'rounded-tr-[5px]', !last && 'rounded-br-[5px]']
                        : [!first && 'rounded-tl-[5px]', !last && 'rounded-bl-[5px]'],
                      m.deleted && 'bg-transparent text-subtle-foreground italic shadow-[0_0_0_1px_var(--border)]',
                      big && 'bg-transparent px-1 text-[2.5rem] leading-tight text-foreground shadow-none',
                      bare && 'bg-transparent p-0 shadow-none',
                      m.deleting && 'opacity-60',
                    )}
                  >
                    {quoted || m.replyTo ? (
                      <ReplyQuote
                        // A deleted message of the person's own has no coloured bubble behind it.
                        self={m.self && !m.deleted}
                        author={quoted ? authorOf(quoted) : undefined}
                        text={
                          !quoted
                            ? 'An earlier message'
                            : quoted.deleted
                              ? 'Message deleted'
                              : quoted.body
                                ? summarize(quoted.body) || 'A message'
                                : 'A message that can’t be shown here'
                        }
                        onOpen={quoted ? () => showMessage(quoted) : undefined}
                      />
                    ) : null}
                    {m.deleted ? (
                      'Message deleted'
                    ) : m.body ? (
                      <>
                        {files.length ? (
                          <Attachments network={network} attachments={files} className={bare ? undefined : 'my-1'} />
                        ) : null}
                        {shownText ? <Linked text={shownText} /> : null}
                        {cards.length ? <LinkCards cards={cards} network={network} self={m.self} /> : null}
                      </>
                    ) : (
                      'This message can’t be opened on this device.'
                    )}
                    {/* The exact time is the tooltip for a mouse; said here for assistive tech. */}
                    <span className="sr-only">, {fullTime(m.at)}</span>
                    {meta && bare ? (
                      // Over the picture's corner, on a scrim so it reads on any picture.
                      <span className="absolute right-2 bottom-2 inline-flex rounded-full bg-scrim px-1.5 py-1 text-on-color">
                        {meta}
                      </span>
                    ) : meta && cards.length ? (
                      // Under a link's card, on its own short line: there's no last line of text to share.
                      <span
                        className={cn(
                          'flex justify-end',
                          m.self ? 'text-primary-foreground/90' : 'text-subtle-foreground',
                        )}
                      >
                        {meta}
                      </span>
                    ) : meta ? (
                      <>
                        {/* Room at the end of the last line, so the time sits beside the text when it fits. */}
                        <span aria-hidden className="invisible ml-2 inline-flex">
                          {meta}
                        </span>
                        <span
                          className={cn(
                            'absolute right-3 bottom-[5px] inline-flex',
                            m.self && !big && !m.deleted ? 'text-primary-foreground/90' : 'text-subtle-foreground',
                          )}
                        >
                          {meta}
                        </span>
                      </>
                    ) : null}
                  </div>
                  {reacted?.length ? (
                    <div className="z-[1] mx-2 -mt-1.5 flex flex-wrap gap-1">
                      {reacted.map((r) => (
                        <Button
                          variant="bare"
                          type="button"
                          key={r.key}
                          aria-pressed={r.mine}
                          disabled={!canReact}
                          title={canReact ? (r.mine ? 'Remove your reaction' : 'React with this too') : undefined}
                          onClick={() => props.onReact(m, r.key)}
                          className={cn(
                            'h-[18px] rounded-[11px] disabled:opacity-100 bg-surface px-1.5 text-sm leading-[18px] shadow-[0_0_0_1px_var(--border)] hover:shadow-[0_0_0_1px_var(--border-strong)]',
                            r.mine &&
                              'bg-primary-soft text-primary-ink shadow-[0_0_0_1px_var(--accent-ring)] hover:shadow-[0_0_0_1px_var(--accent-ring)]',
                          )}
                        >
                          {shownKey(r.key)} {r.count}
                          {r.more ? '+' : ''}
                        </Button>
                      ))}
                    </div>
                  ) : null}
                  {m.self ? (
                    <DeliveryProblem
                      m={m}
                      again={props.againOf(m)}
                      onSendAgain={props.onSendAgain}
                      onDiscard={props.onDiscard}
                    />
                  ) : null}
                  {!m.pending && !m.deleted && !m.deleting ? (
                    // Beside the bubble, nearest first, on the side away from its sender.
                    <div
                      className={cn(
                        'absolute top-1/2 flex -translate-y-1/2 gap-1',
                        m.self ? 'right-full mr-2 flex-row-reverse' : 'left-full ml-2',
                      )}
                    >
                      <Button
                        variant="bare"
                        type="button"
                        aria-label="Reply"
                        title="Reply"
                        onClick={() => props.onReply(m)}
                        className={ACTION}
                      >
                        <Reply className="size-[15px]" />
                      </Button>
                      {canReact ? (
                        <ReactionPicker
                          mine={(reacted ?? []).filter((r) => r.mine).map((r) => r.key)}
                          onPick={(key) => props.onReact(m, key)}
                          triggerClassName={ACTION}
                        />
                      ) : null}
                      {editable || deletable ? (
                        <MessageMenu
                          self={m.self}
                          onEdit={editable ? () => props.onEdit(m) : undefined}
                          onDelete={deletable ? () => props.onDelete(m) : undefined}
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          )
        })}
        {shownScheduled.map((s) => (
          <div key={s.id} className="mt-3 ml-auto flex w-fit max-w-[min(78%,38rem)] flex-col items-end">
            <div className="rounded-[18px] px-3 py-[7px] leading-[1.42] whitespace-pre-wrap text-primary-ink shadow-[inset_0_0_0_1.5px_var(--accent-ring)] [overflow-wrap:anywhere]">
              {s.body === undefined ? (
                <span className="text-subtle-foreground">Opening…</span>
              ) : s.body === null ? (
                <span className="text-subtle-foreground italic">
                  This scheduled message can’t be shown here. You can still cancel it.
                </span>
              ) : (
                s.body
              )}
            </div>
            <div className="mx-2.5 mt-1 flex items-center gap-2 text-xs text-primary-ink">
              <Clock className="size-3" /> Sends {formatWhen(s.sendAt)}
              {s.via ? ` on ${s.via}` : null}
              <Button
                variant="link"
                size="sm"
                className="h-auto text-xs"
                onClick={() => props.onSendScheduledNow(s.id)}
              >
                Send now
              </Button>
              <Button
                variant="link"
                size="sm"
                className="h-auto text-xs"
                disabled={s.cancelling}
                aria-busy={s.cancelling}
                onClick={() => props.onCancelScheduled(s)}
              >
                {s.cancelling ? 'Cancelling…' : 'Cancel'}
              </Button>
            </div>
          </div>
        ))}
        {shownCancelled.map((c) => (
          <CancelledRow
            key={c.id}
            item={c}
            onRestore={() => props.onRestoreCancelled(c)}
            onDiscard={() => props.onDiscardCancelled(c)}
          />
        ))}
        {props.typing > 0 ? (
          <div
            role="status"
            className="mt-3 flex w-fit items-center gap-1 rounded-[18px] bg-surface px-3.5 py-3 shadow-[0_0_0_1px_var(--border)]"
          >
            <span className="sr-only">
              {props.typing === 1 ? 'Someone is typing…' : `${props.typing} people are typing…`}
            </span>
            {[0, 150, 300].map((delay) => (
              <span
                key={delay}
                aria-hidden
                style={{ animationDelay: `${delay}ms` }}
                className="size-1.5 animate-bounce rounded-full bg-subtle-foreground motion-reduce:animate-none"
              />
            ))}
          </div>
        ) : null}
      </div>
      {away ? (
        <Button
          variant="bare"
          type="button"
          aria-label="Jump to latest"
          title="Jump to latest"
          onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })}
          className="absolute right-5 bottom-3 flex size-9 items-center justify-center rounded-full bg-surface text-muted-foreground shadow-[0_0_0_1px_var(--border),var(--elevation-md)] hover:text-foreground"
        >
          <ArrowDown className="size-[18px]" />
        </Button>
      ) : null}
    </div>
  )
}

/**
 * A cancelled scheduled message, kept on the server until its text is back in the composer or
 * the person discards it, so a reload or crash in between loses nothing.
 */
function CancelledRow({
  item,
  onRestore,
  onDiscard,
}: {
  item: CancelledItem
  onRestore: () => void
  onDiscard: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="mt-3 ml-auto flex w-fit max-w-[min(78%,38rem)] flex-col items-end">
      <div className="rounded-[18px] px-3 py-[7px] leading-[1.42] whitespace-pre-wrap text-muted-foreground shadow-[inset_0_0_0_1.5px_var(--border-strong)] [overflow-wrap:anywhere]">
        {item.body === undefined ? (
          <span className="text-subtle-foreground">Opening…</span>
        ) : item.body === null ? (
          <span className="text-subtle-foreground italic">This cancelled message can’t be shown here.</span>
        ) : (
          item.body
        )}
      </div>
      <div className="mx-2.5 mt-1 flex items-center gap-2 text-xs text-muted-foreground">
        {item.restored ? 'Cancelled message · Restored to your draft' : 'Cancelled message'}
        {item.via ? ` · ${item.via}` : null}
        {confirming ? (
          <>
            <span className="text-danger">Discard it for good?</span>
            <Button variant="link" size="sm" className="h-auto text-xs" onClick={() => setConfirming(false)}>
              Keep
            </Button>
            <Button variant="link" size="sm" className="h-auto text-xs text-danger" onClick={onDiscard}>
              Discard
            </Button>
          </>
        ) : (
          <>
            {typeof item.body === 'string' ? (
              <Button variant="link" size="sm" className="h-auto text-xs" onClick={onRestore}>
                Restore
              </Button>
            ) : null}
            <Button variant="link" size="sm" className="h-auto text-xs" onClick={() => setConfirming(true)}>
              Discard
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The message a reply answers, at the top of its bubble: who wrote it and how it begins. When
 * that message is loaded the whole card is a button that goes to it.
 */
function ReplyQuote(props: {
  self: boolean
  author: string | undefined
  text: string
  onOpen?: (() => void) | undefined
}) {
  const content = (
    <>
      <span
        className={cn(
          'flex min-w-0 items-center gap-1 text-xs font-semibold',
          props.self ? 'text-primary-foreground' : 'text-primary-ink',
        )}
      >
        <Reply aria-hidden className="size-3 shrink-0" />
        <span className="truncate">
          {props.author ? (
            <>
              <span className="sr-only">Reply to </span>
              {props.author}
            </>
          ) : (
            'Reply'
          )}
        </span>
      </span>
      <span className="line-clamp-2 text-sm">{props.text}</span>
    </>
  )
  // On the person's own bubble the tint darkens it in light and lightens it in dark, away from its
  // text, so the quote keeps the bubble's contrast.
  const look = cn(
    '-mx-1 mt-px mb-1.5 flex max-w-[calc(100%+0.5rem)] flex-col gap-0.5 rounded-[10px] border-l-[3px] py-1 pr-2.5 pl-2 text-left whitespace-normal',
    props.self ? 'border-primary-foreground/70 bg-foreground/15' : 'border-primary bg-foreground/[0.06]',
  )
  return props.onOpen ? (
    <Button
      variant="bare"
      type="button"
      title="Go to message"
      onClick={props.onOpen}
      className={cn(
        look,
        'cursor-pointer transition-colors',
        props.self ? 'hover:bg-foreground/25' : 'hover:bg-foreground/10',
      )}
    >
      {content}
    </Button>
  ) : (
    <span className={look}>{content}</span>
  )
}

// In the tab order always, shown on hover or when it has keyboard focus.
const ACTION =
  'flex size-7 items-center justify-center rounded-full bg-surface text-muted-foreground opacity-0 shadow-[0_0_0_1px_var(--border),var(--elevation-sm)] group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100'

/**
 * A message's other actions. The one chosen runs once the menu has closed, so focus goes where it
 * takes it (the composer, for Edit), and a dialog it opens isn't opened under the closing menu.
 */
function MessageMenu({
  self,
  onEdit,
  onDelete,
}: {
  self: boolean
  onEdit: (() => void) | undefined
  onDelete: (() => void) | undefined
}) {
  const chosen = useRef<(() => void) | null>(null)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="bare"
          type="button"
          aria-label="More"
          title="More"
          className={cn(ACTION, 'data-[state=open]:text-foreground data-[state=open]:opacity-100')}
        >
          <MoreHorizontal className="size-[15px]" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align={self ? 'end' : 'start'}
        className="min-w-[160px]"
        onCloseAutoFocus={(e) => {
          const run = chosen.current
          chosen.current = null
          if (!run) return
          e.preventDefault()
          run()
        }}
      >
        {onEdit ? (
          <DropdownMenuItem onSelect={() => (chosen.current = onEdit)}>
            <Pencil /> Edit
          </DropdownMenuItem>
        ) : null}
        {onDelete ? (
          <DropdownMenuItem className="text-danger [&_svg]:text-danger" onSelect={() => (chosen.current = onDelete)}>
            <Trash2 /> Delete
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Links in a message's text open in a new tab, or the system's browser in the desktop app. */
function Linked({ text }: { text: string }) {
  return linkParts(text).map((part, i) =>
    part.kind === 'link' ? (
      <a key={i} href={part.href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
        {part.text}
      </a>
    ) : (
      part.text
    ),
  )
}

const SETTLED = new Set<Message['delivery']>(['sent', 'delivered', 'read'])

/** Edited and, for the person's own, its delivery state (client-api.md, Sending), or an edit or deletion on its way. */
function Meta({ m }: { m: Message }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11px] leading-none whitespace-nowrap not-italic">
      {m.edited ? 'edited' : null}
      {m.editing || m.deleting ? (
        <Clock className="size-3" aria-label={m.deleting ? 'Deleting' : 'Saving edit'} />
      ) : m.self ? (
        <DeliveryIcon delivery={m.delivery} />
      ) : null}
    </span>
  )
}

function DeliveryIcon({ delivery }: { delivery: Message['delivery'] }) {
  switch (delivery) {
    case undefined:
      return null
    case 'queued':
    case 'claimed':
    case 'submitted':
      return <Clock className="size-3" aria-label="Sending" />
    case 'sent':
      return <Check className="size-3.5" aria-label="Sent" />
    case 'delivered':
      return <CheckCheck className="size-3.5 opacity-70" aria-label="Delivered" />
    case 'read':
      return <CheckCheck className="size-3.5 stroke-[2.75]" aria-label="Read" />
    case 'failed':
    case 'unknown':
      return <AlertCircle className="size-3" aria-hidden />
  }
}

const AGAIN_SAYS: Record<Exclude<SendAgainState, 'sending'>, string> = {
  original: 'Sent',
  going: 'Being sent again',
  sent: 'Sent again',
  maybe: 'May have been sent again',
  failed: 'Sending again failed',
}

/** A send that failed or may not have gone, with what the person can do about it. */
function DeliveryProblem({
  m,
  again,
  onSendAgain,
  onDiscard,
}: {
  m: Message
  /** Where sending it again stands, the same on every row of its chain. */
  again: { state: SendAgainState | undefined; canTry: boolean }
  onSendAgain: (m: Message) => void
  onDiscard: (m: Message) => void
}) {
  const { state, canTry } = again
  const sendAgain = (label: string) => (
    <>
      {state === 'sending' ? (
        <span className="font-medium text-muted-foreground" aria-busy>
          Sending…
        </span>
      ) : state ? (
        <span className="font-medium text-muted-foreground" role={state === 'maybe' ? 'alert' : undefined}>
          {AGAIN_SAYS[state]}
        </span>
      ) : null}
      {/* Another attempt only when none was made or the latest failed: from any row of the chain. */}
      {canTry ? (
        <Button variant="link" size="sm" className="h-auto text-xs" onClick={() => onSendAgain(m)}>
          {label}
        </Button>
      ) : null}
    </>
  )
  if (m.delivery === 'failed')
    return (
      <span className="mx-2.5 mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-danger">
        <AlertCircle className="size-3" /> Not sent
        {sendAgain('Retry')}
        <Button variant="link" size="sm" className="h-auto text-xs text-danger" onClick={() => onDiscard(m)}>
          Delete
        </Button>
      </span>
    )
  if (m.delivery === 'unknown')
    return (
      <span
        className="mx-2.5 mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-warning"
        title="The network didn’t confirm this message. Trioditis never resends on its own."
      >
        <AlertCircle className="size-3" /> May not have sent
        {sendAgain('Send again')}
        <Button variant="link" size="sm" className="h-auto text-xs" onClick={() => onDiscard(m)}>
          Discard
        </Button>
      </span>
    )
  return null
}

/** Where messages will be, while they load: bubbles' shapes at the bottom, as the chat will sit. */
const SKELETON = [
  { self: false, width: 'w-52' },
  { self: false, width: 'w-36' },
  { self: true, width: 'w-60' },
  { self: false, width: 'w-44' },
  { self: true, width: 'w-32' },
  { self: true, width: 'w-48' },
]

function BubblesSkeleton() {
  return (
    // It waits a moment first, so a chat that loads quickly never shows it.
    <div
      aria-busy="true"
      aria-label="Loading messages"
      className="flex min-h-full animate-fade-in-late flex-col justify-end gap-1.5 pb-1"
    >
      {SKELETON.map((b, i) => (
        <span key={i} className={cn('h-8 rounded-[18px] bg-muted', b.width, b.self && 'ml-auto')} />
      ))}
    </div>
  )
}

/** The message list's place while a chat opens with nothing known of it yet. */
export function MessagesSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col px-5 pt-4 pb-3">
      <BubblesSkeleton />
    </div>
  )
}
