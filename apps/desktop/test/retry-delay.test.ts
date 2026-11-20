import { describe, expect, it } from 'vitest'
import { failuresInARow, retryDelay } from '../src/features/shell/retry-delay.ts'

describe('retrying the chat list', () => {
  it('waits 2 seconds, then twice as long each time, up to 30', () => {
    expect([1, 2, 3, 4, 5, 6].map(retryDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000])
  })

  it('counts errors in a row, and starts again after a quiet minute', () => {
    const now = 1_000_000
    expect(failuresInARow(0, 0, now)).toBe(1)
    expect(failuresInARow(3, now - 5_000, now)).toBe(4)
    expect(failuresInARow(3, now - 61_000, now)).toBe(1)
  })
})
