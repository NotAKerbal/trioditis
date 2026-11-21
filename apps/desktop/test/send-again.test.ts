import { ready } from '@trioditis/crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import { againState, replacementId, sendAgain } from '../src/features/chat/send-again.ts'

beforeAll(ready)

const VALID = /^[A-Za-z0-9_-]{16,64}$/
const original = '0123456789abcdef0123456789abcdef'

describe('a replacement send’s ID', () => {
  it('is the same every time for the same message, and one the server takes', () => {
    expect(replacementId(original)).toBe(replacementId(original))
    expect(replacementId(original)).not.toBe(original)
    expect(replacementId(original)).toMatch(VALID)
  })

  it('is never another send’s ID: not a suffix of it, nor cut short', () => {
    // Before, `x-a1`'s replacement was `x-a2`, an ID another send could have had, and long IDs
    // were cut so two could share one.
    expect(replacementId(`${original}-a1`)).not.toBe(`${original}-a2`)
    const long1 = `${'x'.repeat(63)}1`
    const long2 = `${'x'.repeat(63)}2`
    expect(replacementId(long1)).not.toBe(replacementId(long2))
    expect(replacementId(long1)).toMatch(VALID)
    // A replacement's own replacement is as short, and different again.
    const twice = replacementId(replacementId(original))
    expect(twice).toMatch(VALID)
    expect(twice).not.toBe(replacementId(original))
  })
})

describe('sending again', () => {
  it('sends once, however many clicks come while it is on its way or after', async () => {
    const sent: string[] = []
    let finish!: (outcome: 'queued') => void
    const send = (id: string) => {
      sent.push(id)
      return new Promise<'queued'>((resolve) => (finish = resolve))
    }
    const first = sendAgain('aaaaaaaaaaaaaaaa1', send)
    void sendAgain('aaaaaaaaaaaaaaaa1', send)
    void sendAgain('aaaaaaaaaaaaaaaa1', send)
    expect(sent).toEqual([replacementId('aaaaaaaaaaaaaaaa1')])
    finish('queued')
    expect(await first).toBe('sent')
    await sendAgain('aaaaaaaaaaaaaaaa1', send)
    expect(sent).toHaveLength(1)
  })

  it('can be tried again after a failure, with the same ID', async () => {
    const sent: string[] = []
    await sendAgain('bbbbbbbbbbbbbbbb1', async (id) => {
      sent.push(id)
      throw new Error('offline')
    })
    await sendAgain('bbbbbbbbbbbbbbbb1', async (id) => {
      sent.push(id)
      return 'queued' as const
    })
    expect(sent).toEqual([replacementId('bbbbbbbbbbbbbbbb1'), replacementId('bbbbbbbbbbbbbbbb1')])
  })

  it('goes by what the server says, not by what the list shows, so leaving the chat changes nothing', async () => {
    // The server had the ID already: nothing went this time.
    expect(await sendAgain('cccccccccccccccc1', async () => ({ already: 'send' }))).toBe('used')
    expect(await sendAgain('cccccccccccccccc2', async () => ({ already: 'scheduled' }))).toBe('used')
    expect(await sendAgain('cccccccccccccccc3', async () => 'queued' as const)).toBe('sent')
  })

  it('counts a replacement in the list as sent, from whichever tab sent it', () => {
    const none = new Map()
    expect(againState(original, none, new Set([original]))).toBeUndefined()
    expect(againState(original, none, new Set([original, replacementId(original)]))).toBe('sent')
    expect(againState(original, new Map([[original, 'sending']]), new Set())).toBe('sending')
    expect(againState(undefined, none, new Set())).toBeUndefined()
  })
})
