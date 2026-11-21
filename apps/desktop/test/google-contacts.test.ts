import { afterEach, describe, expect, it, vi } from 'vitest'

// desktop.ts reads the bridge off `window` when it loads; in a browser there is none.
vi.stubGlobal('window', {})
const { fetchGooglePhotos, GoogleRefused, readGoogleContacts } = await import('../src/data/google-contacts.ts')
const { canSignInToGoogle, GoogleSignInError, googleSignInProblem } = await import('../src/lib/google-sign-in.ts')

afterEach(() => vi.unstubAllGlobals())

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('reading Google Contacts', () => {
  it('reads every page with the token, as cards with their photo addresses', async () => {
    const calls: { url: string; auth: string | null }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('Authorization') })
      return new URL(url).searchParams.get('pageToken')
        ? json({ connections: [{ names: [{ displayName: 'Bo' }] }] })
        : json({
            connections: [
              {
                resourceName: 'people/c1',
                names: [{ displayName: 'Ann' }],
                photos: [{ url: 'https://lh3.example/a' }],
              },
              { resourceName: 'people/c2' },
            ],
            nextPageToken: 'next',
          })
    })
    const progress: number[] = []
    const cards = await readGoogleContacts('tok', { onProgress: (n) => progress.push(n) })
    expect(cards).toEqual([{ name: 'Ann', uid: 'google:people/c1', photo: 'https://lh3.example/a' }, { name: 'Bo' }])
    expect(progress).toEqual([1, 2])
    expect(calls).toHaveLength(2)
    expect(calls.every((c) => c.auth === 'Bearer tok')).toBe(true)
    expect(calls[0]!.url).toMatch(/^https:\/\/people\.googleapis\.com\/v1\/people\/me\/connections\?/)
    expect(new URL(calls[1]!.url).searchParams.get('pageToken')).toBe('next')
  })

  it('says what Google refused', async () => {
    vi.stubGlobal('fetch', async () => json({}, 403))
    await expect(readGoogleContacts('tok')).rejects.toThrow(/People API/)
    vi.stubGlobal('fetch', async () => json({}, 401))
    await expect(readGoogleContacts('tok')).rejects.toBeInstanceOf(GoogleRefused)
  })

  it('fetches photos as data URLs, leaving out and counting the ones it can’t', async () => {
    vi.stubGlobal(
      'FileReader',
      class {
        result: string | null = null
        onload: (() => void) | null = null
        readAsDataURL(blob: Blob) {
          void blob.text().then((t) => {
            this.result = `data:image/jpeg;base64,${btoa(t)}`
            this.onload?.()
          })
        }
      },
    )
    vi.stubGlobal('fetch', async (url: string) =>
      url.endsWith('/bad') ? new Response('', { status: 404 }) : new Response('img'),
    )
    const cards = [
      { name: 'A', photo: 'https://lh3.example/a' },
      { name: 'B', photo: 'https://lh3.example/bad' },
      { name: 'C', photo: 'data:image/png;base64,xx' },
      { name: 'D' },
    ]
    expect(await fetchGooglePhotos(cards)).toBe(1)
    expect(cards.map((c) => c.photo)).toEqual([
      `data:image/jpeg;base64,${btoa('img')}`,
      undefined,
      'data:image/png;base64,xx',
      undefined,
    ])
  })
})

describe('signing in to Google', () => {
  it('works in a browser, and in a desktop app new enough to hand it to the system browser', () => {
    expect(canSignInToGoogle(undefined)).toBe(true)
    expect(canSignInToGoogle({ setBadge() {}, focus() {}, platform: 'linux' })).toBe(false)
    expect(canSignInToGoogle({ setBadge() {}, focus() {}, platform: 'linux', googleSignIn: async () => ({}) })).toBe(
      true,
    )
  })

  it('says nothing when the person said no, and why otherwise', () => {
    expect(googleSignInProblem(new GoogleSignInError('access_denied'))).toBeNull()
    expect(googleSignInProblem(new GoogleSignInError('blocked'))).toMatch(/pop-ups/)
    expect(googleSignInProblem(new GoogleSignInError('timeout'))).toMatch(/too long/)
    expect(googleSignInProblem(new Error('other'))).toMatch(/didn’t work/)
  })
})
