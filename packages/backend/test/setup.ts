/// <reference types="vitest/importMeta" />
import { convexTest } from 'convex-test'
import mcpTest from '@convex-dev/mcp/test'
import { components } from '../convex/_generated/api'
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

/** A stand-in envelope. The backend never opens envelopes, so its contents don't matter here. */
export function sealed(tag = 'x') {
  return { v: 1 as const, nonce: `nonce-${tag}`, ct: `ct-${tag}`, keys: [{ kid: 'kid', sk: `sk-${tag}` }] }
}
