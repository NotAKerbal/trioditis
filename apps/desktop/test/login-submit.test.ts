import { describe, expect, it } from 'vitest'
import {
  canSubmit,
  initialSubmit,
  submitReducer,
  type SubmitEvent,
  type SubmitState,
} from '../src/features/settings/login-submit.ts'

const run = (events: SubmitEvent[], from: SubmitState = initialSubmit) => events.reduce(submitReducer, from)

describe('sending a login step once', () => {
  it('opens a new step for sending', () => {
    const state = run([{ type: 'step', stepId: 'a' }])
    expect(canSubmit(state, 'a')).toBe(true)
  })

  it('refuses a second send while the first is on its way', () => {
    const sending = run([{ type: 'send', stepId: 'a', attempt: 1 }])
    expect(sending).toEqual({ sentStepId: 'a', attempt: 1, sending: true, error: null })
    expect(canSubmit(sending, 'a')).toBe(false)
    // A second send for the step changes nothing.
    expect(submitReducer(sending, { type: 'send', stepId: 'a', attempt: 1 })).toBe(sending)
  })

  it('keeps the step locked after the server takes it, until the next step', () => {
    const sent = run([
      { type: 'send', stepId: 'a', attempt: 1 },
      { type: 'sent', attempt: 1 },
    ])
    expect(sent.sending).toBe(false)
    expect(canSubmit(sent, 'a')).toBe(false)
    expect(submitReducer(sent, { type: 'send', stepId: 'a', attempt: 1 })).toBe(sent)
    // The same step arriving again from the server doesn't reopen it.
    expect(canSubmit(submitReducer(sent, { type: 'step', stepId: 'a' }), 'a')).toBe(false)
    // The next step does.
    const next = submitReducer(sent, { type: 'step', stepId: 'b' })
    expect(next).toEqual(initialSubmit)
    expect(canSubmit(next, 'b')).toBe(true)
  })

  it('shows the server’s message as it is, and reopens the step without retrying', () => {
    const message = 'That’s already been sent. Wait for the next step.'
    const failed = run([
      { type: 'send', stepId: 'a', attempt: 1 },
      { type: 'failed', attempt: 1, message },
    ])
    expect(failed).toEqual({ ...initialSubmit, error: message })
    // Open for the person to send again by hand; nothing was sent for them.
    expect(canSubmit(failed, 'a')).toBe(true)
    // Sending again clears the message.
    expect(submitReducer(failed, { type: 'send', stepId: 'a', attempt: 2 }).error).toBeNull()
  })

  it('ignores an answer for a step that is already over', () => {
    const moved = run([
      { type: 'send', stepId: 'a', attempt: 1 },
      { type: 'step', stepId: 'b' },
    ])
    expect(submitReducer(moved, { type: 'failed', attempt: 1, message: 'late' })).toBe(moved)
    expect(submitReducer(moved, { type: 'sent', attempt: 1 })).toBe(moved)
    expect(canSubmit(moved, 'b')).toBe(true)
  })

  it('ignores a late answer from before "Start again", even for a step with the same ID', () => {
    const restarted = run([
      { type: 'send', stepId: 'a', attempt: 1 },
      // Start again: the stepper resets, and the new login's first step reuses the ID.
      { type: 'step', stepId: null },
      { type: 'step', stepId: 'a' },
      { type: 'send', stepId: 'a', attempt: 2 },
    ])
    expect(submitReducer(restarted, { type: 'failed', attempt: 1, message: 'old' })).toBe(restarted)
    expect(submitReducer(restarted, { type: 'sent', attempt: 1 })).toBe(restarted)
    expect(restarted.sending).toBe(true)
  })

  it('has nothing to send without a step', () => {
    expect(canSubmit(initialSubmit, null)).toBe(false)
    expect(canSubmit(initialSubmit, undefined)).toBe(false)
    expect(run([{ type: 'step', stepId: null }])).toEqual(initialSubmit)
  })
})
