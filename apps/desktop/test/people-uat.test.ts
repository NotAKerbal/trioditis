import type { PersonPlaintext } from '@trioditis/core'
import { describe, expect, it } from 'vitest'
import { fitCard, importPlanner, newCards, tooMany } from '../src/data/people.ts'
import { identifierProblem, startError } from '../src/data/new-chat.ts'
import { fromHandleField, toHandleField } from '../src/features/people/handles.ts'
import { emptyReport, importSummary, partlyImported } from '../src/features/people/import-report.ts'
import { PAGE_ROWS, pageOf } from '../src/features/people/paging.ts'

const bytes = (card: PersonPlaintext) => new TextEncoder().encode(JSON.stringify(card)).length
const LIMIT = 60 * 1024

describe('large cards', () => {
  const photo = `data:image/jpeg;base64,${'A'.repeat(30_000)}`
  // A stand-in for the canvas: each size gives a picture of that many hundred bytes.
  const shrink = async (_photo: string, pixels: number) => `data:image/jpeg;base64,${'B'.repeat(pixels * 100)}`

  it('leaves a card that fits as it is', async () => {
    const card = { name: 'Ann', photo, note: 'hi' }
    expect(await fitCard(card, shrink)).toEqual({ card, fits: true })
  })

  it('makes the photo smaller before anything else, and keeps the whole note', async () => {
    const note = 'n'.repeat(LIMIT - 20_000)
    const fit = await fitCard({ name: 'Ann', photo, note }, shrink)
    expect(fit.fits).toBe(true)
    expect(fit.photo).toBe('smaller')
    expect(fit.card.note).toBe(note)
    expect(bytes(fit.card)).toBeLessThanOrEqual(LIMIT)
  })

  it('refuses an edit it can only save by cutting the note, rather than cutting it', async () => {
    const note = 'n'.repeat(LIMIT + 10)
    const fit = await fitCard({ name: 'Ann', photo, note }, shrink)
    expect(fit.fits).toBe(false)
    expect(fit.card.note).toBe(note)
  })

  it('cuts an imported note only as a last resort, and says by how much', async () => {
    const note = 'n'.repeat(LIMIT + 10)
    const fit = await fitCard({ name: 'Ann', photo, note }, shrink, { cutNote: true })
    expect(fit.fits).toBe(true)
    expect(fit.photo).toBe('dropped')
    expect(fit.noteCut).toBeGreaterThan(0)
    expect(fit.card.note!.length + fit.noteCut!).toBe(note.length)
  })

  it('reports every change an import made in its summary', () => {
    const report = { ...emptyReport(), written: 3, unreadablePhotos: 1, smallerPhotos: 2, droppedPhotos: 1 }
    report.cutNotes.push('Ann Lee')
    const text = importSummary(report)
    expect(text).toContain('Imported 3 people.')
    expect(text).toContain('1 photo was unreadable and left out.')
    expect(text).toContain('2 photos were made smaller to fit.')
    expect(text).toContain('1 photo was left out of cards too large')
    expect(text).toContain('The note on Ann Lee was too long and was shortened.')
    expect(importSummary({ ...emptyReport(), unchanged: true })).toBe('Everyone in that file is here already.')
  })
})

describe('big imports', () => {
  it('counts only new cards against the limit, and says by how much it would go over', () => {
    const people = [{ personKey: 'a', card: { name: 'A' } }]
    expect(
      newCards(people, [
        { personKey: 'a', card: { name: 'A2' } },
        { personKey: 'b', card: { name: 'B' } },
      ]),
    ).toBe(1)
    expect(tooMany(0, 10_001)).toBe(
      'That would add 10,001 people, and there’s room for 10,000 more (People holds 10,000).',
    )
  })

  it('says how far a stopped import got, and that importing again won’t duplicate', () => {
    expect(partlyImported(300, 1000, 'Your connection dropped.')).toBe(
      'Imported 300 of 1,000 people before it stopped: Your connection dropped. ' +
        'Import the file again to add the rest; those already imported won’t be added twice.',
    )
  })

  it('finishes a stopped import by updating what it wrote, not adding it again', () => {
    const file = [
      { name: 'Ann', phones: [{ value: '+15551234567' }] },
      { name: 'Bob', emails: [{ value: 'bob@example.com' }] },
    ]
    const first = importPlanner(file).plan([])
    // The first run wrote Ann, then stopped. A second import of the same file starts afresh.
    const again = importPlanner(file).plan([first[0]!])
    expect(again.map((p) => p.card.name)).toEqual(['Bob'])
  })
})

describe('usernames in the form', () => {
  it('gives back an untouched username with its own label', () => {
    const field = { value: 'telegram:alice', label: 'Personal' }
    expect(fromHandleField(toHandleField(field))).toBe(field)
    const plain = { value: 'alice', label: 'work' }
    expect(fromHandleField(toHandleField(plain))).toBe(plain)
  })

  it('keeps the label of a username that was edited', () => {
    const shown = toHandleField({ value: 'telegram:alice', label: 'Personal' })
    expect(fromHandleField({ ...shown, value: 'alice2' })).toEqual({ value: 'telegram:alice2', label: 'Personal' })
  })

  it('stores a new username with its service, and drops an emptied one', () => {
    expect(fromHandleField({ value: '@bob', label: 'Signal' })).toEqual({ value: 'signal:bob' })
    expect(fromHandleField({ ...toHandleField({ value: 'telegram:alice' }), value: ' ' })).toBeNull()
  })
})

describe('long lists', () => {
  it('shows a page at a time and says how many more there are', () => {
    const rows = Array.from({ length: PAGE_ROWS + 5 }, (_, i) => i)
    expect(pageOf(rows, PAGE_ROWS).shown).toHaveLength(PAGE_ROWS)
    expect(pageOf(rows, PAGE_ROWS).more).toBe(5)
    expect(pageOf(rows, PAGE_ROWS * 2)).toEqual({ shown: rows, more: 0 })
  })
})

describe('starting a chat from a number', () => {
  it('says why a number can’t be used, instead of that no one has it', () => {
    expect(identifierProblem('needs_country_code', 'signal')).toContain('country code')
    expect(identifierProblem('phone_only', 'whatsapp')).toContain('phone numbers, not usernames')
    expect(startError('not_found', 'whatsapp')).not.toContain('No one on')
  })
})
