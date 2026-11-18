import type { Network } from '@trioditis/core'
import { Button } from '@trioditis/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrail,
  DropdownMenuTrigger,
} from '@trioditis/ui/dropdown-menu'
import { InputGroup } from '@trioditis/ui/input'
import { Kbd } from '@trioditis/ui/kbd'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { cn } from '@trioditis/ui/lib/utils'
import { Archive, ChevronRight, Eye, Filter, Inbox, Search, SquarePen, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { InboxChat } from '~/data/inbox.ts'
import { NETWORK_INFO, networkName } from '~/lib/networks.ts'
import { usePrefs } from '~/lib/prefs.ts'
import { ChatRow } from './chat-row.tsx'

type Show = 'chats' | 'archived'

interface SidebarProps {
  chats: InboxChat[] | undefined
  selectedId: string | undefined
  /** The chat opened while it had unread messages: it stays under Unread until another chat opens. */
  openedUnreadId: string | undefined
  onSelect: (id: string | undefined) => void
  topBarEnd?: ReactNode
  bottomBar: ReactNode
}

const byPinThenRecent = (a: InboxChat, b: InboxChat) => Number(b.pinned) - Number(a.pinned) || b.lastMessageAt - a.lastMessageAt

export function Sidebar({ chats, selectedId, openedUnreadId, onSelect, bottomBar }: SidebarProps) {
  const prefs = usePrefs()
  const [query, setQuery] = useState('')
  const [network, setNetwork] = useState<Network | null>(null)
  const [show, setShow] = useState<Show>('chats')
  const [open, setOpen] = useState({ read: false, archived: false })
  const searchRef = useRef<HTMLInputElement>(null)

  // ⌘K / Ctrl+K jumps to search, unless a dialog is open (Radix makes the page behind it inert).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !document.querySelector('[role="dialog"]')) {
        e.preventDefault()
        searchRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const isUnread = (c: InboxChat) => (c.unread > 0 && !c.muted) || c.id === openedUnreadId
  const filtered = useMemo(() => (chats ?? []).filter((c) => !network || c.network === network).sort(byPinThenRecent), [chats, network])
  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const results = searching ? filtered.filter((c) => c.name.toLowerCase().includes(q) || c.topic?.toLowerCase().includes(q)) : []

  const live = filtered.filter((c) => !c.archived)
  const archived = filtered.filter((c) => c.archived)
  const unread = live.filter(isUnread)
  const read = live.filter((c) => !isUnread(c))
  const simpleList = show === 'archived' ? archived : live

  // What is on screen, in order. A view or filter change that hides the open chat closes it,
  // rather than opening another one: opening a chat marks it read, and nobody asked to read it.
  const shown = searching ? results : prefs.sidebar === 'simple' ? simpleList : [...unread, ...(open.read ? read : []), ...(open.archived ? archived : [])]
  const shownIds = shown.map((c) => c.id as string)
  const filterKey = `${network}|${show}`
  const lastFilterKey = useRef(filterKey)
  useEffect(() => {
    if (lastFilterKey.current === filterKey) return
    lastFilterKey.current = filterKey
    if (selectedId && !shownIds.includes(selectedId)) onSelect(undefined)
  })

  const row = (c: InboxChat) => (
    <ChatRow key={c.id} chat={c} selected={c.id === selectedId} unread={isUnread(c)} showPreview={prefs.previews} showBadge={prefs.networkBadges} onOpen={() => onSelect(c.id)} />
  )
  const networksInUse = [...new Set((chats ?? []).map((c) => c.network))]
  const filterActive = !!network || (prefs.sidebar === 'simple' && show !== 'chats')
  const clearFilters = () => {
    setNetwork(null)
    setShow('chats')
  }

  return (
    <aside className="flex w-[332px] shrink-0 flex-col border-r border-border bg-rail" aria-label="Chats">
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-2.5">
        <InputGroup className="flex-1" icon={<Search className="size-4 shrink-0" />} end={<Kbd>⌘K</Kbd>}>
          <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" aria-label="Search chats" />
        </InputGroup>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Filter chats" className={cn('relative', filterActive && 'bg-primary-soft text-primary')}>
              <Filter className="size-[17px]" />
              {filterActive ? <span className="absolute top-1.5 right-1.5 size-[7px] rounded-full bg-primary ring-2 ring-rail" /> : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {prefs.sidebar === 'simple' ? (
              <>
                <DropdownMenuLabel>Show</DropdownMenuLabel>
                <DropdownMenuCheckboxItem checked={show === 'chats'} onSelect={() => setShow('chats')}>
                  <Inbox /> All chats
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={show === 'archived'} onSelect={() => setShow('archived')}>
                  <Archive /> Archived <DropdownMenuTrail>{(chats ?? []).filter((c) => c.archived).length || ''}</DropdownMenuTrail>
                </DropdownMenuCheckboxItem>
              </>
            ) : null}
            <DropdownMenuLabel>Only this network</DropdownMenuLabel>
            {networksInUse.length === 0 ? <DropdownMenuItem disabled>No chats yet</DropdownMenuItem> : null}
            {networksInUse.map((n) => (
              <DropdownMenuCheckboxItem key={n} checked={network === n} onSelect={() => setNetwork(network === n ? null : n)}>
                <NetworkBadge network={n} label={NETWORK_INFO[n].name} />
                {NETWORK_INFO[n].name}
                <DropdownMenuTrail>{(chats ?? []).filter((c) => c.network === n && c.unread > 0 && !c.muted && !c.archived).length || ''}</DropdownMenuTrail>
              </DropdownMenuCheckboxItem>
            ))}
            {filterActive ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={clearFilters}>
                  <X /> Clear filters
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon" aria-label="New message" title="Starting new chats needs backend support" disabled>
          <SquarePen className="size-[17px]" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
        {filterActive && !searching ? (
          <div className="mx-1 mt-1.5 mb-0.5 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            Showing
            {prefs.sidebar === 'simple' && show === 'archived' ? <b className="inline-flex items-center gap-1 font-semibold text-foreground"><Archive className="size-3.5" /> Archived</b> : null}
            {network ? <b className="inline-flex items-center gap-1 font-semibold text-foreground"><NetworkBadge network={network} label={networkName(network)} size={14} /> {networkName(network)}</b> : null}
            <Button variant="link" size="sm" className="ml-auto h-auto" onClick={clearFilters}>
              Clear
            </Button>
          </div>
        ) : null}

        {chats === undefined ? (
          <ListSkeleton />
        ) : searching ? (
          <>
            <SectionHeader label="Results in all chats" count={results.length} />
            {results.length ? results.map(row) : <Empty>No chats match.</Empty>}
          </>
        ) : chats.length === 0 ? (
          <Empty>No chats yet. Connect a network in Settings → Accounts and they’ll show up here.</Empty>
        ) : prefs.sidebar === 'simple' ? (
          simpleList.length ? simpleList.map(row) : <Empty>Nothing here.</Empty>
        ) : (
          <>
            {unread.length ? (
              <>
                <SectionHeader label="Unread" count={unread.length} />
                {unread.map(row)}
              </>
            ) : (
              <Empty>You’re all caught up.</Empty>
            )}
            <div className="mt-2 border-t border-border pt-1.5">
              <Divider label="Read" icon={<Eye className="size-3.5" />} count={read.length} open={open.read} onToggle={() => setOpen((o) => ({ ...o, read: !o.read }))}>
                {read.map(row)}
              </Divider>
              <Divider label="Archived" icon={<Archive className="size-3.5" />} count={archived.length} open={open.archived} onToggle={() => setOpen((o) => ({ ...o, archived: !o.archived }))}>
                {archived.map(row)}
              </Divider>
            </div>
          </>
        )}
      </div>

      <div className="flex h-[52px] shrink-0 items-center gap-1 border-t border-border px-2.5">{bottomBar}</div>
    </aside>
  )
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-1.5 px-2 pt-3 pb-1.5 text-xs font-semibold tracking-[0.05em] text-subtle-foreground uppercase">
      {label} <span className="text-primary">{count}</span>
    </div>
  )
}

/** A collapsed section, like T3 Code's: label, count and a rule; click to open. Hidden when empty. */
function Divider({ label, icon, count, open, onToggle, children }: { label: string; icon: ReactNode; count: number; open: boolean; onToggle: () => void; children: ReactNode }) {
  if (count === 0) return null
  return (
    <>
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-base font-semibold text-muted-foreground hover:bg-rail-hover hover:text-foreground">
        <ChevronRight className={cn('size-3.5 text-subtle-foreground transition-transform', open && 'rotate-90')} />
        <span className="text-subtle-foreground">{icon}</span>
        {label}
        <span className="text-sm font-medium text-subtle-foreground">{count}</span>
        <span className="h-px flex-1 bg-border-strong" />
      </button>
      {open ? children : null}
    </>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-8 text-center text-sm text-subtle-foreground">{children}</p>
}

function ListSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading chats" className="space-y-1 pt-2">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2.5 py-2">
          <span className="size-10 rounded-full bg-rail-hover" />
          <span className="h-3 flex-1 rounded bg-rail-hover" />
        </div>
      ))}
    </div>
  )
}
