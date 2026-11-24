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
import { cn } from '@trioditis/ui/lib/utils'
import { toast } from '@trioditis/ui/toast'
import { KeyRound, LogOut, Plus, Settings, ShieldCheck } from 'lucide-react'
import { networkName, useNetworkHealth } from '~/data/chats.ts'
import type { SettingsSection } from '~/features/settings/settings-dialog.tsx'
import { signOut } from '~/lib/sign-out.ts'
import { useSession } from '~/lib/session.tsx'

const STATUS_TEXT = {
  online: 'Connected',
  degraded: 'Some accounts disconnected',
  offline: 'Offline',
  none: 'Not connected',
} as const

/** The sidebar's bottom bar: who you are, how your networks are doing, and settings. */
export function BottomBar({
  name,
  email,
  openSettings,
}: {
  name: string
  email: string
  openSettings: (section: SettingsSection, how?: 'connect' | 'list') => void
}) {
  const session = useSession()
  const health = useNetworkHealth()
  const connected = (health ?? []).filter((h) => h.status !== 'none')
  const trouble = connected.filter((h) => h.status !== 'online')
  const initials =
    name
      .trim()
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-[38px] min-w-0 items-center gap-2.5 rounded-[10px] pr-2 pl-1 text-left hover:bg-rail-hover"
            aria-label="Account"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground text-[11px] font-semibold text-background">
              {initials}
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate font-semibold">{name}</span>
              <span className="block truncate text-xs text-subtle-foreground">{window.location.host}</span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top">
          <DropdownMenuLabel className="normal-case tracking-normal">{email}</DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => openSettings('appearance', 'list')}>
            <Settings /> Settings
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openSettings('accounts', 'connect')}>
            <Plus /> Connect a network
          </DropdownMenuItem>
          {session.role === 'admin' ? (
            <DropdownMenuItem onSelect={() => openSettings('members', 'list')}>
              <ShieldCheck /> Admin settings
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => openSettings('keys')}>
            <KeyRound /> Keys and devices
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() =>
              void signOut(session.userId, session.sessionId).then((failure) => failure && toast(failure))
            }
          >
            <LogOut /> Sign out of this device
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-8 items-center gap-2 rounded-[9px] px-2 text-sm font-medium text-muted-foreground hover:bg-rail-hover"
            aria-label="Network status"
          >
            <span className="flex gap-[3px]">
              {(connected.length ? connected : [null]).map((h, i) => (
                <i
                  key={h?.network ?? i}
                  className={cn(
                    'block size-1.5 rounded-full',
                    !h ? 'bg-border-strong' : h.status === 'online' ? 'bg-success' : 'bg-warning',
                  )}
                />
              ))}
            </span>
            {/* "Offline" only when it is: a network with some accounts still connected is degraded. */}
            {trouble.length ? (
              <span className="text-warning">
                {trouble.length}{' '}
                {trouble.every((h) => h.status === 'offline')
                  ? 'offline'
                  : trouble.length === 1
                    ? 'needs attention'
                    : 'need attention'}
              </span>
            ) : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top">
          <DropdownMenuLabel>Networks</DropdownMenuLabel>
          {(health ?? []).map((h) => (
            <DropdownMenuItem key={h.network} onSelect={() => openSettings('accounts')}>
              <NetworkBadge network={h.network} label={networkName(h.network)} />
              {networkName(h.network)}
              <DropdownMenuTrail
                className={h.status === 'offline' || h.status === 'degraded' ? 'font-semibold text-warning' : undefined}
              >
                {STATUS_TEXT[h.status]}
              </DropdownMenuTrail>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openSettings('accounts', 'connect')}>
            <Plus /> Connect a network
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="icon" aria-label="Settings" onClick={() => openSettings('appearance', 'list')}>
        <Settings className="size-[18px]" />
      </Button>
    </>
  )
}
