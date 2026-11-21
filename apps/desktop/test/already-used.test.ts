import { describe, expect, it } from 'vitest'
import { usedOutcome } from '../src/features/chat/already-used.ts'

describe('a draft whose send ID was used already', () => {
  it('says it’s already sending while that send is on its way', () => {
    for (const delivery of ['queued', 'claimed', 'submitted'] as const)
      expect(usedOutcome({ already: 'send', delivery })).toMatchObject({
        action: 'done',
        say: expect.stringMatching(/already sending/),
      })
  })

  it('says it’s already sent once it went', () => {
    for (const delivery of ['sent', 'delivered', 'read'] as const)
      expect(usedOutcome({ already: 'send', delivery })).toMatchObject({
        action: 'done',
        say: expect.stringMatching(/already sent/),
      })
    expect(usedOutcome({ already: 'scheduled', state: 'scheduled' })).toMatchObject({ action: 'done' })
  })

  it('asks the person to check the chat when it may have gone, offering nothing to send again', () => {
    expect(usedOutcome({ already: 'send', delivery: 'unknown' })).toEqual({
      action: 'check',
      say: 'That message may already have been sent. Check the chat before sending it again.',
    })
    expect(usedOutcome({ already: 'send', delivery: null }).action).toBe('check')
  })

  it('offers it again as a new message when that use surely never went', () => {
    expect(usedOutcome({ already: 'send', delivery: 'failed' }).action).toBe('again')
    expect(usedOutcome({ already: 'scheduled', state: 'cancelled' }).action).toBe('again')
    expect(usedOutcome({ already: 'scheduled', state: 'failed' }).action).toBe('again')
  })
})
