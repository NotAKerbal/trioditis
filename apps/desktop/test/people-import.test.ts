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

  it('doesn’t count an entry as written when a later plan moved it to another card', () => {
    // Entry A (Ann, by email) first matches card X; entry B (Bob, by UID) is for card Y.
    const x = { personKey: 'person-x-00000000', card: { name: 'Ann', emails: [{ value: 'ann@x.co' }] } }
    const y = { personKey: 'person-y-00000000', card: { name: 'Bob', uid: 'bob' } }
    const planner = importPlanner([
      { name: 'Ann', emails: [{ value: 'ann@x.co' }], note: 'from file' },
      { name: 'Bob', uid: 'bob', note: 'from file' },
    ])
    expect(planner.plan([x, y]).map((p) => p.personKey)).toEqual([x.personKey, y.personKey])
    // Another device then gives card X Bob's UID and moves Ann's email to card Y. Worked out
    // again, A goes to Y and B to X.
    const x2 = { personKey: x.personKey, card: { name: 'Bob', uid: 'bob' } }
    const y2 = { personKey: y.personKey, card: { name: 'Ann', emails: [{ value: 'ann@x.co' }] } }
    const replanned = planner.plan([x2, y2])
    expect(replanned.map((p) => [p.personKey, p.card.name])).toEqual([
      [y.personKey, 'Ann'],
      [x.personKey, 'Bob'],
    ])
    // X's batch goes through; Y's is refused as stale. Only B was written.
    planner.written([x.personKey])
    const rest = planner.plan([{ ...x2, card: replanned[1]!.card }, y2])
    expect(rest.map((p) => [p.personKey, p.card.name, p.card.note])).toEqual([[y.personKey, 'Ann', 'from file']])
  })
})
