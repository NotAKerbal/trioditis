// Times as the chat list and messages show them.
const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' })
const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

/** "9:41" today, "Tue" this week, "Nov 3" before that. */
export function listTime(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const today = new Date(now)
  if (d.toDateString() === today.toDateString()) return time.format(d)
  if (now - ms < 6 * 24 * 60 * 60 * 1000) return weekday.format(d)
  return date.format(d)
}

export const messageTime = (ms: number) => time.format(new Date(ms))
