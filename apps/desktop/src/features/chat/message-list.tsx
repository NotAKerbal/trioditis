import type { Id } from '@trioditis/backend/dataModel'
import { Button } from '@trioditis/ui/button'
import { cn } from '@trioditis/ui/lib/utils'
import { AlertCircle, Check, CheckCheck, Clock, Reply } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { messageTime } from '~/data/format.ts'
import type { Message } from '~/data/messages.ts'
import { formatWhen } from '~/data/snooze.ts'

export interface ScheduledItem {
  id: Id<'scheduledSends'>
  body: string
  sendAt: number
}

interface MessageListProps {
  messages: Message[]
  loading: boolean
  reactions: Map<string, { key: string; count: number; mine: boolean }[]>
  scheduled: ScheduledItem[]
  group: boolean
  typing: number
  canLoadMore: boolean
  onLoadMore: () => void
  onReply: (m: Message) => void
  onSendAgain: (m: Message) => void
  onDiscard: (m: Message) => void
  onSendScheduledNow: (id: Id<'scheduledSends'>) => void
  onCancelScheduled: (id: Id<'scheduledSends'>, body: string) => void
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
  const atBottom = useRef(true)

  // Stay pinned to the newest message unless the person has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && atBottom.current) el.scrollTop = el.scrollHeight
  }, [messages, scheduled.length, props.typing])
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
        <div className="mb-3 flex justify-center">
          <Button size="sm" onClick={props.onLoadMore}>
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
          <div key={m.id}>
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
                <button
                  type="button"
                  aria-label="Reply"
                  title="Reply"
                  onClick={() => props.onReply(m)}
                  className={cn(
                    'absolute top-1 hidden size-7 items-center justify-center rounded-md bg-surface text-muted-foreground shadow-[0_0_0_1px_var(--border),var(--elevation-sm)] group-focus-within:flex group-hover:flex hover:text-foreground',
                    m.self ? '-left-9' : '-right-9',
                  )}
                >
                  <Reply className="size-[15px]" />
                </button>
              ) : null}
            </div>
          </div>
        )
      })}
      {scheduled.map((s) => (
        <div key={s.id} className="mb-2 ml-auto flex max-w-[78%] flex-col items-end">
          <div className="rounded-[18px] px-3 py-2 leading-[1.42] whitespace-pre-wrap text-primary-ink shadow-[inset_0_0_0_1.5px_var(--accent-ring)] [overflow-wrap:anywhere]">
            {s.body}
          </div>
          <div className="mx-2.5 mt-0.5 flex items-center gap-2 text-xs text-primary-ink">
            <Clock className="size-3" /> Sends {formatWhen(s.sendAt)}
            <Button variant="link" size="sm" className="h-auto text-xs" onClick={() => props.onSendScheduledNow(s.id)}>
              Send now
            </Button>
            <Button
              variant="link"
              size="sm"
              className="h-auto text-xs"
              onClick={() => props.onCancelScheduled(s.id, s.body)}
            >
              Cancel
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
