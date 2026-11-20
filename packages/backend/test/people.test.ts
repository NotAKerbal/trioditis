import { describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { MAX_PEOPLE } from '../convex/people'
import { sealed, setup, signIn, type T } from './setup'

const first = { numItems: 100, cursor: null }
const key = (n: number) => `person-key-${String(n).padStart(6, '0')}`

async function count(t: T, userId: string) {
  return await t.run(async (ctx) => {
    const member = await ctx.db
      .query('members')
      .withIndex('by_userId', (q) => q.eq('userId', userId))
      .unique()
    return member?.peopleCount ?? 0
  })
}

describe('people', () => {
  it('stores sealed cards, replaces them by key, and keeps each person’s apart', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const b = await signIn(t, 'user_b')
    await a.mutation(api.people.put, {
      people: [
        { personKey: key(1), sealed: sealed('ann') },
        { personKey: key(2), sealed: sealed('bob') },
      ],
    })
    await a.mutation(api.people.put, { people: [{ personKey: key(1), sealed: sealed('ann2') }] })
    const page = await a.query(api.people.list, { paginationOpts: first })
    expect(page.page.map((p) => [p.personKey, p.sealed.nonce])).toEqual([
      [key(1), sealed('ann2').nonce],
      [key(2), sealed('bob').nonce],
    ])
    expect(page.isDone).toBe(true)
    expect(await count(t, 'user_a')).toBe(2)
    expect((await b.query(api.people.list, { paginationOpts: first })).page).toEqual([])

    // Another person's delete with the same key doesn't touch these.
    await b.mutation(api.people.remove, { personKeys: [key(1)] })
    expect((await a.query(api.people.list, { paginationOpts: first })).page).toHaveLength(2)
    await a.mutation(api.people.remove, { personKeys: [key(1), key(1), key(9)] })
    expect((await a.query(api.people.list, { paginationOpts: first })).page.map((p) => p.personKey)).toEqual([key(2)])
    expect(await count(t, 'user_a')).toBe(1)
  })

  it('refuses keys, envelopes and batches it shouldn’t store', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    await expect(a.mutation(api.people.put, { people: [{ personKey: 'short', sealed: sealed() }] })).rejects.toThrow(
      /person ID/,
    )
    const plaintext = { ...sealed(), ct: 'not base64url!' }
    await expect(a.mutation(api.people.put, { people: [{ personKey: key(1), sealed: plaintext }] })).rejects.toThrow(
      /isn’t sealed/,
    )
    await expect(
      a.mutation(api.people.put, {
        people: [
          { personKey: key(1), sealed: sealed() },
          { personKey: key(1), sealed: sealed() },
        ],
      }),
    ).rejects.toThrow(/once per call/)
    const many = Array.from({ length: 101 }, (_, i) => ({ personKey: key(i), sealed: sealed() }))
    await expect(a.mutation(api.people.put, { people: many })).rejects.toThrow(/at most 100/)
    // A batch that fails stores nothing.
    expect((await a.query(api.people.list, { paginationOpts: first })).page).toEqual([])
  })

  it('stops at the cap, counting only new cards', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query('members')
        .withIndex('by_userId', (q) => q.eq('userId', 'user_a'))
        .unique()
      await ctx.db.patch(member!._id, { peopleCount: MAX_PEOPLE - 1 })
    })
    await a.mutation(api.people.put, { people: [{ personKey: key(1), sealed: sealed() }] })
    // Replacing a card adds none.
    await a.mutation(api.people.put, { people: [{ personKey: key(1), sealed: sealed('again') }] })
    await expect(a.mutation(api.people.put, { people: [{ personKey: key(2), sealed: sealed() }] })).rejects.toThrow(
      /at most 10,000 people/,
    )
    expect(await count(t, 'user_a')).toBe(MAX_PEOPLE)
  })

  it('refuses a card sealed on a page whose sign-in has changed', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    await expect(
      a.mutation(api.people.put, { people: [{ personKey: key(1), sealed: sealed() }], sessionId: 'another-session' }),
    ).rejects.toThrow()
  })
})

describe('contacts', () => {
  it('lists the person’s contacts on every network, a page at a time', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    await t.run(async (ctx) => {
      for (const [userId, network, ghostId] of [
        ['user_a', 'whatsapp', 'g_1'],
        ['user_a', 'signal', 'g_2'],
        ['user_a', 'fake', 'g_3'],
        ['user_b', 'whatsapp', 'g_4'],
      ] as const) {
        await ctx.db.insert('contacts', {
          userId,
          network: network as 'whatsapp',
          ghostId,
          sealedProfile: sealed(ghostId),
        })
      }
    })
    const page = await a.query(api.contacts.list, { paginationOpts: { numItems: 10, cursor: null } })
    expect(page.page.map((c) => [c.network, c.ghostId]).sort((x, y) => x.join().localeCompare(y.join()))).toEqual([
      ['signal', 'g_2'],
      ['whatsapp', 'g_1'],
    ])
    // A page can come back empty (a retired network's contacts are left out) before the end.
    const seen: string[] = []
    let cursor: string | null = null
    for (let pages = 0; pages < 10; pages++) {
      const small: { page: { ghostId: string }[]; isDone: boolean; continueCursor: string } = await a.query(
        api.contacts.list,
        { paginationOpts: { numItems: 1, cursor } },
      )
      seen.push(...small.page.map((c) => c.ghostId))
      if (small.isDone) break
      cursor = small.continueCursor
    }
    expect(seen.sort((x, y) => x.localeCompare(y))).toEqual(['g_1', 'g_2'])
  })
})
