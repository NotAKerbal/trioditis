import { Avatar } from '@trioditis/ui/avatar'
import { Badge } from '@trioditis/ui/badge'
import { Button } from '@trioditis/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrail,
  DropdownMenuTrigger,
} from '@trioditis/ui/dropdown-menu'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { cn } from '@trioditis/ui/lib/utils'
import { AlarmClock, Archive, ArchiveRestore, Bell, BellOff, Check, Pin } from 'lucide-react'
import type { ReactNode } from 'react'
import { networkName, type Chat } from '~/data/chats.ts'
import { useDraft } from '~/data/drafts.ts'
import { listTime } from '~/data/format.ts'
import { formatWhen, snoozeOptions } from '~/data/snooze.ts'
import { usePrefs } from '~/lib/prefs.ts'
import { rowPreview } from './row-preview.ts'

/** What a row's hover actions do. The sidebar decides; the row only offers them. */
export interface RowActions {
  archive?: () => void
  restore?: () => void
  snooze?: (until: number) => void
  wake?: () => void
  accept?: () => void
}

export function ChatRow({
  chat,
  selected,
  unread,
  preview,
  onOpen,
  actions,
}: {
  chat: Chat
  selected: boolean
  unread: boolean
  preview?: ReactNode
  onOpen: () => void
  actions: RowActions
}) {
  const prefs = usePrefs()
  const draft = useDraft(chat.id).text
  const line = rowPreview({
    previews: prefs.previews,
    draft,
    last: chat.last,
    described: chat.described,
    topic: chat.topic,
    network: networkName(chat.network),
  })
  const snoozed = chat.row.snoozedUntil !== null && !chat.row.woke
  return (
    <div className="group relative">
      <Button
        variant="bare"
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left [--avatar-ring:var(--rail)] hover:bg-rail-hover',
          selected &&
            'bg-surface shadow-[0_0_0_1px_var(--border),var(--elevation-sm)] [--avatar-ring:var(--surface)] hover:bg-surface',
        )}
      >
        <Avatar
          name={chat.name}
          size={40}
          shape={chat.row.kind === 'dm' ? 'circle' : 'square'}
          badge={
            prefs.networkBadges ? (
              <NetworkBadge network={chat.network} label={networkName(chat.network)} size={16} />
            ) : undefined
          }
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className={cn('truncate', unread ? 'font-semibold' : 'font-medium')}>{chat.name}</span>
            {chat.row.pinned ? <Pin aria-label="Pinned" className="size-3 shrink-0 text-subtle-foreground" /> : null}
            {chat.muted ? <BellOff aria-label="Muted" className="size-3 shrink-0 text-subtle-foreground" /> : null}
            {chat.row.woke ? (
              <Badge variant="tag" title="Back from snooze">
                WOKE
              </Badge>
            ) : null}
            {snoozed ? (
              <Badge variant="tag" className="ml-auto shrink-0 font-medium">
                {formatWhen(chat.row.snoozedUntil!)}
              </Badge>
            ) : (
              <span className="ml-auto shrink-0 pl-1 text-xs text-subtle-foreground">
                {/* Imported history doesn't set a time, so a backfilled chat has none to show. */}
                {/* The time of what the row shows: the previewed message's, else the chat's last. */}
                {line.kind === 'message' && chat.last
                  ? listTime(chat.last.at)
                  : chat.row.lastMessageAt > 0
                    ? listTime(chat.row.lastMessageAt)
                    : null}
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            <span className={cn('truncate text-sm', unread ? 'text-muted-foreground' : 'text-subtle-foreground')}>
              {preview ??
                (line.kind === 'draft' ? (
                  <>
                    <span className="font-medium text-danger">Draft:</span> {line.text}
                  </>
                ) : (
                  line.text
                ))}
            </span>
            {chat.mentions > 0 ? (
              <Badge className="ml-auto">@</Badge>
            ) : chat.unread > 0 ? (
              <Badge variant={chat.muted ? 'muted' : 'count'} className="ml-auto">
                {chat.unread}
              </Badge>
            ) : null}
          </span>
        </span>
      </Button>
      <RowActionBar actions={actions} />
    </div>
  )
}

function RowActionBar({ actions }: { actions: RowActions }) {
  const items: ReactNode[] = []
  if (actions.accept)
    items.push(
      <Button key="accept" size="sm" variant="ghost" onClick={actions.accept}>
        <Check className="size-3.5" /> Accept
      </Button>,
    )
  if (actions.wake)
    items.push(
      <Button key="wake" size="sm" variant="ghost" onClick={actions.wake}>
        <Bell className="size-3.5" /> Wake
      </Button>,
    )
  if (actions.restore)
    items.push(
      <Button key="restore" size="sm" variant="ghost" onClick={actions.restore}>
        <ArchiveRestore className="size-3.5" /> Restore
      </Button>,
    )
  if (actions.archive)
    items.push(
      <Button
        key="archive"
        size="icon-sm"
        variant="ghost"
        aria-label="Archive"
        title="Archive"
        onClick={actions.archive}
      >
        <Archive className="size-[15px]" />
      </Button>,
    )
  if (actions.snooze) {
    const snooze = actions.snooze
    items.push(
      <DropdownMenu key="snooze">
        <DropdownMenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Snooze" title="Snooze">
            <AlarmClock className="size-[15px]" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Snooze until</DropdownMenuLabel>
          {snoozeOptions().map((o) => (
            <DropdownMenuItem key={o.label} onSelect={() => snooze(o.until)}>
              <AlarmClock /> {o.label}
              <DropdownMenuTrail>{formatWhen(o.until)}</DropdownMenuTrail>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>,
    )
  }
  if (!items.length) return null
  // Shown on hover, and whenever something in it has keyboard focus or its menu is open.
  return (
    <div className="absolute top-1/2 right-2 hidden -translate-y-1/2 gap-0.5 rounded-[9px] bg-surface p-0.5 shadow-[0_0_0_1px_var(--border),var(--elevation-sm)] group-focus-within:flex group-hover:flex has-[[data-state=open]]:flex">
      {items}
    </div>
  )
}
