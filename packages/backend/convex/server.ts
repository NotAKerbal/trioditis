import { v } from 'convex/values'
import { query } from './_generated/server'

/**
 * What kind of server this is, so the client can hide controls it doesn't offer instead of
 * waiting for a mutation's error. Public: the sign-in and setup screens need it too, and it
 * says nothing about anyone's account.
 */
export const info = query({
  args: {},
  returns: v.object({ demo: v.boolean(), invitations: v.boolean() }),
  handler: async () => {
    const demo = process.env.TRIODITIS_DEMO === '1'
    return { demo, invitations: !demo }
  },
})
