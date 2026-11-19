import { describe, expect, it } from 'vitest'
import { rowPreview } from '../src/features/shell/row-preview.ts'

const msg = (text: string | null, self = false, redacted = false) => ({ at: 1, self, redacted, text })
const base = { previews: true, draft: '', last: null, described: true, topic: undefined, network: 'WhatsApp' }

describe('the second line of a chat in the list', () => {
  it('shows the last message, with "You: " for the person’s own', () => {
    expect(rowPreview({ ...base, last: msg('See you at 7', false, false) })).toEqual({
      kind: 'message',
      text: 'See you at 7',
    })
    expect(rowPreview({ ...base, last: msg('On my way', true, false) }).text).toBe('You: On my way')
  })

  it('puts a draft first, on one line', () => {
    const last = msg('See you at 7', false, false)
    expect(rowPreview({ ...base, last, draft: '  Sounds\ngood  ' })).toEqual({ kind: 'draft', text: 'Sounds good' })
    // Only blank: no draft.
    expect(rowPreview({ ...base, last, draft: '  \n ' }).kind).toBe('message')
  })

  it('says what it can of a message it can’t show', () => {
    expect(rowPreview({ ...base, last: msg(null, false, true) }).text).toBe('Message deleted')
    expect(rowPreview({ ...base, last: msg(null, true, false) }).text).toBe('You: Message')
  })

  it('falls back to the topic, then the network, with no message yet', () => {
    expect(rowPreview({ ...base, topic: 'Weekend plans' }).text).toBe('Weekend plans')
    expect(rowPreview(base).text).toBe('WhatsApp')
    expect(rowPreview({ ...base, described: false }).text).toBe('Waiting for this chat’s details…')
  })

  it('shows only the network with previews off, never message text or a draft', () => {
    const last = msg('secret plans', false, false)
    expect(rowPreview({ ...base, previews: false, last, draft: 'half a thought' })).toEqual({
      kind: 'other',
      text: 'WhatsApp',
    })
  })
})
