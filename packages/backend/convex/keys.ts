import { v } from 'convex/values'
import { query } from './_generated/server'
import { requireMember } from './lib/access'

/**
 * The bridge key: clients seal outbound sends and login input to it. See
 * docs/architecture/bridge-protocol.md, Bridge key.
 */
export const bridge = query({
  args: {},
  returns: v.union(v.null(), v.object({ publicKey: v.string() })),
  handler: async (ctx) => {
    await requireMember(ctx)
    const publicKey = process.env.BRIDGE_PUBLIC_KEY
    return publicKey ? { publicKey } : null
  },
})
