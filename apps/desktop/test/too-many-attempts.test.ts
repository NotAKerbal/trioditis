import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'
import { errorMessage, tooManyAttempts } from '../src/lib/errors.ts'

describe('too many attempts', () => {
  it('says how long to wait, from Retry-After', () => {
    const limited = { status: 429, message: 'Too many requests. Please try again later.' }
    expect(tooManyAttempts(limited, 12)).toBe('Too many attempts. Try again in 12 seconds.')
    expect(tooManyAttempts(limited, 1)).toBe('Too many attempts. Try again in 1 second.')
    expect(tooManyAttempts(limited, null)).toBe('Too many attempts. Wait a moment, then try again.')
    expect(tooManyAttempts({ status: 401, message: 'Invalid email or password' }, 12)).toBeNull()
    expect(tooManyAttempts(null, 12)).toBeNull()
  })

  it('shows the per-account password limit as the server words it', () => {
    const limited = new ConvexError('Too many password attempts. Try again in 40 seconds.')
    expect(errorMessage(limited, 'Your password couldn’t be changed.')).toBe(
      'Too many password attempts. Try again in 40 seconds.',
    )
  })
})
