/** A chat's last message, opened on this device, as the chat list shows it. */
export interface LastMessage {
  self: boolean
  redacted: boolean
  /** The opened text; null if it doesn't open here, or there's none to show (a large message). */
  text: string | null
}

/**
 * The second line of a chat in the list. With previews on: a draft first (it's what the
 * person is in the middle of), then the last message ("You: " for their own), and only then
 * the chat's topic or its network. With previews off, just the network: no message text.
 */
export function rowPreview({
  previews,
  draft,
  last,
  described,
  topic,
  network,
}: {
  previews: boolean
  draft: string
  last: LastMessage | null | undefined
  described: boolean
  topic: string | undefined
  network: string
}): { kind: 'draft' | 'message' | 'other'; text: string } {
  if (!previews) return { kind: 'other', text: network }
  const drafted = draft.trim()
  if (drafted) return { kind: 'draft', text: drafted.replace(/\s+/g, ' ') }
  if (last) {
    const said = last.redacted ? 'Message deleted' : last.text ? last.text.replace(/\s+/g, ' ') : 'Message'
    return { kind: 'message', text: last.self ? `You: ${said}` : said }
  }
  if (!described) return { kind: 'other', text: 'Waiting for this chat’s details…' }
  return { kind: 'other', text: topic ?? network }
}
