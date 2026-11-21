/**
 * Whether a cancelled scheduled message can't go back into the composer as it is: the draft
 * there has something in it (text or a reply) and replies to a different message, or to none
 * where this one is a reply. Merging them would send one's text as the other's reply. Then it
 * stays on the server, listed under the chat, until the person sends or clears their draft and
 * restores it, or discards it (scheduled.cancelled, client-api.md).
 */
export function restoreConflict(draft: { text: string; reply: { eventId: string } | null }, replyTo: string | null) {
  const inUse = !!draft.text.trim() || draft.reply !== null
  return inUse && (draft.reply?.eventId ?? null) !== replyTo
}
