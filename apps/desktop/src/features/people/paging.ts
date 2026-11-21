import { useEffect, useState } from 'react'

// Long lists in the People window are shown a page at a time, so a big address book stays
// quick to draw, and the list says how many more there are rather than stopping quietly.

/** How many rows a list shows at first, and how many more each "Show more" adds. */
export const PAGE_ROWS = 200

/** The rows to show, and how many are left out. */
export function pageOf<T>(rows: readonly T[], limit: number): { shown: readonly T[]; more: number } {
  return { shown: rows.length > limit ? rows.slice(0, limit) : rows, more: Math.max(0, rows.length - limit) }
}

/** A list's page, starting again from the first when `reset` (its search, say) changes. */
export function usePage<T>(rows: readonly T[], reset?: unknown) {
  const [limit, setLimit] = useState(PAGE_ROWS)
  useEffect(() => setLimit(PAGE_ROWS), [reset])
  return { ...pageOf(rows, limit), showMore: () => setLimit((n) => n + PAGE_ROWS) }
}
