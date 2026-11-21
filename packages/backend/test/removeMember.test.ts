import { describe, expect, it } from 'vitest'
import { api, components } from '../convex/_generated/api'
import { setup, signIn, type T } from './setup'

const firstPage = { numItems: 50, cursor: null }

/** A Better Auth user, as sign-up makes one, with a password credential and a passkey. */
async function account(t: T, email: string) {
  return await t.run(async (ctx) => {
    const now = Date.now()
    const user = (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: { name: email.split('@')[0]!, email, emailVerified: false, createdAt: now, updatedAt: now },
      },
    })) as { _id: string }
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'account',
        data: {
          accountId: user._id,
          providerId: 'credential',
          userId: user._id,
          password: 'hash',
          createdAt: now,
          updatedAt: now,
        },
      },
    })
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'passkey',
        data: {
          publicKey: 'pk',
          userId: user._id,
          credentialID: `cred-${email}`,
          counter: 0,
          deviceType: 'singleDevice',
          backedUp: false,
          createdAt: now,
        },
      },
    })
    return user._id
  })
}

async function authRows(t: T, model: 'session' | 'account' | 'passkey', userId: string) {
  return await t.run(async (ctx) => {
    const { page } = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
      model,
      where: [{ field: 'userId', value: userId }],
      paginationOpts: { cursor: null, numItems: 10 },
    })) as { page: unknown[] }
    return page
  })
}

describe('removing a member', () => {
  it('lists members with their name and email, and marks the caller', async () => {
    const t = setup()
    const adminId = await account(t, 'admin@example.com')
    const samId = await account(t, 'sam@example.com')
    const admin = await signIn(t, adminId, 'admin')
    const sam = await signIn(t, samId)
    const { page } = await admin.query(api.members.list, { paginationOpts: firstPage })
    expect(page).toMatchObject([
      { userId: adminId, role: 'admin', email: 'admin@example.com', you: true },
      { userId: samId, role: 'member', email: 'sam@example.com', name: 'sam', you: false },
    ])
    await expect(sam.query(api.members.list, { paginationOpts: firstPage })).rejects.toThrow(/admin/)
  })

  it('takes away membership, sessions, sign-in, key backups, agents and network logins at once', async () => {
    const t = setup()
    const adminId = await account(t, 'admin@example.com')
    const samId = await account(t, 'sam@example.com')
    const admin = await signIn(t, adminId, 'admin')
    const sam = await signIn(t, samId)
    await t.mutation(components.mcp.grants.createApiKey, {
      userId: samId,
      name: 'agent',
      scopes: ['read'],
      resource: 'https://trioditis.test/mcp',
      hash: 'h'.repeat(64),
    })
    await t.run(async (ctx) => {
      await ctx.db.insert('networkAccounts', {
        userId: samId,
        network: 'whatsapp',
        loginId: 'l_sam',
        state: 'CONNECTED',
        updatedAt: 1,
      })
    })

    await admin.mutation(api.members.removeMember, { userId: samId })

    await expect(sam.query(api.keys.identity, {})).rejects.toThrow()
    expect(await sam.query(api.members.me, {})).toBeNull()
    for (const model of ['session', 'account', 'passkey'] as const) expect(await authRows(t, model, samId)).toEqual([])
    expect(await t.query(components.mcp.grants.list, { userId: samId })).toEqual([])
    const left = await t.run(async (ctx) => ({
      members: (await ctx.db.query('members').collect()).map((m) => m.userId),
      backups: (await ctx.db.query('keyBackups').collect()).filter((b) => b.userId === samId),
      accounts: await ctx.db.query('networkAccounts').collect(),
      logouts: (await ctx.db.query('outbox').collect()).filter((c) => c.payload.type === 'logout'),
      user: await ctx.runQuery(components.betterAuth.adapter.findOne, {
        model: 'user',
        where: [{ field: '_id', value: samId }],
      }),
    }))
    expect(left.members).toEqual([adminId])
    expect(left.backups).toEqual([])
    expect(left.accounts[0]).toMatchObject({ logoutPending: true })
    expect(left.logouts).toMatchObject([{ userId: samId, loginId: 'l_sam' }])
    expect(left.user).toBeNull()
    // The admin's own sign-in is untouched.
    expect(await authRows(t, 'account', adminId)).toHaveLength(1)
  })

  it('refuses a member, the admin themselves, an unknown person and a session that changed', async () => {
    const t = setup()
    const adminId = await account(t, 'admin@example.com')
    const samId = await account(t, 'sam@example.com')
    const admin = await signIn(t, adminId, 'admin')
    const sam = await signIn(t, samId)
    await expect(sam.mutation(api.members.removeMember, { userId: adminId })).rejects.toThrow(/admin/)
    await expect(admin.mutation(api.members.removeMember, { userId: adminId })).rejects.toThrow(/yourself/)
    await expect(admin.mutation(api.members.removeMember, { userId: samId, sessionId: 'other' })).rejects.toThrow(
      /session/,
    )
    await expect(admin.mutation(api.members.removeMember, { userId: 'nobody' })).rejects.toThrow(/isn’t a member/)
    expect(await t.run(async (ctx) => (await ctx.db.query('members').collect()).length)).toBe(2)
  })

  it('lets one admin remove another, but never leaves the server without one', async () => {
    const t = setup()
    const aId = await account(t, 'a@example.com')
    const bId = await account(t, 'b@example.com')
    const a = await signIn(t, aId, 'admin')
    const b = await signIn(t, bId, 'admin')
    await a.mutation(api.members.removeMember, { userId: bId })
    // b is gone, so their call is refused; a, the last admin, can't remove themselves either.
    await expect(b.mutation(api.members.removeMember, { userId: aId })).rejects.toThrow()
    await expect(a.mutation(api.members.removeMember, { userId: aId })).rejects.toThrow(/yourself/)
    expect(await t.run(async (ctx) => (await ctx.db.query('members').collect()).map((m) => m.role))).toEqual(['admin'])
  })
})

describe('the invitation list', () => {
  it('pages through every waiting invitation, newest first, without tokens', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    for (let i = 0; i < 120; i++) {
      await admin.mutation(api.members.invite, { email: `p${i}@example.com`, role: 'member' })
    }
    const seen: string[] = []
    let cursor: string | null = null
    for (;;) {
      const result: { page: { email: string }[]; isDone: boolean; continueCursor: string } = await admin.query(
        api.members.invitations,
        { paginationOpts: { numItems: 50, cursor } },
      )
      for (const invitation of result.page) {
        expect(invitation).not.toHaveProperty('tokenHash')
        seen.push(invitation.email)
      }
      if (result.isDone) break
      cursor = result.continueCursor
    }
    expect(seen).toHaveLength(120)
    expect(seen[0]).toBe('p119@example.com')
    expect(new Set(seen).size).toBe(120)
  })
})
