import { ConvexError, v } from 'convex/values'
import { mutation } from './_generated/server'
import { requireMember } from './lib/access'
import { hmacBase64url } from './lib/hash'
import { network } from './validators'

/** How long a media token lasts. The client asks for another before it runs out. */
export const MEDIA_TOKEN_TTL_MS = 60 * 60_000

/** The most bridge hosts one token names: a network has one, and briefly two while one takes over. */
const MAX_HOSTS = 8

/**
 * A token for fetching the person's files on a network from the gateway (`GET /media/<mediaId>`,
 * docs/architecture/client-api.md, Media). The files are ciphertext whose keys are only in the
 * person's sealed plaintext, so the token only has to say who is asking and which bridge hosts
 * to ask: `<payload>.<mac>`, where `payload` is base64url JSON `{ u, h, e }` (the person, the
 * network's host IDs, and when it expires) and `mac` is HMAC-SHA256 under GATEWAY_SECRET of
 * `media-access\n<payload>`. The bridge host gives a file only to its owner.
 */
export const access = mutation({
  args: { network },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, args) => {
    const member = await requireMember(ctx)
    const secret = process.env.GATEWAY_SECRET
    if (!secret) throw new ConvexError('This server can’t show pictures and files.')
    // A handful of rows, one per bridge host there has ever been here.
    const hosts = (await ctx.db.query('bridgeHosts').take(200))
      .filter((host) => host.network === args.network)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, MAX_HOSTS)
      .map((host) => host.hostId)
    const expiresAt = Date.now() + MEDIA_TOKEN_TTL_MS
    const payload = btoa(JSON.stringify({ u: member.userId, h: hosts, e: expiresAt }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
    return { token: `${payload}.${await hmacBase64url(secret, `media-access\n${payload}`)}`, expiresAt }
  },
})
