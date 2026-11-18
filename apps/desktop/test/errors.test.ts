import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'
import { errorCode, errorMessage, sessionChanged } from '../src/lib/errors.ts'

describe('what an error says', () => {
  it('reads a ConvexError’s sentence, as a string or in { code, message }', () => {
    expect(errorMessage(new ConvexError('That isn’t an email address.'), 'fallback')).toBe(
      'That isn’t an email address.',
    )
    const changed = new ConvexError({
      code: 'sessionChanged',
      message: 'This page’s session has changed. Reload the page.',
    })
    expect(errorMessage(changed, 'fallback')).toBe('This page’s session has changed. Reload the page.')
    expect(errorCode(changed)).toBe('sessionChanged')
    expect(sessionChanged(changed)).toBe(true)
  })

  it('has no code for a sentence, and falls back when there’s nothing to say', () => {
    expect(errorCode(new ConvexError('just a sentence'))).toBeUndefined()
    expect(sessionChanged(new ConvexError('This page’s session has changed.'))).toBe(false)
    expect(errorMessage(new ConvexError({ code: 'x' }), 'fallback')).toBe('fallback')
    expect(errorMessage(new Error('[CONVEX M(keys:setup)] Server Error'), 'fallback')).toBe('fallback')
    expect(errorMessage({ message: 'Invalid password' }, 'fallback')).toBe('Invalid password')
  })
})
