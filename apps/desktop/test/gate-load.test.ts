import { describe, expect, it } from 'vitest'
import { confirmSession, keyGateLoad, retryDelay, sessionAnswer } from '../src/features/auth/gate-load.ts'

const base = {
  token: 1 as number | 'failed' | null,
  remote: { failed: false, hasData: false },
  local: { pending: false, hasKey: false },
  recoveryCheckPending: false,
}

describe('the key gate before it can decide', () => {
  it('waits for this device’s own storage first', () => {
    expect(keyGateLoad({ ...base, token: null })).toBe('wait')
    expect(keyGateLoad({ ...base, local: { pending: true, hasKey: false } })).toBe('wait')
  })

  it('opens with the key kept here, without waiting for the server', () => {
    const local = { pending: false, hasKey: true }
    expect(keyGateLoad({ ...base, local })).toBe('openLocal')
    // Offline or failed: the same.
    expect(keyGateLoad({ ...base, local, remote: { failed: true, hasData: false } })).toBe('openLocal')
  })

  it('waits for the server while a recovery key from before a reload is still to be checked', () => {
    const local = { pending: false, hasKey: true }
    expect(keyGateLoad({ ...base, local, recoveryCheckPending: true })).toBe('wait')
    expect(keyGateLoad({ ...base, local, recoveryCheckPending: true, remote: { failed: true, hasData: false } })).toBe(
      'failed',
    )
  })

  it('says the load failed, rather than spinning, when there’s no key here to go on with', () => {
    expect(keyGateLoad({ ...base, remote: { failed: true, hasData: false } })).toBe('failed')
    expect(keyGateLoad(base)).toBe('wait')
  })

  it('decides from the server’s answer once it has one', () => {
    expect(keyGateLoad({ ...base, remote: { failed: false, hasData: true } })).toBe('decide')
    expect(
      keyGateLoad({ ...base, remote: { failed: false, hasData: true }, local: { pending: false, hasKey: true } }),
    ).toBe('decide')
  })
})

describe('confirming the browser is signed out', () => {
  it('counts only an answer, never a failed request', () => {
    expect(sessionAnswer({ data: null, error: null })).toBe('signedOut')
    expect(sessionAnswer({ data: { session: {} }, error: null })).toBe('signedIn')
    expect(sessionAnswer({ data: null, error: { status: 0 } })).toBe('unknown')
    expect(sessionAnswer(null)).toBe('unknown')
  })

  it('backs off from 2 seconds to at most 30', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(retryDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
  })

  it('asks again after each failure until it gets an answer', async () => {
    const answers: ({ data: unknown; error: unknown } | Error)[] = [
      new TypeError('Failed to fetch'),
      { data: null, error: { status: 502 } },
      { data: null, error: null },
    ]
    const waits: number[] = []
    const result = await confirmSession(
      async () => {
        const next = answers.shift()!
        if (next instanceof Error) throw next
        return next
      },
      async (ms) => void waits.push(ms),
      () => false,
    )
    expect(result).toBe('signedOut')
    expect(waits).toEqual([2_000, 4_000])
  })

  it('stops when the page no longer needs to know', async () => {
    let cancelled = false
    let asked = 0
    const result = await confirmSession(
      async () => {
        asked++
        return { data: null, error: { status: 0 } }
      },
      async () => {
        cancelled = true
      },
      () => cancelled,
    )
    expect(result).toBeNull()
    expect(asked).toBe(1)
  })
})
