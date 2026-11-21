import { describe, expect, it } from 'vitest'
import type { Id } from '@trioditis/backend/dataModel'
import { accountLabels } from '../src/data/account-label.ts'
import { bridgeLive, codeGone, HeardClock, liveHealth } from '../src/data/bridge-liveness.ts'
import { newChatChoice, type StartableAccount } from '../src/data/new-chat.ts'
import { accountView, disconnectFailure, disconnectResult } from '../src/features/settings/account-groups.ts'

const id = (s: string) => s as Id<'networkAccounts'>
const MIN = 60_000

describe('bridge liveness', () => {
  it('calls a bridge down two minutes after this page last got a new heartbeat', () => {
    const clock = new HeardClock()
    const row = {
      network: 'whatsapp',
      bridgeOnline: true,
      bridgeLastSeenAt: 1_000,
      accounts: [{ state: 'CONNECTED' as const }],
      status: 'online' as const,
    }
    expect(liveHealth([row], clock, 10 * MIN)[0]).toMatchObject({ bridgeOnline: true, status: 'online' })
    // The same answer, with no heartbeat since: it's still on screen, but the host has gone.
    expect(liveHealth([row], clock, 12 * MIN + 1)[0]).toMatchObject({ bridgeOnline: false, status: 'offline' })
    // A new heartbeat brings it back.
    expect(liveHealth([{ ...row, bridgeLastSeenAt: 2_000 }], clock, 12 * MIN + 2)[0]).toMatchObject({
      bridgeOnline: true,
    })
  })

  it('isn’t fooled by a page clock minutes off from the server’s', () => {
    const clock = new HeardClock()
    // The page's clock is an hour ahead: the heartbeat time looks old, but it just came.
    const heard = clock.heardAt('whatsapp', 1_000, 60 * MIN)
    expect(bridgeLive(true, 1_000, heard, 60 * MIN + 30_000)).toBe(true)
  })

  it('takes the server’s word without a heartbeat time, and when it says down', () => {
    expect(bridgeLive(true, null, undefined, 99 * MIN)).toBe(true)
    expect(bridgeLive(false, 1_000, 1_000, 1_000)).toBe(false)
  })

  it('hides a code from a host that has gone, or once it expires', () => {
    const qr = { type: 'displayAndWait', display: { type: 'qr', data: 'x' } }
    const timing = { updatedAt: 500_000, stepHeardAt: 10_000, hostOnline: true }
    expect(codeGone(qr, timing, 99 * MIN)).toBeNull()
    expect(codeGone(qr, { ...timing, hostOnline: false }, 0)).toBe('host')
    // Expires a minute after the step came, by the bridge host's clock, whatever this one says.
    const expiring = { ...qr, display: { ...qr.display, expiresAt: 560_000 } }
    expect(codeGone(expiring, timing, 69_999)).toBeNull()
    expect(codeGone(expiring, timing, 70_000)).toBe('expired')
    expect(codeGone({ type: 'displayAndWait', expiresAt: 560_000 }, timing, 70_000)).toBe('expired')
    // Only codes on screen expire here.
    expect(codeGone({ type: 'userInput', expiresAt: 0 }, timing, 70_000)).toBeNull()
  })
})

describe('account labels', () => {
  it('adds what tells accounts apart only where there is more than one on a network', () => {
    const labels = accountLabels([
      { id: 'a', network: 'whatsapp', hint: '+15550100' },
      { id: 'b', network: 'whatsapp', hint: '+15550199' },
      { id: 'c', network: 'signal', hint: 'ID …7c10' },
    ])
    expect(labels.get('a')).toEqual({ name: 'WhatsApp', detail: '+15550100', full: 'WhatsApp (+15550100)' })
    expect(labels.get('b')!.full).toBe('WhatsApp (+15550199)')
    expect(labels.get('c')).toEqual({ name: 'Signal', detail: null, full: 'Signal' })
  })

  it('numbers accounts whose hints are missing or the same', () => {
    const labels = accountLabels([
      { id: 'a', network: 'signal', hint: 'ID …7c10' },
      { id: 'b', network: 'signal', hint: 'ID …7c10' },
      { id: 'c', network: 'signal', hint: '' },
    ])
    expect([...labels.values()].map((l) => l.detail)).toEqual([
      'ID …7c10, account 1',
      'ID …7c10, account 2',
      'Account 3',
    ])
  })
})

describe('new chat account choice', () => {
  const wa1: StartableAccount = { networkAccountId: id('a'), network: 'whatsapp', detail: '+15550100' }
  const wa2: StartableAccount = { networkAccountId: id('b'), network: 'whatsapp', detail: '+15550199' }
  const signal: StartableAccount = { networkAccountId: id('c'), network: 'signal', detail: null }

  it('uses the only account on a network', () => {
    expect(newChatChoice([wa1, signal], 'signal', undefined)).toMatchObject({ network: 'signal', account: signal })
  })

  it('doesn’t pick one of several accounts for the person', () => {
    const choice = newChatChoice([wa1, wa2, signal], undefined, undefined)
    expect(choice).toMatchObject({ networks: ['whatsapp', 'signal'], network: 'whatsapp', accounts: [wa1, wa2] })
    expect(choice.account).toBeUndefined()
    expect(newChatChoice([wa1, wa2], 'whatsapp', id('b')).account).toBe(wa2)
    // A pick from another network doesn't carry over.
    expect(newChatChoice([wa1, wa2, signal], 'whatsapp', id('c')).account).toBeUndefined()
  })
})

describe('accounts in Settings', () => {
  const base = { logoutPending: false, logoutError: null }

  it('groups accounts by what is really so, with only actions that do something', () => {
    expect(accountView({ ...base, state: 'CONNECTED' }, false)).toMatchObject({
      group: 'connected',
      note: null,
      reconnect: false,
      disconnect: true,
    })
    expect(accountView({ ...base, state: 'LOGGED_OUT' }, false)).toMatchObject({
      group: 'loggedOut',
      reconnect: true,
      disconnect: false,
    })
    expect(accountView({ ...base, state: 'BAD_CREDENTIALS' }, false)).toMatchObject({
      group: 'attention',
      reconnect: true,
      disconnect: true,
    })
    expect(accountView({ ...base, state: 'TRANSIENT_DISCONNECT' }, false)).toMatchObject({
      group: 'attention',
      reconnect: false,
    })
    // A connected account on a bridge that stopped answering isn't shown as connected.
    expect(accountView({ ...base, state: 'CONNECTED' }, true)).toMatchObject({ group: 'attention', warn: true })
  })

  it('says a disconnect is on its way, or why it didn’t happen', () => {
    expect(accountView({ ...base, state: 'CONNECTED', logoutPending: true }, false)).toMatchObject({
      group: 'connected',
      note: 'Disconnecting…',
      disconnect: false,
    })
    expect(accountView({ ...base, state: 'CONNECTED', logoutError: 'expired' }, false)).toMatchObject({
      group: 'attention',
      note: expect.stringMatching(/didn’t pick up the disconnect/),
      disconnect: true,
    })
    expect(accountView({ ...base, state: 'CONNECTED', logoutError: 'internal' }, false).note).toMatch(
      /may still be connected/,
    )
  })

  it('names the account in what a disconnect says, and never a raw error', () => {
    expect(disconnectResult('queued', 'WhatsApp (+15550100)')).toBe('Disconnecting WhatsApp (+15550100)…')
    expect(disconnectResult('pending', 'Signal')).toBe('Signal is already disconnecting.')
    expect(disconnectResult('loggedOut', 'Signal')).toBe('Signal is already logged out.')
    expect(disconnectFailure(new TypeError('Failed to fetch'), 'Signal')).toBe(
      'Signal couldn’t be disconnected, so it’s still connected. Check your connection, then try again.',
    )
    expect(
      disconnectFailure(
        Object.assign(new Error('[CONVEX M(logins:logout)] Server Error'), { data: undefined }),
        'Signal',
      ),
    ).toMatch(/couldn’t be disconnected/)
    expect(disconnectFailure({ data: 'That account doesn’t exist.' }, 'Signal')).toBe(
      'Signal isn’t one of your accounts any more.',
    )
  })
})
