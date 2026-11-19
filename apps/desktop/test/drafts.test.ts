import { describe, expect, it } from 'vitest'
import { appendToDraft, getDraft, restoreDraft, setDraftReply, setDraftText, takeDraft } from '../src/data/drafts.ts'

let n = 0
const chat = () => `chat-${++n}`

describe('drafts, wherever the action that changes them finishes', () => {
  it('takes a draft once: what was taken can’t be taken again', () => {
    const a = chat()
    setDraftText(a, 'happy birthday')
    expect(takeDraft(a)).toEqual({ text: 'happy birthday', reply: null })
    // A second schedule, or a send, finds nothing to send.
    expect(takeDraft(a)).toBeNull()
  })

  it('never sends what was scheduled again, though an earlier send fails meanwhile', () => {
    const a = chat()
    // Send A; while it's on its way, schedule B.
    setDraftText(a, 'A')
    const sent = takeDraft(a)!
    setDraftText(a, 'B')
    const scheduled = takeDraft(a)!
    expect(scheduled.text).toBe('B')
    // A doesn't go and comes back; then B's schedule succeeds, leaving it out of the composer.
    restoreDraft(a, sent.text, sent.reply)
    expect(getDraft(a).text).toBe('A')
    expect(takeDraft(a)).toEqual({ text: 'A', reply: null })
  })

  it('keeps text typed after a schedule began, even across leaving the chat and coming back', () => {
    const a = chat()
    setDraftText(a, 'happy birthday')
    const scheduled = takeDraft(a)!
    // The person opens another chat, comes back (the store outlives both panes), and types.
    setDraftText(chat(), 'elsewhere')
    setDraftText(a, 'and see you Sunday')
    // The schedule fails: its text comes back ahead of the new text, which stays.
    restoreDraft(a, scheduled.text, scheduled.reply)
    expect(getDraft(a).text).toBe('happy birthday\nand see you Sunday')
  })

  it('puts a failed send back ahead of anything typed since, and its reply only if none is set', () => {
    const a = chat()
    setDraftText(a, '  first  ')
    setDraftReply(a, { id: 'm1' })
    const taken = takeDraft<{ id: string }>(a)
    expect(taken).toEqual({ text: 'first', reply: { id: 'm1' } })
    expect(getDraft(a)).toMatchObject({ text: '', reply: null })
    setDraftText(a, 'second')
    setDraftReply(a, { id: 'm2' })
    restoreDraft(a, taken!.text, taken!.reply)
    expect(getDraft(a)).toMatchObject({ text: 'first\nsecond', reply: { id: 'm2' } })
  })

  it('has nothing to take from an empty draft', () => {
    const a = chat()
    setDraftText(a, '   ')
    expect(takeDraft(a)).toBeNull()
    expect(getDraft(a).text).toBe('   ')
  })

  it('adds a cancelled message below the draft, saying whether there was one', () => {
    const a = chat()
    expect(appendToDraft(a, 'cancelled')).toBe(false)
    expect(getDraft(a).text).toBe('cancelled')
    expect(appendToDraft(a, 'another')).toBe(true)
    expect(getDraft(a).text).toBe('cancelled\nanother')
  })

  it('only ever raises the revision, even through an empty draft', () => {
    const a = chat()
    setDraftText(a, 'x')
    const before = getDraft(a).rev
    setDraftText(a, '')
    setDraftText(a, 'x')
    expect(getDraft(a).rev).toBeGreaterThan(before)
  })
})
