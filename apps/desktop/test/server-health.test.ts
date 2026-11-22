import { describe, expect, it } from 'vitest'
import { bridgeState, serverState } from '../src/features/settings/health-section.tsx'

const MIN = 60_000
const now = 100 * MIN
const probe = (minutesAgo: number, ms = 40, ok = true) => ({ at: now - minutesAgo * MIN, ms, ok })

describe('Server health', () => {
  it('says the server is keeping up while its probes answer quickly', () => {
    const state = serverState([probe(2), probe(1)], now)
    expect(state).toMatchObject({ say: 'Keeping up, 40 ms', warn: false, timeouts: 0, slowest: 40 })
  })

  it('counts a probe that timed out, and one that never got kept, as timeouts', () => {
    // 10 minutes ago, then nothing until 2 minutes ago: seven checks went missing.
    const state = serverState([probe(10), probe(2, 1000, false), probe(1, 900)], now)
    expect(state).toMatchObject({ say: 'Slow, 900 ms', warn: true, timeouts: 8, slowest: 1000 })
  })

  it('says it isn’t answering when its last answer is minutes old', () => {
    expect(serverState([probe(6)], now)).toMatchObject({ say: 'Not answering', warn: true, timeouts: 5 })
    expect(serverState([], now)).toMatchObject({ say: 'Not checked yet', warn: false })
  })

  it('sums up how a bridge’s deliveries are going', () => {
    const bridge = { network: 'signal' as const, live: true, at: now, backlog: 0, pushMs: 200, failedPushes: 0 }
    expect(bridgeState(bridge)).toEqual({ say: 'Caught up', warn: false })
    expect(bridgeState({ ...bridge, backlog: 1240, pushMs: 2500, failedPushes: 3 })).toEqual({
      say: '1,240 waiting, 2.5 s a delivery, 3 failed',
      warn: true,
    })
    expect(bridgeState({ ...bridge, live: false })).toEqual({ say: 'Offline', warn: true })
  })
})
