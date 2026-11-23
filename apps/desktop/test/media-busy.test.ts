import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const access = vi.fn()
vi.mock('~/lib/convex.ts', () => ({ convex: { mutation: (...args: unknown[]) => access(...args) } }))
vi.mock('~/lib/session.tsx', () => ({ useSession: () => ({}) }))

const { ServerBusy, fetchCiphertext } = await import('../src/data/media.ts')

const answer = (status: number) => new Response(status === 200 ? new Uint8Array([1, 2, 3]) : null, { status })
let user = 0

describe('fetching a file from a busy server', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    access.mockReset()
    user++
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('waits on a busy gateway with the same token, rather than asking for another', async () => {
    access.mockResolvedValue({ token: 't1', expiresAt: Date.now() + 3_600_000 })
    const fetch = vi.fn().mockResolvedValueOnce(answer(503)).mockResolvedValueOnce(answer(200))
    vi.stubGlobal('fetch', fetch)
    const bytes = fetchCiphertext(`u${user}`, 'signal', 'm1')
    await vi.runAllTimersAsync()
    expect(await bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(access).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls.map((c) => (c[1] as RequestInit).headers)).toEqual([
      { authorization: 'Bearer t1' },
      { authorization: 'Bearer t1' },
    ])
  })

  it('says the server is busy, not that the file is broken, once the gateway stays busy', async () => {
    access.mockResolvedValue({ token: 't1', expiresAt: Date.now() + 3_600_000 })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => answer(503)),
    )
    const bytes = fetchCiphertext(`u${user}`, 'signal', 'm1').catch((e: unknown) => e)
    await vi.runAllTimersAsync()
    expect(await bytes).toBeInstanceOf(ServerBusy)
  })

  it('replaces a refused token once, however many files were refused it', async () => {
    access
      .mockResolvedValueOnce({ token: 'old', expiresAt: Date.now() + 3_600_000 })
      .mockResolvedValue({ token: 'new', expiresAt: Date.now() + 3_600_000 })
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementation(async (_url: string, init: RequestInit) =>
          answer((init.headers as Record<string, string>).authorization === 'Bearer old' ? 401 : 200),
        ),
    )
    const files = Promise.all(['a', 'b', 'c'].map((m) => fetchCiphertext(`u${user}`, 'signal', m)))
    await vi.runAllTimersAsync()
    await files
    expect(access).toHaveBeenCalledTimes(2)
  })

  it('shares a timed-out token request among the files waiting on it', async () => {
    access.mockRejectedValue(new Error('[CONVEX M(media:access)] Server Error'))
    vi.stubGlobal('fetch', vi.fn())
    const files = ['a', 'b', 'c'].map((m) => fetchCiphertext(`u${user}`, 'signal', m).catch((e: unknown) => e))
    for (const file of files) expect(await file).toBeInstanceOf(ServerBusy)
    expect(access).toHaveBeenCalledTimes(1)
  })

  it('passes a refusal on as it is', async () => {
    access.mockRejectedValue(new ConvexError('Only members can see files.'))
    vi.stubGlobal('fetch', vi.fn())
    expect(await fetchCiphertext(`u${user}`, 'signal', 'a').catch((e: unknown) => e)).toBeInstanceOf(ConvexError)
  })
})
