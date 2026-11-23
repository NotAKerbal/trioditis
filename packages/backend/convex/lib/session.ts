import { ConvexError } from 'convex/values'
import type { GenericCtx } from '@convex-dev/better-auth'
import { components } from '../_generated/api'
import type { DataModel } from '../_generated/dataModel'

// Who is signed in. Kept apart from auth.ts, which loads Better Auth and its plugins: a
// module is loaded afresh for each call, so a function that only needs to know who is signed
// in imports this and pays for nothing else.

/**
 * The signed-in user and the Better Auth session they're signed in with, or null. Every
 * function that touches a person's data gets them here (or from `currentUserId` and
 * `requireUserId`), so this one place decides who is signed in.
 *
 * A Convex token works for several minutes after it is issued, so the user counts as signed
 * in only while the Better Auth session it names is still there, theirs and unexpired.
 * Signing out deletes that row, and live queries run again without the user.
 */
export async function currentSession(
  ctx: GenericCtx<DataModel>,
): Promise<{ userId: string; sessionId: string } | null> {
  const identity = await ctx.auth.getUserIdentity()
  const sessionId = identity?.sessionId
  if (!identity || typeof sessionId !== 'string') return null
  const live = await ctx.runQuery(components.betterAuth.sessions.live, { sessionId, userId: identity.subject })
  return live ? { userId: identity.subject, sessionId } : null
}

/**
 * What a call bound to a session is refused with when it runs as another one. `code` is for
 * the app to act on; `message` is for the person.
 */
export const SESSION_CHANGED = {
  code: 'sessionChanged',
  message: 'This page’s session has changed. Reload the page.',
} as const

/**
 * Refuses the call, before it writes anything, unless it runs as the Better Auth session
 * `sessionId`. A page passes the session it opened with (`members.me`'s `sessionId`), because
 * the Convex client it shares with other tabs can switch to another account's token while the
 * page still shows the first: without this, a write the page meant for one account would land
 * on the other. With `userId`, the session must also be that user's. Returns the session's
 * user when `sessionId` is given; omitted, nothing is checked.
 */
export async function requireSessionIfGiven(
  ctx: GenericCtx<DataModel>,
  sessionId: string | undefined,
  userId?: string,
) {
  if (sessionId === undefined) return
  const session = await currentSession(ctx)
  if (session?.sessionId !== sessionId || (userId !== undefined && session.userId !== userId)) {
    throw new ConvexError(SESSION_CHANGED)
  }
  return session.userId
}

/** The signed-in user's ID, or null. */
export async function currentUserId(ctx: GenericCtx<DataModel>): Promise<string | null> {
  return (await currentSession(ctx))?.userId ?? null
}

export async function requireUserId(ctx: GenericCtx<DataModel>): Promise<string> {
  const userId = await currentUserId(ctx)
  if (!userId) throw new ConvexError('You’re signed out. Sign in again to continue.')
  return userId
}

/**
 * The Better Auth user with this ID, or null: what `authComponent.getAnyUserById` asks, without
 * loading auth.ts.
 */
export async function anyUserById(ctx: GenericCtx<DataModel>, userId: string) {
  return await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'user',
    where: [{ field: '_id', value: userId }],
  })
}
