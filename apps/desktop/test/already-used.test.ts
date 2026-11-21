import { describe, expect, it } from 'vitest'
import { wentAlready } from '../src/features/chat/already-used.ts'

describe('a draft whose send ID was used already', () => {
  it('is done when that send went, or may have, or a schedule still stands', () => {
    for (const delivery of ['queued', 'claimed', 'submitted', 'sent', 'delivered', 'read', 'unknown'] as const)
      expect(wentAlready({ already: 'send', delivery })).toBe(true)
    expect(wentAlready({ already: 'scheduled', state: 'scheduled' })).toBe(true)
  })

  it('keeps its text when that use never went: cancelled, failed or discarded', () => {
    expect(wentAlready({ already: 'scheduled', state: 'cancelled' })).toBe(false)
    expect(wentAlready({ already: 'scheduled', state: 'failed' })).toBe(false)
    expect(wentAlready({ already: 'send', delivery: 'failed' })).toBe(false)
    expect(wentAlready({ already: 'send', delivery: null })).toBe(false)
  })
})
