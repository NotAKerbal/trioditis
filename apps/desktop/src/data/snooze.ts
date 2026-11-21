// The snooze choices, as times from now. "Later today" is 6 PM, or three hours from now if
// that's sooner than an hour away, and only while that is still today; the rest land at the
// start of a morning. Days are counted on the local calendar, not in 24-hour steps, so a day
// that is 23 or 25 hours long (a daylight saving change) still lands on the right date.

/** `hour` o'clock, local time, `days` calendar days after `date`. */
function at(date: Date, days: number, hour: number) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, hour, 0, 0, 0)
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

export interface SnoozeOption {
  label: string
  until: number
}

/** The furthest ahead a snooze, mute or scheduled send may be: the server refuses more. */
export const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000

/** Whether `until` is a time the server takes for a snooze, mute or scheduled send. */
export const withinAYear = (until: number, now = Date.now()) => until > now && until - now <= MAX_AHEAD_MS

/** Refuses a time the server would, in its words: it must be ahead, and within a year. */
export function checkWithinAYear(until: number, now = Date.now()) {
  if (until <= now) throw new Error('Pick a time in the future.')
  if (until - now > MAX_AHEAD_MS) throw new Error('Pick a time within a year.')
}

export function snoozeOptions(now = new Date()): SnoozeOption[] {
  const tonight = at(now, 0, 18)
  const soon = new Date(now.getTime() + 3 * 60 * 60 * 1000)
  const later = tonight.getTime() - now.getTime() > 60 * 60 * 1000 ? tonight : soon
  const tomorrow = at(now, 1, 9)
  const daysToSaturday = (6 - now.getDay() + 7) % 7 || 7
  const saturday = at(now, daysToSaturday, 10)
  const daysToMonday = (1 - now.getDay() + 7) % 7 || 7
  const monday = at(now, daysToMonday, 9)
  // Late in the evening, three hours on is tomorrow already: "Later today" would be wrong, and
  // Tomorrow covers it.
  const options = [
    ...(sameDay(later, now) ? [{ label: 'Later today', until: later.getTime() }] : []),
    { label: 'Tomorrow', until: tomorrow.getTime() },
    { label: 'This weekend', until: saturday.getTime() },
    { label: 'Next week', until: monday.getTime() },
  ]
  // These all land within a week, but offer only what the server would take.
  return options.filter((o) => withinAYear(o.until, now.getTime()))
}

const when = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
export const formatWhen = (ms: number) => when.format(new Date(ms))
