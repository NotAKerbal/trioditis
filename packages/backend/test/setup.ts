/// <reference types="vitest/importMeta" />
import { convexTest } from 'convex-test'
import mcpTest from '@convex-dev/mcp/test'
import { api, components } from '../convex/_generated/api'
import schema from '../convex/schema'
import betterAuthSchema from '../convex/betterAuth/schema'

const modules = import.meta.glob(['../convex/**/*.ts', '!../convex/betterAuth/**'])
const betterAuthModules = import.meta.glob(['../convex/betterAuth/**/*.ts', '!../convex/betterAuth/auth.ts'])

export const GATEWAY_SECRET = 'test-gateway-secret'
export const SETUP_TOKEN = 'test-setup-token'

export function setup() {
  process.env.GATEWAY_SECRET = GATEWAY_SECRET
  process.env.TRIODITIS_SETUP_TOKEN = SETUP_TOKEN
  process.env.TRIODITIS_NETWORKS = 'whatsapp,fake'
  process.env.SITE_URL = 'https://trioditis.test'
  const t = convexTest(schema, modules)
  t.registerComponent('betterAuth', betterAuthSchema, betterAuthModules)
  mcpTest.register(t, 'mcp')
  return t
}

export type T = ReturnType<typeof setup>

/** A signed-in member: a Better Auth user and session, and their membership. */
export async function signIn(t: T, userId: string, role: 'admin' | 'member' = 'member', identity = true) {
  const session = await t.run(async (ctx) => {
    return (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'session',
        data: {
          token: `token-${userId}`,
          userId,
          expiresAt: Date.now() + 60 * 60 * 1000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })) as { _id: string }
  })
  await t.run(async (ctx) => {
    await ctx.db.insert('members', {
      userId,
      role,
      createdAt: Date.now(),
      ...(identity ? { identityPublicKey: 'A'.repeat(43), identityKid: 'K'.repeat(22) } : {}),
    })
  })
  return t.withIdentity({ subject: userId, sessionId: session._id })
}

function base64url(length: number, tag: string) {
  const bytes = new Uint8Array(length)
  bytes.set(new TextEncoder().encode(tag).subarray(0, length))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * A stand-in envelope with the right shape (field lengths as sealing.md gives them). The
 * backend never opens envelopes, so what they hold doesn't matter here.
 */
export function sealed(tag = 'x') {
  return {
    v: 1 as const,
    nonce: base64url(24, `n${tag}`),
    ct: base64url(40, `c${tag}`),
    keys: [{ kid: base64url(16, 'kid'), sk: base64url(80, `s${tag}`) }],
  }
}

/** Reports a bridge host in, as its heartbeat does, so commands can be claimed for it. */
export async function heartbeat(t: T, hostId = 'whatsapp-1', network: 'whatsapp' | 'fake' = 'whatsapp') {
  return await t.mutation(api.gateway.ingest, { secret: GATEWAY_SECRET, hostId, network, events: [] })
}
