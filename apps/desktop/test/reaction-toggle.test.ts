import { describe, expect, it } from 'vitest'
import { confirmed, sameKey, shownKey, withPending, type Reaction } from '../src/data/reaction-toggle.ts'

const HEART = '❤'
const HEART_EMOJI = '❤️'
const r = (key: string, count: number, mine = false): Reaction => ({ key, count, more: false, mine })
const server = new Map([['m1', [r(HEART, 2, true), r('👍', 1)]]])
const pending = (messageId: string, key: string, remove = false) => ({ messageId, key, remove, at: 0 })

describe('the person’s own reactions before the echo', () => {
  it('compares keys without variation selectors, and shows a lone symbol as an emoji', () => {
    expect(sameKey(HEART, HEART_EMOJI)).toBe(true)
    expect(sameKey('👍', HEART)).toBe(false)
    expect(shownKey(HEART)).toBe(HEART_EMOJI)
    expect(shownKey('👍')).toBe('👍')
    expect(shownKey('👨‍👩‍👧')).toBe('👨‍👩‍👧')
  })

  it('adds to a count, starts a new one, and takes the person’s own away', () => {
    const shown = withPending(server, [pending('m1', '👍'), pending('m1', HEART_EMOJI, true), pending('m2', '😂')])
    expect(shown.get('m1')).toEqual([r(HEART, 1), r('👍', 2, true)])
    expect(shown.get('m2')).toEqual([r('😂', 1, true)])
    // The server's answer is left as it was.
    expect(server.get('m1')).toEqual([r(HEART, 2, true), r('👍', 1)])
  })

  it('drops a count to nothing, and ignores a removal of what isn’t the person’s', () => {
    const one = new Map([['m1', [r('🎉', 1, true), r('👍', 1)]]])
    expect(withPending(one, [pending('m1', '🎉', true), pending('m1', '👍', true)]).get('m1')).toEqual([r('👍', 1)])
  })

  it('is confirmed once the server says the same', () => {
    expect(confirmed(pending('m1', HEART_EMOJI), server)).toBe(true)
    expect(confirmed(pending('m1', '👍'), server)).toBe(false)
    expect(confirmed(pending('m1', HEART, true), server)).toBe(false)
    expect(confirmed(pending('m1', '👍', true), server)).toBe(true)
    expect(confirmed(pending('m9', '👍', true), server)).toBe(true)
  })
})
