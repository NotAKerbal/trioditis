import type { ChatView, Network } from '@trioditis/core'
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
import { Input, InputGroup } from '@trioditis/ui/input'
import { Kbd } from '@trioditis/ui/kbd'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { cn } from '@trioditis/ui/lib/utils'
import {
  AlarmClock,
  Archive,
  Ban,
  ChevronRight,
  Clock,
  Eye,
  Filter,
  Inbox,
  Search,
  SquarePen,
  UserPlus,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  networkName,
  useChats,
  useLabels,
  useNetworks,
  useScheduled,
  useScheduledTexts,
  useSidebarLayout,
  type Chat,
  type ChatList,
  type ChatFilter,
  type LabelId,
} from '~/data/chats.ts'
import { formatWhen } from '~/data/snooze.ts'
import { ChatRow, type RowActions } from './chat-row.tsx'
import { LabelDot } from './label-dot.tsx'

/** What the sidebar asks the shell to do to a chat. The shell owns selection and auto-advance. */
export type SidebarAction =
  { type: 'archive' | 'restore' | 'wake' | 'accept'; chat: Chat } | { type: 'snooze'; chat: Chat; until: number }

interface SidebarProps {
  selectedId: string | undefined
  /** The chat opened while it had unread messages: it stays under Unread until another chat opens. */
  openedUnreadId: string | undefined
  onOpen: (chat: Chat) => void
  onClose: () => void
  onAction: (action: SidebarAction) => void
  /** Kept up to date with the on-screen order, for actions taken outside the sidebar. */
  shownRef: { current: string[] }
  chatsRef: { current: Map<string, Chat> }
  bottomBar: ReactNode
}

const SIMPLE_SHOWS: { view: ChatView; label: string; icon: ReactNode }[] = [
  { view: 'inbox', label: 'All chats', icon: <Inbox /> },
  { view: 'requests', label: 'Requests', icon: <UserPlus /> },
  { view: 'snoozed', label: 'Snoozed', icon: <AlarmClock /> },
  { view: 'archived', label: 'Archived', icon: <Archive /> },
  { view: 'blocked', label: 'Blocked', icon: <Ban /> },
]

export function Sidebar({
  selectedId,
  openedUnreadId,
  onOpen,
  onClose,
  onAction,
  shownRef,
  chatsRef,
  bottomBar,
}: SidebarProps) {
  const [layout] = useSidebarLayout()
  const [query, setQuery] = useState('')
  const [network, setNetwork] = useState<Network | undefined>()
  const [labelId, setLabelId] = useState<LabelId | undefined>()
  const [simpleShow, setSimpleShow] = useState<ChatView>('inbox')
  const [open, setOpen] = useState({ read: false, snoozed: false, scheduled: false, requests: false, archived: false })
  const searchRef = useRef<HTMLInputElement>(null)

  // ⌘K / Ctrl+K jumps to search, unless a dialog is open (it makes the page behind it inert).
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

  const filter: ChatFilter = { network, labelId }
  const focused = layout === 'focused'
  const main = useChats(focused ? 'inbox' : simpleShow, filter)
  // Focused mode shows every view at once, folded into dividers; Simple loads only the one it shows.
  const snoozedList = useChats('snoozed', filter, focused)
  const requestsList = useChats('requests', filter, focused)
  const archivedList = useChats('archived', filter, focused)
  const inbox = main.chats
  const snoozed = snoozedList.chats
  const requests = requestsList.chats
  const archived = archivedList.chats
  const scheduledMessages = useScheduled()
  const scheduledTexts = useScheduledTexts((scheduledMessages ?? []).map((s) => s._id))
  const labels = useLabels()
  const networks = useNetworks()

  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const everything = useMemo(() => {
    const seen = new Map<string, Chat>()
    for (const list of [inbox, snoozed, requests, archived]) for (const c of list ?? []) seen.set(c.id, c)
    return [...seen.values()]
  }, [inbox, snoozed, requests, archived])
  const results = searching
    ? everything.filter((c) => c.name.toLowerCase().includes(q) || c.topic?.toLowerCase().includes(q))
    : []

  const isUnread = (c: Chat) => (c.hasUnread && !c.muted) || c.id === openedUnreadId
  const unread = (inbox ?? []).filter(isUnread)
  const read = (inbox ?? []).filter((c) => !isUnread(c))

  // Scheduled messages, each with its chat (when one of the loaded views has it) and its opened text.
  const scheduled = useMemo(
    () =>
      (scheduledMessages ?? []).map((s) => ({
        ...s,
        chat: everything.find((c) => c.id === s.chatId),
        body: scheduledTexts.get(s._id) ?? 'Scheduled message',
      })),
    [scheduledMessages, everything, scheduledTexts],
  )

  // What is on screen, in order: the shell uses it to keep the open chat in view.
  const shown: Chat[] = searching
    ? results
    : focused
      ? [
          ...unread,
          ...(open.read ? read : []),
          ...(open.snoozed ? (snoozed ?? []) : []),
          ...(open.requests ? (requests ?? []) : []),
          ...(open.archived ? (archived ?? []) : []),
        ]
      : (inbox ?? [])
  const shownIds = shown.map((c) => c.id as string)
  shownRef.current = shownIds
  chatsRef.current = new Map(everything.map((c) => [c.id as string, c]))

  // A view or filter change that hides the open chat closes it rather than opening another:
  // opening a chat marks it read, and nobody asked to read it.
  const filterKey = `${network}|${labelId}|${simpleShow}|${layout}`
  const lastFilterKey = useRef(filterKey)
  const loaded = inbox !== undefined && (!focused || (snoozed && requests && archived))
  useEffect(() => {
    if (!loaded || lastFilterKey.current === filterKey) return
    lastFilterKey.current = filterKey
    if (selectedId && !shownIds.includes(selectedId)) onClose()
  })

  const act = onAction
  const actionsFor = (c: Chat): RowActions => {
    if (c.row.isRequest) return { accept: () => act({ type: 'accept', chat: c }) }
    if (c.row.archived) return { restore: () => act({ type: 'restore', chat: c }) }
    if (c.row.snoozedUntil !== null && !c.row.woke) return { wake: () => act({ type: 'wake', chat: c }) }
    if (c.row.blocked) return {}
    return {
      archive: () => act({ type: 'archive', chat: c }),
      snooze: (until) => act({ type: 'snooze', chat: c, until }),
    }
  }
  const row = (c: Chat, preview?: ReactNode) => (
    <ChatRow
      key={`${c.id}${preview ? ':s' : ''}`}
      chat={c}
      selected={c.id === selectedId}
      unread={isUnread(c)}
      preview={preview}
      onOpen={() => onOpen(c)}
      actions={actionsFor(c)}
    />
  )

  const currentLabel = labels?.find((l) => l.id === labelId)
  const filterActive = !!network || !!labelId || (!focused && simpleShow !== 'inbox')
  const clearFilters = () => {
    setNetwork(undefined)
    setLabelId(undefined)
    setSimpleShow('inbox')
  }
  const showLabel = SIMPLE_SHOWS.find((s) => s.view === simpleShow)!

  return (
    <aside className="flex w-[332px] shrink-0 flex-col border-r border-border bg-rail" aria-label="Chats">
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-2.5">
        <InputGroup className="flex-1" icon={<Search className="size-4 shrink-0" />} end={<Kbd>⌘K</Kbd>}>
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search chats"
          />
        </InputGroup>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Filter chats"
              className={cn('relative', filterActive && 'bg-primary-soft text-primary')}
            >
              <Filter className="size-[17px]" />
              {filterActive ? (
                <span className="absolute top-1.5 right-1.5 size-[7px] rounded-full bg-primary ring-2 ring-rail" />
              ) : null}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[70vh] overflow-y-auto">
            {!focused ? (
              <>
                <DropdownMenuLabel>Show</DropdownMenuLabel>
                {SIMPLE_SHOWS.map((s) => (
                  <DropdownMenuCheckboxItem
                    key={s.view}
                    checked={simpleShow === s.view}
                    onSelect={() => setSimpleShow(s.view)}
                  >
                    {s.icon} {s.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </>
            ) : null}
            <DropdownMenuLabel>Only this network</DropdownMenuLabel>
            {(networks ?? []).map((n) => (
              <DropdownMenuCheckboxItem
                key={n.network}
                checked={network === n.network}
                onSelect={() => setNetwork(network === n.network ? undefined : n.network)}
              >
                <NetworkBadge network={n.network} label={n.name} />
                {n.name}
                {n.maturity !== 'stable' ? <DropdownMenuTrail>{n.maturity}</DropdownMenuTrail> : null}
              </DropdownMenuCheckboxItem>
            ))}
            {labels?.length ? (
              <>
                <DropdownMenuLabel>Only this label</DropdownMenuLabel>
                {labels.map((l) => (
                  <DropdownMenuCheckboxItem
                    key={l.id}
                    checked={labelId === l.id}
                    onSelect={() => setLabelId(labelId === l.id ? undefined : l.id)}
                  >
                    <LabelDot color={l.color} /> {l.name}
                  </DropdownMenuCheckboxItem>
                ))}
              </>
            ) : null}
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
        <Button
          variant="ghost"
          size="icon"
          aria-label="New message"
          title="Starting a new chat isn’t available yet"
          disabled
        >
          <SquarePen className="size-[17px]" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
        {filterActive && !searching ? (
          <div className="mx-1 mt-1.5 mb-0.5 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            Showing
            {!focused && simpleShow !== 'inbox' ? (
              <b className="inline-flex items-center gap-1 font-semibold text-foreground [&_svg]:size-3.5">
                {showLabel.icon} {showLabel.label}
              </b>
            ) : null}
            {network ? (
              <b className="inline-flex items-center gap-1 font-semibold text-foreground">
                <NetworkBadge network={network} label={networkName(network)} size={14} /> {networkName(network)}
              </b>
            ) : null}
            {currentLabel ? (
              <b className="inline-flex items-center gap-1 font-semibold text-foreground">
                <LabelDot color={currentLabel.color} /> {currentLabel.name}
              </b>
            ) : null}
            <Button variant="link" size="sm" className="ml-auto h-auto" onClick={clearFilters}>
              Clear
            </Button>
          </div>
        ) : null}

        {inbox === undefined ? (
          <ListSkeleton />
        ) : searching ? (
          <>
            <SectionHeader label="Results in all chats" count={results.length} />
            {results.length ? results.map((c) => row(c)) : <Empty>No chats match.</Empty>}
          </>
        ) : !focused ? (
          inbox.length ? (
            <>
              {inbox.map((c) => row(c))}
              <LoadMore list={main} />
            </>
          ) : (
            <Empty>
              {simpleShow === 'inbox' && !filterActive
                ? 'No chats yet. Connect a network in Settings → Accounts and they’ll show up here.'
                : 'Nothing here.'}
            </Empty>
          )
        ) : (
          <>
            {unread.length ? (
              <>
                <SectionHeader label="Unread" count={unread.length} />
                {unread.map((c) => row(c))}
              </>
            ) : (
              <Empty>
                {everything.length
                  ? 'You’re all caught up.'
                  : 'No chats yet. Connect a network in Settings → Accounts and they’ll show up here.'}
              </Empty>
            )}
            <div className="mt-2 border-t border-border pt-1.5">
              <Divider
                label="Read"
                icon={<Eye />}
                count={read.length}
                more={main}
                open={open.read}
                onToggle={() => setOpen((o) => ({ ...o, read: !o.read }))}
              >
                {read.map((c) => row(c))}
              </Divider>
              <Divider
                label="Snoozed"
                icon={<AlarmClock />}
                count={snoozed?.length ?? 0}
                more={snoozedList}
                open={open.snoozed}
                onToggle={() => setOpen((o) => ({ ...o, snoozed: !o.snoozed }))}
              >
                {snoozed?.map((c) => row(c))}
              </Divider>
              <Divider
                label="Scheduled"
                icon={<Clock />}
                count={scheduled.length}
                open={open.scheduled}
                onToggle={() => setOpen((o) => ({ ...o, scheduled: !o.scheduled }))}
              >
                {scheduled.map((s) =>
                  s.chat ? (
                    row(
                      s.chat,
                      <>
                        <Clock className="mr-1 inline size-3 align-[-1px]" />
                        {formatWhen(s.sendAt)} · {s.body}
                      </>,
                    )
                  ) : (
                    <p key={s._id} className="px-2.5 py-2 text-sm text-muted-foreground">
                      {formatWhen(s.sendAt)} · {s.body}
                    </p>
                  ),
                )}
              </Divider>
              <Divider
                label="Requests"
                icon={<UserPlus />}
                count={requests?.length ?? 0}
                more={requestsList}
                open={open.requests}
                onToggle={() => setOpen((o) => ({ ...o, requests: !o.requests }))}
              >
                {requests?.map((c) => row(c))}
              </Divider>
              <Divider
                label="Archived"
                icon={<Archive />}
                count={archived?.length ?? 0}
                more={archivedList}
                open={open.archived}
                onToggle={() => setOpen((o) => ({ ...o, archived: !o.archived }))}
              >
                {archived?.map((c) => row(c))}
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
function Divider({
  label,
  icon,
  count,
  more,
  open,
  onToggle,
  children,
}: {
  label: string
  icon: ReactNode
  count: number
  /** The view has more chats than are loaded: the count reads "50+" and opening shows Load more. */
  more?: ChatList
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  if (count === 0) return null
  return (
    <>
      <Button
        variant="bare"
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-base font-semibold text-muted-foreground hover:bg-rail-hover hover:text-foreground"
      >
        <ChevronRight className={cn('size-3.5 text-subtle-foreground transition-transform', open && 'rotate-90')} />
        <span className="text-subtle-foreground [&_svg]:size-3.5">{icon}</span>
        {label}
        <span className="text-sm font-medium text-subtle-foreground">
          {count}
          {more?.canLoadMore ? '+' : ''}
        </span>
        <span className="h-px flex-1 bg-border-strong" />
      </Button>
      {open ? children : null}
      {open && more ? <LoadMore list={more} /> : null}
    </>
  )
}

/**
 * Loads the next page of a view as it scrolls near, with the button as a fallback. A page can end
 * early under the server's byte budget, so only the cursor says a view is done, not a short page.
 */
function LoadMore({ list }: { list: ChatList }) {
  const ref = useRef<HTMLButtonElement>(null)
  const loadMore = useRef(list.loadMore)
  loadMore.current = list.loadMore
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadMore.current(), {
      rootMargin: '200px',
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [list.canLoadMore])
  if (!list.canLoadMore) return null
  return (
    <Button ref={ref} variant="ghost" size="sm" block className="my-1" onClick={list.loadMore}>
      Load more chats
    </Button>
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
