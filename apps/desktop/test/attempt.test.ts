import { describe, expect, it } from 'vitest'
import { attempt, errorMessage, UNREACHABLE } from '../src/lib/errors.ts'

describe('an auth request a form waits on', () => {
  it('passes the server’s answer through', async () => {
    expect(await attempt(async () => ({ data: { ok: 1 }, error: null }))).toEqual({ data: { ok: 1 }, error: null })
    const refused = await attempt(async () => ({ data: null, error: { status: 401, message: 'No.' } }))
    expect(errorMessage(refused.error, 'fallback')).toBe('No.')
  })

  it('answers with an error, never a rejection, when the request never got an answer', async () => {
    const result = await attempt(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect(result.data).toBeNull()
    expect(errorMessage(result.error, 'fallback')).toBe(UNREACHABLE)
  })

  it('keeps what went wrong when something else threw', async () => {
    const result = await attempt(async () => {
      throw new Error('out of memory deriving the password')
    })
    expect(errorMessage(result.error, 'fallback')).toBe('out of memory deriving the password')
  })
})
