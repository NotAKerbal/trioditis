import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPair, keyId, openJson, ready, toBase64Url, type KeyPair } from '@trioditis/crypto'
import { api } from '../convex/_generated/api'
import { setup, signIn, type T } from './setup'

beforeAll(ready)
afterEach(() => {
  delete process.env.TRIODITIS_DEMO
  process.env.TRIODITIS_NETWORKS = 'whatsapp,signal'
})

/** A member whose identity key is `identity`, as `keys.setup` leaves one. */
async function memberWithKey(t: T, identity: KeyPair) {
  const as = await signIn(t, 'demo_user', 'admin', false)
  await t.run(async (ctx) => {
    const member = (await ctx.db.query('members').first())!
    await ctx.db.patch(member._id, {
      identityPublicKey: toBase64Url(identity.publicKey),
      identityKid: keyId(identity.publicKey),
    })
  })
  return as
}

describe('demo data', () => {
  it('is refused unless the deployment is a demo with no bridge host', async () => {
    const t = setup()
    const as = await memberWithKey(t, generateKeyPair())
    await expect(as.action(api.demo.seedForMe, {})).rejects.toThrow(/demo deployments/)
    process.env.TRIODITIS_DEMO = '1'
    await expect(as.action(api.demo.seedForMe, {})).rejects.toThrow(/demo deployments/)
  })

  it('seeds only for the page’s session when one is named', async () => {
    const t = setup()
    process.env.TRIODITIS_DEMO = '1'
    delete process.env.TRIODITIS_NETWORKS
    const as = await memberWithKey(t, generateKeyPair())
    // Another account's page: its session isn't the one these calls run as.
    const other = await signIn(t, 'other_user', 'member', false)
    const { sessionId: otherPage } = (await other.query(api.members.me, {}))!
    await expect(as.action(api.demo.seedForMe, { sessionId: otherPage })).rejects.toMatchObject({
      data: { code: 'sessionChanged' },
    })
    expect(await t.run(async (ctx) => await ctx.db.query('networkAccounts').collect())).toEqual([])
    const { sessionId } = (await as.query(api.members.me, {}))!
    expect(await as.action(api.demo.seedForMe, { sessionId })).toEqual({ seeded: true })
  })

  it('seeds once, sealed to the person’s key', async () => {
    const t = setup()
    process.env.TRIODITIS_DEMO = '1'
    delete process.env.TRIODITIS_NETWORKS
    const identity = generateKeyPair()
    const as = await memberWithKey(t, identity)
    expect(await as.action(api.demo.seedForMe, {})).toEqual({ seeded: true })
    expect(await as.action(api.demo.seedForMe, {})).toEqual({ seeded: false })

    const [accounts, chats, contacts, messages] = await t.run(async (ctx) => [
      await ctx.db.query('networkAccounts').collect(),
      await ctx.db.query('chats').collect(),
      await ctx.db.query('contacts').collect(),
      await ctx.db.query('messages').collect(),
    ])
    expect(accounts.map((account) => account.network).sort()).toEqual([
      'gmessages',
      'instagram',
      'meta',
      'signal',
      'slack',
      'telegram',
      'whatsapp',
    ])
    expect(accounts.every((account) => account.state === 'CONNECTED')).toBe(true)
    // Each chat is on the network of an account it belongs to.
    expect(chats.every((chat) => accounts.some((a) => a.network === chat.network && a.loginId === chat.loginId))).toBe(
      true,
    )
    // Eight, and Alice again on Signal, to link on one People card.
    expect(chats).toHaveLength(9)
    expect(new Set(chats.map((chat) => chat.view))).toEqual(new Set(['inbox', 'requests', 'snoozed', 'archived']))
    expect(chats.filter((chat) => chat.kind === 'group')).toHaveLength(2)
    // The six contacts, on each network they have a chat on.
    expect(contacts).toHaveLength(11)
    expect(new Set(contacts.map((contact) => contact.ghostId)).size).toBe(6)
    expect(messages).toHaveLength(180)

    const message = messages[0]!
    const body = openJson<{ body: string }>(message.sealed!, identity, {
      kind: 'message',
      ownerUserId: 'demo_user',
      objectId: message.eventId,
    })
    expect(typeof body.body).toBe('string')
    const chat = chats[0]!
    expect(
      openJson<{ name: string }>(chat.sealedMeta!, identity, {
        kind: 'chat',
        ownerUserId: 'demo_user',
        objectId: chat.portalId,
      }).name,
    ).toBeTruthy()
    // A direct chat says who it's with, sealed with the rest, as a bridge host's does.
    for (const dm of chats.filter((c) => c.kind === 'dm')) {
      const meta = openJson<{ dmGhostId?: string }>(dm.sealedMeta!, identity, {
        kind: 'chat',
        ownerUserId: 'demo_user',
        objectId: dm.portalId,
      })
      expect(contacts.some((c) => c.network === dm.network && c.ghostId === meta.dmGhostId)).toBe(true)
    }
    const contact = contacts[0]!
    expect(
      openJson(contact.sealedProfile, identity, {
        kind: 'contact',
        ownerUserId: 'demo_user',
        objectId: contact.ghostId,
      }),
    ).toHaveProperty('name')
    // Pinned chats come first in the inbox.
    const { page } = await as.query(api.chats.list, { paginationOpts: { numItems: 10, cursor: null } })
    expect(page[0]!.pinned).toBe(true)
  })

  it('finishes a seed that stopped partway when called again', async () => {
    const t = setup()
    process.env.TRIODITIS_DEMO = '1'
    delete process.env.TRIODITIS_NETWORKS
    const as = await memberWithKey(t, generateKeyPair())
    expect(await as.action(api.demo.seedForMe, {})).toEqual({ seeded: true })
    // As if it had stopped after some accounts and chats: one account, no contacts and two chats missing.
    await t.run(async (ctx) => {
      await ctx.db.delete((await ctx.db.query('networkAccounts').first())!._id)
      for (const contact of await ctx.db.query('contacts').collect()) await ctx.db.delete(contact._id)
      const chats = await ctx.db.query('chats').collect()
      for (const chat of chats.slice(0, 2)) {
        const messages = await ctx.db
          .query('messages')
          .withIndex('by_chat_sort', (q) => q.eq('chatId', chat._id))
          .collect()
        for (const message of messages) await ctx.db.delete(message._id)
        await ctx.db.delete(chat._id)
      }
    })
    expect(await as.action(api.demo.seedForMe, {})).toEqual({ seeded: true })
    expect(await as.action(api.demo.seedForMe, {})).toEqual({ seeded: false })
    const [accounts, chats, contacts, messages] = await t.run(async (ctx) => [
      await ctx.db.query('networkAccounts').collect(),
      await ctx.db.query('chats').collect(),
      await ctx.db.query('contacts').collect(),
      await ctx.db.query('messages').collect(),
    ])
    expect([accounts.length, chats.length, contacts.length, messages.length]).toEqual([7, 9, 11, 180])
  })

  it('needs the key set up first', async () => {
    const t = setup()
    process.env.TRIODITIS_DEMO = '1'
    delete process.env.TRIODITIS_NETWORKS
    const as = await signIn(t, 'demo_user', 'admin', false)
    await expect(as.action(api.demo.seedForMe, {})).rejects.toThrow(/Set up your key/)
  })
})
