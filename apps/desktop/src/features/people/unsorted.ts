import { cardFromContacts, parseIdentifier, type NetworkContact } from '@trioditis/core'

// The contacts on no card, as the Not in People list shows them: one row a group, with the
// group's name and what its contacts are known by.

/** An identifier as a row shows it, or '' for a network's own internal ID nobody would type. */
export function shownIdentifier(raw: string) {
  const id = parseIdentifier(raw)
  if (!id) return raw
  if (id.kind !== 'username') return id.value
  return id.service.endsWith('-internal') ? '' : `@${id.value}`
}

export interface UnsortedRow {
  contacts: NetworkContact[]
  name: string
  details: string[]
}

export function unsortedRow(contacts: NetworkContact[]): UnsortedRow {
  const details = new Set(
    contacts.flatMap((c) => [...(c.identifiers ?? []), c.profile.handle ?? ''].map(shownIdentifier)),
  )
  details.delete('')
  return { contacts, name: cardFromContacts(contacts).name ?? '', details: [...details] }
}

/**
 * Whether a row matches a search: by name, number, email or username. A number matches by its
 * digits, however it's written, once three or more are typed.
 */
export function rowMatches(row: UnsortedRow, query: string) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if ([row.name, ...row.details].some((t) => t.toLowerCase().includes(q))) return true
  const digits = q.replace(/\D/g, '')
  return digits.length >= 3 && row.details.some((d) => d.replace(/\D/g, '').includes(digits))
}
