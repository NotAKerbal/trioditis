/**
 * What a search looked through, as its header says it: every chat of the views shown only once
 * they're all loaded, and narrowed by the filters still on, by name, so a filter never hides
 * results unsaid.
 */
export function searchScope({
  searchedAll,
  view,
  network,
  label,
}: {
  /** Every view searched is loaded to its end. */
  searchedAll: boolean
  /** The one view shown (Simple layout), by its menu name; null when every view is (Focused). */
  view: string | null
  network: string | undefined
  label: string | undefined
}): string {
  const where = !searchedAll
    ? 'loaded chats'
    : view === null
      ? 'all chats'
      : view === 'All chats'
        ? 'the inbox'
        : view.toLowerCase()
  const on = network ? ` on ${network}` : ''
  const labelled = label ? ` labelled “${label}”` : ''
  return `Results in ${where}${on}${labelled}`
}
