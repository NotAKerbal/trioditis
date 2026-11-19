import type { Id } from '@trioditis/backend/dataModel'
import { Button } from '@trioditis/ui/button'
import { cn } from '@trioditis/ui/lib/utils'
import { AlertCircle, Check, CheckCheck, Clock, Reply } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { messageTime } from '~/data/format.ts'
import type { Message, Reaction } from '~/data/messages.ts'
import { formatWhen } from '~/data/snooze.ts'

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

export function MessageList(props: MessageListProps) {
  const { messages, reactions, scheduled } = props
  const scroller = useRef<HTMLDivElement>(null)
  const top = useRef<HTMLDivElement>(null)
  const atBottom = useRef(true)
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
      atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  const byEvent = new Map(messages.map((m) => [m.eventId, m]))
  let lastDay = ''

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-2" aria-live="polite">
      {props.canLoadMore ? (
        <div ref={top} className="mb-3 flex justify-center">
          <Button size="sm" onClick={loadEarlier}>
            Load earlier messages
          </Button>
        </div>
      ) : null}
      {props.loading ? (
        <p className="py-16 text-center text-sm text-subtle-foreground" aria-busy="true">
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
        const showWho = props.group && !m.self && (!prev || prev.ghostId !== m.ghostId || showDay)
        const quoted = m.replyTo ? byEvent.get(m.replyTo) : undefined
        return (
          <div key={m.id} data-message-id={m.id}>
            {showDay ? (
              <div className="my-3 flex justify-center">
                <span className="rounded-[10px] bg-surface px-2.5 py-0.5 text-xs text-subtle-foreground shadow-[0_0_0_1px_var(--border)]">
                  {day}
                </span>
              </div>
            ) : null}
            <div
              className={cn(
                'group relative mb-0.5 flex max-w-[78%] flex-col',
                m.self ? 'ml-auto items-end' : 'items-start',
              )}
            >
              {showWho ? (
                <span className="mt-2.5 mb-0.5 ml-3 text-sm font-semibold text-muted-foreground">Someone</span>
              ) : null}
              <div
                className={cn(
                  'rounded-[18px] px-3 py-2 leading-[1.42] whitespace-pre-wrap [overflow-wrap:anywhere]',
                  m.self ? 'bg-primary text-primary-foreground' : 'bg-surface shadow-[0_0_0_1px_var(--border)]',
                  m.deleted && 'bg-transparent text-subtle-foreground italic shadow-[0_0_0_1px_var(--border)]',
                )}
              >
                {quoted || m.replyTo ? (
                  <span className="mb-1 block border-l-[3px] border-current pl-2 text-sm opacity-80">
                    {quoted?.body?.body ?? 'An earlier message'}
                  </span>
                ) : null}
                {m.deleted
                  ? 'Message deleted'
                  : m.body
                    ? m.body.body || attachmentLabel(m)
                    : 'This message can’t be opened on this device.'}
              </div>
              {reactions.get(m.id)?.length ? (
                <div className="z-[1] -mt-1.5 mx-2 flex gap-1">
                  {reactions.get(m.id)!.map((r) => (
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
              <div className="mx-2.5 mt-0.5 mb-2 flex items-center gap-1.5 text-xs text-subtle-foreground">
                {m.edited ? <span>Edited ·</span> : null}
                {messageTime(m.at)}
                {m.self ? <Delivery m={m} onSendAgain={props.onSendAgain} onDiscard={props.onDiscard} /> : null}
              </div>
              {!m.pending && !m.deleted ? (
                <Button
                  variant="bare"
                  type="button"
                  aria-label="Reply"
                  title="Reply"
                  onClick={() => props.onReply(m)}
                  // In the tab order always, shown on hover or when it has keyboard focus.
                  className={cn(
                    'absolute top-1 flex size-7 items-center justify-center rounded-md bg-surface text-muted-foreground opacity-0 shadow-[0_0_0_1px_var(--border),var(--elevation-sm)] group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100',
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
        <div key={s.id} className="mb-2 ml-auto flex max-w-[78%] flex-col items-end">
          <div className="rounded-[18px] px-3 py-2 leading-[1.42] whitespace-pre-wrap text-primary-ink shadow-[inset_0_0_0_1.5px_var(--accent-ring)] [overflow-wrap:anywhere]">
            {s.body === undefined ? (
              // Its text is still on its way: a quiet bar where it will go, not a word that flashes.
              <span
                role="status"
                aria-label="Loading the scheduled message"
                className="block h-[1.42em] w-32 rounded-full bg-[var(--accent-ring)] opacity-30 motion-safe:animate-pulse"
              />
            ) : s.body === null ? (
              <span className="text-subtle-foreground italic">
                This scheduled message can’t be shown here. You can still cancel it.
              </span>
            ) : (
              s.body
            )}
          </div>
          <div className="mx-2.5 mt-0.5 flex items-center gap-2 text-xs text-primary-ink">
            <Clock className="size-3" /> Sends {formatWhen(s.sendAt)}
            <Button variant="link" size="sm" className="h-auto text-xs" onClick={() => props.onSendScheduledNow(s.id)}>
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
        <p className="mx-2 mb-2 text-sm text-subtle-foreground">
          {props.typing === 1 ? 'Someone is typing…' : `${props.typing} people are typing…`}
        </p>
      ) : null}
    </div>
  )
}

function attachmentLabel(m: Message) {
  const n = m.body?.attachments?.length ?? 0
  if (!n) return ''
  // Opening files needs the gateway's media proxy, which isn't built yet.
  return n === 1 ? `📎 ${m.body!.attachments![0]!.name ?? 'An attachment'}` : `📎 ${n} attachments`
}

/** The delivery states of docs/architecture/client-api.md, Sending. */
function Delivery({
  m,
  onSendAgain,
  onDiscard,
}: {
  m: Message
  onSendAgain: (m: Message) => void
  onDiscard: (m: Message) => void
}) {
  switch (m.delivery) {
    case undefined:
      return null
    case 'queued':
    case 'claimed':
    case 'submitted':
      return (
        <span className="inline-flex items-center gap-1" title="Sending">
          <Clock className="size-3" /> Sending
        </span>
      )
    case 'sent':
      return (
        <span title="Sent">
          <Check className="size-3.5" aria-label="Sent" />
        </span>
      )
    case 'delivered':
      return (
        <span title="Delivered">
          <CheckCheck className="size-3.5" aria-label="Delivered" />
        </span>
      )
    case 'read':
      return (
        <span title="Read" className="text-primary">
          <CheckCheck className="size-3.5" aria-label="Read" />
        </span>
      )
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 font-semibold text-danger">
          <AlertCircle className="size-3" /> Not sent
          <Button variant="link" size="sm" className="h-auto text-xs" onClick={() => onSendAgain(m)}>
            Retry
          </Button>
          <Button variant="link" size="sm" className="h-auto text-xs text-danger" onClick={() => onDiscard(m)}>
            Delete
          </Button>
        </span>
      )
    case 'unknown':
      return (
        <span
          className="inline-flex items-center gap-1.5 font-semibold text-warning"
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
  }
}
