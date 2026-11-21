/**
 * Whether a cancelled scheduled message can't go back into the composer as it is: the draft
 * there has something in it (text or a reply) and replies to a different message, or to none
 * where this one is a reply. Merging them would send one's text as the other's reply. Then the
 * cancel isn't made, and the person sends or clears their draft first.
 */
export function restoreConflict(draft: { text: string; reply: { eventId: string } | null }, replyTo: string | null) {
  const inUse = !!draft.text.trim() || draft.reply !== null
  return inUse && (draft.reply?.eventId ?? null) !== replyTo
}

/** What the scheduled message's Cancel button does, by what's known of its text. */
export function cancelKind(body: string | null | undefined): 'wait' | 'discard' | 'restore' {
  // Not opened yet: cancelling now would delete the only copy before its text could come back.
  if (body === undefined) return 'wait'
  // This device can't open it, so there's nothing to put back: cancelling only discards it.
  if (body === null) return 'discard'
  return 'restore'
}
