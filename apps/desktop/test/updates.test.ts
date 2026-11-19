import { describe, expect, it } from 'vitest'
import {
  buildOutdated,
  runningVersion,
  updaterStale,
  updateView,
  UPDATER_STALE_MS,
  type UpdateStatus,
} from '../src/data/updates.ts'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const base: UpdateStatus = {
  channel: 'stable',
  autoUpdate: false,
  version: A,
  updaterConfigured: true,
  request: null,
  updater: null,
}
const latest = (over: Partial<NonNullable<NonNullable<UpdateStatus['updater']>['latest']>> = {}) => ({
  channel: 'stable' as const,
  commit: B,
  committedAt: 2,
  subject: 'Add things',
  behind: 2,
  ahead: 0,
  checkedAt: 3,
  ...over,
})

describe('updateView', () => {
  it('says the updater is off where the server has none', () => {
    expect(updateView({ ...base, updaterConfigured: false })).toEqual({ kind: 'off' })
  })

  it('puts an update in progress first, then a waiting request, then a failure', () => {
    const updating = { seenAt: 1, state: 'updating' as const, startedAt: 5, latest: latest() }
    expect(updateView({ ...base, request: { kind: 'update', at: 1 }, updater: updating })).toMatchObject({
      kind: 'updating',
      startedAt: 5,
    })
    const failed = { seenAt: 1, state: 'failed' as const, message: 'It broke.', latest: latest() }
    expect(updateView({ ...base, request: { kind: 'update', at: 1 }, updater: failed })).toEqual({
      kind: 'waiting',
      request: 'update',
    })
    expect(updateView({ ...base, updater: failed })).toEqual({ kind: 'failed', message: 'It broke.' })
  })

  it('offers an update only when the channel is ahead and the server has nothing it lacks', () => {
    const idle = (l: ReturnType<typeof latest>) => ({
      ...base,
      updater: { seenAt: 1, state: 'idle' as const, latest: l },
    })
    expect(updateView(idle(latest()))).toMatchObject({ kind: 'available', commit: B, behind: 2 })
    expect(updateView(idle(latest({ behind: 0 })))).toEqual({ kind: 'current', checkedAt: 3 })
    expect(updateView(idle(latest({ behind: 0, ahead: 4 })))).toEqual({ kind: 'ahead', ahead: 4, behind: 0 })
    expect(updateView(idle(latest({ behind: 1, ahead: 1 })))).toEqual({ kind: 'ahead', ahead: 1, behind: 1 })
    // A check of the other channel says nothing about this one.
    expect(updateView(idle(latest({ channel: 'nightly' })))).toEqual({ kind: 'unchecked' })
  })
})

describe('the updater’s health and the version', () => {
  it('takes a quiet updater as stopped', () => {
    expect(updaterStale(base, 0)).toBe(true)
    const seen = { ...base, updater: { seenAt: 1_000, state: 'idle' as const } }
    expect(updaterStale(seen, 1_000 + UPDATER_STALE_MS)).toBe(false)
    expect(updaterStale(seen, 1_001 + UPDATER_STALE_MS)).toBe(true)
    expect(updaterStale({ ...base, updaterConfigured: false }, 0)).toBe(false)
  })

  it('shows the commit the updater reports, or else the installer’s', () => {
    expect(runningVersion(base)).toEqual({ commit: A })
    expect(runningVersion({ ...base, version: 'unknown' })).toBeNull()
    const current = { commit: B, committedAt: 9 }
    expect(runningVersion({ ...base, updater: { seenAt: 1, state: 'idle', current } })).toEqual(current)
  })

  it('counts a page outdated only when both builds are known and differ', () => {
    expect(buildOutdated(A, B)).toBe(true)
    expect(buildOutdated(A, A)).toBe(false)
    expect(buildOutdated(undefined, B)).toBe(false)
    expect(buildOutdated(A, null)).toBe(false)
    expect(buildOutdated('unknown', B)).toBe(false)
    expect(buildOutdated(A, 'unknown')).toBe(false)
  })
})
