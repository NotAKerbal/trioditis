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
    const sending = run([{ type: 'send', stepId: 'a' }])
    expect(sending).toEqual({ sentStepId: 'a', sending: true, error: null })
    expect(canSubmit(sending, 'a')).toBe(false)
    // A second send for the step changes nothing.
    expect(submitReducer(sending, { type: 'send', stepId: 'a' })).toBe(sending)
  })

  it('keeps the step locked after the server takes it, until the next step', () => {
    const sent = run([
      { type: 'send', stepId: 'a' },
      { type: 'sent', stepId: 'a' },
    ])
    expect(sent.sending).toBe(false)
    expect(canSubmit(sent, 'a')).toBe(false)
    expect(submitReducer(sent, { type: 'send', stepId: 'a' })).toBe(sent)
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
      { type: 'send', stepId: 'a' },
      { type: 'failed', stepId: 'a', message },
    ])
    expect(failed).toEqual({ sentStepId: null, sending: false, error: message })
    // Open for the person to send again by hand; nothing was sent for them.
    expect(canSubmit(failed, 'a')).toBe(true)
    // Sending again clears the message.
    expect(submitReducer(failed, { type: 'send', stepId: 'a' }).error).toBeNull()
  })

  it('ignores an answer for a step that is already over', () => {
    const moved = run([
      { type: 'send', stepId: 'a' },
      { type: 'step', stepId: 'b' },
    ])
    expect(submitReducer(moved, { type: 'failed', stepId: 'a', message: 'late' })).toBe(moved)
    expect(submitReducer(moved, { type: 'sent', stepId: 'a' })).toBe(moved)
    expect(canSubmit(moved, 'b')).toBe(true)
  })

  it('has nothing to send without a step', () => {
    expect(canSubmit(initialSubmit, null)).toBe(false)
    expect(canSubmit(initialSubmit, undefined)).toBe(false)
    expect(run([{ type: 'step', stepId: null }])).toEqual(initialSubmit)
  })
})
