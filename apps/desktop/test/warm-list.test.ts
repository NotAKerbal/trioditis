import { describe, expect, it } from 'vitest'
import { warmList } from '~/data/warm-list.ts'

const ids = (list: ReturnType<typeof warmList<{ id: string }>>) => list.get().map((i) => i.id)

describe('warmList', () => {
  it('keeps the most recently wanted first, and lets go of the oldest past its limit', () => {
    const list = warmList<{ id: string }>(3)
    for (const id of ['a', 'b', 'c', 'd']) list.add({ id })
    expect(ids(list)).toEqual(['d', 'c', 'b'])
  })

  it('moves one wanted again to the front without listing it twice', () => {
    const list = warmList<{ id: string }>(3)
    for (const id of ['a', 'b', 'c', 'a']) list.add({ id })
    expect(ids(list)).toEqual(['a', 'c', 'b'])
  })

  it('tells listeners of changes only, so a pointer resting on one row is no work', () => {
    const list = warmList<{ id: string }>(3)
    let heard = 0
    const stop = list.subscribe(() => heard++)
    list.add({ id: 'a' })
    const before = list.get()
    list.add({ id: 'a' })
    expect(heard).toBe(1)
    // The same list, so React sees nothing changed.
    expect(list.get()).toBe(before)
    stop()
    list.add({ id: 'b' })
    expect(heard).toBe(1)
  })
})
