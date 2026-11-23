import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, internal } from '../convex/_generated/api'
import { GATEWAY_SECRET, setup, signIn } from './setup'

const HOST = { hostId: 'whatsapp-1', network: 'whatsapp' as const }
const pressure = (backlog: number) => ({ backlog, pushMs: 1200, failedPushes: 2 })

afterEach(() => {
  vi.useRealTimers()
})

describe('server health', () => {
  it('keeps what each bridge host says of its deliveries, at most every 30 seconds', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const t = setup()
    const heartbeat = (backlog: number) =>
      t.mutation(api.gateway.ingest, { secret: GATEWAY_SECRET, ...HOST, events: [], pressure: pressure(backlog) })
    await heartbeat(500)
    vi.setSystemTime(1_010_000)
    await heartbeat(400)
    const admin = await signIn(t, 'admin_a', 'admin')
    expect((await admin.query(api.health.server, {})).bridges).toEqual([
      { network: 'whatsapp', backlog: 500, pushMs: 1200, failedPushes: 2, at: 1_000_000, stopped: false },
    ])
    vi.setSystemTime(1_031_000)
    await heartbeat(20)
    expect((await admin.query(api.health.server, {})).bridges[0]).toMatchObject({ backlog: 20, at: 1_031_000 })
    // A host stopping is written at once, and so is its coming back.
    vi.setSystemTime(1_032_000)
    await t.mutation(api.gateway.ingest, {
      secret: GATEWAY_SECRET,
      ...HOST,
      events: [],
      stopping: true,
      pressure: pressure(0),
    })
    expect((await admin.query(api.health.server, {})).bridges[0]).toMatchObject({ stopped: true, at: 1_032_000 })
    vi.setSystemTime(1_033_000)
    await heartbeat(0)
    expect((await admin.query(api.health.server, {})).bridges[0]).toMatchObject({ stopped: false, at: 1_033_000 })
  })

  it('keeps the last hour of the server timing itself', async () => {
    const t = setup()
    for (let i = 0; i < 65; i++) await t.mutation(internal.health.record, { at: i, ms: 10 + i, ok: i !== 64 })
    const admin = await signIn(t, 'admin_a', 'admin')
    const { probes } = await admin.query(api.health.server, {})
    expect(probes).toHaveLength(60)
    expect(probes[0]).toEqual({ at: 5, ms: 15, ok: true })
    expect(probes.at(-1)).toEqual({ at: 64, ms: 74, ok: false })
  })

  it('times a small query of its own', async () => {
    const t = setup()
    await t.action(internal.health.probe, {})
    const admin = await signIn(t, 'admin_a', 'admin')
    const { probes } = await admin.query(api.health.server, {})
    expect(probes).toHaveLength(1)
    expect(probes[0]!.ok).toBe(true)
  })

  it('is for admins only', async () => {
    const t = setup()
    const member = await signIn(t, 'member_a')
    await expect(member.query(api.health.server, {})).rejects.toThrow(/admin/)
  })
})
