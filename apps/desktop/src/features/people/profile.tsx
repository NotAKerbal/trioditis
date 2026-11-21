import type { Id } from '@trioditis/backend/dataModel'
import {
  cardFromContacts,
  cardTitle,
  contactKey,
  moveLinks,
  suggestLinks,
  type Network,
  type NetworkContact,
} from '@trioditis/core'
import { Avatar } from '@trioditis/ui/avatar'
import { Button } from '@trioditis/ui/button'
import { NetworkBadge } from '@trioditis/ui/network-badge'
import { toast } from '@trioditis/ui/toast'
import { Pencil, UserPlus, Users } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { networkName } from '~/data/chats.ts'
import { useContacts } from '~/data/contacts.ts'
import { useDmChats } from '~/data/conversations.ts'
import {
  contactsByKey,
  PartlySaved,
  Stale,
  TooLarge,
  useNetworkContacts,
  usePeople,
  usePeopleActions,
  type Change,
  type StoredPerson,
} from '~/data/people.ts'
import { MediaAvatar } from '~/features/chat/attachments.tsx'
import { Group } from '~/features/settings/layout.tsx'
import { errorMessage, sessionChanged } from '~/lib/errors.ts'
import { newClientId } from '~/lib/sealed.ts'
import { ChoosePerson, ContactLine, Details, FieldGroup, MessageButton, shownHandle } from './people-dialog.tsx'

/** A contact on a network, as a profile is asked for: who a direct chat is with, or a sender. */
export interface ContactRef {
  network: Network
  ghostId: string
}

/**
 * A person's profile, for the side of a chat: their People card when one links the contact,
 * with every network it links and a way to the chat on each, or else the contact's own profile
 * and a way to add them to People. Adding them is what puts their direct chats on every
 * network together (conversations.ts).
 */
export function PersonProfile({
  contact,
  fallbackName,
  fallbackAvatar,
  here,
  onOpenChat,
  onOpenPerson,
}: {
  /** Who it's about; undefined for a direct chat the bridge host hasn't said who it's with yet. */
  contact: ContactRef | undefined
  fallbackName: string
  /** Shown until the card or contact has a picture. */
  fallbackAvatar?: ReactNode
  /** The chats open beside it: their accounts need no way to open them. */
  here: ReadonlySet<string>
  onOpenChat: (chatId: Id<'chats'>) => void
  onOpenPerson: (personKey: string) => void
}) {
  const people = usePeople()
  const contacts = useNetworkContacts()
  const actions = usePeopleActions(people)
  const dmChats = useDmChats()
  const byContact = useMemo(() => contactsByKey(contacts), [contacts])
  const key = contact ? contactKey(contact) : undefined
  // Asked for on its own, so the profile shows before every contact has loaded.
  const direct = useContacts(contact?.network ?? 'whatsapp', contact ? [contact.ghostId] : [])
  const loaded = key ? byContact.get(key) : undefined
  const profile = loaded?.profile ?? (contact ? direct.get(contact.ghostId) : undefined)
  const person = key ? people?.find((p) => p.card.links?.some((l) => contactKey(l) === key)) : undefined
  const suggestion = useMemo(
    () => (people && loaded && !person ? suggestLinks(people, [loaded])[0] : undefined),
    [people, loaded, person],
  )
  const [choosing, setChoosing] = useState(false)
  const [busy, setBusy] = useState(false)

  async function save(change: Change, failure: string) {
    setBusy(true)
    try {
      await actions.apply(change)
      return true
    } catch (err) {
      if (sessionChanged(err)) window.location.reload()
      else if (err instanceof PartlySaved) toast(errorMessage(err.reason, failure))
      else toast(err instanceof Stale || err instanceof TooLarge ? err.message : errorMessage(err, failure))
      return false
    } finally {
      setBusy(false)
    }
  }
  // Worked out again from the latest cards, so a contact another device linked meanwhile stays.
  const addTo = (personKey: string, them: NetworkContact) =>
    save((fresh) => moveLinks(fresh, personKey, [them]), 'That couldn’t be linked.')
  const addNew = (them: NetworkContact) =>
    save((fresh) => {
      if (fresh.some((p) => p.card.links?.some((l) => contactKey(l) === contactKey(them)))) return []
      return [{ personKey: newClientId(), card: cardFromContacts([them]) }]
    }, 'That person couldn’t be added.')

  const card = person?.card
  const name = (card && cardTitle(card)) || profile?.name || profile?.handle || fallbackName
  const subtitle = card
    ? [card.title, card.org].filter(Boolean).join(', ')
    : profile?.handle && profile.handle !== name
      ? shownHandle(profile.handle)
      : ''
  const avatar = card?.photo ? (
    <Avatar name={name} src={card.photo} size={68} className="mx-auto" />
  ) : contact && profile?.avatar ? (
    <MediaAvatar network={contact.network} picture={profile.avatar} name={name} size={68} className="mx-auto" />
  ) : (
    (fallbackAvatar ?? <Avatar name={name} size={68} className="mx-auto" />)
  )
  // A card's accounts, or the contact alone: each with a way to its chat when there's one.
  const accounts: NetworkContact[] = card
    ? (card.links ?? []).flatMap((l) => byContact.get(contactKey(l)) ?? [])
    : loaded
      ? [loaded]
      : contact && profile
        ? [{ ...contact, profile }]
        : []

  return (
    <div className="px-5 pt-6 pb-2">
      <div className="text-center">
        {avatar}
        <h2 className="mt-2.5 text-lg font-bold">{name}</h2>
        {subtitle ? <p className="mt-0.5 truncate text-sm text-subtle-foreground">{subtitle}</p> : null}
        {contact && !card ? (
          <p className="mt-0.5 inline-flex items-center gap-1.5 text-sm text-subtle-foreground">
            <NetworkBadge network={contact.network} label={networkName(contact.network)} size={14} />
            {networkName(contact.network)}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {card ? (
            <>
              <MessageButton card={card} byContact={byContact} onOpenChat={onOpenChat} />
              <Button size="sm" onClick={() => onOpenPerson(person.personKey)}>
                <Pencil className="size-3.5" /> Edit
              </Button>
            </>
          ) : contact && profile ? (
            <>
              <MessageButton card={{ name, links: [contact] }} byContact={byContact} onOpenChat={onOpenChat} />
              {suggestion ? (
                <Button
                  size="sm"
                  loading={busy}
                  disabled={!loaded}
                  onClick={() => loaded && void addTo(suggestion.personKey, loaded)}
                >
                  <UserPlus className="size-3.5" /> Add to {suggestedName(people, suggestion.personKey)}
                </Button>
              ) : (
                <Button size="sm" loading={busy} disabled={!loaded} onClick={() => loaded && void addNew(loaded)}>
                  <UserPlus className="size-3.5" /> Add to People
                </Button>
              )}
              <Button size="sm" variant="ghost" disabled={!loaded || !people?.length} onClick={() => setChoosing(true)}>
                <Users className="size-3.5" /> {suggestion ? 'Someone else' : 'Add to someone'}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {accounts.length ? (
        <div className="mt-6">
          <Group title={card ? 'Accounts' : undefined}>
            {accounts.map((a) => {
              const chatId = dmChats.get(contactKey(a))
              return (
                <ContactLine key={contactKey(a)} contact={a}>
                  {chatId && !here.has(chatId) ? (
                    <Button size="sm" variant="ghost" onClick={() => onOpenChat(chatId as Id<'chats'>)}>
                      Open
                    </Button>
                  ) : null}
                </ContactLine>
              )
            })}
          </Group>
        </div>
      ) : null}
      {card ? (
        <div className="mt-6 space-y-6 [&>section]:mt-0">
          <FieldGroup title="Phone" fields={card.phones} />
          <FieldGroup title="Email" fields={card.emails} />
          <FieldGroup title="Usernames" fields={card.handles?.map((h) => ({ ...h, value: shownHandle(h.value) }))} />
          <Details card={card} />
        </div>
      ) : null}
      {people && loaded ? (
        <ChoosePerson
          open={choosing}
          onOpenChange={setChoosing}
          people={people}
          onChoose={(p) => {
            setChoosing(false)
            void addTo(p.personKey, loaded)
          }}
        />
      ) : null}
    </div>
  )
}

function suggestedName(people: readonly StoredPerson[] | undefined, key: string) {
  const card = people?.find((p) => p.personKey === key)?.card
  return card ? cardTitle(card) || 'them' : 'them'
}
