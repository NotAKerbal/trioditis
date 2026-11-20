import { describe, expect, it } from 'vitest'
import { importPlanner } from '../src/data/people.ts'

describe('importing in calls', () => {
  it('leaves an entry already written out of later plans, so a card deleted meanwhile stays deleted', () => {
    const existing = [{ personKey: 'person-ann-0000000', card: { name: 'Ann', uid: 'u1' } }]
    const planner = importPlanner([{ name: 'Ann Lee', uid: 'u1' }, { name: 'Bob' }])
    const first = planner.plan(existing)
    expect(first.map((p) => p.card.name)).toEqual(['Ann Lee', 'Bob'])
    // The first call wrote Ann's card; another device then deleted it before the second call.
    planner.written([first[0]!.personKey])
    const again = planner.plan([])
    expect(again.map((p) => p.card.name)).toEqual(['Bob'])
    // Bob's card keeps the key it was planned with.
    expect(again[0]!.personKey).toBe(first[1]!.personKey)
  })
})
