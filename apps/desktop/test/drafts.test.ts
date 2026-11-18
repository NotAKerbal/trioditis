import { describe, expect, it } from 'vitest'
import {
  appendToDraft,
  claimDraft,
  clearDraftIf,
  getDraft,
  releaseDraft,
  restoreDraft,
  setDraftReply,
  setDraftText,
  takeDraft,
} from '../src/data/drafts.ts'

let n = 0
const chat = () => `chat-${++n}`

describe('drafts, wherever the action that changes them finishes', () => {
  it('keeps text typed after a schedule began, even across leaving the chat and coming back', () => {
    const a = chat()
    setDraftText(a, 'happy birthday')
    // Scheduling starts: it notes the draft's revision.
    const rev = getDraft(a).rev
    // The person opens another chat, comes back to this one (the store outlives both panes)…
    setDraftText(chat(), 'elsewhere')
    // …and types before the schedule answers.
    setDraftText(a, 'happy birthday, and see you Sunday')
    clearDraftIf(a, rev)
    expect(getDraft(a).text).toBe('happy birthday, and see you Sunday')
  })

  it('clears what was scheduled when nothing was typed since', () => {
    const a = chat()
    setDraftText(a, 'see you then')
    setDraftReply(a, { id: 'm1' })
    const rev = getDraft(a).rev
    clearDraftIf(a, rev)
    expect(getDraft(a)).toMatchObject({ text: '', reply: null })
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

describe('a draft being scheduled', () => {
  it('can’t be sent or scheduled again until the schedule answers', () => {
    const a = `chat-claim-${Date.now()}`
    setDraftText(a, 'see you tomorrow')
    const rev = claimDraft(a)
    expect(rev).not.toBeNull()
    expect(claimDraft(a)).toBeNull()
    expect(takeDraft(a)).toBeNull()
    expect(getDraft(a).text).toBe('see you tomorrow')
    releaseDraft(a, rev!)
    expect(takeDraft(a)).toEqual({ text: 'see you tomorrow', reply: null })
  })

  it('keeps its revision while claimed, so a schedule still clears it on success', () => {
    const a = `chat-claim-rev-${Date.now()}`
    setDraftText(a, 'happy birthday')
    const rev = claimDraft(a)!
    expect(getDraft(a).rev).toBe(rev)
    clearDraftIf(a, rev)
    releaseDraft(a, rev)
    expect(getDraft(a)).toMatchObject({ text: '', scheduling: null })
  })
})
