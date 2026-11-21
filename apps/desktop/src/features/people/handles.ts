import { parseIdentifier, type PersonField } from '@trioditis/core'

// Usernames on a card, as the People form edits them: a service and a name, stored as
// `service:name` so they match what networks report. A username keeps its own label too (an
// iPhone's "Personal", say), which the form doesn't show, so it's carried through unchanged.

/** A username as the form edits it, with the field it came from. */
export interface HandleField extends PersonField {
  /** The card's field this was made from, to give back as it was when it isn't edited. */
  from?: PersonField
}

/** A card's username for the form: its service as the label, when it names one. */
export function toHandleField(f: PersonField): HandleField {
  const id = parseIdentifier(f.value)
  return id?.kind === 'username'
    ? { value: id.value, label: id.service, from: f }
    : { value: f.value, label: '', from: f }
}

/**
 * A form's username back as the card holds it, or null when it was emptied. One the person
 * didn't touch is the card's field as it was, its own label and all; an edited one keeps the
 * label it had, since the form's label box is its service, not its label.
 */
export function fromHandleField(f: HandleField): PersonField | null {
  const value = f.value.trim().replace(/^@/, '')
  if (!value) return null
  if (f.from) {
    const shown = toHandleField(f.from)
    if (shown.value === f.value && (shown.label ?? '') === (f.label ?? '')) return f.from
  }
  const service = f.label?.trim().toLowerCase()
  const stored = service && !value.includes(':') ? `${service}:${value}` : value
  const label = f.from?.label
  return label ? { value: stored, label } : { value: stored }
}
