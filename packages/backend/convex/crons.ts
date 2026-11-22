import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

// A rate limit bucket refills within a few minutes; this keeps the table to recent clients.
crons.interval('prune rate limits', { minutes: 10 }, internal.rateLimits.prune, {})
// Requests to start a chat are kept a day; this keeps the table to recent ones.
crons.interval('prune chat starts', { hours: 1 }, internal.newChats.prune, {})
// A cancelled message's copy waits 30 days to be restored or discarded (scheduled.ts).
crons.interval('forget old cancelled messages', { hours: 6 }, internal.scheduled.forgetOldCancelled, {})
// How quickly the server answers a small query of its own, for Admin settings → Server health.
crons.interval('time the server', { minutes: 1 }, internal.health.probe, {})

export default crons
