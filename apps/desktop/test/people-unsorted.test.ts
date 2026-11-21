import type { NetworkContact } from '@trioditis/core'
import { describe, expect, it } from 'vitest'
import { rowMatches, unsortedRow } from '../src/features/people/unsorted.ts'

const contact = (over: Partial<NetworkContact> & { profile: NetworkContact['profile'] }): NetworkContact => ({
  network: 'whatsapp',
  ghostId: 'g1',
  ...over,
})

describe('searching Not in People', () => {
  const row = unsortedRow([
    contact({ profile: { name: 'Ann Lee' }, identifiers: ['tel:+1 (555) 123-4567'] }),
    contact({
      network: 'signal',
      ghostId: 'g2',
      profile: { handle: 'annie' },
      identifiers: ['mailto:Ann@Example.com'],
    }),
  ])

  it('shows the group by its name and what its contacts are known by', () => {
    expect(row.name).toBe('Ann Lee')
    expect(row.details).toContain('ann@example.com')
  })

  it('matches by name, email or username, without case', () => {
    expect(rowMatches(row, '')).toBe(true)
    expect(rowMatches(row, 'lee')).toBe(true)
    expect(rowMatches(row, 'EXAMPLE')).toBe(true)
    expect(rowMatches(row, 'annie')).toBe(true)
    expect(rowMatches(row, 'bob')).toBe(false)
  })

  it('matches a number by its digits however it is typed, from three digits on', () => {
    expect(rowMatches(row, '555-123')).toBe(true)
    expect(rowMatches(row, '5551234567')).toBe(true)
    expect(rowMatches(row, '5-5')).toBe(false)
    expect(rowMatches(row, '999')).toBe(false)
  })

  it('leaves out a network’s internal IDs', () => {
    const hidden = unsortedRow([contact({ profile: { name: 'Bo' }, identifiers: ['whatsapp-internal:123456789'] })])
    expect(hidden.details).toEqual([])
    expect(rowMatches(hidden, '123456')).toBe(false)
  })
})
