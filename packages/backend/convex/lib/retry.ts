import { v } from 'convex/values'
import type { Doc } from '../_generated/dataModel'
import type { QueryCtx } from '../_generated/server'
import { deliveryState } from '../validators'

// Sending a message again, decided here and not by the client. Every attempt is a link in a
// chain from the original send: its outbox row records the original (`retryRoot`), the link
// before it (`retryOf`) and its place (`retryIndex`). The next link's client message ID is
// worked out here from the original and its place, so any tab, after any reload, asks for the
// same next send, and the outbox's ID fence makes it one. The first attempt may be made when
// the original failed or may not have gone; a later one only when the latest attempt failed and
// nothing else in the chain, the original included, was sent or may still go (any state but
// failed): a send that turns out to have gone after all ends the chain. Never by itself.

/** The prefix of every attempt's client message ID: no other send may take one. */
export const RETRY_PREFIX = 'rt_'

/** The most attempts a message can have. */
export const MAX_ATTEMPTS = 8

/** Where a chain stands, as `messages.retryStates` and `messages.sendAgain` say it. */
export const retryState = v.object({
  /** The original send's client message ID. */
  root: v.string(),
  /** The latest attempt's client message ID; null when none has been made. */
  latest: v.union(v.null(), v.string()),
  /** The latest attempt's delivery state (null when none, or not known). */
  delivery: v.union(v.null(), deliveryState),
  /** Whether another attempt may be made now. */
  allowed: v.boolean(),
  /** The next attempt's client message ID, to seal it with, when one is allowed. */
  nextId: v.union(v.null(), v.string()),
})

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

/** The client message ID of attempt `index` (1, 2…) of the chain from `root`: 46 characters. */
export async function retryId(root: string, index: number) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`trioditis/retry/v1/${root}/${index}`))
  return `${RETRY_PREFIX}${toBase64Url(new Uint8Array(hash))}`
}

async function outboxRow(ctx: QueryCtx, userId: string, clientMessageId: string) {
  return await ctx.db
    .query('outbox')
    .withIndex('by_clientMessageId', (q) => q.eq('userId', userId).eq('clientMessageId', clientMessageId))
    .first()
}

const TROUBLED = new Set(['failed', 'unknown'])
const SENT = new Set(['sent', 'delivered', 'read'])

/**
 * Where the chain `clientMessageId` belongs to stands: it may be the original or any attempt.
 * Null if it isn't one of this person's sends.
 */
export async function retryPlan(ctx: QueryCtx, userId: string, clientMessageId: string) {
  const row = await outboxRow(ctx, userId, clientMessageId)
  if (!row || row.payload.type !== 'send') return null
  const root = row.retryRoot ?? clientMessageId
  const original = row.retryRoot ? await outboxRow(ctx, userId, root) : row
  // The whole chain, oldest first: there are at most MAX_ATTEMPTS attempts.
  const links = await ctx.db
    .query('outbox')
    .withIndex('by_retryRoot', (q) => q.eq('userId', userId).eq('retryRoot', root))
    .take(MAX_ATTEMPTS + 1)
  const latest: Doc<'outbox'> | undefined = links.at(-1)
  const index = latest?.retryIndex ?? 0
  const chain = [...(original ? [original] : []), ...links]
  const went = chain.find((r) => SENT.has(r.delivery ?? ''))
  const allowed =
    index < MAX_ATTEMPTS &&
    !went &&
    (latest
      ? latest.delivery === 'failed' && chain.every((r) => r.delivery === 'failed')
      : TROUBLED.has(original?.delivery ?? ''))
  // What the chain shows: the send that went, if one did, or else the latest attempt.
  const shown = went ?? latest
  return {
    root,
    latest: shown?.clientMessageId ?? null,
    delivery: shown?.delivery ?? null,
    allowed,
    nextId: allowed ? await retryId(root, index + 1) : null,
    /** For making the next attempt. */
    next: { of: latest?.clientMessageId ?? root, index: index + 1, chatId: (original ?? row).chatId },
  }
}
