import { ready } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  againState,
  latestAttempt,
  replacementId,
  sendAgain,
  stateOf,
  type SendAnswer,
} from '../src/features/chat/send-again.ts'

beforeAll(ready)

const VALID = /^[A-Za-z0-9_-]{16,64}$/
const original = '0123456789abcdef0123456789abcdef'
const none = new Map<string, string | null | undefined>()

describe('an attempt’s ID', () => {
  it('is the same every time for the same message, and one the server takes', () => {
    expect(replacementId(original)).toBe(replacementId(original))
    expect(replacementId(original)).not.toBe(original)
    expect(replacementId(original)).toMatch(VALID)
  })

  it('is never another send’s ID, and the next link is as short and different again', () => {
    const long1 = `${'x'.repeat(63)}1`
    const long2 = `${'x'.repeat(63)}2`
    expect(replacementId(long1)).not.toBe(replacementId(long2))
    const twice = replacementId(replacementId(original))
    expect(twice).toMatch(VALID)
    expect(twice).not.toBe(replacementId(original))
  })
})

describe('sending again', () => {
  it('sends once per attempt, however many clicks come while it is on its way or after', async () => {
    const sent: string[] = []
    let finish!: (answer: SendAnswer) => void
    const send = (id: string) => {
      sent.push(id)
      return new Promise<SendAnswer>((resolve) => (finish = resolve))
    }
    const first = sendAgain('aaaaaaaaaaaaaaaa1', none, send)
    void sendAgain('aaaaaaaaaaaaaaaa1', none, send)
    void sendAgain('aaaaaaaaaaaaaaaa1', none, send)
    expect(sent).toEqual([replacementId('aaaaaaaaaaaaaaaa1')])
    finish('queued')
    // Taken by the server: on its way, not sent yet.
    expect(await first).toBe('going')
    await sendAgain('aaaaaaaaaaaaaaaa1', none, send)
    expect(sent).toHaveLength(1)
  })

  it('can be tried again with the same ID when the call didn’t reach the server', async () => {
    const sent: string[] = []
    await sendAgain('bbbbbbbbbbbbbbbb1', none, async (id) => {
      sent.push(id)
      throw new Error('offline')
    })
    await sendAgain('bbbbbbbbbbbbbbbb1', none, async (id) => (sent.push(id), 'queued' as const))
    expect(sent).toEqual([replacementId('bbbbbbbbbbbbbbbb1'), replacementId('bbbbbbbbbbbbbbbb1')])
  })

  it('goes on to the next link only after the last one failed, under an ID worked out from it', async () => {
    const o = 'cccccccccccccccc1'
    const r1 = replacementId(o)
    const r2 = replacementId(r1)
    const ids: string[] = []
    const failed = async (id: string) => (ids.push(id), { already: 'send' as const, delivery: 'failed' })
    expect(await sendAgain(o, none, failed)).toBe('failed')
    expect(await sendAgain(o, none, async (id) => (ids.push(id), 'queued' as const))).toBe('going')
    expect(ids).toEqual([r1, r2])
    // On its way: no third.
    expect(await sendAgain(o, none, failed)).toBe('going')
    expect(ids).toHaveLength(2)
  })

  it('reads the chain from the list, so another tab or a reload makes the same next attempt', async () => {
    const o = 'dddddddddddddddd1'
    const r1 = replacementId(o)
    const r2 = replacementId(r1)
    // Another tab sent r1, and it failed: the list shows it.
    const listed = new Map([[r1, 'failed']])
    const ids: string[] = []
    await sendAgain(o, listed, async (id) => (ids.push(id), 'queued' as const))
    expect(ids).toEqual([r2])
  })
})

describe('the badge on the original', () => {
  it('follows the latest attempt’s delivery state in the list', () => {
    const o = 'eeeeeeeeeeeeeeee1'
    const r1 = replacementId(o)
    const r2 = replacementId(r1)
    const local = new Map()
    for (const [delivery, state] of [
      ['queued', 'going'],
      ['claimed', 'going'],
      ['submitted', 'going'],
      ['sent', 'sent'],
      ['delivered', 'sent'],
      ['read', 'sent'],
      ['unknown', 'maybe'],
      ['failed', 'failed'],
    ] as const)
      expect(againState(o, local, new Map([[r1, delivery]]))).toBe(state)
    // Past a failed link to the next.
    expect(
      latestAttempt(
        o,
        local,
        new Map([
          [r1, 'failed'],
          [r2, 'delivered'],
        ]),
      ),
    ).toEqual({ id: r2, state: 'sent' })
    expect(againState(o, local, none)).toBeUndefined()
  })

  it('takes a new send as on its way, and a used ID by how it stands', () => {
    expect(stateOf('queued')).toBe('going')
    expect(stateOf({ already: 'send', delivery: 'read' })).toBe('sent')
    expect(stateOf({ already: 'send', delivery: 'unknown' })).toBe('maybe')
    expect(stateOf({ already: 'send', delivery: 'failed' })).toBe('failed')
    expect(stateOf({ already: 'scheduled', state: 'cancelled' })).toBe('failed')
  })
})
