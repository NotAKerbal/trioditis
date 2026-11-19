import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import { chatViewOf } from '../convex/lib/chatView'
import { GATEWAY_SECRET, sealed, setup, signIn, type T } from './setup'

afterEach(() => {
  vi.useRealTimers()
})

/** A connected account, as the bridge host reports one. */
async function connect(t: T, userId: string, loginId: string, seq: number) {
  await t.mutation(api.gateway.ingest, {
    secret: GATEWAY_SECRET,
    hostId: 'whatsapp-1',
    network: 'whatsapp',
    events: [{ seq, type: 'loginState', userId, loginId, at: Date.now(), state: 'CONNECTED' }],
  })
}

/** Runs the jobs a removal schedules right away, batch after batch, not the later deadlines. */
async function runBatches(t: T) {
  for (let i = 0; i < 20; i++) {
    vi.advanceTimersByTime(1)
    await t.finishInProgressScheduledFunctions()
  }
}

describe('installing networks', () => {
  it('lists every network for admins, installed or not', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin_a', 'admin')
    const catalog = await admin.query(api.networks.catalog, {})
    expect(catalog.map((row) => row.network)).toContain('telegram')
    expect(catalog.every((row) => !row.installed)).toBe(true)
    expect(catalog.find((row) => row.network === 'whatsapp')).toMatchObject({ bridged: true, bridgeOnline: false })
    expect(catalog.find((row) => row.network === 'telegram')).toMatchObject({ bridged: false })
    const member = await signIn(t, 'member_a')
    await expect(member.query(api.networks.catalog, {})).rejects.toThrow(/admin/)
  })

  it('installs only for admins, and only a network the server runs a bridge host for', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin_a', 'admin')
    const member = await signIn(t, 'member_a')
    await expect(member.mutation(api.networks.install, { network: 'whatsapp' })).rejects.toThrow(/admin/)
    await expect(admin.mutation(api.networks.install, { network: 'telegram' })).rejects.toThrow(/doesn’t run a bridge/)
    await expect(member.mutation(api.logins.start, { network: 'whatsapp' })).rejects.toThrow(/installed/)

    await admin.mutation(api.networks.install, { network: 'whatsapp' })
    await admin.mutation(api.networks.install, { network: 'whatsapp' })
    expect((await member.query(api.networks.list, {})).map((n) => n.network)).toEqual(['whatsapp'])
    expect(await member.mutation(api.logins.start, { network: 'whatsapp' })).toBeTruthy()
    const audit = await t.run(async (ctx) => await ctx.db.query('auditLog').collect())
    expect(audit.filter((row) => row.action === 'networks.install')).toHaveLength(1)
  })

  it('removes a network, disconnecting everyone’s accounts on it and stopping logins', async () => {
    vi.useFakeTimers()
    const t = setup()
    const admin = await signIn(t, 'admin_a', 'admin')
    const member = await signIn(t, 'member_a')
    await admin.mutation(api.networks.install, { network: 'whatsapp' })
    await admin.mutation(api.networks.install, { network: 'signal' })
    await connect(t, 'admin_a', 'login_admin', 1)
    await connect(t, 'member_a', 'login_member', 2)
    const pending = await member.mutation(api.logins.start, { network: 'whatsapp' })
    expect((await admin.query(api.networks.catalog, {})).find((row) => row.network === 'whatsapp')).toMatchObject({
      installed: true,
      accounts: 2,
      bridgeOnline: true,
    })

    await admin.mutation(api.networks.remove, { network: 'whatsapp' })
    await runBatches(t)
    expect((await member.query(api.networks.list, {})).map((n) => n.network)).toEqual(['signal'])
    await expect(member.mutation(api.logins.start, { network: 'whatsapp' })).rejects.toThrow(/installed/)
    const [accounts, commands] = await t.run(async (ctx) => [
      await ctx.db.query('networkAccounts').collect(),
      await ctx.db.query('outbox').collect(),
    ])
    expect(accounts.every((account) => account.logoutPending)).toBe(true)
    expect(commands.filter((command) => command.payload.type === 'logout')).toHaveLength(2)
    expect(
      commands.filter(
        (command) => command.payload.type === 'loginCancel' && command.payload.loginSessionId === pending,
      ),
    ).toHaveLength(1)
    // The login ends at once, so a step the bridge host sends meanwhile can't bring it back.
    expect((await member.query(api.logins.session, { loginSessionId: pending }))!.state).toBe('cancelled')
    // Removing it again asks for nothing more.
    await admin.mutation(api.networks.remove, { network: 'whatsapp' })
    await runBatches(t)
    expect(
      (await t.run(async (ctx) => await ctx.db.query('outbox').collect())).filter((c) => c.payload.type === 'logout'),
    ).toHaveLength(2)
    // What the bridge host sends before the logouts land still arrives.
    await connect(t, 'member_a', 'login_member', 3)
    // Installing it again makes it connectable.
    await admin.mutation(api.networks.install, { network: 'whatsapp' })
    expect((await member.query(api.networks.list, {})).map((n) => n.network)).toEqual(['whatsapp', 'signal'])
  })

  it('logs out every account on a removed network, however many, in batches', async () => {
    vi.useFakeTimers()
    const t = setup()
    const admin = await signIn(t, 'admin_a', 'admin')
    await admin.mutation(api.networks.install, { network: 'whatsapp' })
    await t.run(async (ctx) => {
      // Logged-out rows first in the index, as a long history leaves them, then live ones.
      for (let i = 0; i < 1100; i++) {
        await ctx.db.insert('networkAccounts', {
          userId: `u${i}`,
          network: 'whatsapp',
          loginId: `a${String(i).padStart(4, '0')}`,
          state: i < 1000 ? 'LOGGED_OUT' : 'CONNECTED',
          updatedAt: 1,
        })
      }
    })
    await admin.mutation(api.networks.remove, { network: 'whatsapp' })
    await runBatches(t)
    const accounts = await t.run(async (ctx) => await ctx.db.query('networkAccounts').collect())
    expect(accounts.filter((account) => account.state === 'CONNECTED' && !account.logoutPending)).toEqual([])
  })

  it('logs out an account whose login finishes after its network was removed', async () => {
    vi.useFakeTimers()
    const t = setup()
    const admin = await signIn(t, 'admin_a', 'admin')
    await admin.mutation(api.networks.install, { network: 'whatsapp' })
    await admin.mutation(api.networks.remove, { network: 'whatsapp' })
    await runBatches(t)
    // The bridge host finished the login before the cancel reached it.
    await connect(t, 'admin_a', 'late', 1)
    const [account] = await t.run(async (ctx) => await ctx.db.query('networkAccounts').collect())
    expect(account).toMatchObject({ state: 'CONNECTED', logoutPending: true })
    // A network nobody has decided on yet (an older server before its migrations) is left alone.
    await t.mutation(api.gateway.ingest, {
      secret: GATEWAY_SECRET,
      hostId: 'signal-1',
      network: 'signal',
      events: [{ seq: 1, type: 'loginState', userId: 'admin_a', loginId: 's', at: Date.now(), state: 'CONNECTED' }],
    })
    const signal = (await t.run(async (ctx) => await ctx.db.query('networkAccounts').collect())).find(
      (row) => row.network === 'signal',
    )
    expect(signal!.logoutPending).toBeUndefined()
  })
})

describe('rows left on the fake network', () => {
  it('are skipped by reads until they’re purged', async () => {
    const t = setup()
    const as = await signIn(t, 'user_a')
    const fake = 'fake' as 'whatsapp'
    const sessionId = await t.run(async (ctx) => {
      for (const network of [fake, 'whatsapp' as const]) {
        await ctx.db.insert('networkAccounts', {
          userId: 'user_a',
          network,
          loginId: 'l',
          state: 'CONNECTED',
          updatedAt: 1,
        })
        const row = {
          userId: 'user_a',
          network,
          loginId: 'l',
          portalId: `p_${network}`,
          kind: 'dm' as const,
          lastMessageAt: 0,
          unreadCount: 0,
          pinned: false,
          archived: false,
        }
        await ctx.db.insert('chats', { ...row, view: chatViewOf(row) })
      }
      return await ctx.db.insert('loginSessions', { userId: 'user_a', network: fake, state: 'pending', updatedAt: 1 })
    })
    const { page } = await as.query(api.chats.list, { paginationOpts: { numItems: 10, cursor: null } })
    expect(page.map((chat) => chat.network)).toEqual(['whatsapp'])
    expect((await as.query(api.logins.accounts, {})).map((account) => account.network)).toEqual(['whatsapp'])
    expect(await as.query(api.logins.session, { loginSessionId: sessionId })).toBeNull()
  })
})

describe('migrations for installed networks', () => {
  it('installs the networks people had connected, once, and never against an admin’s choice', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin_a', 'admin')
    await connect(t, 'admin_a', 'login_admin', 1)
    await t.run(async (ctx) => {
      // A logged-out account doesn't count.
      await ctx.db.insert('networkAccounts', {
        userId: 'admin_a',
        network: 'signal',
        loginId: 'old',
        state: 'LOGGED_OUT',
        updatedAt: 1,
      })
    })
    await t.mutation(internal.migrations.installConnectedNetworks, {})
    await t.mutation(internal.migrations.installConnectedNetworks, {})
    const rows = await t.run(async (ctx) => await ctx.db.query('serverNetworks').collect())
    expect(rows).toMatchObject([{ network: 'whatsapp', installed: true, updatedBy: 'migration' }])

    await admin.mutation(api.networks.remove, { network: 'whatsapp' })
    await t.mutation(internal.migrations.installConnectedNetworks, {})
    expect((await admin.query(api.networks.list, {})).map((n) => n.network)).toEqual([])
  })

  it('deletes everything on the fake network and nothing else', async () => {
    vi.useFakeTimers()
    const t = setup()
    await signIn(t, 'user_a')
    const fake = 'fake' as 'whatsapp'
    const keep = await t.run(async (ctx) => {
      const chatRow = (network: 'whatsapp', portalId: string) => {
        const row = {
          userId: 'user_a',
          network,
          loginId: 'l',
          portalId,
          kind: 'dm' as const,
          lastMessageAt: 0,
          unreadCount: 0,
          pinned: false,
          archived: false,
        }
        return { ...row, view: chatViewOf(row) }
      }
      for (const network of [fake, 'whatsapp' as const]) {
        await ctx.db.insert('networkAccounts', {
          userId: 'user_a',
          network,
          loginId: 'l',
          state: 'CONNECTED',
          updatedAt: 1,
        })
        await ctx.db.insert('contacts', { userId: 'user_a', network, ghostId: 'g', sealedProfile: sealed('p') })
        await ctx.db.insert('bridgeHosts', { hostId: `${network}-1`, network, lastSeq: 0, lastSeenAt: 1 })
        await ctx.db.insert('loginSessions', { userId: 'user_a', network, state: 'pending', updatedAt: 1 })
        await ctx.db.insert('outbox', {
          userId: 'user_a',
          network,
          payload: { type: 'logout' },
          state: 'expired',
          attempts: 0,
          createdAt: 1,
        })
      }
      // A fake login started and cancelled before it made an account: its commands, someone else's.
      for (const type of ['loginStart', 'loginCancel'] as const) {
        const commandId = await ctx.db.insert('outbox', {
          userId: 'user_b',
          network: fake,
          payload: type === 'loginStart' ? { type, loginSessionId: 's', network: fake } : { type, loginSessionId: 's' },
          state: 'expired',
          attempts: 0,
          createdAt: 1,
        })
        await ctx.db.insert('outboxPayloads', { commandId, sealed: sealed(`l${type}`) })
      }
      await ctx.db.insert('loginSessions', { userId: 'user_b', network: fake, state: 'cancelled', updatedAt: 1 })
      await ctx.db.insert('quarantine', {
        hostId: 'fake-1',
        seq: 1,
        type: 'message',
        userId: 'user_a',
        reason: 'x',
        at: 1,
      })
      // Enough fake chats and messages to need several batches.
      for (let c = 0; c < 7; c++) {
        const chatId = await ctx.db.insert('chats', chatRow(fake, `p${c}`))
        for (let m = 0; m < 60; m++) {
          const messageId = await ctx.db.insert('messages', {
            userId: 'user_a',
            chatId,
            network: fake,
            eventId: `e${c}_${m}`,
            networkTs: m,
            sortKey: `${m}`,
            sender: { self: true },
            sealedObjectId: `e${c}_${m}`,
            historical: false,
          })
          if (m === 0) {
            await ctx.db.insert('reactions', {
              userId: 'user_a',
              chatId,
              messageId,
              senderKey: 'self',
              key: '👍',
              eventId: `r${c}`,
              addedAt: 1,
              networkTs: 1,
            })
          }
        }
        await ctx.db.insert('receipts', { userId: 'user_a', chatId, senderKey: 's', upToEventId: 'e', networkTs: 1 })
        const commandId = await ctx.db.insert('outbox', {
          userId: 'user_a',
          network: fake,
          chatId,
          payload: { type: 'send', portalId: `p${c}`, clientMessageId: `c${c}` },
          state: 'rejected',
          attempts: 0,
          createdAt: 1,
        })
        await ctx.db.insert('outboxPayloads', { commandId, sealed: sealed(`s${c}`) })
      }
      return await ctx.db.insert('chats', chatRow('whatsapp', 'kept'))
    })

    // A chat of big messages: together far past what one transaction may read.
    const bigChat = await t.run(async (ctx) => {
      const row = {
        userId: 'user_a',
        network: fake,
        loginId: 'l',
        portalId: 'big',
        kind: 'dm' as const,
        lastMessageAt: 0,
        unreadCount: 0,
        pinned: false,
        archived: false,
      }
      return await ctx.db.insert('chats', { ...row, view: chatViewOf(row) })
    })
    for (let batch = 0; batch < 4; batch++) {
      await t.run(async (ctx) => {
        for (let m = 0; m < 8; m++) {
          const eventId = `big${batch}_${m}`
          await ctx.db.insert('messages', {
            userId: 'user_a',
            chatId: bigChat,
            network: fake,
            eventId,
            networkTs: m,
            sortKey: eventId,
            sender: { self: true },
            sealed: { ...sealed(eventId), ct: 'A'.repeat(600_000) },
            sealedObjectId: eventId,
            historical: false,
          })
        }
      })
    }

    await t.action(internal.migrations.runAll, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    const left = await t.run(async (ctx) => {
      const tables = [
        'networkAccounts',
        'contacts',
        'bridgeHosts',
        'loginSessions',
        'outbox',
        'chats',
        'messages',
        'reactions',
        'receipts',
        'quarantine',
        'outboxPayloads',
      ] as const
      const rows: Record<string, unknown[]> = {}
      for (const table of tables) rows[table] = await ctx.db.query(table).collect()
      return rows
    })
    for (const [table, rows] of Object.entries(left)) {
      expect(
        rows.some((row) => (row as { network?: string }).network === 'fake'),
        table,
      ).toBe(false)
    }
    expect(left.messages).toEqual([])
    expect(left.reactions).toEqual([])
    expect(left.receipts).toEqual([])
    expect(left.quarantine).toEqual([])
    expect(left.outboxPayloads).toEqual([])
    expect(left.chats).toMatchObject([{ _id: keep }])
    expect(left.networkAccounts).toHaveLength(1)
    expect(left.contacts).toHaveLength(1)
    expect(left.bridgeHosts).toHaveLength(1)
    expect(left.loginSessions).toHaveLength(1)
    expect(left.outbox).toHaveLength(1)
  })
})
