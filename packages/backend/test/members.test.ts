import { describe, expect, it } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import { sha256Hex } from '../convex/lib/hash'
import { SETUP_TOKEN, sealed, setup, signIn } from './setup'

describe('accounts', () => {
  it('lets only the setup token create the first account, as admin', async () => {
    const t = setup()
    expect(await t.query(internal.members.mayCreateAccount, { email: 'a@example.com' })).toEqual({ allowed: false })
    expect(
      await t.query(internal.members.mayCreateAccount, { email: 'a@example.com', tokenHash: await sha256Hex('wrong') }),
    ).toEqual({ allowed: false })
    const tokenHash = await sha256Hex(SETUP_TOKEN)
    expect(await t.query(internal.members.mayCreateAccount, { email: 'a@example.com', tokenHash })).toEqual({
      allowed: true,
    })

    await t.mutation(internal.members.onAccountCreated, { userId: 'admin', email: 'a@example.com', tokenHash })
    // The setup token works once: a second account racing for it gets no membership.
    await t.mutation(internal.members.onAccountCreated, { userId: 'late', email: 'b@example.com', tokenHash })
    const members = await t.run(async (ctx) => await ctx.db.query('members').collect())
    expect(members).toMatchObject([{ userId: 'admin', role: 'admin' }])
    expect(await t.query(internal.members.mayCreateAccount, { email: 'b@example.com', tokenHash })).toEqual({
      allowed: false,
    })
  })

  it('admits an invited person once, by email and token', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    const { token } = await admin.mutation(api.members.invite, { email: 'Sam@Example.com', role: 'member' })
    const tokenHash = await sha256Hex(token)

    expect(await t.query(internal.members.mayCreateAccount, { email: 'other@example.com', tokenHash })).toEqual({
      allowed: false,
    })
    expect(await t.query(internal.members.mayCreateAccount, { email: 'sam@example.com', tokenHash })).toEqual({
      allowed: true,
    })
    await t.mutation(internal.members.onAccountCreated, { userId: 'sam', email: 'sam@example.com', tokenHash })
    expect(await t.query(internal.members.mayCreateAccount, { email: 'sam@example.com', tokenHash })).toEqual({
      allowed: false,
    })

    const invitations = await admin.query(api.members.invitations, {})
    expect(invitations[0]).toMatchObject({ email: 'sam@example.com', acceptedBy: 'sam' })
    expect(invitations[0]).not.toHaveProperty('tokenHash')
  })

  it('only lets admins invite', async () => {
    const t = setup()
    const member = await signIn(t, 'sam')
    await expect(member.mutation(api.members.invite, { email: 'x@example.com', role: 'member' })).rejects.toThrow(
      /admin/,
    )
  })

  it('refuses a signed-out caller and an ended session', async () => {
    const t = setup()
    await signIn(t, 'sam')
    expect(await t.query(api.members.me, {})).toBeNull()
    const ended = t.withIdentity({ subject: 'sam', sessionId: 'not-a-session' })
    await expect(ended.query(api.chats.list, {})).rejects.toThrow(/signed out/)
  })

  it('sets the identity key once', async () => {
    const t = setup()
    const sam = await signIn(t, 'sam', 'member', false)
    const publicKey = 'B'.repeat(43)
    await sam.mutation(api.members.setIdentityKey, { publicKey, kid: 'C'.repeat(22) })
    await sam.mutation(api.members.setIdentityKey, { publicKey, kid: 'C'.repeat(22) })
    await expect(
      sam.mutation(api.members.setIdentityKey, { publicKey: 'D'.repeat(43), kid: 'E'.repeat(22) }),
    ).rejects.toThrow(/already/)
  })
})

describe('logins', () => {
  it('needs an identity key and an enabled network', async () => {
    const t = setup()
    const noKey = await signIn(t, 'sam', 'member', false)
    await expect(noKey.mutation(api.logins.start, { network: 'whatsapp' })).rejects.toThrow(/setting up/)
    const isaac = await signIn(t, 'isaac')
    await expect(isaac.mutation(api.logins.start, { network: 'discord' })).rejects.toThrow(/enabled/)
    const sessionId = await isaac.mutation(api.logins.start, { network: 'whatsapp' })
    expect(await isaac.query(api.logins.session, { loginSessionId: sessionId })).toMatchObject({ state: 'pending' })
    expect(await noKey.query(api.logins.session, { loginSessionId: sessionId })).toBeNull()
  })

  it('accepts input only for the step being shown, sealed', async () => {
    const t = setup()
    const isaac = await signIn(t, 'isaac')
    const loginSessionId = await isaac.mutation(api.logins.start, { network: 'whatsapp' })
    await expect(isaac.mutation(api.logins.submit, { loginSessionId, stepId: 's1', sealed: sealed() })).rejects.toThrow(
      /over/,
    )
    await t.run(async (ctx) => {
      await ctx.db.patch(loginSessionId, { state: 'active', step: { stepId: 's1', type: 'userInput' } })
    })
    await isaac.mutation(api.logins.submit, { loginSessionId, stepId: 's1', sealed: sealed() })
    const commands = await t.run(async (ctx) => await ctx.db.query('outbox').collect())
    expect(commands.map((command) => command.payload.type)).toEqual(['loginStart', 'loginSubmit'])
  })
})

describe('privacy between people', () => {
  it('shows each person only their own chats and messages', async () => {
    const t = setup()
    const a = await signIn(t, 'user_a')
    const b = await signIn(t, 'user_b')
    const chatId = await t.run(
      async (ctx) =>
        await ctx.db.insert('chats', {
          userId: 'user_a',
          network: 'whatsapp',
          loginId: 'l',
          portalId: 'p',
          kind: 'dm',
          lastMessageAt: 0,
          unreadCount: 0,
          pinned: false,
          archived: false,
        }),
    )
    expect(await a.query(api.chats.list, {})).toHaveLength(1)
    expect(await b.query(api.chats.list, {})).toHaveLength(0)
    await expect(b.query(api.chats.get, { chatId })).rejects.toThrow(/doesn’t exist/)
    await expect(
      b.query(api.messages.list, { chatId, paginationOpts: { numItems: 10, cursor: null } }),
    ).rejects.toThrow(/doesn’t exist/)
  })

  it('gives an agent only its own person’s networks', async () => {
    const t = setup()
    await t.run(async (ctx) => {
      for (const userId of ['user_a', 'user_b']) {
        await ctx.db.insert('networkAccounts', {
          userId,
          network: 'whatsapp',
          loginId: `l_${userId}`,
          state: 'CONNECTED',
          updatedAt: 1,
        })
      }
    })
    expect(await t.query(internal.mcp.networksForUser, { userId: 'user_a' })).toEqual([
      { network: 'whatsapp', state: 'CONNECTED', lastHealthyAt: null },
    ])
  })
})
