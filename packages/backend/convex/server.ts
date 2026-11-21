import { v } from 'convex/values'
import { query } from './_generated/server'
import { demoEnabled } from './demo'

/**
 * What kind of server this is, so the client can hide controls it doesn't offer instead of
 * waiting for a mutation's error. Public: the sign-in and setup screens need it too, and it
 * says nothing about anyone's account.
 */
export const info = query({
  args: {},
  returns: v.object({ demo: v.boolean(), invitations: v.boolean(), version: v.union(v.string(), v.null()) }),
  handler: async () => {
    // `demo` is whether demo data loads here (`demo.seedForMe`); invitations are off on any
    // server marked a demo, as `members.invite` refuses them there. `version` is the commit
    // the installer deployed (TRIODITIS_VERSION), so an open page can tell the server was
    // updated under it; the web app's own files already identify the build.
    return {
      demo: demoEnabled(),
      invitations: process.env.TRIODITIS_DEMO !== '1',
      version: process.env.TRIODITIS_VERSION || null,
    }
  },
})
