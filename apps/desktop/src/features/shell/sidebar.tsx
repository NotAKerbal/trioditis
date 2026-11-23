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
  ChevronDown,
  ChevronUp,
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
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import {
  mergedChat,
  membersOf,
  networkName,
  useChatCounts,
  useChat,
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
import { cardIndex, mergeDms, setConversations, setDmChats } from '~/data/conversations.ts'
import { warmChat } from '~/data/chat-content.ts'
import { useSendMutations } from '~/data/messages.ts'
import { usePeople, warmPeople } from '~/data/people.ts'
import { formatWhen } from '~/data/snooze.ts'
import { errorMessage } from '~/lib/errors.ts'
import { ChatRow, type RowActions } from './chat-row.tsx'
import { LabelDot } from './label-dot.tsx'
import { inFilter, viewOf } from './filter-match.ts'
import { searchScope } from './search-scope.ts'
import { countsAsUnread, unreadIncomplete, type Count } from './unread-fill.ts'
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
  /** Counts the changes of what the list is showing (search, open sheet, filters). */
  contextRef: { current: number }
  chatsRef: { current: Map<string, Chat> }
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
  onOpenId,
  onClose,
  onAction,
  onPeople,
  onNewChat,
  shownRef,
  contextRef,
  chatsRef,
}: SidebarProps) {
  const [layout] = useSidebarLayout()
  const session = useSession()
  const prefs = usePrefs()
  const [query, setQuery] = useState('')
  const [network, setNetwork] = useState<Network | undefined>()
  const [labelId, setLabelId] = useState<LabelId | undefined>()
  const [simpleShow, setSimpleShow] = useState<ChatView>('inbox')
  // The section open on Focused's bottom sheet, over the Unread list; one at a time.
  const [sheet, setSheet] = useState<SectionKey | null>(null)
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
  // A person's direct chats on several networks are one row, once their People card links them
  // (conversations.ts). Each view puts its own together: a chat stays in the view it's in.
  const people = usePeople()
  const cards = useMemo(() => cardIndex(people), [people])
  const merge = (list: Chat[] | undefined) => list && mergeDms(list, cards).map((g) => mergedChat(g.members, g.person))
  const inbox = useMemo(() => merge(main.chats), [main.chats, cards])
  const snoozed = useMemo(() => merge(snoozedList.chats), [snoozedList.chats, cards])
  const requests = useMemo(() => merge(requestsList.chats), [requestsList.chats, cards])
  const archived = useMemo(() => merge(archivedList.chats), [archivedList.chats, cards])
  const blocked = useMemo(() => merge(blockedList.chats), [blockedList.chats, cards])
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
  // The open chat's pane shows every chat of its conversation, and acts on them all.
  useEffect(() => {
    setConversations(everything.map((c) => membersOf(c).map((m) => m.id)))
    setDmChats(everything.flatMap(membersOf))
  }, [everything])
  const has = (c: Chat, id: string | undefined) => !!id && membersOf(c).some((m) => m.id === id)
  // Search looks through the chats loaded so far, of the views shown; these are the ones with more.
  const searched = focused ? [main, snoozedList, requestsList, archivedList, blockedList] : [main]
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

  // The open chat as the server has it, for when no loaded page has it: archived from its row
  // into a section whose page with it hasn't loaded yet, say, or opened from a scheduled message.
  // Focused still lists it, under the section it's in.
  const openChat = useChat(selectedId as ChatId | undefined)
  const unlisted =
    focused &&
    openChat &&
    !everything.some((c) => has(c, selectedId)) &&
    inFilter(openChat, { network, labelId, view: null })
      ? openChat
      : undefined

  // Judged chat by chat, by the same rule the fill below and the server's count use.
  const isUnread = (c: Chat) => membersOf(c).some(countsAsUnread) || has(c, openedUnreadId)
  const unread = (inbox ?? []).filter(isUnread)
  if (unlisted && viewOf(unlisted.row) === 'inbox' && isUnread(unlisted)) unread.push(unlisted)
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

  // Unread lists every unread chat with nothing to click: the inbox loads page after page until
  // the server's count of them is met (unread-fill.ts). Counted as the server counts, from what
  // is stored rather than this device's clock (a timed mute is cleared by a write when it ends),
  // and without the chat kept under Unread after opening it, so neither stands in for one still
  // to load.
  const filling =
    focused &&
    inbox !== undefined &&
    unreadIncomplete({
      more: main.canLoadMore || main.loading,
      // Each chat of a merged conversation, as the server counts them apart.
      loadedUnread: inbox.flatMap(membersOf).filter(countsAsUnread).length,
      count: counts?.inbox,
    })
  const loadInbox = useRef(main.loadMore)
  loadInbox.current = main.loadMore
  // A page that lands makes `canLoadMore` true again, which asks for the next while still filling.
  useEffect(() => {
    if (filling && main.canLoadMore) loadInbox.current()
  }, [filling, main.canLoadMore])

  // Scheduled messages, each with its chat (when one of the loaded views has it) and its opened text.
  const scheduled = useMemo(
    () =>
      (scheduledMessages ?? []).map((s) => ({
        ...s,
        chat: everything.find((c) => has(c, s.chatId)),
        body: scheduledTexts.get(s._id) ?? 'Scheduled message',
      })),
    [scheduledMessages, everything, scheduledTexts],
  )

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
  // A scheduled message's row is keyed by it: a conversation can have several.
  const row = (c: Chat, preview?: ReactNode, key?: string) => (
    <ChatRow
      key={key ?? c.id}
      chat={c}
      selected={has(c, selectedId)}
      unread={isUnread(c)}
      preview={preview}
      onOpen={() => onOpen(c)}
      actions={actionsFor(c)}
    />
  )

  // The open chat, when it's in this section, so the section still shows it while folded.
  const keep = (chats: Chat[] | undefined, view: ChatView) => {
    const open =
      chats?.find((c) => has(c, selectedId)) ??
      (unlisted && viewOf(unlisted.row) === view && !(view === 'inbox' && isUnread(unlisted)) ? unlisted : undefined)
    return open ? { id: open.id, row: row(open) } : undefined
  }

  // Focused's other sections, at the foot of the list; each opens as a sheet over Unread.
  const sections: Section[] = [
    {
      key: 'read',
      label: 'Read',
      icon: <Eye />,
      count: tally(read.length, main),
      chats: read,
      more: main,
      content: () => read.map((c) => row(c)),
      kept: keep(read, 'inbox'),
      ready: true,
    },
    {
      key: 'snoozed',
      label: 'Snoozed',
      icon: <AlarmClock />,
      count: tally(snoozed?.length ?? 0, snoozedList),
      chats: snoozed ?? [],
      more: snoozedList,
      content: () => snoozed?.map((c) => row(c)),
      kept: keep(snoozed, 'snoozed'),
    },
    {
      key: 'scheduled',
      label: 'Scheduled',
      icon: <Clock />,
      count: tally(scheduled.length),
      chats: [],
      content: () =>
        scheduled.map((s) =>
          s.chat ? (
            row(
              s.chat,
              <>
                <Clock className="mr-1 inline size-3 align-[-1px]" />
                {/* With previews off, when it goes, not what it says. */}
                {formatWhen(s.sendAt)}
                {prefs.previews ? ` · ${s.body}` : null}
              </>,
              s._id,
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
        ),
    },
    {
      key: 'requests',
      label: 'Requests',
      icon: <UserPlus />,
      count: tally(requests?.length ?? 0, requestsList, counts?.requests),
      chats: requests ?? [],
      more: requestsList,
      content: () => requests?.map((c) => row(c)),
      kept: keep(requests, 'requests'),
    },
    {
      key: 'archived',
      label: 'Archived',
      icon: <Archive />,
      count: tally(archived?.length ?? 0, archivedList),
      chats: archived ?? [],
      more: archivedList,
      content: () => archived?.map((c) => row(c)),
      kept: keep(archived, 'archived'),
    },
    {
      key: 'blocked',
      label: 'Blocked',
      icon: <Ban />,
      count: tally(blocked?.length ?? 0, blockedList),
      chats: blocked ?? [],
      more: blockedList,
      content: () => blocked?.map((c) => row(c)),
      kept: keep(blocked, 'blocked'),
    },
  ]
  const drawer = focused && !searching && inbox !== undefined
  const sheetOpen = drawer && sheet !== null

  // What is on screen, in order: the shell uses it to move on after an archive or snooze. An open
  // sheet covers Unread, so moving on stays in the sheet, and never opens (and reads) a chat
  // hidden behind it.
  const sheetChats = sheetOpen ? sections.find((s) => s.key === sheet)?.chats : undefined
  const shown: Chat[] = searching ? results : focused ? (sheetChats ?? unread) : (inbox ?? [])
  const shownIds = shown.flatMap((c) => membersOf(c).map((m) => m.id as string))
  const loaded = inbox !== undefined && (!focused || (snoozed && requests && archived && blocked))
  shownRef.current = loaded ? shownIds : null
  chatsRef.current = new Map(everything.flatMap((c) => membersOf(c).map((m) => [m.id as string, c] as const)))

  // A view or filter change that hides the open chat closes it rather than opening another:
  // opening a chat marks it read, and nobody asked to read it. Judged from the chats themselves,
  // not from what the lists show, as the chat's page may be one still to come: the open chat as
  // the server has it now (the same subscription the chat pane uses), and the other chats of
  // its conversation as the lists last had them. It stays open, as it is, while any of them still
  // matches. It isn't moved to the chat that matches: the pane would start reading that chat
  // afresh and could mark messages read that were never on screen.
  const filterKey = `${network}|${labelId}|${simpleShow}|${layout}`
  const lastFilterKey = useRef(filterKey)
  // A new revision for each change of what the list shows, so leaving and coming back is a change.
  const context = `${q}|${sheetOpen ? sheet : ''}|${filterKey}`
  const lastContext = useRef(context)
  if (lastContext.current !== context) {
    lastContext.current = context
    contextRef.current += 1
  }
  // The open conversation's chats as of the last render, before a filter change empties the lists.
  const openMembers = useRef<Chat[]>([])
  // The chat open when the filter changed, still to be judged once the server answers; a chat
  // opened after the change was opened under the new filter, and isn't judged.
  const toJudge = useRef<{ id: string; others: Chat[] } | undefined>(undefined)
  useEffect(() => {
    if (lastFilterKey.current !== filterKey) {
      lastFilterKey.current = filterKey
      toJudge.current = selectedId
        ? { id: selectedId, others: openMembers.current.filter((m) => m.id !== selectedId) }
        : undefined
    }
    const judging = toJudge.current
    if (!judging) return
    if (judging.id !== selectedId) {
      toJudge.current = undefined
      return
    }
    if (openChat === undefined) return
    toJudge.current = undefined
    const shows = (c: Chat) => inFilter(c, { network, labelId, view: focused ? null : simpleShow })
    if (openChat && !shows(openChat) && !judging.others.some(shows)) onClose()
  })
  useEffect(() => {
    const open = selectedId ? everything.find((c) => has(c, selectedId)) : undefined
    if (open) openMembers.current = membersOf(open)
    else if (!openMembers.current.some((m) => m.id === selectedId)) openMembers.current = []
  })

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
            onChange={(e) => {
              setQuery(e.target.value)
              // Search takes the sheet's place, and clearing it comes back to Unread, with the
              // focus still in the search field.
              if (e.target.value.trim()) setSheet(null)
            }}
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

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div data-autoload-root className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3" inert={sheetOpen}>
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
              {results.map((c) => row(c))}
              {/* Search looks through what's loaded, so the views searched load on while the end
                  of the results is in sight: with few matches, that's to their ends. */}
              <AutoLoad lists={searched} />
              {!results.length && searchedAll ? <Empty>No chats match.</Empty> : null}
            </>
          ) : !focused ? (
            // A page can hold no rows yet more to come, so only the end of the view is empty.
            inbox.length || main.canLoadMore || main.loading ? (
              <>
                {inbox.map((c) => row(c))}
                <AutoLoad lists={[main]} />
              </>
            ) : (
              <Empty>
                {simpleShow === 'inbox' && !filterActive
                  ? 'No chats yet. Connect a network in Settings → Accounts.'
                  : 'Nothing here.'}
              </Empty>
            )
          ) : unread.length || counts?.inbox.count || counts?.woke.count ? (
            // Shown too when the server counts unread chats not loaded yet: they're on their way.
            <>
              <SectionHeader
                label="Unread"
                count={counts ? badge(counts.inbox) : unread.length}
                note={counts?.woke.count ? `${badge(counts.woke)} woke` : undefined}
              />
              {unread.map((c) => row(c))}
              {filling ? <ListSkeleton rows={unread.length ? 1 : 3} /> : null}
            </>
          ) : filling ? (
            <ListSkeleton />
          ) : (
            <Empty>
              {everything.length ? 'You’re all caught up.' : 'No chats yet. Connect a network in Settings → Accounts.'}
            </Empty>
          )}
        </div>
        {drawer ? (
          <Drawer
            sections={sections}
            open={sheet}
            onOpen={setSheet}
            onFocusLost={() => searchRef.current?.focus({ preventScroll: true })}
          />
        ) : null}
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

type SectionKey = 'read' | 'snoozed' | 'scheduled' | 'requests' | 'archived' | 'blocked'

/** One of Focused's sections under Unread. */
interface Section {
  key: SectionKey
  label: string
  icon: ReactNode
  /** What its row says, "50+" while more are to load; null hides an empty section. */
  count: string | null
  /** Its chats, in order, as the sheet shows them; none for Scheduled, which lists messages. */
  chats: Chat[]
  /** The view it pages through, loaded on as the sheet scrolls. */
  more?: ChatList
  /** Its rows, rendered only while it's on the sheet. */
  content: () => ReactNode
  /**
   * The open chat's row, when the chat is in this section: shown under the section's row while
   * the section is folded, so opening a chat from the sheet and closing the sheet doesn't hide it.
   */
  kept?: { id: string; row: ReactNode }
  /**
   * Its rows drawn ahead, out of sight, once the browser is idle: for the section opened most,
   * so its sheet slides up with the rows and their pictures already there.
   */
  ready?: boolean
}

/**
 * A section's count as its row shows it, or null to hide the row: only when the view is empty
 * to its end, since a page can hold no rows yet more to come. `total` is the server's count for
 * the whole view, when it has one, in place of the loaded count.
 */
function tally(count: number, more?: ChatList, total?: Count): string | null {
  const pending = !!more && (more.canLoadMore || more.loading)
  if (count === 0 && !pending && !total?.count) return null
  return total ? badge(total) : `${count}${pending ? '+' : ''}`
}

const SHEET_MS = 300

/** How many of the first unread chats are fetched ahead, and how long after the list settles. */
const WARM_UNREAD = 3
const WARM_UNREAD_AFTER_MS = 1_500

/**
 * Focused's other sections, as rows at the foot of the list, so Unread has the room. A row
 * opens its section as a sheet that slides up over Unread, like T3 Code's; its header, or
 * Escape, slides it back down. One section at a time.
 */
function Drawer({
  sections,
  open,
  onOpen,
  onFocusLost,
}: {
  sections: Section[]
  open: SectionKey | null
  onOpen: (key: SectionKey | null) => void
  /** Closing left no row to focus: every section emptied while the sheet was open. */
  onFocusLost: () => void
}) {
  // The section on the sheet: kept while it slides away, so it doesn't empty mid-motion, then
  // dropped, so a closed sheet loads nothing.
  const [onSheet, setOnSheet] = useState(open)
  if (open && open !== onSheet) setOnSheet(open)
  useEffect(() => {
    if (open) return
    const timer = setTimeout(() => setOnSheet(null), SHEET_MS + 100)
    return () => clearTimeout(timer)
  }, [open])

  // Focus goes with the sheet: to its header when it opens, back to its row when it closes.
  const headRef = useRef<HTMLButtonElement>(null)
  const rowRefs = useRef(new Map<SectionKey, HTMLButtonElement>())
  const footRef = useRef<HTMLDivElement>(null)
  const wasOpen = useRef(open)
  useEffect(() => {
    if (open) headRef.current?.focus({ preventScroll: true })
    // Its own row, or the first one left if its section emptied while open, or else Search.
    else if (wasOpen.current) {
      const row = rowRefs.current.get(wasOpen.current) ?? rowRefs.current.values().next().value
      if (row) row.focus({ preventScroll: true })
      else onFocusLost()
    }
    wasOpen.current = open
  }, [open])

  const rows = sections.filter((s) => s.count !== null)
  // The open chat's row sits under its section's row, which may be at the edge of a short
  // footer: scrolled into the footer's view as the sheet closes, and when the row comes or
  // changes while it's closed (the chat's own copy, or its section's first page, arriving late),
  // so nothing hides it. Keyed by the rows the footer draws, not the sections it may draw.
  const keptKey = rows.map((s) => (s.kept ? `${s.key}:${s.kept.id}` : '')).join()
  useEffect(() => {
    const foot = footRef.current
    const kept = foot?.querySelector('[data-kept]')
    if (open || !foot || !kept) return
    const f = foot.getBoundingClientRect()
    const k = kept.getBoundingClientRect()
    if (k.bottom > f.bottom) foot.scrollTop += k.bottom - f.bottom
    else if (k.top < f.top) foot.scrollTop -= f.top - k.top
  }, [open, keptKey])

  const current = sections.find((s) => s.key === onSheet)
  const idle = useIdle(sections.some((s) => s.ready))
  return (
    <>
      {idle
        ? sections
            .filter((s) => s.ready && s.key !== onSheet && s.count !== null)
            .map((s) => (
              <div key={s.key} hidden>
                {s.content()}
              </div>
            ))
        : null}
      {rows.length ? (
        // At most half the column, scrolling past that, so Unread keeps room in a short window.
        <div
          ref={footRef}
          className="max-h-[50%] shrink-0 overflow-y-auto border-t border-border px-2 py-1"
          inert={open !== null}
        >
          {rows.map((s) => (
            <Fragment key={s.key}>
              <SectionRow
                ref={(el) => {
                  if (el) rowRefs.current.set(s.key, el)
                  else rowRefs.current.delete(s.key)
                }}
                section={s}
                onClick={() => onOpen(s.key)}
              />
              {s.kept ? <div data-kept>{s.kept.row}</div> : null}
            </Fragment>
          ))}
        </div>
      ) : null}
      <div
        role="region"
        aria-label={current?.label}
        inert={open === null}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return
          e.stopPropagation()
          onOpen(null)
        }}
        style={{ transitionDuration: `${SHEET_MS}ms` }}
        className={cn(
          'absolute inset-0 z-10 flex flex-col border-t border-border bg-rail transition-transform ease-(--ease-out) motion-reduce:transition-none',
          open ? 'translate-y-0' : 'translate-y-full',
        )}
      >
        {current ? (
          <>
            <div className="shrink-0 px-2 pt-1">
              <SectionRow ref={headRef} section={current} open onClick={() => onOpen(null)} />
            </div>
            <div data-autoload-root className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {current.content()}
              {/* Rows stay while the sheet slides away, but loading stops as it closes. */}
              {current.more ? <AutoLoad lists={open ? [current.more] : []} /> : null}
              {current.count === null ? <Empty>Nothing here.</Empty> : null}
            </div>
          </>
        ) : null}
      </div>
    </>
  )
}

/** A section's row: label, count and a rule, with the way it slides. */
function SectionRow({
  section,
  open = false,
  onClick,
  ref,
}: {
  section: Section
  open?: boolean
  onClick: () => void
  ref?: Ref<HTMLButtonElement>
}) {
  const Chevron = open ? ChevronDown : ChevronUp
  return (
    <Button
      ref={ref}
      variant="bare"
      type="button"
      aria-expanded={open}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-base font-semibold text-muted-foreground hover:bg-rail-hover hover:text-foreground"
    >
      <Chevron className="size-3.5 text-subtle-foreground" />
      <span className="text-subtle-foreground [&_svg]:size-3.5">{section.icon}</span>
      {section.label}
      <span className="text-sm font-medium text-subtle-foreground">{section.count ?? 0}</span>
      <span className="h-px flex-1 bg-border-strong" />
    </Button>
  )
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
 * Loads each list's next page while the end of what's shown is in sight, one page after
 * another, so a list fills itself as it scrolls, with nothing to click. A page can end early
 * under the server's byte budget, so only the cursor says a view is done, not a short page.
 */
function AutoLoad({ lists }: { lists: Pick<ChatList, 'canLoadMore' | 'loading' | 'loadMore'>[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const [inSight, setInSight] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Watched against the list's own scroller, so the next page is asked for a screen early.
    const observer = new IntersectionObserver((entries) => setInSight(entries.at(-1)?.isIntersecting ?? false), {
      root: el.closest('[data-autoload-root]'),
      rootMargin: '0px 0px 400px 0px',
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const latest = useRef(lists)
  latest.current = lists
  // A page landing while the end is still in sight makes its list ready again: on to the next.
  const ready = lists.map((l) => (l.canLoadMore ? 1 : 0)).join('')
  useEffect(() => {
    if (inSight) for (const l of latest.current) if (l.canLoadMore) l.loadMore()
  }, [inSight, ready])
  return <div ref={ref}>{lists.some((l) => l.loading) ? <ListSkeleton rows={2} /> : null}</div>
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-3 py-8 text-center text-sm text-subtle-foreground">{children}</p>
}

function ListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading chats" className="space-y-1 pt-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-2.5 py-2">
          <span className="size-10 rounded-full bg-rail-hover" />
          <span className="h-3 flex-1 rounded bg-rail-hover" />
        </div>
      ))}
    </div>
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
