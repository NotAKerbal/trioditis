import { ConvexError, v } from 'convex/values'
import { mutation } from './_generated/server'
import { ownChat, requireMember } from './lib/access'
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
    return { token: await sign(secret, 'media-access', { u: member.userId, h: hosts, e: expiresAt }), expiresAt }
  },
})

/** How long an upload token lasts: long enough to send a few large files on a slow link. */
export const UPLOAD_TOKEN_TTL_MS = 15 * 60_000

/**
 * A token for giving the gateway files to send on a chat (`PUT /media/<mediaId>`,
 * docs/architecture/client-api.md, Media): the same shape as `access`, signed for
 * `media-upload` instead, and naming only the bridge host that runs the chat's account, which
 * its send will go to. The file is ciphertext; its key goes only in the sealed send.
 */
export const upload = mutation({
  args: { chatId: v.id('chats') },
  returns: v.object({ token: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { chatId }) => {
    const member = await requireMember(ctx)
    const chat = await ownChat(ctx, member.userId, chatId)
    const secret = process.env.GATEWAY_SECRET
    if (!secret) throw new ConvexError('This server can’t send pictures and files.')
    const account = await ctx.db
      .query('networkAccounts')
      .withIndex('by_login', (q) => q.eq('network', chat.network).eq('loginId', chat.loginId))
      .unique()
    if (!account?.hostId || account.userId !== member.userId) {
      throw new ConvexError('This chat’s account isn’t connected, so files can’t be sent on it now.')
    }
    const expiresAt = Date.now() + UPLOAD_TOKEN_TTL_MS
    return {
      token: await sign(secret, 'media-upload', { u: member.userId, h: [account.hostId], e: expiresAt }),
      expiresAt,
    }
  },
})

async function sign(secret: string, purpose: string, claims: { u: string; h: string[]; e: number }) {
  const payload = btoa(JSON.stringify(claims)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  return `${payload}.${await hmacBase64url(secret, `${purpose}\n${payload}`)}`
}
