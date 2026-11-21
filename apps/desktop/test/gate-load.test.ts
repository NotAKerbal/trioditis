import { describe, expect, it } from 'vitest'
import { keyGateLoad } from '../src/features/auth/gate-load.ts'

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
    expect(keyGateLoad({ ...base, remote: { failed: false, hasData: true }, local: { pending: false, hasKey: true } })).toBe(
      'decide',
    )
  })
})
