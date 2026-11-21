import { beforeEach, describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { MAX_PEOPLE } from '../convex/people'
import { GATEWAY_SECRET, heartbeat, sealed, setup, signIn, type T } from './setup'

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

// A fresh backend expects a host's events from the first sequence number.
let seq = 0
beforeEach(() => {
  seq = 0
})
async function ingest(t: T, events: Record<string, unknown>[]) {
  return await t.mutation(api.gateway.ingest, {
    secret: GATEWAY_SECRET,
    hostId: 'whatsapp-1',
    network: 'whatsapp',
    events: events.map((e) => ({ userId: 'user_a', loginId: 'login_a', at: 1_000, seq: ++seq, ...e })) as never,
  })
}

describe('people', () => {
  it('stores sealed cards, replaces them by key, and keeps each person’s apart', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const b = await signIn(t, 'user_b')
    expect(await a.query(api.people.revision, {})).toBe(0)
    let revision = await a.mutation(api.people.put, {
      people: [
        { personKey: key(1), sealed: sealed('ann') },
        { personKey: key(2), sealed: sealed('bob') },
      ],
      revision: 0,
    })
    revision = await a.mutation(api.people.put, { people: [{ personKey: key(1), sealed: sealed('ann2') }], revision })
    expect(revision).toBe(2)
    expect(await a.query(api.people.revision, {})).toBe(2)
    const page = await a.query(api.people.list, { paginationOpts: first })
    expect(page.page.map((p) => [p.personKey, p.sealed.nonce])).toEqual([
      [key(1), sealed('ann2').nonce],
      [key(2), sealed('bob').nonce],
    ])
    expect(page.isDone).toBe(true)
    expect(await count(t, 'user_a')).toBe(2)
    expect((await b.query(api.people.list, { paginationOpts: first })).page).toEqual([])

    // Another person's delete with the same key doesn't touch these.
    await b.mutation(api.people.remove, { personKeys: [key(1)], revision: 0 })
    expect((await a.query(api.people.list, { paginationOpts: first })).page).toHaveLength(2)
    revision = await a.mutation(api.people.remove, { personKeys: [key(1), key(1), key(9)], revision })
    expect((await a.query(api.people.list, { paginationOpts: first })).page.map((p) => p.personKey)).toEqual([key(2)])
    expect(await count(t, 'user_a')).toBe(1)
    expect(revision).toBe(3)
  })

  it('refuses a write made from an older address book', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    await a.mutation(api.people.put, { people: [{ personKey: key(1), sealed: sealed('ann') }], revision: 0 })
    // A second device still at revision 0 links the same contact to another card.
    await expect(
      a.mutation(api.people.put, { people: [{ personKey: key(2), sealed: sealed('bob') }], revision: 0 }),
    ).rejects.toThrow(/changed on another device/)
    await expect(a.mutation(api.people.remove, { personKeys: [key(1)], revision: 0 })).rejects.toThrow(
      /changed on another device/,
    )
    expect((await a.query(api.people.list, { paginationOpts: first })).page.map((p) => p.personKey)).toEqual([key(1)])
  })

  it('refuses keys, envelopes and batches it shouldn’t store', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const put = (people: { personKey: string; sealed: ReturnType<typeof sealed> }[]) =>
      a.mutation(api.people.put, { people, revision: 0 })
    await expect(put([{ personKey: 'short', sealed: sealed() }])).rejects.toThrow(/person ID/)
    await expect(put([{ personKey: key(1), sealed: { ...sealed(), ct: 'not base64url!' } }])).rejects.toThrow(
      /isn’t sealed/,
    )
    await expect(
      put([
        { personKey: key(1), sealed: sealed() },
        { personKey: key(1), sealed: sealed() },
      ]),
    ).rejects.toThrow(/once per call/)
    await expect(put(Array.from({ length: 101 }, (_, i) => ({ personKey: key(i), sealed: sealed() })))).rejects.toThrow(
      /at most 100/,
    )
    // A batch that fails stores nothing.
    expect((await a.query(api.people.list, { paginationOpts: first })).page).toEqual([])
    expect(await a.query(api.people.revision, {})).toBe(0)
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
    let revision = await a.mutation(api.people.put, { people: [{ personKey: key(1), sealed: sealed() }], revision: 0 })
    // Replacing a card adds none.
    revision = await a.mutation(api.people.put, { people: [{ personKey: key(1), sealed: sealed('again') }], revision })
    await expect(
      a.mutation(api.people.put, { people: [{ personKey: key(2), sealed: sealed() }], revision }),
    ).rejects.toThrow(/at most 10,000 people/)
    expect(await count(t, 'user_a')).toBe(MAX_PEOPLE)
  })

  it('refuses a card sealed on a page whose sign-in has changed', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    await expect(
      a.mutation(api.people.put, {
        people: [{ personKey: key(1), sealed: sealed() }],
        revision: 0,
        sessionId: 'another-session',
      }),
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
    expect(page.page.map((c) => `${c.network}/${c.ghostId}`).sort((x, y) => x.localeCompare(y))).toEqual([
      'signal/g_2',
      'whatsapp/g_1',
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

  it('keeps what each login knows a contact by apart from the profile every member gets', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    await ingest(t, [{ type: 'loginState', state: 'CONNECTED' }])
    // Identifiers need no profile first; a later profile update leaves them alone.
    await ingest(t, [
      { type: 'contactIdentifiers', ghostId: 'g_1', sealed: sealed('idents') },
      { type: 'contact', ghostId: 'g_1', sealed: sealed('profile') },
      { type: 'contact', ghostId: 'g_1', sealed: sealed('profile2') },
    ])
    expect((await a.query(api.contacts.list, { paginationOpts: first })).page).toEqual([
      { network: 'whatsapp', ghostId: 'g_1', sealedProfile: sealed('profile2') },
    ])
    // Each login's are its own: another login's don't replace these, and a login's newer ones do.
    await ingest(t, [
      { type: 'loginState', state: 'CONNECTED', loginId: 'login_b' },
      { type: 'contactIdentifiers', ghostId: 'g_1', sealed: sealed('idents_b'), loginId: 'login_b' },
      { type: 'contactIdentifiers', ghostId: 'g_1', sealed: sealed('idents2') },
    ])
    const rows = (await a.query(api.contacts.identifiers, { paginationOpts: first })).page
    expect(rows.map((r) => [r.ghostId, r.loginId, r.sealed.nonce])).toEqual([
      ['g_1', 'login_a', sealed('idents2').nonce],
      ['g_1', 'login_b', sealed('idents_b').nonce],
    ])
    const b = await signIn(t, 'user_b')
    expect((await b.query(api.contacts.identifiers, { paginationOpts: first })).page).toEqual([])
  })

  it('asks a connected login for its contacts’ numbers again, at most every ten minutes', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const b = await signIn(t, 'user_b')
    await heartbeat(t)
    await ingest(t, [{ type: 'loginState', state: 'CONNECTED' }])
    const account = await t.run(async (ctx) => (await ctx.db.query('networkAccounts').first())!)
    await expect(b.mutation(api.contacts.sync, { networkAccountId: account._id })).rejects.toThrow(/doesn’t exist/)
    expect(await a.mutation(api.contacts.sync, { networkAccountId: account._id })).toEqual({ queued: true })
    expect(await a.mutation(api.contacts.sync, { networkAccountId: account._id })).toEqual({ queued: false })
    const commands = await t.run(async (ctx) => await ctx.db.query('outbox').collect())
    expect(commands.map((c) => [c.loginId, c.payload.type])).toEqual([['login_a', 'syncContacts']])
    await ingest(t, [{ type: 'loginState', state: 'LOGGED_OUT' }])
    await t.run(async (ctx) => await ctx.db.patch(account._id, { contactsSyncedAt: 0 }))
    await expect(a.mutation(api.contacts.sync, { networkAccountId: account._id })).rejects.toThrow(/isn’t connected/)
  })
})
