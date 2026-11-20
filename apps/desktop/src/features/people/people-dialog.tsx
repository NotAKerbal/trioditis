import {
  cardFromContacts,
  cardTitle,
  contactKey,
  groupUnlinked,
  moveLinks,
  parseContactsFile,
  parseIdentifier,
  suggestLinks,
  toVCards,
  withoutLinks,
  type LinkSuggestion,
  type MatchReason,
  type NetworkContact,
  type Person,
  type PersonField,
  type PersonPlaintext,
} from '@trioditis/core'
import { Avatar } from '@trioditis/ui/avatar'
import { Button } from '@trioditis/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@trioditis/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@trioditis/ui/dropdown-menu'
import { Input, InputGroup } from '@trioditis/ui/input'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { Textarea } from '@trioditis/ui/textarea'
import { toast } from '@trioditis/ui/toast'
import { cn } from '@trioditis/ui/lib/utils'
import { Download, Link2, MoreHorizontal, Pencil, Plus, Search, Trash2, Upload, Users, X } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import { networkName } from '~/data/chats.ts'
import {
  contactsByKey,
  download,
  importPlan,
  shrinkPhoto,
  useNetworkContacts,
  usePeople,
  usePeopleActions,
} from '~/data/people.ts'
import { Group, Loading } from '~/features/settings/layout.tsx'
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
}: {
  view: PeopleView | undefined
  onViewChange: (view: PeopleView | undefined) => void
}) {
  return (
    <Dialog open={!!view} onOpenChange={(open) => !open && onViewChange(undefined)}>
      <DialogContent className="flex h-[660px] w-[min(980px,calc(100vw-32px))]" aria-describedby={undefined}>
        {view ? <People view={view} onViewChange={onViewChange} /> : null}
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

function People({ view, onViewChange }: { view: PeopleView; onViewChange: (view: PeopleView | undefined) => void }) {
  const people = usePeople()
  const contacts = useNetworkContacts()
  const actions = usePeopleActions()
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
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

  /** Saves cards, saying so if it fails. True once they're saved. */
  async function save(changed: Person[], failure: string) {
    try {
      await actions.save(changed)
      return true
    } catch (err) {
      if (sessionChanged(err)) window.location.reload()
      else toast(errorMessage(err, failure))
      return false
    }
  }

  async function importFile(file: File) {
    setBusy(true)
    try {
      const cards = parseContactsFile(await file.text())
      if (!cards.length) return toast('No contacts were found in that file.')
      for (const card of cards) {
        if (card.photo) {
          const small = await shrinkPhoto(card.photo)
          if (small) card.photo = small
          else delete card.photo
        }
      }
      const plan = importPlan(people ?? [], cards)
      await actions.save(plan)
      toast(`Imported ${plan.length.toLocaleString()} ${plan.length === 1 ? 'person' : 'people'}`)
      onViewChange('suggested')
    } catch (err) {
      if (sessionChanged(err)) window.location.reload()
      else toast(errorMessage(err, 'That file couldn’t be imported.'))
    } finally {
      setBusy(false)
    }
  }

  async function remove(person: Person) {
    try {
      await actions.remove([person.personKey])
      onViewChange('all')
      toast(`Deleted ${cardTitle(person.card)}`, {
        label: 'Undo',
        onClick: () => void save([person], 'It couldn’t be put back.'),
      })
    } catch (err) {
      toast(errorMessage(err, 'That person couldn’t be deleted.'))
    }
  }

  return (
    <>
      <div className="flex w-[300px] shrink-0 flex-col border-r border-border bg-rail">
        <DialogTitle className="sr-only">People</DialogTitle>
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border px-2.5">
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
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-2" aria-label="People" aria-busy={busy || !people}>
          {suggestions.length && !query ? (
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
          {!people ? (
            <div className="px-2">
              <Loading />
            </div>
          ) : shown.length ? (
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
      <div className="min-w-0 flex-1 overflow-y-auto px-7 pt-14 pb-7">
        {view === 'new' ? (
          <PersonForm
            card={{ name: query.trim() }}
            onCancel={() => onViewChange('all')}
            onSave={async (card) => {
              const personKey = newClientId()
              if (await save([{ personKey, card }], 'That person couldn’t be saved.')) onViewChange(`p:${personKey}`)
            }}
          />
        ) : view === 'suggested' ? (
          <Suggestions
            suggestions={suggestions}
            people={people ?? []}
            onLink={(personKey, linked) => save(moveLinks(people ?? [], personKey, linked), 'That couldn’t be linked.')}
          />
        ) : view === 'unsorted' ? (
          <Unsorted
            groups={unsorted}
            people={sorted}
            onCreate={(groups) =>
              save(
                groups.map((g) => ({ personKey: newClientId(), card: cardFromContacts(g) })),
                'Those people couldn’t be added.',
              )
            }
            onLink={(personKey, linked) => save(moveLinks(people ?? [], personKey, linked), 'That couldn’t be linked.')}
          />
        ) : selected ? (
          <PersonDetail
            key={selected.personKey}
            person={selected}
            byContact={byContact}
            contacts={contacts ?? []}
            suggestions={suggestions.filter((s) => s.personKey === selected.personKey)}
            onSave={(card) => save([{ personKey: selected.personKey, card }], 'That person couldn’t be saved.')}
            onLink={(linked) => save(moveLinks(people ?? [], selected.personKey, linked), 'That couldn’t be linked.')}
            onDelete={() => void remove(selected)}
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
function ContactLine({ contact, children }: { contact: NetworkContact; children?: ReactNode }) {
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
function shownIdentifier(raw: string) {
  const id = parseIdentifier(raw)
  if (!id) return raw
  if (id.kind !== 'username') return id.value
  return id.service.endsWith('-internal') ? '' : `@${id.value}`
}

function PersonDetail({
  person,
  byContact,
  contacts,
  suggestions,
  onSave,
  onLink,
  onDelete,
}: {
  person: Person
  byContact: Map<string, NetworkContact>
  contacts: readonly NetworkContact[]
  suggestions: LinkSuggestion[]
  onSave: (card: PersonPlaintext) => Promise<boolean>
  onLink: (contacts: NetworkContact[]) => Promise<boolean>
  onDelete: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const { card } = person
  if (editing) {
    return (
      <PersonForm
        card={card}
        onCancel={() => setEditing(false)}
        onSave={async (next) => {
          if (await onSave(next)) setEditing(false)
        }}
      />
    )
  }
  const links = card.links ?? []
  const subtitle = [card.title, card.org].filter(Boolean).join(', ')
  return (
    <div>
      <div className="mb-7 flex items-center gap-4">
        <Avatar name={cardTitle(card)} src={card.photo} size={56} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-bold tracking-[-0.015em]">{cardTitle(card)}</h2>
          {subtitle ? <div className="truncate text-sm text-muted-foreground">{subtitle}</div> : null}
        </div>
        <Button size="sm" onClick={() => setEditing(true)}>
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
                onClick={() => void onSave(withoutLinks(card, [link]))}
              >
                <X className="size-4" />
              </Button>
            </ContactLine>
          ) : null
        })}
        {suggestions.map((s) => (
          <ContactLine key={contactKey(s.contact)} contact={s.contact}>
            <span className="text-sm text-subtle-foreground">{REASON[s.reason]}</span>
            <Button size="sm" onClick={() => void onLink([s.contact])}>
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

const shownHandle = (value: string) => {
  const id = parseIdentifier(value)
  return id?.kind === 'username' ? `${id.service} @${id.value}` : value
}

function FieldGroup({ title, fields }: { title: string; fields: PersonField[] | undefined }) {
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

function Details({ card }: { card: PersonPlaintext }) {
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
  const shown = contacts
    .filter(
      (c) =>
        !q ||
        [c.profile.name, c.profile.handle, ...(c.profile.identifiers ?? []), networkName(c.network)].some((t) =>
          t?.toLowerCase().includes(q),
        ),
    )
    .slice(0, 200)
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
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Searches the person's cards, to add contacts to one. */
function ChoosePerson({
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
  const shown = people.filter((p) => matches(p.card, query)).slice(0, 200)
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
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Suggestions({
  suggestions,
  people,
  onLink,
}: {
  suggestions: LinkSuggestion[]
  people: readonly Person[]
  onLink: (personKey: string, contacts: NetworkContact[]) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)
  const names = new Map(people.map((p) => [p.personKey, cardTitle(p.card)]))
  // A contact suggested for several cards is left for the person to choose; a shared number,
  // email or username for only one is safe to link in one go.
  const counts = new Map<string, number>()
  for (const s of suggestions) counts.set(contactKey(s.contact), (counts.get(contactKey(s.contact)) ?? 0) + 1)
  const sure = suggestions.filter((s) => s.reason !== 'name' && counts.get(contactKey(s.contact)) === 1)

  async function linkAll() {
    setBusy(true)
    const byPerson = new Map<string, NetworkContact[]>()
    for (const s of sure) byPerson.set(s.personKey, [...(byPerson.get(s.personKey) ?? []), s.contact])
    for (const [personKey, contacts] of byPerson) if (!(await onLink(personKey, contacts))) break
    setBusy(false)
  }

  if (!suggestions.length) return <p className="text-sm text-muted-foreground">Nothing to link.</p>
  return (
    <Group
      title="Suggested links"
      action={
        sure.length ? (
          <Button size="sm" loading={busy} onClick={() => void linkAll()}>
            Link {sure.length.toLocaleString()} matches
          </Button>
        ) : undefined
      }
    >
      {suggestions.slice(0, 500).map((s) => (
        <ContactLine key={`${contactKey(s.contact)}>${s.personKey}`} contact={s.contact}>
          <div className="min-w-0 text-right">
            <div className="truncate font-medium">{names.get(s.personKey)}</div>
            <div className="text-sm text-subtle-foreground">{REASON[s.reason]}</div>
          </div>
          <Button size="sm" disabled={busy} onClick={() => void onLink(s.personKey, [s.contact])}>
            Link
          </Button>
        </ContactLine>
      ))}
    </Group>
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
  if (!groups.length) return <p className="text-sm text-muted-foreground">Every contact is in People.</p>
  return (
    <>
      <Group
        title="Not in People"
        action={
          <Button
            size="sm"
            loading={busy}
            onClick={async () => {
              setBusy(true)
              await onCreate(groups)
              setBusy(false)
            }}
          >
            Add all
          </Button>
        }
      >
        {groups.slice(0, 500).map((group) => (
          <div key={group.map(contactKey).join(' ')} className="flex min-h-[52px] items-center gap-3 px-4 py-2">
            <span className="flex gap-1">
              {group.map((c) => (
                <NetworkBadge key={contactKey(c)} network={c.network} label={networkName(c.network)} size={18} />
              ))}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{cardFromContacts(group).name || 'Unknown'}</div>
              <div className="truncate text-sm text-muted-foreground">
                {[
                  ...new Set(
                    group.flatMap((c) => (c.profile.identifiers ?? [c.profile.handle ?? '']).map(shownIdentifier)),
                  ),
                ]
                  .filter(Boolean)
                  .join(', ')}
              </div>
            </div>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAdding(group)}>
              Add to…
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void onCreate([group])}>
              Add
            </Button>
          </div>
        ))}
      </Group>
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
  fields: PersonField[]
  onChange: (fields: PersonField[]) => void
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
            className="w-32"
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

/** Usernames edit as service and name; they're stored as `service:name` so they match networks'. */
const toHandleField = (f: PersonField): PersonField => {
  const id = parseIdentifier(f.value)
  return id?.kind === 'username' ? { value: id.value, label: id.service } : { value: f.value, label: f.label ?? '' }
}
const fromHandleField = (f: PersonField): PersonField | null => {
  const value = f.value.trim().replace(/^@/, '')
  if (!value) return null
  const service = f.label?.trim().toLowerCase()
  return { value: service && !value.includes(':') ? `${service}:${value}` : value }
}

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
  const [handles, setHandles] = useState((card.handles ?? []).map(toHandleField))
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
        <div className="flex gap-2">
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
