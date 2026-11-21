import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'

// desktop.ts reads the bridge off `window` when it loads; in a browser there is none.
vi.stubGlobal('window', {})
const { fetchGooglePhotos, GoogleRefused, readGoogleContacts } = await import('../src/data/google-contacts.ts')
const { canSignInToGoogle, GoogleSignInError, googleSignInProblem, signInToGoogle } =
  await import('../src/lib/google-sign-in.ts')

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

describe('the sign-in popup’s answer', () => {
  const callback = readFileSync(new URL('../public/google-contacts.js', import.meta.url), 'utf8')

  /** Runs /google-contacts.html's script as Google's redirect would land on it. */
  function land(fragment: string) {
    const status = { textContent: '' }
    runInNewContext(callback, {
      location: { hash: `#${fragment}`, pathname: '/google-contacts.html', host: 'chat.example.com' },
      history: { replaceState() {} },
      document: { getElementById: () => status },
      URLSearchParams,
      BroadcastChannel,
      setTimeout: () => undefined,
      window: { close() {} },
    })
  }

  function signIn() {
    let url = ''
    vi.stubGlobal('window', {
      location: { origin: 'https://chat.example.com' },
      open: (u: string) => ((url = u), {}),
    })
    const token = signInToGoogle('id.apps.googleusercontent.com')
    return { token, state: new URL(url).searchParams.get('state')! }
  }

  it('hands the token to the page that asked', async () => {
    const { token, state } = signIn()
    land(`state=${state}&access_token=ya29.token&token_type=Bearer&expires_in=3599`)
    await expect(token).resolves.toBe('ya29.token')
  })

  it('hands Google’s error to it, and ignores an answer for another sign-in', async () => {
    const { token, state } = signIn()
    land(`state=w${'x'.repeat(32)}&access_token=other`)
    land(`state=${state}&error=access_denied`)
    await expect(token).rejects.toMatchObject({ code: 'access_denied' })
  })
})
