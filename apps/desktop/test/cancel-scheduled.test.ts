import { describe, expect, it } from 'vitest'
import { restoreConflict } from '../src/features/chat/cancel-scheduled.ts'

const draft = (text: string, eventId: string | null = null) => ({ text, reply: eventId ? { eventId } : null })

describe('putting a cancelled message back in the composer', () => {
  it('goes into an empty composer, reply or not', () => {
    expect(restoreConflict(draft(''), null)).toBe(false)
    expect(restoreConflict(draft('   '), 'e1')).toBe(false)
  })

  it('joins a draft that replies to the same message, or neither replies', () => {
    expect(restoreConflict(draft('hi', 'e1'), 'e1')).toBe(false)
    expect(restoreConflict(draft('hi'), null)).toBe(false)
  })

  it('never merges under a different reply: it stays on the server instead', () => {
    expect(restoreConflict(draft('hi', 'e2'), 'e1')).toBe(true)
    // The draft would become a reply, or the reply would be lost.
    expect(restoreConflict(draft('hi'), 'e1')).toBe(true)
    expect(restoreConflict(draft('hi', 'e2'), null)).toBe(true)
    // A reply chosen with nothing typed yet is a draft too.
    expect(restoreConflict(draft('', 'e2'), 'e1')).toBe(true)
  })
})
