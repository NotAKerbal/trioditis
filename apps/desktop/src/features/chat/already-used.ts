import type { api } from '@trioditis/backend/api'
import type { FunctionReturnType } from 'convex/server'

// What a send or schedule found when its client message ID had been used already
// (messages.send, client-api.md Sending), and what the client makes of it.

export type AlreadyUsed = Exclude<FunctionReturnType<typeof api.messages.send>, 'queued'>

/** What to say when a cancel came after the message's time or Send now: by where that send stands. */
export function beatenBySend(delivery: string | null): string {
  switch (delivery) {
    case 'queued':
    case 'claimed':
    case 'submitted':
      return 'Too late to cancel: it’s being sent.'
    case 'sent':
    case 'delivered':
    case 'read':
      return 'Too late to cancel: it was sent.'
    case 'failed':
      return 'Too late to cancel: it went out, and failed.'
    default:
      return 'Too late to cancel: it may have been sent. Check the chat.'
  }
}

/**
 * What to do with a draft whose send ID was used already, and what to tell the person:
 * - `done`: that use went, is going, or is still scheduled. This one isn't sent again.
 * - `check`: it may have gone (`unknown`). Not sent again, and not offered again either: the
 *   person looks at the chat first, and can type it again if it didn't.
 * - `again`: it surely never went (failed, or cancelled or failed when scheduled). The text
 *   comes back as a new draft, so sending it is a new message.
 */
export function usedOutcome(used: AlreadyUsed): { action: 'done' | 'check' | 'again'; say: string } {
  if (used.already === 'scheduled') {
    if (used.state === 'scheduled')
      return { action: 'done', say: 'That message is already scheduled, from another tab or before a reload.' }
    return {
      action: 'again',
      say: `That exact message was scheduled before and ${used.state === 'cancelled' ? 'cancelled' : 'never went'}. It’s back in the composer: send it again to send it as a new message.`,
    }
  }
  switch (used.delivery) {
    case 'queued':
    case 'claimed':
    case 'submitted':
      return { action: 'done', say: 'That message is already sending, from another tab or before a reload.' }
    case 'sent':
    case 'delivered':
    case 'read':
      return { action: 'done', say: 'That message was already sent, from another tab or before a reload.' }
    case 'failed':
      return {
        action: 'again',
        say: 'That exact message failed before. It’s back in the composer: send it again to send it as a new message.',
      }
    default:
      // `unknown`, or a send from before its state was kept.
      return {
        action: 'check',
        say: 'That message may already have been sent. Check the chat before sending it again.',
      }
  }
}
