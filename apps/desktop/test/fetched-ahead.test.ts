import { describe, expect, it } from 'vitest'
import { failedAhead, fetchAheadFailed } from '~/data/fetched-ahead.ts'

describe('fetched ahead', () => {
  it('remembers a failure for longer than the cache keeps it, then forgets it', () => {
    fetchAheadFailed('chat:a', 0)
    expect(failedAhead('chat:a', 5 * 60_000 + 1)).toBe(true)
    expect(failedAhead('chat:a', 6 * 60_000 + 1)).toBe(false)
    expect(failedAhead('chat:a', 0)).toBe(false)
  })

  it('knows only what failed', () => {
    fetchAheadFailed('people', 0)
    expect(failedAhead('chat:b', 0)).toBe(false)
  })
})
