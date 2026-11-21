import { components } from '../_generated/api'
import type { MutationCtx } from '../_generated/server'

const PAGE = 200

/**
 * Deletes every row of a Better Auth `model` that belongs to `userId`, a page at a time, in this
 * transaction: so none is left behind however many there are (a person signed in on many devices
 * has many sessions).
 */
export async function deleteAllAuthRows(
  ctx: MutationCtx,
  model: 'session' | 'account' | 'passkey',
  userId: string,
): Promise<number> {
  let deleted = 0
  let cursor: string | null = null
  for (;;) {
    const result = (await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model, where: [{ field: 'userId', value: userId }] },
      paginationOpts: { cursor, numItems: PAGE },
    })) as { count: number; isDone: boolean; continueCursor: string }
    deleted += result.count
    if (result.isDone) return deleted
    cursor = result.continueCursor
  }
}
