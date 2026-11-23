import { Button } from '@trioditis/ui/button'
import type { Network } from '@trioditis/core'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrail,
  DropdownMenuTrigger,
} from '@trioditis/ui/dropdown-menu'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { Textarea } from '@trioditis/ui/textarea'
import { CircleHelp, Clock, FileIcon, Loader2, Reply, SendHorizontal, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { networkName } from '~/data/chats.ts'
import type { Message } from '~/data/messages.ts'
import { formatWhen, snoozeOptions } from '~/data/snooze.ts'
import { fileSize } from './attachments.tsx'
import { pastedFiles, type OutgoingFile } from './outgoing-files.ts'

/** One of a conversation's chats a message can go by: its network, and which account if several. */
export interface ViaOption {
  id: string
  network: Network
  label: string
}

interface ComposerProps {
  network: Network
  /** The chat it sends on: a menu open when that changes closes, so it can't act on another. */
  destination?: string | undefined
  /** In a conversation of a person's chats on several networks, the ones to choose from. */
  via?: { options: ViaOption[]; current: string; onChange: (id: string) => void } | undefined
  draft: string
  onDraft: (text: string) => void
  /** Files to send with it, each as a message of its own; the text goes with the first. */
  files: OutgoingFile[]
  onAddFiles: (files: File[]) => void
  onRemoveFile: (id: string) => void
  replyTo: Message | null
  onCancelReply: () => void
  onSend: () => void
  onSchedule: (sendAt: number) => void
  disabled: string | null
}

export function Composer({
  network,
  destination,
  via,
  draft,
  onDraft,
  files,
  onAddFiles,
  onRemoveFile,
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

  const empty = !draft.trim() && files.length === 0
  const sending = files.some((f) => f.sending)
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
      {files.length ? (
        <ul aria-label="Files to send" className="mx-2 mt-2 flex gap-2 overflow-x-auto pb-1">
          {files.map((f) => (
            <li
              key={f.id}
              className="relative flex h-16 shrink-0 items-center overflow-hidden rounded-[9px] bg-surface-2"
            >
              {f.preview ? (
                <img src={f.preview} alt={f.file.name || 'Picture'} className="size-16 object-cover" />
              ) : (
                <span className="flex max-w-52 items-center gap-2 pr-8 pl-3 text-sm">
                  <FileIcon className="size-5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate">{f.file.name || 'File'}</span>
                    <span className="block text-xs text-subtle-foreground">{fileSize(f.file.size)}</span>
                  </span>
                </span>
              )}
              {f.sending ? (
                <span className="absolute inset-0 flex items-center justify-center bg-surface/60">
                  <Loader2 className="size-5 animate-spin" aria-label="Sending" />
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${f.file.name || 'file'}`}
                  className="absolute top-0.5 right-0.5 bg-surface/80"
                  onClick={() => onRemoveFile(f.id)}
                >
                  <X className="size-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {/* The placeholder says why too, but it's gone once there's text. */}
      {disabled && draft.length > 0 ? <p className="mx-3 mt-2 text-sm text-subtle-foreground">{disabled}</p> : null}
      <div className="flex items-end gap-1 p-1.5">
        {via ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={via.current ? `Sending on ${networkName(network)}. Change` : 'Choose where to send'}
                title={via.current ? 'Send on another network' : 'Choose where to send'}
              >
                {via.current ? (
                  <NetworkBadge network={network} label={networkName(network)} size={18} />
                ) : (
                  <CircleHelp className="size-[18px]" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="top">
              <DropdownMenuLabel>Send on</DropdownMenuLabel>
              {via.options.map((o) => (
                <DropdownMenuCheckboxItem key={o.id} checked={o.id === via.current} onSelect={() => via.onChange(o.id)}>
                  <NetworkBadge network={o.network} label={networkName(o.network)} />
                  {o.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Textarea
          variant="bare"
          ref={input}
          rows={1}
          value={draft}
          disabled={!!disabled}
          placeholder={disabled ?? `Message on ${networkName(network)}`}
          aria-label="Message"
          onChange={(e) => onDraft(e.target.value)}
          onPaste={(e) => {
            const pasted = pastedFiles(e.clipboardData)
            if (!pasted.length) return
            e.preventDefault()
            onAddFiles(pasted)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (!empty && !sending) onSend()
            }
            if (e.key === 'Escape' && replyTo) onCancelReply()
          }}
          className="max-h-40 min-h-[38px] flex-1 px-2 py-2"
        />
        <DropdownMenu key={destination}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Schedule for later"
              title={files.length ? 'Files can’t be scheduled yet' : 'Schedule for later'}
              disabled={empty || files.length > 0 || !!disabled}
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
          disabled={empty || sending || !!disabled}
          onClick={onSend}
        >
          <SendHorizontal className="size-[17px]" />
        </Button>
      </div>
    </div>
  )
}
