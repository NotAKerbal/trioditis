import { beforeAll, describe, expect, it } from 'vitest'
import { snoozeOptions } from '../src/data/snooze.ts'

// In America/Denver, 2026's clocks go forward at 2 AM on Sunday 8 March and back at 2 AM on
// Sunday 1 November. Snooze times count calendar days there, not 24-hour steps.

beforeAll(() => {
  process.env.TZ = 'America/Denver'
})

/** A local wall-clock time in Denver, as the snooze menu would see it. */
const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi)
const wall = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}
const options = (now: Date) => Object.fromEntries(snoozeOptions(now).map((o) => [o.label, wall(o.until)]))

describe('snooze times around daylight saving, in America/Denver', () => {
  it('runs in Denver', () => {
    // MST is UTC-7 in January, MDT UTC-6 in July.
    expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(420)
    expect(new Date(2026, 6, 15).getTimezoneOffset()).toBe(360)
  })

  it('Tomorrow, late on the Saturday before clocks go forward, is Sunday morning', () => {
    const o = options(local(2026, 3, 7, 23, 30))
    expect(o['Tomorrow']).toBe('2026-3-8 9:00')
    // Sunday is the weekend already, so This weekend is the next Saturday.
    expect(o['This weekend']).toBe('2026-3-14 10:00')
    expect(o['Next week']).toBe('2026-3-9 9:00')
  })

  it('Tomorrow, late on the Saturday before clocks go back, is Sunday morning', () => {
    const o = options(local(2026, 10, 31, 23, 30))
    expect(o['Tomorrow']).toBe('2026-11-1 9:00')
    expect(o['Next week']).toBe('2026-11-2 9:00')
  })

  it('a week ahead across the change lands on the right days', () => {
    // Monday 2 March, before the change: the weekend and next Monday are after it.
    const o = options(local(2026, 3, 2, 8))
    expect(o['This weekend']).toBe('2026-3-7 10:00')
    expect(o['Next week']).toBe('2026-3-9 9:00')
    const back = options(local(2026, 10, 26, 8))
    expect(back['This weekend']).toBe('2026-10-31 10:00')
    expect(back['Next week']).toBe('2026-11-2 9:00')
  })

  it('offers no Later today once three hours on is tomorrow', () => {
    expect(options(local(2026, 3, 7, 23))['Later today']).toBeUndefined()
    expect(options(local(2026, 3, 7, 21, 1))['Later today']).toBeUndefined()
    expect(snoozeOptions(local(2026, 3, 7, 23)).map((o) => o.label)).toEqual(['Tomorrow', 'This weekend', 'Next week'])
  })

  it('offers Later today while it is still today', () => {
    expect(options(local(2026, 3, 7, 8))['Later today']).toBe('2026-3-7 18:00')
    expect(options(local(2026, 3, 7, 17, 30))['Later today']).toBe('2026-3-7 20:30')
    expect(options(local(2026, 3, 7, 20, 59))['Later today']).toBe('2026-3-7 23:59')
  })
})
