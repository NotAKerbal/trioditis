import { Avatar } from '@trioditis/ui/avatar'
import { Badge } from '@trioditis/ui/badge'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { cn } from '@trioditis/ui/lib/utils'
import { BellOff, Pin } from 'lucide-react'
import { listTime } from '~/data/format.ts'
import type { InboxChat } from '~/data/inbox.ts'
import { networkName } from '~/lib/networks.ts'

export function ChatRow({ chat, selected, unread, showPreview, showBadge, onOpen }: { chat: InboxChat; selected: boolean; unread: boolean; showPreview: boolean; showBadge: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left [--avatar-ring:var(--rail)] hover:bg-rail-hover',
        selected && 'bg-surface shadow-[0_0_0_1px_var(--border),var(--elevation-sm)] [--avatar-ring:var(--surface)] hover:bg-surface',
      )}
    >
      <Avatar
        name={chat.name}
        size={40}
        shape={chat.kind === 'dm' ? 'circle' : 'square'}
        badge={showBadge ? <NetworkBadge network={chat.network} label={networkName(chat.network)} size={16} /> : undefined}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cn('truncate', unread ? 'font-semibold' : 'font-medium')}>{chat.name}</span>
          {chat.pinned ? <Pin aria-label="Pinned" className="size-3 shrink-0 text-subtle-foreground" /> : null}
          {chat.muted ? <BellOff aria-label="Muted" className="size-3 shrink-0 text-subtle-foreground" /> : null}
          <span className="ml-auto shrink-0 pl-1 text-xs text-subtle-foreground">{listTime(chat.lastMessageAt)}</span>
        </span>
        {showPreview ? (
          <span className="mt-0.5 flex items-center gap-1.5">
            <span className={cn('truncate text-sm', unread ? 'text-muted-foreground' : 'text-subtle-foreground')}>
              {chat.described ? (chat.topic ?? networkName(chat.network)) : 'Waiting for this chat’s details…'}
            </span>
            {chat.unread > 0 ? (
              <Badge variant={chat.muted ? 'muted' : 'count'} className="ml-auto">
                {chat.unread}
              </Badge>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  )
}
