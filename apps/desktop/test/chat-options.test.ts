import { describe, expect, it } from 'vitest'
import type { Id } from '@trioditis/backend/dataModel'
import { chatOptions } from '../src/data/new-chat.ts'

const a = { networkAccountId: 'acct_a' as Id<'networkAccounts'>, network: 'gmessages' as const }
const b = { networkAccountId: 'acct_b' as Id<'networkAccounts'>, network: 'gmessages' as const }

describe('chat options on a card', () => {
  const card = {
    name: 'Ann',
    phones: [{ value: '+15551234567' }],
    links: [{ network: 'gmessages' as const, ghostId: 'g_ann' }],
  }
  const byContact = new Map([
    [
      'gmessages/g_ann',
      { network: 'gmessages' as const, ghostId: 'g_ann', profile: { name: 'Ann' }, networkAccountIds: ['acct_a'] },
    ],
  ])

  it('keeps the number on an account the linked contact didn’t come from', () => {
    const options = chatOptions(card, [b], byContact as never)
    expect(options.map((o) => [o.networkAccountId, 'ghostId' in o.target ? 'contact' : 'number'])).toEqual([
      ['acct_b', 'contact'],
      ['acct_b', 'number'],
    ])
  })

  it('numbers accounts the same way on every card, and skips the number where the contact is sure to work', () => {
    const options = chatOptions(card, [a, b], byContact as never)
    expect(options.map((o) => o.label)).toEqual(['Ann (account 1)', 'Ann (account 2)', '+15551234567 (account 2)'])
    expect(options.map((o) => o.networkAccountId)).toEqual(['acct_a', 'acct_b', 'acct_b'])
  })
})
