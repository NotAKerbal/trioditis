import { ready } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  chainOf,
  chainRoots,
  fromDelivery,
  latestAttempt,
  nextAttempt,
  replacementId,
  sendAgain,
  stateOf,
  type SendAgainState,
  type SendAnswer,
} from '../src/features/chat/send-again.ts'

beforeAll(ready)

const VALID = /^[A-Za-z0-9_-]{16,64}$/
const original = '0123456789abcdef0123456789abcdef'
const known = (entries: [string, string | null][] = []) =>
  new Map<string, SendAgainState>(entries.map(([id, d]) => [id, fromDelivery(d)]))
const idle = new Set<string>()

describe('an attempt’s ID', () => {
  it('is the same every time for the same message, and one the server takes', () => {
    expect(replacementId(original)).toBe(replacementId(original))
    expect(replacementId(original)).not.toBe(original)
    expect(replacementId(original)).toMatch(VALID)
  })

  it('chains: each next one from the one before, never another send’s', () => {
    const chain = chainOf(original)
    expect(chain[0]).toBe(replacementId(original))
    expect(chain[1]).toBe(replacementId(chain[0]!))
    expect(new Set(chain).size).toBe(chain.length)
    for (const id of chain) expect(id).toMatch(VALID)
  })
})

describe('every row of a chain', () => {
  it('belongs to the original, so each shows the same and acts the same', () => {
    const [r1, r2] = chainOf(original)
    const roots = chainRoots([original, r1!, r2!, 'someone-else-0000'])
    expect(roots.get(r1!)).toBe(original)
    expect(roots.get(r2!)).toBe(original)
    expect(roots.get(original)).toBe(original)
    expect(roots.get('someone-else-0000')).toBe('someone-else-0000')
  })

  it('offers another attempt only when none was made or the latest failed', () => {
    const [r1, r2] = chainOf(original)
    expect(nextAttempt(original, known(), idle)).toBe(r1)
    // r1 may have gone: no further attempt from any row, and every row says so.
    const unknown = known([[r1!, 'unknown']])
    expect(nextAttempt(original, unknown, idle)).toBeNull()
    expect(latestAttempt(original, unknown, idle)?.state).toBe('maybe')
    // r1 failed: the next is r2, worked out from r1.
    expect(nextAttempt(original, known([[r1!, 'failed']]), idle)).toBe(r2)
    // r1 failed and r2 was sent: done.
    expect(
      latestAttempt(
        original,
        known([
          [r1!, 'failed'],
          [r2!, 'read'],
        ]),
        idle,
      ),
    ).toEqual({ id: r2, state: 'sent' })
    expect(
      nextAttempt(
        original,
        known([
          [r1!, 'failed'],
          [r2!, 'read'],
        ]),
        idle,
      ),
    ).toBeNull()
  })

  it('reads a link whose copy is gone from what the server says, not a guess', () => {
    const [r1, r2] = chainOf(original)
    // r1's row was deleted after it failed: the server still says failed, so r2 is next.
    const fromServer = new Map<string, SendAgainState>([[r1!, stateOf({ already: 'send', delivery: 'failed' })]])
    expect(latestAttempt(original, fromServer, idle)?.state).toBe('failed')
    expect(nextAttempt(original, fromServer, idle)).toBe(r2)
  })

  it('shows the latest attempt’s own delivery state', () => {
    const [r1] = chainOf(original)
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
      expect(latestAttempt(original, known([[r1!, delivery]]), idle)?.state).toBe(state)
    expect(stateOf('queued')).toBe('going')
  })
})

describe('sending again', () => {
  it('sends once per attempt, however many clicks come while it is on its way', async () => {
    const o = 'aaaaaaaaaaaaaaaa1'
    const sent: string[] = []
    let finish!: (answer: SendAnswer) => void
    const send = (id: string) => {
      sent.push(id)
      return new Promise<SendAnswer>((resolve) => (finish = resolve))
    }
    const first = sendAgain(o, known(), send)
    void sendAgain(o, known(), send)
    void sendAgain(o, known(), send)
    expect(sent).toEqual([replacementId(o)])
    finish('queued')
    expect(await first).toBe('going')
    // Once its copy is listed as on its way, no more.
    await sendAgain(o, known([[replacementId(o), 'queued']]), send)
    expect(sent).toHaveLength(1)
  })

  it('makes the same attempt from another tab or after a reload, so the server dedupes it', async () => {
    const o = 'bbbbbbbbbbbbbbbb1'
    const ids: string[] = []
    const send = async (id: string) => (ids.push(id), 'queued' as const)
    await sendAgain(o, known([[replacementId(o), 'failed']]), send)
    await sendAgain(o, known([[replacementId(o), 'failed']]), send)
    expect(ids).toEqual([chainOf(o)[1], chainOf(o)[1]])
  })
})
