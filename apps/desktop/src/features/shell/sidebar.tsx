import type { Id } from '@trioditis/backend/dataModel'
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
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { cn } from '@trioditis/ui/lib/utils'
import { toast } from '@trioditis/ui/toast'
import {
  AlarmClock,
  AlertCircle,
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
  Users,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  networkName,
  useChatCounts,
  useChats,
  useLabels,
  useNetworks,
  useScheduled,
  useScheduledTexts,
  useSidebarLayout,
  type Chat,
  type ChatId,
  type ChatList,
  type ChatFilter,
  type LabelId,
} from '~/data/chats.ts'
import { warmChat } from '~/data/chat-content.ts'
import { useSendMutations } from '~/data/messages.ts'
import { warmPeople } from '~/data/people.ts'
import { formatWhen } from '~/data/snooze.ts'
import { errorMessage } from '~/lib/errors.ts'
import { ChatRow, type RowActions } from './chat-row.tsx'
import { LabelDot } from './label-dot.tsx'
import { searchScope } from './search-scope.ts'
import { usePrefs } from '~/lib/prefs.ts'
import { useSession } from '~/lib/session.tsx'

/** What the sidebar asks the shell to do to a chat. The shell owns selection and auto-advance. */
export type SidebarAction =
  { type: 'archive' | 'restore' | 'wake' | 'accept'; chat: Chat } | { type: 'snooze'; chat: Chat; until: number }

interface SidebarProps {
  selectedId: string | undefined
  /** The chat opened while it had unread messages: it stays under Unread until another chat opens. */
  openedUnreadId: string | undefined
  onOpen: (chat: Chat) => void
  /** Opens a chat by ID, for one the sidebar hasn't loaded (a scheduled message's). */
  onOpenId: (chatId: ChatId) => void
  onClose: () => void
  onAction: (action: SidebarAction) => void
  onPeople: () => void
  onNewChat: () => void
  /**
   * Kept up to date with the on-screen order, for actions taken outside the sidebar; null
   * while the list is still loading, when there's nothing to compare against.
   */
  shownRef: { current: string[] | null }
  chatsRef: { current: Map<string, Chat> }
}

/** How many of the first unread chats are fetched ahead, and how long after the list settles. */
const WARM_UNREAD = 3
const WARM_UNREAD_AFTER_MS = 1_500

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
  onOpenId,
  onClose,
  onAction,
  onPeople,
  onNewChat,
  shownRef,
  chatsRef,
}: SidebarProps) {
  const [layout] = useSidebarLayout()
  const session = useSession()
  const prefs = usePrefs()
  const [query, setQuery] = useState('')
  const [network, setNetwork] = useState<Network | undefined>()
  const [labelId, setLabelId] = useState<LabelId | undefined>()
  const [simpleShow, setSimpleShow] = useState<ChatView>('inbox')
  const [open, setOpen] = useState({
    read: false,
    snoozed: false,
    scheduled: false,
    requests: false,
    archived: false,
    blocked: false,
  })
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
  // Focused pages its inbox by recency alone, so Read is newest first across pages; Unread
  // puts the pins first among what's loaded.
  const main = useChats(focused ? 'inbox' : simpleShow, filter, true, focused ? 'recent' : undefined)
  // Focused mode shows every view at once, folded into dividers; Simple loads only the one it shows.
  const snoozedList = useChats('snoozed', filter, focused)
  const requestsList = useChats('requests', filter, focused)
  const archivedList = useChats('archived', filter, focused)
  const blockedList = useChats('blocked', filter, focused)
  const inbox = main.chats
  const snoozed = snoozedList.chats
  const requests = requestsList.chats
  const archived = archivedList.chats
  const blocked = blockedList.chats
  // The server's badge counts cover every chat, not only the pages loaded, but not a filter.
  const serverCounts = useChatCounts()
  const counts = network || labelId ? undefined : serverCounts
  // A scheduled send whose chat was gone when its time came failed: it's listed apart, to dismiss.
  const scheduledRows = useScheduled()
  const scheduledMessages = useMemo(() => scheduledRows?.filter((s) => s.state !== 'failed'), [scheduledRows])
  const failedSends = useMemo(() => scheduledRows?.filter((s) => s.state === 'failed') ?? [], [scheduledRows])
  const scheduledTexts = useScheduledTexts((scheduledMessages ?? []).map((s) => s._id))
  const labels = useLabels()
  const networks = useNetworks()

  const q = query.trim().toLowerCase()
  const searching = q.length > 0
  const everything = useMemo(() => {
    const seen = new Map<string, Chat>()
    for (const list of [inbox, snoozed, requests, archived, blocked]) for (const c of list ?? []) seen.set(c.id, c)
    return [...seen.values()]
  }, [inbox, snoozed, requests, archived, blocked])
  // Search looks through the chats loaded so far, of the views shown; these are the ones with more.
  const searched = focused ? [main, snoozedList, requestsList, archivedList, blockedList] : [main]
  const unloaded = searched.filter((l) => l.canLoadMore)
  const searchedAll = searched.every((l) => l.exhausted)
  const searchLabel = searchScope({
    searchedAll,
    view: focused ? null : SIMPLE_SHOWS.find((v) => v.view === simpleShow)!.label,
    network: network ? networkName(network) : undefined,
    label: labelId ? (labels?.find((l) => l.id === labelId)?.name ?? 'a label') : undefined,
  })
  const results = searching
    ? everything.filter((c) => c.name.toLowerCase().includes(q) || c.topic?.toLowerCase().includes(q))
    : []

  const isUnread = (c: Chat) => (c.hasUnread && !c.muted) || c.id === openedUnreadId
  const unread = (inbox ?? []).filter(isUnread)
  if (focused) unread.sort((a, b) => Number(b.row.pinned) - Number(a.row.pinned))
  // Newest first. The server pages Focused that way already, except with a label, whose pages
  // come in the order chats were labelled: then the loaded chats are sorted, by the same key.
  const read = (inbox ?? []).filter((c) => !isUnread(c))
  if (focused && labelId) read.sort((a, b) => b.row.lastMessageAt - a.row.lastMessageAt)

  // The first few unread chats are the likeliest to be opened next: fetched ahead once the list
  // has settled, so going through them is instant (data/chat-content.ts).
  const nextUp = unread
    .filter((c) => c.id !== selectedId)
    .slice(0, WARM_UNREAD)
    .map((c) => c.id)
    .join()
  const unreadRef = useRef(unread)
  unreadRef.current = unread
  useEffect(() => {
    if (!nextUp) return
    const ids = nextUp.split(',')
    const timer = setTimeout(() => {
      // Most likely last, so it's the one kept longest.
      for (const id of [...ids].reverse()) {
        const chat = unreadRef.current.find((c) => c.id === id)
        if (chat) warmChat(chat)
      }
    }, WARM_UNREAD_AFTER_MS)
    return () => clearTimeout(timer)
  }, [nextUp])

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
          ...(open.blocked ? (blocked ?? []) : []),
        ]
      : (inbox ?? [])
  const shownIds = shown.map((c) => c.id as string)
  const loaded = inbox !== undefined && (!focused || (snoozed && requests && archived && blocked))
  shownRef.current = loaded ? shownIds : null
  chatsRef.current = new Map(everything.map((c) => [c.id as string, c]))

  // A view or filter change that hides the open chat closes it rather than opening another:
  // opening a chat marks it read, and nobody asked to read it.
  const filterKey = `${network}|${labelId}|${simpleShow}|${layout}`
  const lastFilterKey = useRef(filterKey)
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
    <>
      <div className="flex h-(--bar-h) shrink-0 items-center gap-1 border-b border-border px-2.5">
        <InputGroup className="flex-1" icon={<Search className="size-4 shrink-0" />}>
          <Input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search chats"
          />
        </InputGroup>
        <Button variant="ghost" size="icon" aria-label="New chat" onClick={onNewChat}>
          <SquarePen className="size-[17px]" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="People"
          // The address book is fetched ahead as the person reaches for it, so it opens full.
          onPointerEnter={warmPeople}
          onFocus={warmPeople}
          onPointerDown={warmPeople}
          onClick={onPeople}
        >
          <Users className="size-[17px]" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Filter chats"
              className={cn(filterActive && 'bg-primary-soft text-primary')}
            >
              <Filter className="size-[17px]" />
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
                    {s.view === 'requests' && counts?.requests.count ? (
                      <DropdownMenuTrail>{badge(counts.requests)}</DropdownMenuTrail>
                    ) : null}
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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
        {/* Shown while searching too: the filters narrow the search, and Clear widens it. */}
        {filterActive ? (
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

        <FailedScheduled rows={failedSends} />
        {inbox === undefined ? (
          // Opened before the server answered (app-gate.tsx): nothing is kept here to show.
          session.offline ? (
            <Empty>Can’t reach your server. Nothing shows until it’s back; still trying.</Empty>
          ) : (
            <ListSkeleton />
          )
        ) : searching ? (
          <>
            <SectionHeader label={searchLabel} count={results.length} />
            {results.length ? results.map((c) => row(c)) : <Empty>No chats match.</Empty>}
            {unloaded.length ? (
              <LoadMore
                list={{ canLoadMore: true, loadMore: () => unloaded.forEach((l) => l.loadMore()) }}
                auto={false}
                label="Search more chats"
              />
            ) : null}
          </>
        ) : !focused ? (
          // A page can hold no rows yet more to come, so only the end of the view is empty.
          inbox.length || main.canLoadMore ? (
            <>
              {inbox.map((c) => row(c))}
              <LoadMore list={main} />
            </>
          ) : (
            <Empty>
              {simpleShow === 'inbox' && !filterActive
                ? 'No chats yet. Connect a network in Settings → Accounts.'
                : 'Nothing here.'}
            </Empty>
          )
        ) : (
          <>
            {/* Shown too when the server counts unread chats not loaded yet: the next page has them. */}
            {unread.length || counts?.inbox.count || counts?.woke.count ? (
              <>
                <SectionHeader
                  label="Unread"
                  count={counts ? badge(counts.inbox) : unread.length}
                  note={counts?.woke.count ? `${badge(counts.woke)} woke` : undefined}
                />
                {unread.map((c) => row(c))}
              </>
            ) : main.canLoadMore ? null : (
              <Empty>
                {everything.length
                  ? 'You’re all caught up.'
                  : 'No chats yet. Connect a network in Settings → Accounts.'}
              </Empty>
            )}
            {/* The inbox's next page can hold unread chats too, so it's offered with Read folded;
                it loads on scroll only at the end of the open Read list. */}
            {!open.read ? <LoadMore list={main} auto={false} /> : null}
            <div className="mt-2 border-t border-border pt-1.5">
              <Divider
                label="Read"
                icon={<Eye />}
                count={read.length}
                more={main}
                open={open.read}
                ready
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
                        {/* With previews off, when it goes, not what it says. */}
                        {formatWhen(s.sendAt)}
                        {prefs.previews ? ` · ${s.body}` : null}
                      </>,
                    )
                  ) : (
                    // Its chat isn't in a loaded view (not scrolled to yet): it still opens it.
                    <Button
                      variant="bare"
                      type="button"
                      key={s._id}
                      onClick={() => onOpenId(s.chatId)}
                      className={cn(
                        'block w-full truncate rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-rail-hover hover:text-foreground',
                        s.chatId === selectedId && 'bg-rail-hover text-foreground',
                      )}
                    >
                      <Clock className="mr-1 inline size-3 align-[-1px]" />
                      {formatWhen(s.sendAt)}
                      {prefs.previews ? ` · ${s.body}` : ' · Scheduled message'}
                    </Button>
                  ),
                )}
              </Divider>
              <Divider
                label="Requests"
                icon={<UserPlus />}
                count={requests?.length ?? 0}
                total={counts?.requests}
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
              <Divider
                label="Blocked"
                icon={<Ban />}
                count={blocked?.length ?? 0}
                more={blockedList}
                open={open.blocked}
                onToggle={() => setOpen((o) => ({ ...o, blocked: !o.blocked }))}
              >
                {blocked?.map((c) => row(c))}
              </Divider>
            </div>
          </>
        )}
      </div>
    </>
  )
}

/**
 * The sidebar's column, with the bottom bar outside the list, so its menus stay open and
 * Settings stays in reach while RetryBoundary retries a list that couldn't load.
 */
export function SidebarFrame({
  bottomBar,
  chatOpen,
  children,
}: {
  bottomBar: ReactNode
  /** A chat is open: on a narrow screen it takes the whole width, and the list steps aside. */
  chatOpen: boolean
  children: ReactNode
}) {
  return (
    // Hidden, not unmounted, behind an open chat on a narrow screen: the shell still reads what
    // the list shows to move on after an archive or snooze.
    <aside
      className={cn(
        'flex w-[332px] shrink-0 flex-col border-r border-border bg-rail max-md:w-full max-md:border-r-0',
        chatOpen && 'max-md:hidden',
      )}
      aria-label="Chats"
    >
      {children}
      <div className="flex h-(--bar-h) shrink-0 items-center gap-1 border-t border-border px-2.5">{bottomBar}</div>
    </aside>
  )
}

/** A badge count from chats.counts: it stops at 99, and `more` says there may be others. */
const badge = (c: { count: number; more: boolean }) => `${c.count}${c.more ? '+' : ''}`

function SectionHeader({ label, count, note }: { label: string; count: number | string; note?: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2 pt-3 pb-1.5 text-xs font-semibold tracking-[0.05em] text-subtle-foreground uppercase">
      {label} <span className="text-primary">{count}</span>
      {note ? <span className="font-medium normal-case">· {note}</span> : null}
    </div>
  )
}

/**
 * A collapsed section, like T3 Code's: label, count and a rule; click to open. Hidden only when
 * the view is empty to its end: a page can hold no rows yet more to come.
 *
 * Its rows stay drawn, out of sight, once it has been opened, and from the start when `ready`,
 * so opening it shows them at once, their pictures already loaded, rather than drawing them then.
 */
function Divider({
  label,
  icon,
  count,
  total,
  more,
  open,
  ready = false,
  onToggle,
  children,
}: {
  label: string
  icon: ReactNode
  count: number
  /** The server's count for the whole view, when it has one, in place of the loaded count. */
  total?: { count: number; more: boolean } | undefined
  /** The view has more chats than are loaded: the count reads "50+" and opening shows Load more. */
  more?: ChatList
  open: boolean
  /** Draw its rows from the start, while it's still folded: for the section opened most. */
  ready?: boolean
  onToggle: () => void
  children: ReactNode
}) {
  const [opened, setOpened] = useState(open)
  if (open && !opened) setOpened(true)
  const drawn = useIdle(ready) || opened
  if (count === 0 && !more?.canLoadMore && !total?.count) return null
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
          {total ? badge(total) : `${count}${more?.canLoadMore ? '+' : ''}`}
        </span>
        <span className="h-px flex-1 bg-border-strong" />
      </Button>
      {drawn ? <div hidden={!open}>{children}</div> : null}
      {open && more ? <LoadMore list={more} /> : null}
    </>
  )
}

/** True once the browser has had a moment free, after `wanted` turns true: work that can wait. */
function useIdle(wanted: boolean) {
  const [idle, setIdle] = useState(false)
  useEffect(() => {
    if (!wanted || idle) return
    // Safari has no requestIdleCallback; a short wait does as well there.
    if ('requestIdleCallback' in window) {
      const handle = window.requestIdleCallback(() => setIdle(true), { timeout: 2_000 })
      return () => window.cancelIdleCallback(handle)
    }
    const timer = setTimeout(() => setIdle(true), 500)
    return () => clearTimeout(timer)
  }, [wanted, idle])
  return idle
}

/**
 * Scheduled messages that failed: their time came after their chat was gone, so they were never
 * sent and their copies are deleted. Shown in either layout until dismissed (scheduled.cancel).
 */
function FailedScheduled({ rows }: { rows: { _id: Id<'scheduledSends'>; sendAt: number }[] }) {
  const { cancelScheduled } = useSendMutations()
  if (!rows.length) return null
  return (
    <div className="mx-0.5 mt-1 mb-2 space-y-1.5 rounded-lg bg-warning-soft p-2.5 text-sm text-warning-ink">
      {rows.map((s) => (
        <div key={s._id} className="flex items-start gap-2">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span className="flex-1">A message scheduled for {formatWhen(s.sendAt)} wasn’t sent: its chat is gone.</span>
          <Button
            size="sm"
            variant="ghost"
            className="-my-1"
            onClick={() =>
              void cancelScheduled({ scheduledId: s._id }).catch((e: unknown) =>
                toast(errorMessage(e, 'That couldn’t be dismissed. Try again.')),
              )
            }
          >
            Dismiss
          </Button>
        </div>
      ))}
    </div>
  )
}

/**
 * Loads the next page of a view as it scrolls near, with the button as a fallback. A page can end
 * early under the server's byte budget, so only the cursor says a view is done, not a short page.
 * `auto` off makes it a button only, where loading on sight could fetch a whole view unseen.
 */
function LoadMore({
  list,
  auto = true,
  label = 'Load more chats',
}: {
  list: Pick<ChatList, 'canLoadMore' | 'loadMore'>
  auto?: boolean
  label?: string
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const loadMore = useRef(list.loadMore)
  loadMore.current = list.loadMore
  useEffect(() => {
    const el = ref.current
    if (!el || !auto) return
    const observer = new IntersectionObserver((entries) => entries[0]?.isIntersecting && loadMore.current(), {
      rootMargin: '200px',
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [list.canLoadMore, auto])
  if (!list.canLoadMore) return null
  return (
    <Button ref={ref} variant="ghost" size="sm" block className="my-1" onClick={list.loadMore}>
      {label}
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
