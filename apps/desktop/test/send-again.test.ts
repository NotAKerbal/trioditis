import { describe, expect, it } from 'vitest'
import { againView, fromDelivery, sendAgain, type RetryState } from '../src/features/chat/send-again.ts'

const chain = (over: Partial<RetryState> = {}): RetryState => ({
  root: 'root-0000000000000001',
  latest: null,
  delivery: null,
  allowed: true,
  nextId: 'rt_next',
  ...over,
})

describe('a row’s Send again', () => {
  it('shows what the server says of its chain, and offers another attempt only when it allows one', () => {
    expect(againView(chain(), new Set())).toEqual({ state: undefined, canTry: true })
    expect(againView(chain({ latest: 'rt_1', delivery: 'unknown', allowed: false, nextId: null }), new Set())).toEqual({
      state: 'maybe',
      canTry: false,
    })
    expect(againView(chain({ latest: 'rt_1', delivery: 'failed' }), new Set())).toEqual({
      state: 'failed',
      canTry: true,
    })
    // The original turned out to have gone: the chain says Sent, and offers nothing.
    expect(
      againView(chain({ latest: chain().root, delivery: 'sent', allowed: false, nextId: null }), new Set()),
    ).toEqual({ state: 'original', canTry: false })
    // Nothing known of it (not a send): nothing offered.
    expect(againView(undefined, new Set())).toEqual({ state: undefined, canTry: false })
  })

  it('is the same on every row of a chain: the state is the chain’s, not the row’s', () => {
    const state = chain({ latest: 'rt_1', delivery: 'queued', allowed: false, nextId: null })
    expect(againView(state, new Set())).toEqual(againView({ ...state }, new Set()))
    expect(againView(state, new Set()).state).toBe('going')
  })

  it('reads each delivery state', () => {
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
      expect(fromDelivery(delivery)).toBe(state)
  })
})

describe('sending again', () => {
  it('asks once per chain while an attempt is on its way, and only when allowed', async () => {
    const asked: string[] = []
    let finish!: (r: { created: boolean }) => void
    const send = (id: string) => {
      asked.push(id)
      return new Promise<{ created: boolean }>((resolve) => (finish = resolve))
    }
    const first = sendAgain(chain(), send)
    expect(await sendAgain(chain(), send)).toBe(false)
    expect(againView(chain(), new Set([chain().root])).state).toBe('sending')
    finish({ created: true })
    expect(await first).toBe(true)
    expect(asked).toEqual(['rt_next'])
    // The server says no more: nothing is asked.
    expect(await sendAgain(chain({ allowed: false, nextId: null }), send)).toBe(false)
    expect(asked).toHaveLength(1)
  })

  it('takes the server’s word that nothing was made', async () => {
    expect(await sendAgain(chain(), async () => ({ created: false }))).toBe(false)
  })

  it('passes a real error on, for the chat to say, and can be tried again after', async () => {
    await expect(
      sendAgain(chain(), async () => Promise.reject(new Error('That message can’t be replied to.'))),
    ).rejects.toThrow(/replied to/)
    // Not left as on its way.
    expect(againView(chain(), new Set()).canTry).toBe(true)
    expect(await sendAgain(chain(), async () => ({ created: true }))).toBe(true)
  })
})
