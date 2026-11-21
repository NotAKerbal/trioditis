import { Button } from '@trioditis/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrail,
  DropdownMenuTrigger,
} from '@trioditis/ui/dropdown-menu'
import { Textarea } from '@trioditis/ui/textarea'
import { Clock, Reply, SendHorizontal, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { networkName } from '~/data/chats.ts'
import type { Message } from '~/data/messages.ts'
import { formatWhen, snoozeOptions } from '~/data/snooze.ts'

interface ComposerProps {
  network: string
  draft: string
  onDraft: (text: string) => void
  replyTo: Message | null
  onCancelReply: () => void
  onSend: () => void
  onSchedule: (sendAt: number) => void
  disabled: string | null
}

export function Composer({
  network,
  draft,
  onDraft,
  replyTo,
  onCancelReply,
  onSend,
  onSchedule,
  disabled,
}: ComposerProps) {
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (replyTo) input.current?.focus()
  }, [replyTo])
  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [draft])

  const empty = !draft.trim()
  return (
    <div className="mx-3.5 mb-3.5 shrink-0 rounded-[14px] bg-surface shadow-[0_0_0_1px_var(--border),var(--elevation-sm)] focus-within:shadow-[0_0_0_1px_var(--accent-ring),0_0_0_4px_var(--accent-soft)]">
      {replyTo ? (
        <div className="mx-2 mt-2 flex items-center gap-2 rounded-[9px] bg-surface-2 py-1 pr-1 pl-2.5 text-sm text-muted-foreground">
          <Reply className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate border-l-[3px] border-primary pl-2">
            <span className="sr-only">Replying to </span>
            {replyTo.body?.body || 'a message'}
          </span>
          <Button variant="ghost" size="icon-sm" aria-label="Cancel reply" onClick={onCancelReply}>
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}
      {/* The placeholder says why too, but it's gone once there's text. */}
      {disabled && draft.length > 0 ? <p className="mx-3 mt-2 text-sm text-subtle-foreground">{disabled}</p> : null}
      <div className="flex items-end gap-1 p-1.5">
        <Textarea
          variant="bare"
          ref={input}
          rows={1}
          value={draft}
          disabled={!!disabled}
          placeholder={disabled ?? `Message on ${networkName(network)}`}
          aria-label="Message"
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (!empty) onSend()
            }
            if (e.key === 'Escape' && replyTo) onCancelReply()
          }}
          className="max-h-40 min-h-[38px] flex-1 px-2 py-2"
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Schedule for later"
              title="Schedule for later"
              disabled={empty || !!disabled}
            >
              <Clock className="size-[18px]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top">
            <DropdownMenuLabel>Send later</DropdownMenuLabel>
            {snoozeOptions().map((o) => (
              <DropdownMenuItem key={o.label} onSelect={() => onSchedule(o.until)}>
                <Clock /> {o.label}
                <DropdownMenuTrail>{formatWhen(o.until)}</DropdownMenuTrail>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="primary"
          size="icon"
          aria-label="Send"
          title="Send (Enter)"
          disabled={empty || !!disabled}
          onClick={onSend}
        >
          <SendHorizontal className="size-[17px]" />
        </Button>
      </div>
    </div>
  )
}
