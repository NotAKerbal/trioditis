import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { generateKeyPair, keyId, openJson, ready, toBase64Url, type KeyPair } from '@trioditis/crypto'
import { api } from '../convex/_generated/api'
import { setup, signIn, type T } from './setup'

beforeAll(ready)
afterEach(() => {
  delete process.env.TRIODITIS_DEMO
  process.env.TRIODITIS_NETWORKS = 'whatsapp,fake'
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
  it('is refused unless the deployment is a demo with only the fake network', async () => {
    const t = setup()
    const as = await memberWithKey(t, generateKeyPair())
    await expect(as.action(api.demo.seedForMe, {})).rejects.toThrow(/demo deployments/)
    process.env.TRIODITIS_DEMO = '1'
    await expect(as.action(api.demo.seedForMe, {})).rejects.toThrow(/demo deployments/)
  })

  it('seeds once, sealed to the person’s key', async () => {
    const t = setup()
    process.env.TRIODITIS_DEMO = '1'
    process.env.TRIODITIS_NETWORKS = 'fake'
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
    expect(accounts).toMatchObject([{ network: 'fake', state: 'CONNECTED' }])
    expect(chats).toHaveLength(8)
    expect(new Set(chats.map((chat) => chat.view))).toEqual(new Set(['inbox', 'requests', 'snoozed', 'archived']))
    expect(chats.filter((chat) => chat.kind === 'group')).toHaveLength(2)
    expect(contacts).toHaveLength(6)
    expect(messages).toHaveLength(160)

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

  it('needs the key set up first', async () => {
    const t = setup()
    process.env.TRIODITIS_DEMO = '1'
    process.env.TRIODITIS_NETWORKS = 'fake'
    const as = await signIn(t, 'demo_user', 'admin', false)
    await expect(as.action(api.demo.seedForMe, {})).rejects.toThrow(/Set up your key/)
  })
})
