import { describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { GATEWAY_SECRET, sealed, setup, signIn } from './setup'

const HOST = { hostId: 'whatsapp-1', network: 'whatsapp' as const }

async function quarantineTwo(t: ReturnType<typeof setup>) {
  // An edit of a message the backend never got, and an envelope that isn't one.
  const notSealed = { v: 1, nonce: 'n', ct: 'hello in plaintext', keys: [] }
  const base = { userId: 'user_a', loginId: 'login_a', at: 1_000 }
  await t.mutation(api.gateway.ingest, {
    secret: GATEWAY_SECRET,
    ...HOST,
    events: [
      {
        ...base,
        seq: 1,
        type: 'edit',
        portalId: 'p',
        eventId: 'x',
        targetEventId: 'missing',
        networkTs: 1,
        sender: { ghostId: 'g' },
        sealed: sealed(),
      },
      {
        ...base,
        seq: 2,
        type: 'message',
        portalId: 'p',
        eventId: 'e',
        networkTs: 2,
        sender: { ghostId: 'g' },
        sealed: notSealed,
        historical: false,
      },
    ] as never,
  })
}

describe('quarantine', () => {
  it('lists quarantined events to admins only, with codes and no content or owner', async () => {
    const t = setup()
    await quarantineTwo(t)
    const member = await signIn(t, 'user_b')
    await expect(member.query(api.quarantine.list, {})).rejects.toThrow(/admin/)
    const admin = await signIn(t, 'user_admin', 'admin')
    const list = await admin.query(api.quarantine.list, {})
    expect(list).toMatchObject({ count: 2, more: false })
    expect(list.items.map((row) => [row.seq, row.type, row.reason])).toEqual([
      [2, 'message', 'malformed_envelope'],
      [1, 'edit', 'missing_target'],
    ])
    for (const row of list.items) {
      expect(Object.keys(row).sort()).toEqual(['_id', 'at', 'hostId', 'reason', 'seq', 'type'])
    }
    expect(JSON.stringify(list)).not.toContain('plaintext')
  })

  it('lets an admin dismiss them, and only an admin', async () => {
    const t = setup()
    await quarantineTwo(t)
    const admin = await signIn(t, 'user_admin', 'admin')
    const member = await signIn(t, 'user_b')
    const { items } = await admin.query(api.quarantine.list, {})
    await expect(member.mutation(api.quarantine.dismiss, { ids: [items[0]!._id] })).rejects.toThrow(/admin/)
    await admin.mutation(api.quarantine.dismiss, { ids: [items[0]!._id] })
    // Dismissing one already gone is harmless.
    await admin.mutation(api.quarantine.dismiss, { ids: [items[0]!._id] })
    expect((await admin.query(api.quarantine.list, {})).items.map((row) => row.seq)).toEqual([1])
    const audit = await t.run(async (ctx) => await ctx.db.query('auditLog').collect())
    expect(audit.filter((row) => row.action === 'quarantine.dismiss')).toHaveLength(1)
  })
})
