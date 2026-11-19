import { ConvexError, v } from 'convex/values'
import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { requireSessionIfGiven } from './auth'
import { requireAdmin } from './lib/access'
import { audit } from './lib/audit'
import { constantTimeEqual, randomToken } from './lib/hash'
import { commitInfo, updateChannel, updaterReport, type UpdateChannel, type UpdaterReport } from './validators'

// How admins update the server from the app. The work is done by the updater, a service on the
// host beside the Docker Compose bundle (deploy/updater): it watches `poll` for the admins'
// choices and requests, fetches its channel's branch, runs the installer, and `report`s back.
// It signs its calls with UPDATER_SECRET, which only it and the backend have. It only ever moves
// the server forward to the newest commit of a channel's branch on its own git remote, so
// nothing here can make it install anything else. See docs/deploy.md, Updates.

const DEFAULT_CHANNEL: UpdateChannel = 'stable'
const COMMIT = /^[0-9a-f]{40}$/
const MAX_MESSAGE = 500
const MAX_SUBJECT = 200

const requestKind = v.union(v.literal('check'), v.literal('update'))

function assertUpdater(secret: string) {
  const expected = process.env.UPDATER_SECRET
  if (!expected || !constantTimeEqual(secret, expected)) throw new ConvexError('Not the updater')
}

async function settingsRow(ctx: QueryCtx) {
  return await ctx.db
    .query('serverUpdates')
    .withIndex('by_key', (q) => q.eq('key', 'server'))
    .unique()
}

async function ensureSettingsRow(ctx: MutationCtx) {
  const existing = await settingsRow(ctx)
  if (existing) return existing
  const id = await ctx.db.insert('serverUpdates', { key: 'server', channel: DEFAULT_CHANNEL, autoUpdate: false })
  return (await ctx.db.get(id))!
}

/** What the admin settings show: the choices, the waiting request, and the updater's last report. */
export const status = query({
  args: {},
  returns: v.object({
    channel: updateChannel,
    autoUpdate: v.boolean(),
    /** The commit the deployed functions were built from, or null where the installer didn't say. */
    version: v.union(v.string(), v.null()),
    /** Whether this server has an updater at all (the installer's --updater). */
    updaterConfigured: v.boolean(),
    request: v.union(v.null(), v.object({ kind: requestKind, at: v.number() })),
    updater: v.union(v.null(), updaterReport),
  }),
  handler: async (ctx) => {
    await requireAdmin(ctx)
    const row = await settingsRow(ctx)
    return {
      channel: row?.channel ?? DEFAULT_CHANNEL,
      autoUpdate: row?.autoUpdate ?? false,
      version: process.env.TRIODITIS_VERSION || null,
      updaterConfigured: !!process.env.UPDATER_SECRET,
      request: row?.request ? { kind: row.request.kind, at: row.request.at } : null,
      updater: row?.updater ?? null,
    }
  },
})

export const setChannel = mutation({
  args: { channel: updateChannel, sessionId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const admin = await requireAdmin(ctx)
    const row = await ensureSettingsRow(ctx)
    if (row.channel === args.channel) return null
    // The updater looks at the new channel's branch right away rather than at its next
    // hourly check, unless an update is already waiting (which checks first anyway).
    const request = row.request ?? (process.env.UPDATER_SECRET ? newRequest('check', admin.userId) : undefined)
    await ctx.db.patch(row._id, { channel: args.channel, ...(request ? { request } : {}) })
    await audit(ctx, { kind: 'user', id: admin.userId }, `updates.channel.${args.channel}`)
    return null
  },
})

export const setAutoUpdate = mutation({
  args: { enabled: v.boolean(), sessionId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const admin = await requireAdmin(ctx)
    const row = await ensureSettingsRow(ctx)
    if (row.autoUpdate === args.enabled) return null
    await ctx.db.patch(row._id, { autoUpdate: args.enabled })
    await audit(ctx, { kind: 'user', id: admin.userId }, args.enabled ? 'updates.auto.on' : 'updates.auto.off')
    return null
  },
})

function newRequest(kind: 'check' | 'update', by: string) {
  return { id: randomToken(12), kind, at: Date.now(), by }
}

/** Asks the updater to look for a new version now, or to install the newest one. */
export const request = mutation({
  args: { kind: requestKind, sessionId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const admin = await requireAdmin(ctx)
    if (!process.env.UPDATER_SECRET) {
      throw new ConvexError('This server has no updater. Its operator can turn it on with the installer’s --updater.')
    }
    const row = await ensureSettingsRow(ctx)
    if (row.updater?.state === 'updating') throw new ConvexError('An update is already running.')
    // A waiting update isn't replaced by a check: the update looks for the newest version itself.
    if (args.kind === 'check' && row.request?.kind === 'update') return null
    await ctx.db.patch(row._id, { request: newRequest(args.kind, admin.userId) })
    await audit(ctx, { kind: 'user', id: admin.userId }, `updates.${args.kind}`)
    return null
  },
})

/** Takes back a request the updater hasn't started on. An update in progress can't be stopped. */
export const cancelRequest = mutation({
  args: { sessionId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireSessionIfGiven(ctx, args.sessionId)
    const admin = await requireAdmin(ctx)
    const row = await settingsRow(ctx)
    if (!row?.request) return null
    if (row.updater?.state === 'updating') throw new ConvexError('The update has already started.')
    await ctx.db.patch(row._id, { request: undefined })
    await audit(ctx, { kind: 'user', id: admin.userId }, 'updates.cancel')
    return null
  },
})

// --- The updater's calls -------------------------------------------------------------------

/** What the updater acts on. It watches this, so a request reaches it as soon as it's made. */
export const poll = query({
  args: { secret: v.string() },
  returns: v.object({
    channel: updateChannel,
    autoUpdate: v.boolean(),
    request: v.union(v.null(), v.object({ id: v.string(), kind: requestKind })),
  }),
  handler: async (ctx, { secret }) => {
    assertUpdater(secret)
    const row = await settingsRow(ctx)
    return {
      channel: row?.channel ?? DEFAULT_CHANNEL,
      autoUpdate: row?.autoUpdate ?? false,
      request: row?.request ? { id: row.request.id, kind: row.request.kind } : null,
    }
  },
})

/**
 * The updater's report: its state, the commit the server runs, and the newest one on its
 * channel. `done` names the request it has finished, which is then cleared.
 */
export const report = mutation({
  args: {
    secret: v.string(),
    state: updaterReport.fields.state,
    message: v.optional(v.string()),
    current: v.optional(commitInfo),
    latest: v.optional(updaterReport.fields.latest),
    done: v.optional(v.string()),
    /** The request this report starts on: refused if it was cancelled meanwhile. */
    claim: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    assertUpdater(args.secret)
    for (const commit of [args.current?.commit, args.latest?.commit]) {
      if (commit !== undefined && !COMMIT.test(commit)) throw new ConvexError('Not a commit ID')
    }
    const row = await ensureSettingsRow(ctx)
    if (args.claim !== undefined && row.request?.id !== args.claim) throw new ConvexError('That request was cancelled.')
    const previous = row.updater
    const now = Date.now()
    // An update's start is when it was first reported; a failure keeps the start of the update
    // that failed.
    const startedAt =
      args.state === 'updating'
        ? previous?.state === 'updating' && previous.startedAt
          ? previous.startedAt
          : now
        : args.state === 'failed'
          ? previous?.startedAt
          : undefined
    const current = args.current ?? previous?.current
    const latest = args.latest
      ? { ...args.latest, subject: args.latest.subject.slice(0, MAX_SUBJECT) }
      : previous?.latest
    const updater: UpdaterReport = {
      seenAt: now,
      state: args.state,
      ...(args.message ? { message: args.message.slice(0, MAX_MESSAGE) } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(current ? { current } : {}),
      ...(latest ? { latest } : {}),
    }
    const finished = args.done !== undefined && row.request?.id === args.done
    await ctx.db.patch(row._id, { updater, ...(finished ? { request: undefined } : {}) })
    return null
  },
})
