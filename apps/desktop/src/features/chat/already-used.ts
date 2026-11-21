import type { api } from '@trioditis/backend/api'
import type { FunctionReturnType } from 'convex/server'

// What a send or schedule found when its client message ID had been used already
// (messages.send, client-api.md Sending), and what the client makes of it.

export type AlreadyUsed = Exclude<FunctionReturnType<typeof api.messages.send>, 'queued'>

/** Whether the earlier use of an ID went out, or still will: then this one mustn't. */
export function wentAlready(used: AlreadyUsed) {
  if (used.already === 'scheduled') return used.state === 'scheduled'
  // Unknown may have gone; only a failed one, or one whose copy was discarded, surely didn't.
  return used.delivery !== null && used.delivery !== 'failed'
}

/** What to say when a draft's send ID had gone already: it wasn't sent or scheduled again. */
export function alreadyWent(used: AlreadyUsed) {
  return used.already === 'send'
    ? 'That message was already sent, from another tab or before a reload. It wasn’t sent again.'
    : 'That message is already scheduled, from another tab or before a reload. It wasn’t sent again.'
}
