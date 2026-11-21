import { describe, expect, it } from 'vitest'
import { againState, replacementId, sendAgain } from '../src/features/chat/send-again.ts'

const VALID = /^[A-Za-z0-9_-]{16,64}$/
const original = '0123456789abcdef0123456789abcdef'

describe('a replacement send’s ID', () => {
  it('is the same every time for the same message, and one the server takes', () => {
    expect(replacementId(original)).toBe(replacementId(original))
    expect(replacementId(original)).not.toBe(original)
    expect(replacementId(original)).toMatch(VALID)
  })

  it('counts up for a replacement’s own replacement, staying short', () => {
    expect(replacementId(original)).toBe(`${original}-a1`)
    expect(replacementId(`${original}-a1`)).toBe(`${original}-a2`)
    let id = original
    for (let i = 0; i < 500; i++) id = replacementId(id)
    expect(id).toBe(`${original}-a500`)
    expect(id).toMatch(VALID)
  })

  it('stays within 64 characters for the longest ID', () => {
    const long = 'x'.repeat(64)
    expect(replacementId(long)).toMatch(VALID)
    expect(replacementId(long)).toHaveLength(64)
  })
})

describe('sending again', () => {
  it('sends once, however many clicks come while it is on its way or after', async () => {
    const sent: string[] = []
    let finish!: () => void
    const send = (id: string) => {
      sent.push(id)
      return new Promise<void>((resolve) => (finish = resolve))
    }
    const first = sendAgain('aaaaaaaaaaaaaaaa1', send)
    void sendAgain('aaaaaaaaaaaaaaaa1', send)
    void sendAgain('aaaaaaaaaaaaaaaa1', send)
    expect(sent).toEqual(['aaaaaaaaaaaaaaaa1-a1'])
    finish()
    await first
    await sendAgain('aaaaaaaaaaaaaaaa1', send)
    expect(sent).toEqual(['aaaaaaaaaaaaaaaa1-a1'])
  })

  it('can be tried again after a failure, with the same ID', async () => {
    const sent: string[] = []
    await sendAgain('bbbbbbbbbbbbbbbb1', async (id) => {
      sent.push(id)
      throw new Error('offline')
    })
    await sendAgain('bbbbbbbbbbbbbbbb1', async (id) => {
      sent.push(id)
    })
    expect(sent).toEqual(['bbbbbbbbbbbbbbbb1-a1', 'bbbbbbbbbbbbbbbb1-a1'])
  })

  it('counts a replacement in the list as sent, from whichever tab sent it', () => {
    const none = new Map()
    expect(againState(original, none, new Set([original]))).toBeUndefined()
    expect(againState(original, none, new Set([original, `${original}-a1`]))).toBe('sent')
    expect(againState(original, new Map([[original, 'sending']]), new Set())).toBe('sending')
    expect(againState(undefined, none, new Set())).toBeUndefined()
  })
})
