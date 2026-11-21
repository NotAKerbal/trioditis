// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

// Which hook was given the chat, and which was told to skip, on each render.
const asked: { hook: 'cached' | 'fresh'; args: unknown }[] = []
const page = (hook: 'cached' | 'fresh') => (_query: unknown, args: unknown) => {
  asked.push({ hook, args })
  return { results: [], status: 'LoadingFirstPage', loadMore: () => {} }
}
vi.mock('convex-helpers/react/cache/hooks', () => ({ usePaginatedQuery: page('cached') }))
vi.mock('convex/react', () => ({ usePaginatedQuery: page('fresh'), useMutation: () => () => {} }))
vi.mock('~/lib/session.tsx', () => ({ useSession: () => ({ userId: 'u1' }) }))
const { useMessages } = await import('../src/data/messages.ts')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

async function render(attempt: number) {
  asked.length = 0
  const root = createRoot(document.createElement('div'))
  const Pane = () => (useMessages('chat1' as never, attempt), null)
  await act(async () => root.render(createElement(Pane)))
  await act(async () => root.unmount())
  return new Set(asked.map((a) => `${a.hook}:${a.args === 'skip' ? 'skip' : 'chat'}`))
}

describe('a chat’s messages', () => {
  it('come from the cache at first', async () => {
    expect(await render(0)).toEqual(new Set(['cached:chat', 'fresh:skip']))
  })

  // The cache would answer with the error it kept, and keep one more page to ask again on
  // every reconnect.
  it('are asked for outside the cache after a page couldn’t load', async () => {
    expect(await render(1)).toEqual(new Set(['cached:skip', 'fresh:chat']))
    expect(await render(4)).toEqual(new Set(['cached:skip', 'fresh:chat']))
  })
})
