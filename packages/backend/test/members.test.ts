import { describe, expect, it, vi } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import { sha256Hex } from '../convex/lib/hash'
import { SETUP_TOKEN, sealed, setup, signIn } from './setup'

describe('accounts', () => {
  const reserve = (t: ReturnType<typeof setup>, email: string, tokenHash?: string) =>
    t.mutation(internal.members.reserveAdmission, { email, ...(tokenHash ? { tokenHash } : {}) })

  it('admits only the setup token’s first sign-up, as admin', async () => {
    const t = setup()
    expect(await reserve(t, 'a@example.com')).toEqual({ allowed: false })
    expect(await reserve(t, 'a@example.com', await sha256Hex('wrong'))).toEqual({ allowed: false })
    const tokenHash = await sha256Hex(SETUP_TOKEN)
    expect(await reserve(t, 'a@example.com', tokenHash)).toEqual({ allowed: true })
    // A second sign-up racing for the setup token is refused before it gets an account.
    expect(await reserve(t, 'b@example.com', tokenHash)).toEqual({ allowed: false })

    expect(
      await t.mutation(internal.members.onAccountCreated, { userId: 'admin', email: 'A@example.com', tokenHash }),
    ).toEqual({
      admitted: true,
    })
    expect(await t.run(async (ctx) => await ctx.db.query('members').collect())).toMatchObject([
      { userId: 'admin', role: 'admin' },
    ])
    // Once there is an admin, the setup token admits nobody.
    expect(await reserve(t, 'b@example.com', tokenHash)).toEqual({ allowed: false })
  })

  it('admits an invited person once, by email and token', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    const { token } = await admin.mutation(api.members.invite, { email: 'Sam@Example.com', role: 'member' })
    const tokenHash = await sha256Hex(token)

    expect(await reserve(t, 'other@example.com', tokenHash)).toEqual({ allowed: false })
    expect(await reserve(t, 'sam@example.com', tokenHash)).toEqual({ allowed: true })
    expect(await reserve(t, 'sam@example.com', tokenHash)).toEqual({ allowed: false })
    await expect(
      admin.mutation(api.members.revokeInvitation, {
        invitationId: (await admin.query(api.members.invitations, {}))[0]!._id,
      }),
    ).rejects.toThrow(/right now/)
    expect(
      await t.mutation(internal.members.onAccountCreated, { userId: 'sam', email: 'sam@example.com', tokenHash }),
    ).toEqual({ admitted: true })
    expect(await reserve(t, 'sam@example.com', tokenHash)).toEqual({ allowed: false })

    const invitations = await admin.query(api.members.invitations, {})
    expect(invitations[0]).toMatchObject({ email: 'sam@example.com', acceptedBy: 'sam' })
    expect(invitations[0]).not.toHaveProperty('tokenHash')
    expect(await t.query(internal.members.isMember, { userId: 'sam' })).toBe(true)
  })

  it('finishes a sign-up whose invitation expired while it was in progress', async () => {
    vi.useFakeTimers()
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    const { token } = await admin.mutation(api.members.invite, { email: 'sam@example.com', role: 'member' })
    const tokenHash = await sha256Hex(token)
    vi.advanceTimersByTime(7 * 24 * 60 * 60 * 1000 - 1_000)
    expect(await reserve(t, 'sam@example.com', tokenHash)).toEqual({ allowed: true })
    vi.advanceTimersByTime(5_000)
    expect(
      await t.mutation(internal.members.onAccountCreated, { userId: 'sam', email: 'sam@example.com', tokenHash }),
    ).toEqual({ admitted: true })
    vi.useRealTimers()
  })

  it('turns invitations off on demo servers', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    process.env.TRIODITIS_DEMO = '1'
    try {
      await expect(admin.mutation(api.members.invite, { email: 'real@example.com', role: 'member' })).rejects.toThrow(
        /demo/,
      )
    } finally {
      delete process.env.TRIODITIS_DEMO
    }
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
    await expect(ended.query(api.chats.list, { paginationOpts: { numItems: 10, cursor: null } })).rejects.toThrow(
      /signed out/,
    )
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
          view: 'inbox',
        }),
    )
    expect((await a.query(api.chats.list, { paginationOpts: { numItems: 10, cursor: null } })).page).toHaveLength(1)
    expect((await b.query(api.chats.list, { paginationOpts: { numItems: 10, cursor: null } })).page).toHaveLength(0)
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

describe('server info', () => {
  it('says whether this is a demo server, signed in or not', async () => {
    const t = setup()
    expect(await t.query(api.server.info, {})).toEqual({ demo: false, invitations: true })
    process.env.TRIODITIS_DEMO = '1'
    try {
      expect(await t.query(api.server.info, {})).toEqual({ demo: true, invitations: false })
    } finally {
      delete process.env.TRIODITIS_DEMO
    }
  })
})
