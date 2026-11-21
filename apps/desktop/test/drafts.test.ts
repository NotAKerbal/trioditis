import { describe, expect, it, vi } from 'vitest'
import { appendToDraft, getDraft, restoreDraft, setDraftReply, setDraftText, takeDraft } from '../src/data/drafts.ts'

let n = 0
const chat = () => `chat-${++n}`

describe('drafts, wherever the action that changes them finishes', () => {
  it('takes a draft once: what was taken can’t be taken again', () => {
    const a = chat()
    setDraftText(a, 'happy birthday')
    expect(takeDraft(a)).toMatchObject({ text: 'happy birthday', reply: null })
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
    expect(takeDraft(a)).toMatchObject({ text: 'A', reply: null })
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
    expect(taken).toMatchObject({ text: 'first', reply: { id: 'm1' } })
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

  it('puts a cancelled reply’s target back with its text, unless a reply is set already', () => {
    const a = chat()
    appendToDraft(a, 'see you then', { eventId: 'e1' })
    expect(getDraft(a)).toMatchObject({ text: 'see you then', reply: { eventId: 'e1' } })
    // The reply chosen since is the newer choice.
    appendToDraft(a, 'and this', { eventId: 'e2' })
    expect(getDraft(a).reply).toEqual({ eventId: 'e1' })
    // A cancelled message that wasn't a reply leaves the reply alone.
    const b = chat()
    setDraftReply(b, { eventId: 'e3' })
    appendToDraft(b, 'plain')
    expect(getDraft(b).reply).toEqual({ eventId: 'e3' })
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

describe('what a reload would lose', () => {
  it('counts a taken draft until its send settles, failure and restore included', async () => {
    // A fresh store: the tests above leave drafts in theirs.
    vi.resetModules()
    const drafts = await import('../src/data/drafts.ts')
    expect(drafts.hasDrafts()).toBe(false)
    drafts.setDraftText('a', 'on its way')
    const taken = drafts.takeDraft('a')!
    let fail!: (e: Error) => void
    const sending = drafts.whileSending(() =>
      new Promise<void>((_, reject) => (fail = reject)).catch(() => drafts.restoreDraft('a', taken.text, taken.reply)),
    )
    // The text is in neither the draft nor the server yet.
    expect(drafts.getDraft('a').text).toBe('')
    expect(drafts.hasDrafts()).toBe(true)
    fail(new Error('offline'))
    await sending
    expect(drafts.getDraft('a').text).toBe('on its way')
    drafts.setDraftText('a', '')
    expect(drafts.hasDrafts()).toBe(false)
  })
})
