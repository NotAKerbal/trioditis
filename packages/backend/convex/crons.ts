import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

// A rate limit bucket refills within a few minutes; this keeps the table to recent clients.
crons.interval('prune rate limits', { minutes: 10 }, internal.rateLimits.prune, {})

export default crons
