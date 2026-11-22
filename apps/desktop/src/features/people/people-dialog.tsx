import {
  cardFromContacts,
  cardTitle,
  contactKey,
  groupUnlinked,
  linkChange,
  linkIndex,
  moveLinks,
  parseContactsFile,
  parseIdentifier,
  suggestLinks,
  toVCards,
  withLinks,
  withoutLinkChange,
  withoutLinks,
  type LinkChange,
  type LinkSuggestion,
  type MatchReason,
  type NetworkContact,
  type Person,
  type PersonField,
  type PersonPlaintext,
} from '@trioditis/core'
import { Avatar } from '@trioditis/ui/avatar'
import { Button } from '@trioditis/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@trioditis/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@trioditis/ui/dropdown-menu'
import { Input, InputGroup } from '@trioditis/ui/input'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { Textarea } from '@trioditis/ui/textarea'
import { toast } from '@trioditis/ui/toast'
import { cn } from '@trioditis/ui/lib/utils'
import {
  ArrowLeft,
  Check,
  Contact,
  Download,
  Link2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Id } from '@trioditis/backend/dataModel'
import { networkName } from '~/data/chats.ts'
import { chatOptions, useStartableAccounts, useStartChat } from '~/data/new-chat.ts'
import {
  contactsByKey,
  download,
  fitCard,
  importPlanner,
  PartlySaved,
  shrinkPhoto,
  useNetworkContacts,
  usePeople,
  usePeopleActions,
  useSyncContacts,
  Stale,
  TooLarge,
  type Change,
  type StoredPerson,
} from '~/data/people.ts'
import { fromHandleField, toHandleField, type HandleField } from '~/features/people/handles.ts'
import { emptyReport, importSummary, partlyImported } from '~/features/people/import-report.ts'
import { usePage } from '~/features/people/paging.ts'
import { fetchGooglePhotos, GoogleRefused, readGoogleContacts, useGoogleClientId } from '~/data/google-contacts.ts'
import { canSignInToGoogle, GoogleSignInError, googleSignInProblem, signInToGoogle } from '~/lib/google-sign-in.ts'
import { rowMatches, shownIdentifier, unsortedRow } from '~/features/people/unsorted.ts'
import { Group } from '~/features/settings/layout.tsx'
import { failedAhead } from '~/data/fetched-ahead.ts'
import { LoadError, RetryBoundary } from '~/features/shell/retry-boundary.tsx'
import { SyncBar, useConnected } from '~/features/shell/sync-bar.tsx'
import { useSession } from '~/lib/session.tsx'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { newClientId } from '~/lib/sealed.ts'

/**
 * What the People window shows on the right: nothing chosen, a card, a new card, the suggested
 * links, or the network contacts on no card. Kept in the URL with the window open.
 */
export type PeopleView = 'all' | 'new' | 'suggested' | 'unsorted' | `p:${string}`

export const isPeopleView = (value: unknown): value is PeopleView =>
  typeof value === 'string' &&
  (['all', 'new', 'suggested', 'unsorted'].includes(value) || /^p:[\w-]{16,64}$/.test(value))

const REASON: Record<MatchReason, string> = {
  phone: 'Same number',
  email: 'Same email',
  username: 'Same username',
  name: 'Same name',
}

/** The People window: the person's address book, and how it links their contacts on each network. */
export function PeopleDialog({
  view,
  onViewChange,
  onOpenChat,
}: {
  view: PeopleView | undefined
  onViewChange: (view: PeopleView | undefined) => void
  /** Opens a chat a card started, closing the window. */
  onOpenChat: (chatId: Id<'chats'>) => void
}) {
  const session = useSession()
  return (
    <Dialog open={!!view} onOpenChange={(open) => !open && onViewChange(undefined)}>
      <DialogContent className="flex h-[660px] w-[min(980px,calc(100vw-32px))]" aria-describedby={undefined}>
        {/* A page of the address book the server couldn't answer takes down only this window,
            which then tries again, asking afresh (usePages), rather than the whole app. */}
        {view ? (
          <RetryBoundary
            offline={session.offline}
            fallback={(say, retry) => (
              <div className="flex min-w-0 flex-1 flex-col">
                <DialogTitle className="sr-only">People</DialogTitle>
                <LoadError say={say('Couldn’t load your people.')} onRetry={retry} />
              </div>
            )}
          >
            {(attempt) => <People view={view} retries={attempt} onViewChange={onViewChange} onOpenChat={onOpenChat} />}
          </RetryBoundary>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function matches(card: PersonPlaintext, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const digits = q.replace(/\D/g, '')
  const text = [cardTitle(card), card.nickname, card.org, ...(card.emails ?? []).map((e) => e.value)]
  const handles = (card.handles ?? []).map((h) => h.value)
  return (
    [...text, ...handles].some((t) => t?.toLowerCase().includes(q)) ||
    (digits.length >= 3 && (card.phones ?? []).some((p) => p.value.replace(/\D/g, '').includes(digits)))
  )
}

function People({
  view,
  retries,
  onViewChange,
  onOpenChat,
}: {
  view: PeopleView
  /** Retries so far after a page couldn't load (RetryBoundary): each asks afresh. */
  retries: number
  onViewChange: (view: PeopleView | undefined) => void
  onOpenChat: (chatId: Id<'chats'>) => void
}) {
  // From the cache, so the window opens full; afresh on a retry, or when fetching ahead failed
  // (data/fetched-ahead.ts), past the failed page the cache keeps.
  const [failedBefore] = useState(() => failedAhead('people'))
  const from = retries > 0 || failedBefore ? 'fresh' : 'cached'
  const people = usePeople(from)
  const contacts = useNetworkContacts(from)
  const actions = usePeopleActions(people)
  const syncContacts = useSyncContacts()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [googleGuide, setGoogleGuide] = useState(false)
  const googleClientId = useGoogleClientId()
  const fileRef = useRef<HTMLInputElement>(null)

  const sorted = useMemo(
    () =>
      [...(people ?? [])].sort((a, b) =>
        cardTitle(a.card).localeCompare(cardTitle(b.card), undefined, { sensitivity: 'base' }),
      ),
    [people],
  )
  const shown = useMemo(() => sorted.filter((p) => matches(p.card, query)), [sorted, query])
  const suggestions = useMemo(() => (people && contacts ? suggestLinks(people, contacts) : []), [people, contacts])
  // A contact with a suggested card is left out here, so it isn't made a second card instead.
  const unsorted = useMemo(() => {
    if (!people || !contacts) return []
    const suggested = new Set(suggestions.map((s) => contactKey(s.contact)))
    return groupUnlinked(
      people,
      contacts.filter((c) => !suggested.has(contactKey(c))),
    )
  }, [people, contacts, suggestions])
  const byContact = useMemo(() => contactsByKey(contacts), [contacts])
  const selected = view.startsWith('p:') ? sorted.find((p) => `p:${p.personKey}` === view) : undefined
  // The list shows once the cards and the contacts are both here: the rows for suggested links
  // and contacts not in People come from the two together, and would push the list down after.
  const listed = !!people && !!contacts
  const connected = useConnected()

  /** Runs a write, saying so if it fails. True once it's saved. */
  async function attempt(write: () => Promise<unknown>, failure: string) {
    try {
      await write()
      return true
    } catch (err) {
      if (sessionChanged(err)) window.location.reload()
      else if (err instanceof PartlySaved) {
        toast(
          `Saved ${err.written.toLocaleString()} of ${err.total.toLocaleString()} before it stopped: ` +
            errorMessage(err.reason, failure),
        )
      } else toast(err instanceof Stale || err instanceof TooLarge ? err.message : errorMessage(err, failure))
      return false
    }
  }
  const run = (change: Change, failure: string) => attempt(() => actions.apply(change), failure)
  const link = (personKey: string, linked: NetworkContact[]) =>
    run((fresh) => moveLinks(fresh, personKey, linked), 'That couldn’t be linked.')

  /**
   * Links suggested contacts to a card. Unlike `link`, it never moves one off another card: a
   * contact linked elsewhere since it was suggested stops it, so a suggestion can't undo another
   * choice. Once saved, gives back the contacts it linked, and what takes them off again.
   */
  async function linkSuggested(personKey: string, linked: NetworkContact[]): Promise<Linked | undefined> {
    let change: LinkChange | undefined
    const saved = await run((fresh) => {
      const before = fresh.find((p) => p.personKey === personKey)
      if (!before) throw new Stale('This person was deleted on another device.')
      const on = linkIndex(fresh)
      if (linked.some((c) => (on.get(contactKey(c)) ?? personKey) !== personKey)) {
        throw new Stale('That account was linked to someone else meanwhile.')
      }
      const after = withLinks(
        before.card,
        linked.filter((c) => !on.has(contactKey(c))),
      )
      // Worked out on each attempt, so it matches what was finally saved.
      change = linkChange(before.card, after)
      return change.links.length ? [{ personKey, card: after }] : []
    }, 'That couldn’t be linked.')
    const done = change
    if (!saved || !done) return undefined
    return {
      contacts: new Set(done.links.map(contactKey)),
      undo: async () => {
        let stale = false
        const saved = await run((fresh) => {
          const now = fresh.find((p) => p.personKey === personKey)
          const on = new Set((now?.card.links ?? []).map(contactKey))
          stale = !now || !done.links.every((l) => on.has(contactKey(l)))
          return now && !stale ? [{ personKey, card: withoutLinkChange(now.card, done) }] : []
        }, 'That couldn’t be undone.')
        if (!saved) return 'failed'
        if (stale) toast('That link was changed on another device, so it wasn’t undone.')
        return stale ? 'stale' : 'done'
      },
    }
  }

  async function sync() {
    const asked = await attempt(async () => {
      const n = await syncContacts.run()
      toast(n ? 'Contacts are on their way.' : 'Contacts were asked for a moment ago.')
    }, 'Contacts couldn’t be asked for.')
    return asked
  }

  /**
   * Saves cards read from a file or from Google. Everything the import has to change to save a
   * card is counted, and said at the end. `read` gives the cards, and how many photos it
   * already couldn't read.
   */
  async function importCards(
    read: () => Promise<{ cards: PersonPlaintext[]; unreadablePhotos?: number }>,
    empty: string,
  ) {
    setBusy(true)
    const failure = 'Those contacts couldn’t be imported.'
    try {
      const { cards, unreadablePhotos = 0 } = await read()
      if (!cards.length) return toast(empty)
      const report = emptyReport()
      report.unreadablePhotos = unreadablePhotos
      const ready: PersonPlaintext[] = []
      for (const card of cards) {
        if (card.photo) {
          const small = await shrinkPhoto(card.photo)
          if (small) card.photo = small
          else {
            delete card.photo
            report.unreadablePhotos++
          }
        }
        const fit = await fitCard(card, shrinkPhoto, { cutNote: true, dropPhoto: true })
        if (fit.photo === 'smaller') report.smallerPhotos++
        if (fit.photo === 'dropped') report.droppedPhotos++
        if (fit.noteCut) report.cutNotes.push(cardTitle(card))
        // One that still doesn't fit stops the import in saveMany, before anything is saved.
        ready.push(fit.card)
      }
      const planner = importPlanner(ready)
      // The planner tracks what's written by entry: a card written once can be where a later
      // entry belongs after another device's change, so it isn't left out of later plans.
      report.written = await actions.saveMany(planner.plan, planner.written, { skipWritten: false })
      report.notImported = planner.unwritten().map(cardTitle)
      report.ambiguous = planner.ambiguous().map(cardTitle)
      report.unchanged = !report.written && !report.ambiguous.length && !report.notImported.length
      toast(importSummary(report))
      onViewChange('suggested')
    } catch (err) {
      if (sessionChanged(err)) window.location.reload()
      else if (err instanceof PartlySaved)
        toast(partlyImported(err.written, err.total, errorMessage(err.reason, failure)))
      else if (err instanceof GoogleRefused) toast(err.message)
      else toast(err instanceof TooLarge ? `${err.message} Nothing was imported.` : errorMessage(err, failure))
    } finally {
      setBusy(false)
    }
  }

  const importFile = (file: File) =>
    importCards(async () => ({ cards: parseContactsFile(await file.text()) }), 'No contacts were found in that file.')

  /**
   * Reads the person's contacts straight from Google, where an admin has set it up; otherwise
   * says how to export them to a file. Signing in starts here, in the click, so the browser
   * lets its window open.
   */
  function importGoogle() {
    if (!googleClientId || !canSignInToGoogle()) return setGoogleGuide(true)
    signInToGoogle(googleClientId).then(
      (token) =>
        void importCards(async () => {
          const cards = await readGoogleContacts(token)
          return { cards, unreadablePhotos: await fetchGooglePhotos(cards) }
        }, 'There are no contacts in that Google account.'),
      (err: unknown) => {
        if (err instanceof GoogleSignInError && err.code === 'unavailable') return setGoogleGuide(true)
        const problem = googleSignInProblem(err)
        if (problem) toast(problem)
      },
    )
  }

  async function remove(person: StoredPerson) {
    try {
      await actions.remove([person.personKey])
      onViewChange('all')
      toast(`Deleted ${cardTitle(person.card)}`, {
        label: 'Undo',
        // Put back without any contact linked to another card since.
        onClick: () =>
          void run((fresh) => {
            const linked = linkIndex(fresh)
            const links = (person.card.links ?? []).filter((l) => !linked.has(contactKey(l)))
            return [{ personKey: person.personKey, card: { ...person.card, links } }]
          }, 'It couldn’t be put back.'),
      })
    } catch (err) {
      toast(errorMessage(err, 'That person couldn’t be deleted.'))
    }
  }

  // A narrow window shows the list or what's chosen from it, not both side by side: beside a
  // 300px list there's no room left for a form.
  const listOnly = view === 'all'
  return (
    <>
      <div
        className={cn(
          'w-full shrink-0 flex-col border-border bg-rail md:flex md:w-[300px] md:border-r',
          listOnly ? 'flex' : 'hidden',
        )}
      >
        <DialogTitle className="sr-only">People</DialogTitle>
        {/* On a narrow window the list is full width, under the window's close button. */}
        <div className="relative flex h-14 shrink-0 items-center gap-1 border-b border-border pr-14 pl-2.5 md:px-2.5">
          <InputGroup className="flex-1" icon={<Search className="size-4 shrink-0" />}>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search people"
            />
          </InputGroup>
          <Button variant="ghost" size="icon" aria-label="New person" onClick={() => onViewChange('new')}>
            <Plus className="size-[18px]" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More" disabled={busy || !people}>
                <MoreHorizontal className="size-[18px]" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => fileRef.current?.click()}>
                <Upload /> Import contacts…
              </DropdownMenuItem>
              <DropdownMenuItem disabled={googleClientId === undefined} onSelect={importGoogle}>
                <Contact /> Import from Google…
              </DropdownMenuItem>
              {syncContacts.available ? (
                <DropdownMenuItem onSelect={() => void sync()}>
                  <RefreshCw /> Sync phone numbers
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                disabled={!people?.length}
                onSelect={() => download(toVCards(sorted.map((p) => p.card)), 'people.vcf', 'text/vcard')}
              >
                <Download /> Export all
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Input
            ref={fileRef}
            type="file"
            accept=".vcf,.vcard,.csv,text/vcard,text/x-vcard,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              e.target.value = ''
              if (file) void importFile(file)
            }}
          />
          <SyncBar active={!listed || !connected} offline={!connected} />
          <GoogleGuide
            open={googleGuide}
            onOpenChange={setGoogleGuide}
            onChooseFile={() => {
              setGoogleGuide(false)
              fileRef.current?.click()
            }}
          />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="People" aria-busy={busy || !listed}>
          {!listed ? (
            <PeopleSkeleton />
          ) : suggestions.length && !query ? (
            <NavRow
              icon={<Link2 />}
              active={view === 'suggested'}
              onClick={() => onViewChange('suggested')}
              trail={suggestions.length}
            >
              Suggested links
            </NavRow>
          ) : null}
          {unsorted.length && !query ? (
            <NavRow
              icon={<Users />}
              active={view === 'unsorted'}
              onClick={() => onViewChange('unsorted')}
              trail={unsorted.length}
            >
              Not in People
            </NavRow>
          ) : null}
          {!listed ? null : shown.length ? (
            shown.map((p) => (
              <Button
                variant="bare"
                key={p.personKey}
                type="button"
                aria-current={view === `p:${p.personKey}` ? 'page' : undefined}
                onClick={() => onViewChange(`p:${p.personKey}`)}
                className={cn(
                  'flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-left [content-visibility:auto] [contain-intrinsic-size:auto_44px] hover:bg-rail-hover',
                  view === `p:${p.personKey}` && 'bg-surface shadow-[0_0_0_1px_var(--border)]',
                )}
              >
                <Avatar name={cardTitle(p.card)} src={p.card.photo} size={28} />
                <span className="min-w-0 flex-1 truncate font-medium">{cardTitle(p.card)}</span>
              </Button>
            ))
          ) : (
            <p className="px-2 py-2 text-sm text-muted-foreground">{query ? 'No one matches.' : 'No people yet.'}</p>
          )}
        </nav>
      </div>
      <div
        className={cn('relative min-w-0 flex-1 overflow-y-auto px-4 pt-14 pb-7 md:block md:px-7', listOnly && 'hidden')}
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label="All people"
          className="absolute top-4 left-2 md:hidden"
          onClick={() => onViewChange('all')}
        >
          <ArrowLeft className="size-[18px]" />
        </Button>
        {view === 'new' ? (
          <PersonForm
            card={{ name: query.trim() }}
            onCancel={() => onViewChange('all')}
            onSave={async (card) => {
              const personKey = newClientId()
              if (await run(() => [{ personKey, card }], 'That person couldn’t be saved.'))
                onViewChange(`p:${personKey}`)
            }}
          />
        ) : view === 'suggested' ? (
          <Suggestions suggestions={suggestions} people={people ?? []} onLink={linkSuggested} />
        ) : view === 'unsorted' ? (
          <Unsorted
            groups={unsorted}
            people={sorted}
            onCreate={(groups) =>
              attempt(
                () =>
                  // Worked out again from the latest cards: a contact linked elsewhere meanwhile stays there.
                  actions.saveMany((fresh) => {
                    const linked = linkIndex(fresh)
                    return groups.flatMap((g) => {
                      const free = g.filter((c) => !linked.has(contactKey(c)))
                      return free.length ? [{ personKey: newClientId(), card: cardFromContacts(free) }] : []
                    })
                  }),
                'Those people couldn’t be added.',
              )
            }
            onLink={link}
          />
        ) : selected ? (
          <PersonDetail
            key={selected.personKey}
            person={selected}
            byContact={byContact}
            contacts={contacts ?? []}
            suggestions={suggestions.filter((s) => s.personKey === selected.personKey)}
            onChange={run}
            onLink={(linked) => link(selected.personKey, linked)}
            onDelete={() => void remove(selected)}
            onOpenChat={onOpenChat}
          />
        ) : view.startsWith('p:') && people ? (
          <p className="text-sm text-muted-foreground">That person isn’t here any more.</p>
        ) : null}
      </div>
    </>
  )
}

function NavRow({
  icon,
  active,
  onClick,
  trail,
  children,
}: {
  icon: ReactNode
  active: boolean
  onClick: () => void
  trail: number
  children: ReactNode
}) {
  return (
    <Button
      variant="bare"
      type="button"
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left font-medium text-muted-foreground hover:bg-rail-hover hover:text-foreground [&_svg]:size-4',
        active && 'bg-surface font-semibold text-foreground shadow-[0_0_0_1px_var(--border)]',
      )}
    >
      {icon}
      <span className="flex-1">{children}</span>
      <span className="text-xs text-subtle-foreground">{trail.toLocaleString()}</span>
    </Button>
  )
}

/** A network contact on one line: where, who, and what the network knows them by. */
export function ContactLine({ contact, children }: { contact: NetworkContact; children?: ReactNode }) {
  const name = contact.profile.name || contact.profile.handle || 'Unknown'
  const handle =
    contact.profile.handle && contact.profile.handle !== name ? shownIdentifier(contact.profile.handle) : ''
  return (
    <div className="flex min-h-[52px] items-center gap-3 px-4 py-2">
      <NetworkBadge network={contact.network} label={networkName(contact.network)} size={18} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{name}</div>
        {handle ? <div className="truncate text-sm text-muted-foreground">{handle}</div> : null}
      </div>
      {children}
    </div>
  )
}

/** An identifier as people write it: a number or address without its scheme, a username with @. */
function PersonDetail({
  person,
  byContact,
  contacts,
  suggestions,
  onChange,
  onLink,
  onDelete,
  onOpenChat,
}: {
  person: StoredPerson
  byContact: Map<string, NetworkContact>
  contacts: readonly NetworkContact[]
  suggestions: LinkSuggestion[]
  onChange: (change: Change, failure: string) => Promise<boolean>
  onLink: (contacts: NetworkContact[]) => Promise<boolean>
  onDelete: () => void
  onOpenChat: (chatId: Id<'chats'>) => void
}) {
  // The card as it was when editing began: saving checks nothing has changed it since.
  const [editing, setEditing] = useState<StoredPerson | null>(null)
  const [choosing, setChoosing] = useState(false)
  // The suggestions being linked: each moves up into the card's accounts once saved.
  const [linking, setLinking] = useState<ReadonlySet<string>>(new Set())
  const { card, personKey } = person
  if (editing) {
    return (
      <PersonForm
        card={editing.card}
        onCancel={() => setEditing(null)}
        onSave={async (next) => {
          const saved = await onChange((fresh) => {
            const now = fresh.find((p) => p.personKey === personKey)
            if (!now) throw new Stale('This person was deleted on another device.')
            if (now.updatedAt !== editing.updatedAt) {
              throw new Stale('This person changed on another device. Cancel to see the change, then edit again.')
            }
            return [{ personKey, card: next }]
          }, 'That person couldn’t be saved.')
          if (saved) setEditing(null)
        }}
      />
    )
  }
  const links = card.links ?? []
  const subtitle = [card.title, card.org].filter(Boolean).join(', ')
  return (
    <div>
      <div className="mb-7 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Avatar name={cardTitle(card)} src={card.photo} size={56} />
        <div className="min-w-[8rem] flex-1">
          <h2 className="truncate text-lg font-bold tracking-[-0.015em]">{cardTitle(card)}</h2>
          {subtitle ? <div className="truncate text-sm text-muted-foreground">{subtitle}</div> : null}
        </div>
        <MessageButton card={card} byContact={byContact} onOpenChat={onOpenChat} />
        <Button size="sm" onClick={() => setEditing(person)}>
          <Pencil className="size-3.5" /> Edit
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="More">
              <MoreHorizontal className="size-[18px]" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onDelete} className="text-danger">
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <FieldGroup title="Phone" fields={card.phones} />
      <FieldGroup title="Email" fields={card.emails} />
      <FieldGroup title="Usernames" fields={card.handles?.map((h) => ({ ...h, value: shownHandle(h.value) }))} />
      <Group
        title="Accounts"
        action={
          <Button size="sm" variant="ghost" onClick={() => setChoosing(true)}>
            <Plus className="size-3.5" /> Link
          </Button>
        }
      >
        {links.map((link) => {
          const contact = byContact.get(contactKey(link))
          return contact ? (
            <ContactLine key={contactKey(link)} contact={contact}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Unlink ${networkName(link.network)}`}
                onClick={() =>
                  void onChange((fresh) => {
                    const now = fresh.find((p) => p.personKey === personKey)
                    return now ? [{ personKey, card: withoutLinks(now.card, [link]) }] : []
                  }, 'That couldn’t be unlinked.')
                }
              >
                <X className="size-4" />
              </Button>
            </ContactLine>
          ) : null
        })}
        {suggestions.map((s) => (
          <ContactLine key={contactKey(s.contact)} contact={s.contact}>
            <span className="text-sm text-subtle-foreground">{REASON[s.reason]}</span>
            <Button
              size="sm"
              loading={linking.has(contactKey(s.contact))}
              onClick={() => {
                const key = contactKey(s.contact)
                setLinking((now) => new Set(now).add(key))
                void onLink([s.contact]).finally(() => setLinking((now) => new Set([...now].filter((k) => k !== key))))
              }}
            >
              Link
            </Button>
          </ContactLine>
        ))}
      </Group>
      <Details card={card} />
      <ChooseContact
        open={choosing}
        onOpenChange={setChoosing}
        contacts={contacts.filter((c) => !links.some((l) => contactKey(l) === contactKey(c)))}
        onChoose={(contact) => {
          setChoosing(false)
          void onLink([contact])
        }}
      />
    </div>
  )
}

/** Starts a chat with the person, on one of the ways their card offers (chatOptions). */
export function MessageButton({
  card,
  byContact,
  onOpenChat,
}: {
  card: PersonPlaintext
  byContact: Map<string, NetworkContact>
  onOpenChat: (chatId: Id<'chats'>) => void
}) {
  const accounts = useStartableAccounts()
  const start = useStartChat(onOpenChat)
  const options = chatOptions(card, accounts, byContact)
  useEffect(() => {
    if (start.error) toast(start.error)
  }, [start.error])
  if (!options.length) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="primary" loading={start.busy}>
          <MessageSquare className="size-3.5" /> Message
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((o, i) => (
          <DropdownMenuItem key={i} onSelect={() => void start.begin(o.network, o.networkAccountId, o.target)}>
            <NetworkBadge network={o.network} label={networkName(o.network)} />
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export const shownHandle = (value: string) => {
  const id = parseIdentifier(value)
  return id?.kind === 'username' ? `${id.service} @${id.value}` : value
}

export function FieldGroup({ title, fields }: { title: string; fields: PersonField[] | undefined }) {
  if (!fields?.length) return null
  return (
    <Group title={title}>
      {fields.map((f, i) => (
        <div key={i} className="flex min-h-11 items-center gap-3 px-4 py-2">
          <span className="min-w-0 flex-1 truncate select-text">{f.value}</span>
          {f.label ? <span className="text-sm text-subtle-foreground">{f.label}</span> : null}
        </div>
      ))}
    </Group>
  )
}

export function Details({ card }: { card: PersonPlaintext }) {
  const rows: [string, ReactNode][] = []
  if (card.nickname) rows.push(['Nickname', card.nickname])
  if (card.birthday) rows.push(['Birthday', card.birthday.replace(/^--/, '')])
  for (const a of card.addresses ?? []) {
    const text = [a.street, [a.locality, a.region, a.postcode].filter(Boolean).join(' '), a.country].filter(Boolean)
    rows.push([
      a.label ? `Address, ${a.label}` : 'Address',
      <span className="whitespace-pre-line">{text.join('\n')}</span>,
    ])
  }
  for (const u of card.urls ?? []) rows.push([u.label ?? 'Website', u.value])
  if (card.note) rows.push(['Note', <span className="whitespace-pre-line">{card.note}</span>])
  if (!rows.length) return null
  return (
    <Group title="Details">
      {rows.map(([label, value], i) => (
        <div key={i} className="flex gap-4 px-4 py-3">
          <span className="w-28 shrink-0 text-sm text-muted-foreground">{label}</span>
          <span className="min-w-0 flex-1 break-words select-text">{value}</span>
        </div>
      ))}
    </Group>
  )
}

/** Searches the person's network contacts, to link one to a card. */
function ChooseContact({
  open,
  onOpenChange,
  contacts,
  onChoose,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  contacts: readonly NetworkContact[]
  onChoose: (contact: NetworkContact) => void
}) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const page = usePage(
    contacts.filter(
      (c) =>
        !q ||
        [c.profile.name, c.profile.handle, ...(c.identifiers ?? []), networkName(c.network)].some((t) =>
          t?.toLowerCase().includes(q),
        ),
    ),
    q,
  )
  const shown = page.shown
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[520px] w-[min(480px,calc(100vw-32px))] flex-col" aria-describedby={undefined}>
        <DialogTitle className="px-5 pt-5 pb-3 text-md">Link an account</DialogTitle>
        <div className="px-5 pb-3">
          <InputGroup icon={<Search className="size-4 shrink-0" />}>
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search contacts"
            />
          </InputGroup>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {shown.length ? (
            shown.map((c) => (
              <Button
                variant="bare"
                key={contactKey(c)}
                type="button"
                className="block w-full text-left hover:bg-surface-2"
                onClick={() => onChoose(c)}
              >
                <ContactLine contact={c} />
              </Button>
            ))
          ) : (
            <p className="px-5 text-sm text-muted-foreground">No contacts match.</p>
          )}
          <ShowMore more={page.more} onClick={page.showMore} className="mx-5" />
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Searches the person's cards, to add contacts to one. */
export function ChoosePerson({
  open,
  onOpenChange,
  people,
  onChoose,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  people: readonly Person[]
  onChoose: (person: Person) => void
}) {
  const [query, setQuery] = useState('')
  const page = usePage(
    people.filter((p) => matches(p.card, query)),
    query,
  )
  const shown = page.shown
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[520px] w-[min(480px,calc(100vw-32px))] flex-col" aria-describedby={undefined}>
        <DialogTitle className="px-5 pt-5 pb-3 text-md">Add to a person</DialogTitle>
        <div className="px-5 pb-3">
          <InputGroup icon={<Search className="size-4 shrink-0" />}>
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              aria-label="Search people"
            />
          </InputGroup>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2">
          {shown.length ? (
            shown.map((p) => (
              <Button
                variant="bare"
                key={p.personKey}
                type="button"
                className="flex h-11 w-full items-center gap-2.5 rounded-md px-2 text-left hover:bg-surface-2"
                onClick={() => onChoose(p)}
              >
                <Avatar name={cardTitle(p.card)} src={p.card.photo} size={28} />
                <span className="truncate font-medium">{cardTitle(p.card)}</span>
              </Button>
            ))
          ) : (
            <p className="px-2 text-sm text-muted-foreground">No one matches.</p>
          )}
          <ShowMore more={page.more} onClick={page.showMore} className="mx-2" />
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Takes a saved change back: `stale` when it no longer can, as another device changed it since,
 * and `failed` when it couldn't be saved and may be tried again.
 */
type Undo = () => Promise<'done' | 'stale' | 'failed'>

/** What a save of suggested links linked, by `contactKey`, and what takes it back. */
interface Linked {
  contacts: ReadonlySet<string>
  undo: Undo
}

/** A suggestion acted on in the list, shown as it stands until the cards catch up. */
interface Kept {
  suggestion: LinkSuggestion
  /** `undone` shows it as a suggestion again, until the live list has it once more. */
  state: 'linking' | 'linked' | 'undoing' | 'undone'
  /** A row linked on its own takes itself back; linking all the matches has one Undo for them. */
  undo?: Undo
  /** The cards have shown it linked. */
  seen?: boolean
}

/** Rows linked in one save, and what takes them back. */
interface Save {
  keys: string[]
  undo: Undo
}

const suggestionKey = (s: LinkSuggestion) => `${contactKey(s.contact)}>${s.personKey}`

function Suggestions({
  suggestions,
  people,
  onLink,
}: {
  suggestions: LinkSuggestion[]
  people: readonly Person[]
  onLink: (personKey: string, contacts: NetworkContact[]) => Promise<Linked | undefined>
}) {
  const [busy, setBusy] = useState<'linking' | 'undoing' | null>(null)
  const [kept, setKept] = useState<ReadonlyMap<string, Kept>>(new Map())
  // The saves "Link all" made, which its Undo takes back together.
  const [batch, setBatch] = useState<readonly Save[]>([])
  // The rows' order from the first click on, and every row seen since. A linked account leaves
  // the live list, with its other suggestions, and without these the rows below would move up
  // under the pointer, so the next click lands on another.
  const [order, setOrder] = useState<readonly string[] | null>(null)
  const [seen] = useState(() => new Map<string, LinkSuggestion>())
  const owner = useMemo(() => linkIndex(people), [people])
  // Accounts being linked or taken back, or linked here: their other suggestions wait.
  const held = new Set(
    [...kept.values()].filter((k) => k.state !== 'undone').map((k) => contactKey(k.suggestion.contact)),
  )
  const rows = useMemo(() => {
    for (const s of suggestions) seen.set(suggestionKey(s), s)
    if (!order) return suggestions
    // Accounts acted on here, whose other suggestions keep their place while the cards catch up.
    const acted = new Set([...kept.values()].map((k) => contactKey(k.suggestion.contact)))
    const live = new Map(suggestions.map((s) => [suggestionKey(s), s]))
    const shown = (key: string) => {
      const s = live.get(key) ?? kept.get(key)?.suggestion ?? seen.get(key)
      return s && (live.has(key) || kept.has(key) || acted.has(contactKey(s.contact))) ? [s] : []
    }
    const listed = new Set(order)
    return [...order.flatMap(shown), ...suggestions.filter((s) => !listed.has(suggestionKey(s)))]
  }, [suggestions, kept, order, seen])
  const page = usePage(rows)
  const names = new Map(people.map((p) => [p.personKey, cardTitle(p.card)]))
  // A contact suggested for several cards is left for the person to choose; a shared number,
  // email or username for only one is safe to link in one go.
  const counts = new Map<string, number>()
  for (const s of suggestions) counts.set(contactKey(s.contact), (counts.get(contactKey(s.contact)) ?? 0) + 1)
  const sure = suggestions.filter(
    (s) => s.reason !== 'name' && counts.get(contactKey(s.contact)) === 1 && !held.has(contactKey(s.contact)),
  )
  // A save still has its Undo while a row of it shows linked.
  const linkedHere = (key: string) => ['linked', 'undoing'].includes(kept.get(key)?.state ?? '')
  const undoable = batch.filter((save) => save.keys.some(linkedHere))
  const undoCount = undoable.reduce((n, save) => n + save.keys.filter(linkedHere).length, 0)

  // New suggestions join the order where they first show, at the end.
  useEffect(() => {
    if (!order) return
    const listed = new Set(order)
    const added = suggestions.map(suggestionKey).filter((key) => !listed.has(key))
    if (added.length) setOrder([...order, ...added])
  }, [suggestions, order])

  // Kept rows follow the cards: an undone row is let go once it's suggested again, and a linked
  // one, with its Undo, once the cards show it linked and then not, as when another device
  // unlinks or moves it.
  useEffect(() => {
    const live = new Set(suggestions.map(suggestionKey))
    const next = new Map(kept)
    for (const [key, k] of kept) {
      const on = owner.get(contactKey(k.suggestion.contact)) === k.suggestion.personKey
      if (k.state === 'undone' && live.has(key)) next.delete(key)
      else if (k.state === 'linked' && !k.seen && on) next.set(key, { ...k, seen: true })
      else if (k.state === 'linked' && k.seen && !on) next.delete(key)
    }
    if (next.size !== kept.size || [...next].some(([key, k]) => kept.get(key) !== k)) setKept(next)
  }, [suggestions, kept, owner])

  /** Changes kept rows; `undefined` lets one go. */
  const update = (keys: readonly string[], to: (k: Kept | undefined) => Kept | undefined) =>
    setKept((now) => {
      const next = new Map(now)
      for (const key of keys) {
        const k = to(next.get(key))
        if (k) next.set(key, k)
        else next.delete(key)
      }
      return next
    })

  /**
   * Links a card's suggestions in one save. Gives back the rows it linked and their undo, an
   * empty save when there was nothing left to link, or undefined when it couldn't be saved.
   */
  async function link(personKey: string, group: LinkSuggestion[], own: boolean): Promise<Save | undefined> {
    setOrder((now) => now ?? rows.map(suggestionKey))
    const keys = group.map(suggestionKey)
    for (const s of group) update([suggestionKey(s)], () => ({ suggestion: s, state: 'linking' }))
    const saved = await onLink(
      personKey,
      group.map((s) => s.contact),
    )
    const linked = saved ? group.filter((s) => saved.contacts.has(contactKey(s.contact))).map(suggestionKey) : []
    update(keys, (k) =>
      k && saved && linked.includes(suggestionKey(k.suggestion))
        ? { ...k, state: 'linked', undo: own ? saved.undo : undefined }
        : undefined,
    )
    return saved && { keys: linked, undo: saved.undo }
  }

  /** Takes a save back, showing its rows as suggestions again; a stale one lets them go. */
  async function undo(save: Save) {
    const keys = save.keys.filter(linkedHere)
    update(keys, (k) => k && { ...k, state: 'undoing' })
    const result = await save.undo()
    update(keys, (k) =>
      k && result !== 'stale' ? { ...k, state: result === 'done' ? 'undone' : 'linked' } : undefined,
    )
    return result
  }

  async function linkAll() {
    setBusy('linking')
    const byPerson = new Map<string, LinkSuggestion[]>()
    for (const s of sure) byPerson.set(s.personKey, [...(byPerson.get(s.personKey) ?? []), s])
    for (const [personKey, group] of byPerson) {
      const save = await link(personKey, group, false)
      if (!save) break
      if (save.keys.length) setBatch((now) => [...now, save])
    }
    setBusy(null)
  }

  /** Takes back every save "Link all" made that still can, stopping at one that couldn't be saved. */
  async function undoAll() {
    setBusy('undoing')
    for (const save of undoable) {
      if ((await undo(save)) === 'failed') break
      setBatch((now) => now.filter((s) => s !== save))
    }
    setBusy(null)
  }

  if (!rows.length) return <p className="text-sm text-muted-foreground">Nothing to link.</p>
  return (
    <Group
      title="Suggested links"
      action={
        <>
          {undoable.length ? (
            <Button
              size="sm"
              variant="ghost"
              loading={busy === 'undoing'}
              disabled={!!busy}
              onClick={() => void undoAll()}
            >
              Undo {undoCount.toLocaleString()} {undoCount === 1 ? 'link' : 'links'}
            </Button>
          ) : null}
          {sure.length ? (
            <Button size="sm" loading={busy === 'linking'} disabled={!!busy} onClick={() => void linkAll()}>
              Link {sure.length.toLocaleString()} matches
            </Button>
          ) : null}
        </>
      }
    >
      {page.shown.map((s) => {
        const key = suggestionKey(s)
        const k = kept.get(key)
        const who = names.get(s.personKey) ?? 'this person'
        return (
          <ContactLine key={key} contact={s.contact}>
            <div className="min-w-0 text-right">
              <div className="truncate font-medium">{names.get(s.personKey)}</div>
              <div className="text-sm text-subtle-foreground">{REASON[s.reason]}</div>
            </div>
            {k && (k.state === 'linked' || k.state === 'undoing') ? (
              <>
                <span className="flex items-center gap-1 text-sm text-success">
                  <Check className="size-3.5" /> Linked
                </span>
                {k.undo ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={k.state === 'undoing'}
                    disabled={!!busy}
                    aria-label={`Undo linking to ${who}`}
                    onClick={() => void undo({ keys: [key], undo: k.undo! })}
                  >
                    Undo
                  </Button>
                ) : null}
              </>
            ) : (
              <Button
                size="sm"
                loading={k?.state === 'linking'}
                disabled={!!busy || (!k && held.has(contactKey(s.contact)))}
                aria-label={`Link to ${who}`}
                onClick={() => void link(s.personKey, [s], true)}
              >
                Link
              </Button>
            )}
          </ContactLine>
        )
      })}
      <ShowMore more={page.more} onClick={page.showMore} className="mx-4 mb-2" />
    </Group>
  )
}

/**
 * How to bring Google Contacts in without a live connection: export them from Google as a
 * vCard file, then import that. Shown where no admin has set up Google sign-in.
 */
function GoogleGuide({
  open,
  onOpenChange,
  onChooseFile,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChooseFile: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(440px,calc(100vw-32px))] p-6">
        <DialogTitle className="text-md">Import from Google</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          In Google Contacts, choose Export, then vCard, and import the file it saves.
        </DialogDescription>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => window.open('https://contacts.google.com/', '_blank', 'noopener,noreferrer')}
          >
            Open Google Contacts
          </Button>
          <Button variant="primary" onClick={onChooseFile}>
            Choose file…
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Says how many more a long list has, and shows them when asked. */
function ShowMore({ more, onClick, className }: { more: number; onClick: () => void; className?: string }) {
  if (!more) return null
  return (
    <Button type="button" size="sm" variant="ghost" className={className} onClick={onClick}>
      Show more ({more.toLocaleString()} not shown)
    </Button>
  )
}

function Unsorted({
  groups,
  people,
  onCreate,
  onLink,
}: {
  groups: NetworkContact[][]
  people: readonly Person[]
  onCreate: (groups: NetworkContact[][]) => Promise<boolean>
  onLink: (personKey: string, contacts: NetworkContact[]) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState<NetworkContact[] | null>(null)
  const [query, setQuery] = useState('')
  const rows = useMemo(() => groups.map(unsortedRow), [groups])
  const found = useMemo(() => rows.filter((r) => rowMatches(r, query)), [rows, query])
  const page = usePage(found, query)
  if (!groups.length) return <p className="text-sm text-muted-foreground">Every contact is in People.</p>
  return (
    <>
      <InputGroup className="mb-5" icon={<Search className="size-4 shrink-0" />}>
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          aria-label="Search contacts not in People"
        />
      </InputGroup>
      <Group
        title="Not in People"
        action={
          found.length ? (
            <Button
              size="sm"
              loading={busy}
              onClick={async () => {
                setBusy(true)
                await onCreate(found.map((r) => r.contacts))
                setBusy(false)
              }}
            >
              {/* A search narrows what's added to the contacts it found. */}
              {query.trim() ? `Add ${found.length.toLocaleString()}` : 'Add all'}
            </Button>
          ) : undefined
        }
      >
        {page.shown.map((row) => (
          <div key={row.contacts.map(contactKey).join(' ')} className="flex min-h-[52px] items-center gap-3 px-4 py-2">
            <span className="flex gap-1">
              {row.contacts.map((c) => (
                <NetworkBadge key={contactKey(c)} network={c.network} label={networkName(c.network)} size={18} />
              ))}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{row.name || 'Unknown'}</div>
              <div className="truncate text-sm text-muted-foreground">{row.details.join(', ')}</div>
            </div>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAdding(row.contacts)}>
              Add to…
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void onCreate([row.contacts])}>
              Add
            </Button>
          </div>
        ))}
        <ShowMore more={page.more} onClick={page.showMore} className="mx-4 mb-2" />
      </Group>
      {found.length ? null : <p className="px-1 text-sm text-muted-foreground">No one matches.</p>}
      <ChoosePerson
        open={!!adding}
        onOpenChange={(open) => !open && setAdding(null)}
        people={people}
        onChoose={(person) => {
          const group = adding
          setAdding(null)
          if (group) void onLink(person.personKey, group)
        }}
      />
    </>
  )
}

const LABELS = ['mobile', 'home', 'work', 'other']

/** A list of values with labels, as the form edits phones, emails and usernames. */
function FieldsEditor({
  legend,
  fields,
  onChange,
  placeholder,
  labels,
  type,
  noun,
}: {
  legend: string
  /** What one of them is called, for the add button's accessible name. */
  noun: string
  fields: HandleField[]
  onChange: (fields: HandleField[]) => void
  placeholder: string
  labels: string[]
  type?: string
}) {
  const listId = `labels-${legend}`
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-xs font-semibold tracking-[0.06em] text-subtle-foreground uppercase">
        {legend}
      </legend>
      {fields.map((f, i) => (
        <div key={i} className="flex gap-2">
          <Input
            className="w-24 shrink-0 sm:w-32"
            list={listId}
            value={f.label ?? ''}
            placeholder="Label"
            aria-label={`${legend} ${i + 1} label`}
            onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
          />
          <Input
            type={type}
            value={f.value}
            placeholder={placeholder}
            aria-label={`${legend} ${i + 1}`}
            onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove ${legend.toLowerCase()} ${i + 1}`}
            onClick={() => onChange(fields.filter((_, j) => j !== i))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      <datalist id={listId}>
        {labels.map((l) => (
          <option key={l} value={l} />
        ))}
      </datalist>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={`Add ${noun}`}
        onClick={() => onChange([...fields, { value: '' }])}
      >
        <Plus className="size-3.5" /> Add
      </Button>
    </fieldset>
  )
}

const SERVICES = ['signal', 'telegram', 'instagram', 'twitter', 'bluesky', 'linkedin', 'slack', 'skype', 'xmpp']

function PersonForm({
  card,
  onSave,
  onCancel,
}: {
  card: PersonPlaintext
  onSave: (card: PersonPlaintext) => Promise<void>
  onCancel: () => void
}) {
  const [name, setName] = useState(card.name)
  const [org, setOrg] = useState(card.org ?? '')
  const [title, setTitle] = useState(card.title ?? '')
  const [phones, setPhones] = useState(card.phones ?? [])
  const [emails, setEmails] = useState(card.emails ?? [])
  // Usernames edit as service and name (handles.ts), keeping any label of their own.
  const [handles, setHandles] = useState<HandleField[]>((card.handles ?? []).map(toHandleField))
  const [birthday, setBirthday] = useState(card.birthday ?? '')
  const [note, setNote] = useState(card.note ?? '')
  const [saving, setSaving] = useState(false)
  const birthdayValid = !birthday.trim() || /^(\d{4}|-)-\d{2}-\d{2}$/.test(birthday.trim())

  const clean = (fields: PersonField[]) =>
    fields.flatMap((f) => {
      const value = f.value.trim()
      const label = f.label?.trim()
      return value ? [label ? { value, label } : { value }] : []
    })

  return (
    <form
      className="max-w-[560px] space-y-6"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!birthdayValid) return
        const next: PersonPlaintext = { ...card, name: name.trim() }
        // A new name replaces the parts it was made from.
        if (next.name !== card.name)
          for (const k of ['given', 'family', 'middle', 'prefix', 'suffix'] as const) delete next[k]
        const set = <K extends keyof PersonPlaintext>(key: K, value: PersonPlaintext[K] | undefined) => {
          if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) delete next[key]
          else next[key] = value
        }
        set('org', org.trim())
        set('title', title.trim())
        set('phones', clean(phones))
        set('emails', clean(emails))
        set(
          'handles',
          handles.map(fromHandleField).filter((f): f is PersonField => f !== null),
        )
        set('birthday', birthday.trim())
        set('note', note.trim())
        setSaving(true)
        await onSave(next)
        setSaving(false)
      }}
    >
      <h2 className="sr-only">{card.name ? `Edit ${card.name}` : 'New person'}</h2>
      <div className="space-y-2">
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Name" />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={org} onChange={(e) => setOrg(e.target.value)} placeholder="Company" aria-label="Company" />
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Job title"
            aria-label="Job title"
          />
        </div>
      </div>
      <FieldsEditor
        legend="Phone"
        noun="phone number"
        fields={phones}
        onChange={setPhones}
        placeholder="Number"
        labels={LABELS}
        type="tel"
      />
      <FieldsEditor
        legend="Email"
        noun="email"
        fields={emails}
        onChange={setEmails}
        placeholder="Address"
        labels={LABELS}
        type="email"
      />
      <FieldsEditor
        legend="Usernames"
        noun="username"
        fields={handles}
        onChange={setHandles}
        placeholder="Username"
        labels={SERVICES}
      />
      <div className="space-y-2">
        <Input
          value={birthday}
          onChange={(e) => setBirthday(e.target.value)}
          placeholder="Birthday, YYYY-MM-DD"
          aria-label="Birthday"
          aria-invalid={!birthdayValid || undefined}
        />
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note"
          aria-label="Note"
          rows={3}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" loading={saving} disabled={!name.trim() || !birthdayValid}>
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** Where the list of people will be, while it loads: rows' shapes, as the list will sit. */
function PeopleSkeleton() {
  return (
    // It waits a moment first, so a list that loads quickly never shows it.
    <div aria-label="Loading people" className="animate-fade-in-late">
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-2.5 px-2">
          <span className="size-7 shrink-0 rounded-full bg-muted" />
          <span className="h-3 flex-1 rounded bg-muted" />
        </div>
      ))}
    </div>
  )
}
