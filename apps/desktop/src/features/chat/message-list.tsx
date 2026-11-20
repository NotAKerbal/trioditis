import type { Id } from '@trioditis/backend/dataModel'
import { Button } from '@trioditis/ui/button'
import { cn } from '@trioditis/ui/lib/utils'
import { AlertCircle, ArrowDown, Check, CheckCheck, Clock, Reply } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { messageTime } from '~/data/format.ts'
import type { Message, Reaction } from '~/data/messages.ts'
import { formatWhen } from '~/data/snooze.ts'
import { isBigEmoji, linkParts, sameRun } from './message-text.ts'

export interface ScheduledItem {
  id: Id<'scheduledSends'>
  /** Its text once its copy is opened here; null if the copy doesn't open here; undefined until then. */
  body: string | null | undefined
  sendAt: number
}

interface MessageListProps {
  messages: Message[]
  loading: boolean
  reactions: Map<string, Reaction[]>
  scheduled: ScheduledItem[]
  group: boolean
  typing: number
  canLoadMore: boolean
  /** An earlier page is on its way. */
  loadingMore: boolean
  onLoadMore: () => void
  onReply: (m: Message) => void
  onSendAgain: (m: Message) => void
  onDiscard: (m: Message) => void
  onSendScheduledNow: (id: Id<'scheduledSends'>) => void
  /** Cancels it; `body` is its text to put back: null if it can't be shown, undefined if not here yet. */
  onCancelScheduled: (id: Id<'scheduledSends'>, body: string | null | undefined) => void
}

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'short', day: 'numeric' })
function dayLabel(ms: number) {
  const d = new Date(ms)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === new Date(Date.now() - 86_400_000).toDateString()) return 'Yesterday'
  return dayFormat.format(d)
}

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
      return
    }
    if (atBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, scheduled.length, props.typing, props.loadingMore])

  // Earlier messages load as the top of the list scrolls near; the button stays as a fallback.
  // A page can end early under the server's byte budget, so only the cursor says it's the start.
  useEffect(() => {
    const el = top.current
    if (!el || !props.canLoadMore) return
    const observer = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadEarlierRef.current(), {
      root: scroller.current,
      rootMargin: '300px 0px 0px 0px',
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [props.canLoadMore])
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const onScroll = () => {
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      atBottom.current = fromBottom < 40
      setAway(fromBottom > 300)
    }
    el.addEventListener('scroll', onScroll)
    // The composer growing (a reply, a long draft) shrinks the list: keep the newest in view.
    const resized = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight
    })
    resized.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      resized.disconnect()
    }
  }, [])

  const byEvent = new Map(messages.map((m) => [m.eventId, m]))
  let lastDay = ''

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-3',
          // Messages that had to be fetched ease in; a chat shown from the cache is just there.
          openedLoading && !props.loading && 'animate-fade-in motion-reduce:animate-none',
        )}
        aria-live="polite"
      >
        {props.canLoadMore ? (
          <div ref={top} className="mb-3 flex justify-center">
            <Button size="sm" variant="ghost" onClick={loadEarlier}>
              Load earlier messages
            </Button>
          </div>
        ) : null}
        {props.loading ? (
          <p className="animate-fade-in-late py-16 text-center text-sm text-subtle-foreground" aria-busy="true">
            Opening messages…
          </p>
        ) : messages.length === 0 && scheduled.length === 0 ? (
          <p className="py-16 text-center text-sm text-subtle-foreground">No messages here yet.</p>
        ) : null}
        {messages.map((m, i) => {
          const day = dayLabel(m.at)
          const showDay = day !== lastDay
          lastDay = day
          const prev = messages[i - 1]
          const next = messages[i + 1]
          const first = !sameRun(prev, m)
          const last = !sameRun(m, next)
          const showWho = props.group && !m.self && first
          const quoted = m.replyTo ? byEvent.get(m.replyTo) : undefined
          const text = m.body?.body ?? ''
          const big = !m.deleted && !quoted && !m.replyTo && isBigEmoji(text)
          const settled = m.delivery === undefined || SETTLED.has(m.delivery)
          // The time once per run, at its end, as most messaging apps show it; a message still
          // going, edited or in trouble shows its own.
          const meta = last || !settled || m.edited ? <Meta m={m} /> : null
          const reacted = reactions.get(m.id)
          return (
            <div key={m.id} data-message-id={m.id} className={cn(first && !showDay && 'mt-3', !first && 'mt-0.5')}>
              {showDay ? (
                <p className="mt-4 mb-3 text-center text-xs font-medium text-subtle-foreground">{day}</p>
              ) : null}
              {showWho ? <p className="mb-1 ml-3 text-sm font-semibold text-muted-foreground">Someone</p> : null}
              <div
                className={cn(
                  'group relative flex w-fit max-w-[min(78%,38rem)] flex-col',
                  m.self ? 'ml-auto items-end' : 'items-start',
                )}
              >
                <div
                  title={meta ? undefined : fullTime(m.at)}
                  className={cn(
                    'relative rounded-[18px] px-3 py-[7px] leading-[1.42] whitespace-pre-wrap [overflow-wrap:anywhere]',
                    m.self ? 'bg-primary text-primary-foreground' : 'bg-surface shadow-[0_0_0_1px_var(--border)]',
                    // Joined bubbles meet with tighter corners on the sender's side.
                    m.self
                      ? [!first && 'rounded-tr-[5px]', !last && 'rounded-br-[5px]']
                      : [!first && 'rounded-tl-[5px]', !last && 'rounded-bl-[5px]'],
                    m.deleted && 'bg-transparent text-subtle-foreground italic shadow-[0_0_0_1px_var(--border)]',
                    big && 'bg-transparent px-1 text-[2.5rem] leading-tight text-foreground shadow-none',
                  )}
                >
                  {quoted || m.replyTo ? (
                    <span className="mb-1 block border-l-[3px] border-current pl-2 text-sm opacity-80">
                      {quoted?.body?.body ?? 'An earlier message'}
                    </span>
                  ) : null}
                  {m.deleted ? (
                    'Message deleted'
                  ) : m.body ? (
                    text ? (
                      <Linked text={text} />
                    ) : (
                      attachmentLabel(m)
                    )
                  ) : (
                    'This message can’t be opened on this device.'
                  )}
                  {meta ? (
                    <>
                      {/* Room at the end of the last line, so the time sits beside the text when it fits. */}
                      <span aria-hidden className="invisible ml-2 inline-flex">
                        {meta}
                      </span>
                      <span
                        className={cn(
                          'absolute right-3 bottom-[5px] inline-flex',
                          m.self && !big && !m.deleted ? 'text-primary-foreground/75' : 'text-subtle-foreground',
                        )}
                      >
                        {meta}
                      </span>
                    </>
                  ) : null}
                </div>
                {reacted?.length ? (
                  <div className="z-[1] mx-2 -mt-1.5 flex gap-1">
                    {reacted.map((r) => (
                      <span
                        key={r.key}
                        className={cn(
                          'rounded-[11px] bg-surface px-1.5 text-sm shadow-[0_0_0_1px_var(--border)]',
                          r.mine && 'bg-primary-soft text-primary-ink shadow-[0_0_0_1px_var(--accent-ring)]',
                        )}
                      >
                        {r.key} {r.count}
                        {r.more ? '+' : ''}
                      </span>
                    ))}
                  </div>
                ) : null}
                {m.self ? <DeliveryProblem m={m} onSendAgain={props.onSendAgain} onDiscard={props.onDiscard} /> : null}
                {!m.pending && !m.deleted ? (
                  <Button
                    variant="bare"
                    type="button"
                    aria-label="Reply"
                    title="Reply"
                    onClick={() => props.onReply(m)}
                    // In the tab order always, shown on hover or when it has keyboard focus.
                    className={cn(
                      'absolute top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-surface text-muted-foreground opacity-0 shadow-[0_0_0_1px_var(--border),var(--elevation-sm)] group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100',
                      m.self ? '-left-9' : '-right-9',
                    )}
                  >
                    <Reply className="size-[15px]" />
                  </Button>
                ) : null}
              </div>
            </div>
          )
        })}
        {scheduled.map((s) => (
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
              <Button
                variant="link"
                size="sm"
                className="h-auto text-xs"
                onClick={() => props.onSendScheduledNow(s.id)}
              >
                Send now
              </Button>
              {/* Cancelling needs only the schedule, so it's always offered: the text comes back to the
                  composer when it's here, and the person is told when it isn't. */}
              <Button
                variant="link"
                size="sm"
                className="h-auto text-xs"
                onClick={() => props.onCancelScheduled(s.id, s.body)}
              >
                {s.body === null ? 'Cancel send' : 'Cancel'}
              </Button>
            </div>
          </div>
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

function attachmentLabel(m: Message) {
  const n = m.body?.attachments?.length ?? 0
  if (!n) return ''
  // Opening files needs the gateway's media proxy, which isn't built yet.
  return n === 1 ? `📎 ${m.body!.attachments![0]!.name ?? 'An attachment'}` : `📎 ${n} attachments`
}

const SETTLED = new Set<Message['delivery']>(['sent', 'delivered', 'read'])

/** Edited, the time and, for the person's own, its delivery state (client-api.md, Sending). */
function Meta({ m }: { m: Message }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[11px] leading-none whitespace-nowrap not-italic"
      title={fullTime(m.at)}
    >
      {m.edited ? 'edited ' : null}
      {messageTime(m.at)}
      {m.self ? <DeliveryIcon delivery={m.delivery} /> : null}
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

/** A send that failed or may not have gone, with what the person can do about it. */
function DeliveryProblem({
  m,
  onSendAgain,
  onDiscard,
}: {
  m: Message
  onSendAgain: (m: Message) => void
  onDiscard: (m: Message) => void
}) {
  if (m.delivery === 'failed')
    return (
      <span className="mx-2.5 mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-danger">
        <AlertCircle className="size-3" /> Not sent
        <Button variant="link" size="sm" className="h-auto text-xs" onClick={() => onSendAgain(m)}>
          Retry
        </Button>
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
        <Button variant="link" size="sm" className="h-auto text-xs" onClick={() => onSendAgain(m)}>
          Send again
        </Button>
        <Button variant="link" size="sm" className="h-auto text-xs" onClick={() => onDiscard(m)}>
          Discard
        </Button>
      </span>
    )
  return null
}
