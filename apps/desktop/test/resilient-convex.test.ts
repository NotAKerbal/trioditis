import type { Watch } from 'convex/react'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Resubscriber, isTransient } from '../src/lib/resilient-convex.ts'

const timeout = () => new Error('[CONVEX Q(chats:get)] [Request ID: 1] Server Error')

/**
 * One query on a pretend server, the way Convex treats it: its answer stays, error and all,
 * until every subscription to it is dropped; the next subscription has it run again.
 */
class FakeQuery {
  result: { value: unknown } | { error: unknown } | undefined
  subs = new Set<() => void>()
  runs = 0

  watch(): Watch<unknown> {
    return {
      onUpdate: (callback) => {
        if (this.subs.size === 0) {
          this.runs++
          this.result = undefined
        }
        this.subs.add(callback)
        return () => void this.subs.delete(callback)
      },
      localQueryResult: () => {
        if (!this.result) return undefined
        if ('error' in this.result) throw this.result.error
        return this.result.value
      },
      journal: () => undefined,
    }
  }

  answer(result: { value: unknown } | { error: unknown }) {
    this.result = result
    // A copy: a callback may unsubscribe.
    for (const callback of Array.from(this.subs)) callback()
  }
}

class Trouble {
  failures: (string | undefined)[] = []
  answers: string[] = []
  forgotten: string[] = []
  failed(key?: string) {
    this.failures.push(key)
  }
  answered(key: string) {
    this.answers.push(key)
  }
  forget(key: string) {
    this.forgotten.push(key)
  }
}

function setup() {
  const server = new FakeQuery()
  const trouble = new Trouble()
  const waits: number[] = []
  const resubscriber = new Resubscriber(
    trouble as never,
    (run, ms) => {
      waits.push(ms)
      return setTimeout(run, ms)
    },
    () => 0.5,
  )
  const watch = resubscriber.wrap('chats:get|{}', server.watch())
  return { server, trouble, waits, watch }
}

describe('a query the server fails to answer', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps its last answer, without a change, and is asked again until it answers', () => {
    const { server, trouble, waits, watch } = setup()
    const changes = vi.fn()
    watch.onUpdate(changes)
    server.answer({ value: 'row' })
    expect(changes).toHaveBeenCalledTimes(1)

    server.answer({ error: timeout() })
    expect(changes).toHaveBeenCalledTimes(1)
    expect(watch.localQueryResult()).toBe('row')
    expect(trouble.failures).toEqual(['chats:get|{}'])

    vi.advanceTimersByTime(waits[0]!)
    expect(server.runs).toBe(2)
    expect(watch.localQueryResult()).toBe('row')
    server.answer({ value: 'newer row' })
    expect(changes).toHaveBeenCalledTimes(2)
    expect(watch.localQueryResult()).toBe('newer row')
    expect(trouble.answers).toEqual(['chats:get|{}'])
  })

  it('is still loading, not failed, when it had never answered', () => {
    const { server, watch } = setup()
    const changes = vi.fn()
    watch.onUpdate(changes)
    server.answer({ error: timeout() })
    expect(() => watch.localQueryResult()).not.toThrow()
    expect(watch.localQueryResult()).toBeUndefined()
    // A one-off `convex.query()` resolves on its first change: it mustn't resolve with nothing.
    expect(changes).not.toHaveBeenCalled()
  })

  it('waits longer each time it fails again, and drops every subscription so it runs afresh', () => {
    const { server, waits, watch } = setup()
    watch.onUpdate(() => {})
    watch.onUpdate(() => {})
    for (let i = 0; i < 3; i++) {
      server.answer({ error: timeout() })
      vi.advanceTimersByTime(waits.at(-1)!)
    }
    expect(waits).toEqual([2_000, 4_000, 8_000])
    expect(server.runs).toBe(4)
    expect(server.subs.size).toBe(2)
  })

  it('counts one failure once, however many watch it', () => {
    const { server, trouble, watch } = setup()
    watch.onUpdate(() => {})
    watch.onUpdate(() => {})
    server.answer({ error: timeout() })
    watch.localQueryResult()
    expect(trouble.failures).toHaveLength(1)
  })

  it('stops asking once nothing watches it', () => {
    const { server, trouble, waits, watch } = setup()
    const stop = watch.onUpdate(() => {})
    server.answer({ error: timeout() })
    stop()
    vi.advanceTimersByTime(waits[0]!)
    expect(server.runs).toBe(1)
    expect(trouble.forgotten).toEqual(['chats:get|{}'])
  })
})

describe('the server refusing', () => {
  it('passes a ConvexError on: that chat is gone, and asking again won’t change it', () => {
    const { server, trouble, watch } = setup()
    const changes = vi.fn()
    watch.onUpdate(changes)
    server.answer({ value: 'row' })
    server.answer({ error: new ConvexError('That chat doesn’t exist.') })
    expect(changes).toHaveBeenCalledTimes(2)
    expect(() => watch.localQueryResult()).toThrow(ConvexError)
    expect(trouble.failures).toEqual([])
  })

  it('tells a refusal from a failure', () => {
    expect(isTransient(new ConvexError('Only an admin can do that.'))).toBe(false)
    expect(isTransient(timeout())).toBe(true)
  })
})
