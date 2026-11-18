// Sending a login step's input once. The server takes one submission per step and refuses a
// second ("That’s already been sent. Wait for the next step."), so after a send the step stays
// locked until the bridge host sends the next step. A send that fails reopens the step with the
// server's message, for the person to try again; nothing is retried for them.

export interface SubmitState {
  /** The step whose input was sent (or is being sent), or null while the step is open. */
  sentStepId: string | null
  sending: boolean
  /** Why the last send failed, as the server put it. */
  error: string | null
}

export type SubmitEvent =
  | { type: 'send'; stepId: string }
  | { type: 'sent'; stepId: string }
  | { type: 'failed'; stepId: string; message: string }
  | { type: 'step'; stepId: string | null }

export const initialSubmit: SubmitState = { sentStepId: null, sending: false, error: null }

/** Whether the input for `stepId` can be sent now. */
export function canSubmit(state: SubmitState, stepId: string | null | undefined): boolean {
  return !!stepId && !state.sending && state.sentStepId !== stepId
}

export function submitReducer(state: SubmitState, event: SubmitEvent): SubmitState {
  switch (event.type) {
    case 'send':
      if (!canSubmit(state, event.stepId)) return state
      return { sentStepId: event.stepId, sending: true, error: null }
    case 'sent':
      // Stays locked: the next step from the bridge host is what opens the form again. An
      // answer for a step that's already over changes nothing.
      return event.stepId === state.sentStepId ? { ...state, sending: false } : state
    case 'failed':
      return event.stepId === state.sentStepId ? { sentStepId: null, sending: false, error: event.message } : state
    case 'step':
      // The step that was sent arriving again changes nothing; any other step starts open.
      return event.stepId !== null && event.stepId === state.sentStepId ? state : initialSubmit
  }
}
