// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { withOriginalFiles } from '../src/data/messages.ts'

const picture = { mediaId: 'm', mime: 'image/png', size: 1, name: 'a.png', key: 'k', nonce: 'n' }

describe('an edited message as shown', () => {
  it('keeps the original’s picture when the edit changed only its caption', () => {
    const original = { type: 'image' as const, body: 'old caption', attachments: [picture] }
    expect(withOriginalFiles({ type: 'text', body: 'new caption' }, original)).toEqual({
      type: 'image',
      body: 'new caption',
      attachments: [picture],
    })
  })

  it('shows an edit with files of its own, or of a message without any, as it is', () => {
    const other = { ...picture, mediaId: 'n' }
    const own = { type: 'image' as const, body: 'b', attachments: [other] }
    expect(withOriginalFiles(own, { type: 'image', body: 'a', attachments: [picture] })).toBe(own)
    const text = { type: 'text' as const, body: 'changed' }
    expect(withOriginalFiles(text, { type: 'text', body: 'hello' })).toBe(text)
    expect(withOriginalFiles(text, null)).toBe(text)
  })
})
