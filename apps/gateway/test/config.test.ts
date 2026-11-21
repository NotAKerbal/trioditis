import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'

const SETTINGS = {
  CONVEX_URL: 'http://backend:3210',
  GATEWAY_SECRET: 'secret',
  TRIODITIS_INTERNAL_TOKEN: 'token',
  AGENT_ACCESS_PUBLIC_KEY: 'key',
  BRIDGE_HOSTS: 'whatsapp-1=http://bridge-whatsapp:8611',
}

afterEach(() => {
  for (const name of [...Object.keys(SETTINGS), 'TRIODITIS_RESTORE_PENDING']) delete process.env[name]
})

describe('loadConfig', () => {
  it('starts with its settings', () => {
    Object.assign(process.env, SETTINGS)
    expect(loadConfig().bridgeHosts.get('whatsapp-1')).toBe('http://bridge-whatsapp:8611')
  })

  it("refuses to start while a restore's sends aren't settled", () => {
    Object.assign(process.env, SETTINGS, { TRIODITIS_RESTORE_PENDING: '1800000000000' })
    expect(() => loadConfig()).toThrow(/restore's sends aren't settled/)
  })
})
