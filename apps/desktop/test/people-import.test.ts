import type { Person, PersonPlaintext } from '@trioditis/core'
import { describe, expect, it } from 'vitest'
import { importPlanner, saveInCalls } from '../src/data/people.ts'

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

  it('writes a card again when another device’s change puts a pending entry on it', async () => {
    const phone = '+15550000001'
    // X is entry 0's card by UID; Y has the number entry C (the last) is found by.
    let store: Person[] = [
      { personKey: 'person-x-00000000', card: { name: 'Cat', uid: 'u0' } },
      { personKey: 'person-y-00000000', card: { name: 'Cat', phones: [{ value: phone }] } },
    ]
    const file: PersonPlaintext[] = [
      { name: 'Cat', uid: 'u0', note: 'from file' },
      // Enough new people that C's card goes in a second call.
      ...Array.from({ length: 99 }, (_, i) => ({ name: `New ${i}` })),
      { name: 'Cat', phones: [{ value: phone }], org: 'Acme' },
    ]
    const planner = importPlanner(file)
    let revision = 0
    let calls = 0
    const stale = new Error('people_changed')
    const put = async (batch: Person[], at: number) => {
      calls++
      if (at !== revision) throw stale
      if (calls === 2) {
        // Before the second call lands, another device moves the number from Y to X.
        store = store.map((p) =>
          p.personKey === 'person-x-00000000'
            ? { ...p, card: { ...p.card, phones: [{ value: phone }] } }
            : p.personKey === 'person-y-00000000'
              ? { ...p, card: { name: 'Cat' } }
              : p,
        )
        revision++
        throw stale
      }
      const byKey = new Map(store.map((p) => [p.personKey, p]))
      for (const p of batch) byKey.set(p.personKey, p)
      store = [...byKey.values()]
      return ++revision
    }
    const attempt = async (write: (people: readonly Person[], revision: number) => Promise<void>) => {
      for (let i = 0; ; i++) {
        try {
          return await write(store, revision)
        } catch (err) {
          if (err !== stale || i >= 4) throw err
        }
      }
    }
    const written = await saveInCalls(
      { attempt, put, fit: async (cards) => [...cards] },
      planner.plan,
      planner.written,
      { skipWritten: false },
    )
    const x = store.find((p) => p.personKey === 'person-x-00000000')!.card
    // C landed on X, which the first call had already written, and X kept entry 0's note.
    expect(x).toMatchObject({ name: 'Cat', uid: 'u0', note: 'from file', org: 'Acme', phones: [{ value: phone }] })
    expect(store.filter((p) => p.card.name === 'Cat')).toHaveLength(2)
    expect(written).toBe(100)
    expect(planner.unwritten()).toEqual([])
  })
})
