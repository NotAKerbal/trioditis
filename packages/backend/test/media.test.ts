import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { GATEWAY_SECRET, heartbeat, setup, signIn } from './setup'

describe('media tokens', () => {
  it('names the person and their network’s bridge hosts, signed for the gateway', async () => {
    const t = setup()
    const alice = await signIn(t, 'user_a')
    await heartbeat(t, 'whatsapp-1', 'whatsapp')
    await heartbeat(t, 'signal-1', 'signal')
    const { token, expiresAt } = await alice.mutation(api.media.access, { network: 'whatsapp' })
    const [payload, mac, ...rest] = token.split('.')
    expect(rest).toEqual([])
    expect(mac).toBe(createHmac('sha256', GATEWAY_SECRET).update(`media-access\n${payload}`).digest('base64url'))
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))
    expect(claims).toEqual({ u: 'user_a', h: ['whatsapp-1'], e: expiresAt })
    expect(expiresAt).toBeGreaterThan(Date.now())
  })

  it('needs a member', async () => {
    const t = setup()
    await expect(t.mutation(api.media.access, { network: 'whatsapp' })).rejects.toThrow()
  })
})
