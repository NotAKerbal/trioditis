import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { setup, signIn } from './setup'

const UPDATER_SECRET = 'test-updater-secret'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)

describe('updates', () => {
  beforeEach(() => {
    process.env.UPDATER_SECRET = UPDATER_SECRET
  })
  afterEach(() => {
    delete process.env.UPDATER_SECRET
    delete process.env.TRIODITIS_VERSION
  })

  it('lets only admins see and change how the server updates', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    const member = await signIn(t, 'sam')
    process.env.TRIODITIS_VERSION = A

    expect(await admin.query(api.updates.status, {})).toEqual({
      channel: 'stable',
      autoUpdate: false,
      version: A,
      updaterConfigured: true,
      request: null,
      updater: null,
    })
    await expect(member.query(api.updates.status, {})).rejects.toThrow(/admin/)
    await expect(member.mutation(api.updates.setChannel, { channel: 'nightly' })).rejects.toThrow(/admin/)
    await expect(member.mutation(api.updates.setAutoUpdate, { enabled: true })).rejects.toThrow(/admin/)
    await expect(member.mutation(api.updates.request, { kind: 'update' })).rejects.toThrow(/admin/)

    await admin.mutation(api.updates.setAutoUpdate, { enabled: true })
    await admin.mutation(api.updates.setChannel, { channel: 'nightly' })
    // Switching channels asks the updater to look at the new branch.
    expect(await admin.query(api.updates.status, {})).toMatchObject({
      channel: 'nightly',
      autoUpdate: true,
      request: { kind: 'check' },
    })
    expect(await t.query(api.updates.poll, { secret: UPDATER_SECRET })).toMatchObject({
      channel: 'nightly',
      autoUpdate: true,
      request: { kind: 'check' },
    })
  })

  it('answers only the updater, and only when the server has one', async () => {
    const t = setup()
    await expect(t.query(api.updates.poll, { secret: 'wrong' })).rejects.toThrow(/Not the updater/)
    await expect(t.mutation(api.updates.report, { secret: 'wrong', state: 'idle' })).rejects.toThrow(/Not the updater/)
    delete process.env.UPDATER_SECRET
    await expect(t.query(api.updates.poll, { secret: '' })).rejects.toThrow(/Not the updater/)
    const admin = await signIn(t, 'admin', 'admin')
    await expect(admin.mutation(api.updates.request, { kind: 'update' })).rejects.toThrow(/no updater/)
    expect(await admin.query(api.updates.status, {})).toMatchObject({ updaterConfigured: false })
  })

  it('passes a request to the updater and clears it when the updater is done', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    await admin.mutation(api.updates.request, { kind: 'update' })
    // A check doesn't replace a waiting update.
    await admin.mutation(api.updates.request, { kind: 'check' })
    const { request } = await t.query(api.updates.poll, { secret: UPDATER_SECRET })
    expect(request).toMatchObject({ kind: 'update' })

    await t.mutation(api.updates.report, { secret: UPDATER_SECRET, state: 'updating' })
    await expect(admin.mutation(api.updates.request, { kind: 'update' })).rejects.toThrow(/already running/)
    await expect(admin.mutation(api.updates.cancelRequest, {})).rejects.toThrow(/already started/)
    const updating = await admin.query(api.updates.status, {})
    expect(updating.updater).toMatchObject({ state: 'updating' })
    const startedAt = updating.updater!.startedAt

    // A report for another request leaves this one waiting.
    await t.mutation(api.updates.report, { secret: UPDATER_SECRET, state: 'updating', done: 'other' })
    expect((await admin.query(api.updates.status, {})).request).toMatchObject({ kind: 'update' })

    await t.mutation(api.updates.report, {
      secret: UPDATER_SECRET,
      state: 'failed',
      message: 'x'.repeat(1000),
      done: request!.id,
    })
    const failed = await admin.query(api.updates.status, {})
    expect(failed.request).toBeNull()
    expect(failed.updater).toMatchObject({ state: 'failed', startedAt })
    expect(failed.updater!.message).toHaveLength(500)
  })

  it('keeps what the updater last said about commits', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    const latest = {
      channel: 'stable' as const,
      commit: B,
      committedAt: 2,
      subject: 's'.repeat(300),
      behind: 3,
      ahead: 0,
      checkedAt: 5,
    }
    await t.mutation(api.updates.report, {
      secret: UPDATER_SECRET,
      state: 'idle',
      current: { commit: A, committedAt: 1 },
      latest,
    })
    // A heartbeat without them keeps them.
    await t.mutation(api.updates.report, { secret: UPDATER_SECRET, state: 'idle' })
    const { updater } = await admin.query(api.updates.status, {})
    expect(updater).toMatchObject({ state: 'idle', current: { commit: A }, latest: { commit: B, behind: 3 } })
    expect(updater!.latest!.subject).toHaveLength(200)
    expect(updater).not.toHaveProperty('message')
    expect(updater).not.toHaveProperty('startedAt')

    await expect(
      t.mutation(api.updates.report, {
        secret: UPDATER_SECRET,
        state: 'idle',
        current: { commit: 'not-a-commit', committedAt: 1 },
      }),
    ).rejects.toThrow(/commit/)
  })

  it('keeps the release notes of an update on offer and of the last one installed', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    const latest = {
      channel: 'stable' as const,
      commit: B,
      committedAt: 2,
      subject: 'Merge',
      notes: [
        { label: 'new' as const, text: 'n'.repeat(300) },
        ...Array.from({ length: 150 }, () => ({ label: 'fixed' as const, text: 'Fix' })),
      ],
      behind: 3,
      ahead: 0,
      checkedAt: 5,
    }
    await t.mutation(api.updates.report, { secret: UPDATER_SECRET, state: 'idle', latest })
    const offered = (await admin.query(api.updates.status, {})).updater!.latest!.notes!
    // Cut to what's kept: a line to 200 characters, and at most 100 lines.
    expect(offered).toHaveLength(100)
    expect(offered[0]).toEqual({ label: 'new', text: 'n'.repeat(200) })

    const notes = [{ label: 'security' as const, text: 'Close a hole' }]
    await t.mutation(api.updates.report, {
      secret: UPDATER_SECRET,
      state: 'idle',
      current: { commit: B, committedAt: 2 },
      installed: { from: A, to: B, notes },
    })
    // Later reports keep it, until another update goes in.
    await t.mutation(api.updates.report, { secret: UPDATER_SECRET, state: 'idle' })
    expect((await admin.query(api.updates.status, {})).updater!.installed).toMatchObject({ from: A, to: B, notes })

    await expect(
      t.mutation(api.updates.report, {
        secret: UPDATER_SECRET,
        state: 'idle',
        installed: { from: 'nope', to: B, notes },
      }),
    ).rejects.toThrow(/commit/)
  })

  it('takes back a request the updater hasn’t started, which it then can’t claim', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    await admin.mutation(api.updates.request, { kind: 'update' })
    const { request } = await t.query(api.updates.poll, { secret: UPDATER_SECRET })
    await admin.mutation(api.updates.cancelRequest, {})
    expect((await t.query(api.updates.poll, { secret: UPDATER_SECRET })).request).toBeNull()
    await expect(
      t.mutation(api.updates.report, { secret: UPDATER_SECRET, state: 'updating', claim: request!.id }),
    ).rejects.toThrow(/cancelled/)
    expect((await admin.query(api.updates.status, {})).updater).toBeNull()

    // A request still waiting is claimed, and can't be cancelled after.
    await admin.mutation(api.updates.request, { kind: 'update' })
    const next = (await t.query(api.updates.poll, { secret: UPDATER_SECRET })).request!
    await t.mutation(api.updates.report, { secret: UPDATER_SECRET, state: 'updating', claim: next.id })
    await expect(admin.mutation(api.updates.cancelRequest, {})).rejects.toThrow(/already started/)
  })

  it('makes a waiting request again when the channel changes, so the old one can’t be claimed', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    await admin.mutation(api.updates.setChannel, { channel: 'nightly' })
    await admin.mutation(api.updates.request, { kind: 'update' })
    const old = (await t.query(api.updates.poll, { secret: UPDATER_SECRET })).request!
    await admin.mutation(api.updates.setChannel, { channel: 'stable' })
    const renewed = (await t.query(api.updates.poll, { secret: UPDATER_SECRET })).request!
    expect(renewed).toMatchObject({ kind: 'update' })
    expect(renewed.id).not.toBe(old.id)
    await expect(
      t.mutation(api.updates.report, { secret: UPDATER_SECRET, state: 'updating', claim: old.id }),
    ).rejects.toThrow(/cancelled/)
    // An update for the channel admins left, automatic ones included, can't start either.
    await expect(
      t.mutation(api.updates.report, { secret: UPDATER_SECRET, state: 'updating', claimChannel: 'nightly' }),
    ).rejects.toThrow(/channel changed/)
    await t.mutation(api.updates.report, {
      secret: UPDATER_SECRET,
      state: 'updating',
      claim: renewed.id,
      claimChannel: 'stable',
    })
  })

  it('leaves an update that’s running alone when the channel changes', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    await admin.mutation(api.updates.request, { kind: 'update' })
    const claimed = (await t.query(api.updates.poll, { secret: UPDATER_SECRET })).request!
    await t.mutation(api.updates.report, {
      secret: UPDATER_SECRET,
      state: 'updating',
      claim: claimed.id,
      claimChannel: 'stable',
    })
    await admin.mutation(api.updates.setChannel, { channel: 'nightly' })
    expect((await t.query(api.updates.poll, { secret: UPDATER_SECRET })).request).toEqual(claimed)
    // Its report clears it, and nothing is left to install a second time.
    await t.mutation(api.updates.report, { secret: UPDATER_SECRET, state: 'idle', done: claimed.id })
    expect((await t.query(api.updates.poll, { secret: UPDATER_SECRET })).request).toBeNull()
  })

  it('refuses to start an automatic update once they’re turned off', async () => {
    const t = setup()
    const admin = await signIn(t, 'admin', 'admin')
    await admin.mutation(api.updates.setAutoUpdate, { enabled: true })
    await admin.mutation(api.updates.setAutoUpdate, { enabled: false })
    await expect(
      t.mutation(api.updates.report, {
        secret: UPDATER_SECRET,
        state: 'updating',
        claimChannel: 'stable',
        claimAuto: true,
      }),
    ).rejects.toThrow(/turned off/)
    await admin.mutation(api.updates.setAutoUpdate, { enabled: true })
    await t.mutation(api.updates.report, {
      secret: UPDATER_SECRET,
      state: 'updating',
      claimChannel: 'stable',
      claimAuto: true,
    })
  })
})
