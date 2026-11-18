// The snooze choices, as times from now. "Later today" is 6 PM, or three hours from now if
// that's sooner than an hour away; the rest land at the start of a morning.

function at(date: Date, hour: number) {
  const d = new Date(date)
  d.setHours(hour, 0, 0, 0)
  return d
}

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
  const tonight = at(now, 18)
  const later =
    tonight.getTime() - now.getTime() > 60 * 60 * 1000 ? tonight : new Date(now.getTime() + 3 * 60 * 60 * 1000)
  const tomorrow = at(new Date(now.getTime() + 24 * 60 * 60 * 1000), 9)
  const daysToSaturday = (6 - now.getDay() + 7) % 7 || 7
  const saturday = at(new Date(now.getTime() + daysToSaturday * 24 * 60 * 60 * 1000), 10)
  const daysToMonday = (1 - now.getDay() + 7) % 7 || 7
  const monday = at(new Date(now.getTime() + daysToMonday * 24 * 60 * 60 * 1000), 9)
  // These all land within a week, but offer only what the server would take.
  return [
    { label: 'Later today', until: later.getTime() },
    { label: 'Tomorrow', until: tomorrow.getTime() },
    { label: 'This weekend', until: saturday.getTime() },
    { label: 'Next week', until: monday.getTime() },
  ].filter((o) => withinAYear(o.until, now.getTime()))
}

const when = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
export const formatWhen = (ms: number) => when.format(new Date(ms))
