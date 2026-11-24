import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { api } from '../convex/_generated/api'
import { chatViewOf } from '../convex/lib/chatView'
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

describe('upload tokens', () => {
  async function chatOn(t: ReturnType<typeof setup>, userId: string, hostId?: string) {
    return await t.run(async (ctx) => {
      await ctx.db.insert('networkAccounts', {
        userId,
        network: 'whatsapp',
        loginId: `login_${userId}`,
        ...(hostId ? { hostId } : {}),
        state: 'CONNECTED',
        updatedAt: 1,
      })
      const fields = {
        userId,
        network: 'whatsapp' as const,
        loginId: `login_${userId}`,
        portalId: 'portal_1',
        kind: 'dm' as const,
        lastMessageAt: 0,
        last: null,
        unreadCount: 0,
        pinned: false,
        archived: false,
      }
      return await ctx.db.insert('chats', { ...fields, view: chatViewOf(fields) })
    })
  }

  it('names only the host running the chat’s account, signed for uploads', async () => {
    const t = setup()
    const alice = await signIn(t, 'user_a')
    await heartbeat(t, 'whatsapp-1', 'whatsapp')
    await heartbeat(t, 'whatsapp-2', 'whatsapp')
    const chatId = await chatOn(t, 'user_a', 'whatsapp-2')
    const { token, expiresAt } = await alice.mutation(api.media.upload, { chatId })
    const [payload, mac] = token.split('.')
    expect(mac).toBe(createHmac('sha256', GATEWAY_SECRET).update(`media-upload\n${payload}`).digest('base64url'))
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))).toEqual({
      u: 'user_a',
      h: ['whatsapp-2'],
      e: expiresAt,
    })
  })

  it('is refused for someone else’s chat, or an account no host runs', async () => {
    const t = setup()
    const alice = await signIn(t, 'user_a')
    const bob = await signIn(t, 'user_b')
    const chatId = await chatOn(t, 'user_a', 'whatsapp-1')
    await expect(bob.mutation(api.media.upload, { chatId })).rejects.toThrow()
    const idle = await chatOn(t, 'user_c')
    const carol = await signIn(t, 'user_c')
    await expect(carol.mutation(api.media.upload, { chatId: idle })).rejects.toThrow()
    await expect(alice.mutation(api.media.upload, { chatId: idle })).rejects.toThrow()
  })
})
