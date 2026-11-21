// @vitest-environment happy-dom
import { ConvexError } from 'convex/values'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RetryBoundary } from '../src/features/shell/retry-boundary.tsx'

vi.mock('~/lib/session.tsx', () => ({ useSession: () => ({ userId: 'u1' }) }))
const { firstPageSize } = await import('../src/data/messages.ts')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A part that fails on its first `failing` tries the way a timed-out page does, then loads.
function render(error: () => unknown, failing: number) {
  const host = document.createElement('div')
  const root = createRoot(host)
  const tries: number[] = []
  const Part = ({ attempt }: { attempt: number }) => {
    tries.push(attempt)
    if (attempt < failing) throw error()
    return createElement('p', null, `loaded on try ${attempt}`)
  }
  const tree = createElement(RetryBoundary, {
    fallback: (say: (fallback: string) => string, retry: () => void) =>
      createElement('button', { onClick: retry }, say('Couldn’t load this chat.')),
    children: (attempt: number) => createElement(Part, { attempt }),
  })
  return { host, root, tries, mount: () => act(async () => root.render(tree)) }
}

describe('a part that couldn’t load', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // React reports each error it catches; these are expected.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('shows why in its place, then mounts again by itself with the next try number', async () => {
    const view = render(() => new Error('[CONVEX Q(messages:list)] Server Error'), 2)
    await view.mount()
    // The server's own wording isn't for the person.
    expect(view.host.textContent).toBe('Couldn’t load this chat.')
    await act(async () => vi.advanceTimersByTime(2_000))
    expect(view.host.textContent).toBe('Couldn’t load this chat.')
    // The second error in a row waits twice as long.
    await act(async () => vi.advanceTimersByTime(3_999))
    expect(view.host.textContent).toBe('Couldn’t load this chat.')
    await act(async () => vi.advanceTimersByTime(1))
    expect(view.host.textContent).toBe('loaded on try 2')
    expect(new Set(view.tries)).toEqual(new Set([0, 1, 2]))
    await act(async () => view.root.unmount())
  })

  it('waits for Try again when the server refused, and says what it said', async () => {
    const view = render(() => new ConvexError('That chat doesn’t exist.'), 1)
    await view.mount()
    expect(view.host.textContent).toBe('That chat doesn’t exist.')
    await act(async () => vi.advanceTimersByTime(60_000))
    expect(view.host.textContent).toBe('That chat doesn’t exist.')
    await act(async () => view.host.querySelector('button')!.click())
    expect(view.host.textContent).toBe('loaded on try 1')
    await act(async () => view.root.unmount())
  })
})

describe('the first page of messages on each try', () => {
  // The cache keeps a failed page under its arguments; a retry must not ask under the same ones.
  it('is asked for with different arguments every time', () => {
    const sizes = [0, 1, 2, 3, 4].map(firstPageSize)
    expect(new Set(sizes).size).toBe(sizes.length)
    expect(firstPageSize(0)).toBe(50)
  })
})
