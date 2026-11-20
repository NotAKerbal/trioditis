/** The first wait before the chat list tries again, doubled for each error in a row. */
const FIRST_MS = 2_000
const MOST_MS = 30_000
/** An error this long after the last one starts the count again. */
const QUIET_MS = 60_000

/** How long to wait before retrying, after `failures` errors in a row (the first is 1). */
export function retryDelay(failures: number): number {
  return Math.min(FIRST_MS * 2 ** Math.max(0, failures - 1), MOST_MS)
}

/** The count of errors in a row once another arrives at `now`. */
export function failuresInARow(failures: number, lastErrorAt: number, now: number): number {
  return now - lastErrorAt > QUIET_MS ? 1 : failures + 1
}
