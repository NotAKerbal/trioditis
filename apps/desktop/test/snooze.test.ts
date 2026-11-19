import { describe, expect, it } from 'vitest'
import { checkWithinAYear, MAX_AHEAD_MS, snoozeOptions, withinAYear } from '../src/data/snooze.ts'

const now = new Date('2026-11-18T08:00:00').getTime()

describe('times within a year', () => {
  it('takes a time ahead, up to 365 days', () => {
    expect(withinAYear(now + 60_000, now)).toBe(true)
    expect(withinAYear(now + MAX_AHEAD_MS, now)).toBe(true)
    expect(MAX_AHEAD_MS).toBe(365 * 24 * 60 * 60 * 1000)
  })

  it('refuses the past and more than a year ahead, in the server’s words', () => {
    expect(withinAYear(now, now)).toBe(false)
    expect(withinAYear(now + MAX_AHEAD_MS + 1, now)).toBe(false)
    expect(() => checkWithinAYear(now - 1, now)).toThrow('Pick a time in the future.')
    expect(() => checkWithinAYear(now + MAX_AHEAD_MS + 1, now)).toThrow('Pick a time within a year.')
    expect(() => checkWithinAYear(now + 60_000, now)).not.toThrow()
  })

  it('offers only snooze times the server takes', () => {
    const options = snoozeOptions(new Date(now))
    expect(options.map((o) => o.label)).toEqual(['Later today', 'Tomorrow', 'This weekend', 'Next week'])
    for (const o of options) expect(withinAYear(o.until, now)).toBe(true)
  })
})
