import { describe, expect, it } from 'vitest'
import type { LoginState } from '@trioditis/core/bridge-protocol'
import { accountSquares, MAX_SQUARES } from '../src/features/shell/account-squares.ts'

describe('the status bar has a square for each account', () => {
  it('keeps each network’s accounts together, in network order', () => {
    const squares = accountSquares([
      {
        bridgeOnline: true,
        accounts: [
          { networkAccountId: 'wa1', state: 'CONNECTED' },
          { networkAccountId: 'wa2', state: 'CONNECTED' },
        ],
      },
      { bridgeOnline: true, accounts: [] },
      { bridgeOnline: true, accounts: [{ networkAccountId: 'sig1', state: 'CONNECTED' }] },
    ])
    expect(squares.map((s) => s.id)).toEqual(['wa1', 'wa2', 'sig1'])
  })

  it('calls an account up only when it’s connected and its bridge host is there', () => {
    const squares = accountSquares([
      {
        bridgeOnline: true,
        accounts: [
          { networkAccountId: 'up', state: 'CONNECTED' },
          { networkAccountId: 'connecting', state: 'CONNECTING' },
          { networkAccountId: 'bad', state: 'BAD_CREDENTIALS' },
        ],
      },
      { bridgeOnline: false, accounts: [{ networkAccountId: 'hostGone', state: 'CONNECTED' }] },
    ])
    expect(squares).toEqual([
      { id: 'up', online: true },
      { id: 'connecting', online: false },
      { id: 'bad', online: false },
      { id: 'hostGone', online: false },
    ])
  })

  const many = (states: LoginState[]) => [
    { bridgeOnline: true, accounts: states.map((state, i) => ({ networkAccountId: `a${i}`, state })) },
  ]

  it('stops at as many as fit, leaving out connected ones before any that need attention', () => {
    const squares = accountSquares(many(['CONNECTED', 'CONNECTED', 'BAD_CREDENTIALS', 'CONNECTED', 'CONNECTING']), 3)
    expect(squares.map((s) => s.id)).toEqual(['a0', 'a2', 'a4'])
  })

  it('still stops at the limit when more than that need attention', () => {
    const squares = accountSquares(many(['CONNECTED', 'CONNECTING', 'CONNECTING', 'CONNECTING']), 2)
    expect(squares.map((s) => s.id)).toEqual(['a1', 'a2'])
  })

  it('shows at most MAX_SQUARES of the hundred accounts the server can list', () => {
    expect(accountSquares(many(Array<LoginState>(100).fill('CONNECTED')))).toHaveLength(MAX_SQUARES)
  })
})
