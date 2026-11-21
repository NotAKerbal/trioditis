import { googleSignInUrl } from '@trioditis/core'
import { desktop, type DesktopBridge } from './desktop.ts'

// Signing in to Google for Google Contacts. Google hands the token back in the fragment of
// /google-contacts.html on this server (public/google-contacts.js), which passes it to the page
// that asked: in a browser over a BroadcastChannel from the sign-in popup, and in the desktop
// app, where the sign-in is in the system's browser, as a `trioditis://` link the app checks
// (electron/links.ts). The token is only ever held in memory, for the one import.

/** The channel /google-contacts.html answers on. */
export const GOOGLE_CHANNEL = 'trioditis-google-contacts'

/** How long a sign-in is waited on. */
const WAIT_MS = 10 * 60_000

/** What Google's sign-in answers to on this server, which an admin registers with Google. */
export const googleRedirectUri = (origin = window.location.origin) => `${origin}/google-contacts.html`

export class GoogleSignInError extends Error {
  /**
   * `blocked` (the popup was), `access_denied` (the person said no), `timeout`, `superseded`,
   * `unavailable` (a desktop app that can't be handed Google's answer), or Google's own code.
   */
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}

/**
 * Whether this app can sign in to Google: any browser, and a desktop app new enough to hand
 * the sign-in to the system's browser. An older one would open it there with no way back.
 */
export const canSignInToGoogle = (bridge: DesktopBridge | undefined = desktop) =>
  !bridge || typeof bridge.googleSignIn === 'function'

/** A state the answer has to carry back: `w` for a browser's popup, `d` for the desktop app. */
function newState(kind: 'w' | 'd') {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return (
    kind +
    btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')
  )
}

/**
 * Signs in to Google for read-only access to contacts, answering with the access token. Call it
 * straight from a click, before anything is awaited, or the popup is blocked.
 */
export function signInToGoogle(clientId: string): Promise<string> {
  const bridge = desktop
  const state = newState(bridge ? 'd' : 'w')
  const url = googleSignInUrl({ clientId, redirectUri: googleRedirectUri(), state })
  if (bridge?.googleSignIn) {
    return bridge.googleSignIn(url).then((answer) => {
      if (answer.accessToken) return answer.accessToken
      throw new GoogleSignInError(answer.error ?? 'failed')
    })
  }
  // A popup, so the app (and its unlocked keys) stays as it is underneath.
  const popup = window.open(url, 'trioditis-google', 'popup,width=520,height=680')
  if (!popup) return Promise.reject(new GoogleSignInError('blocked'))
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel(GOOGLE_CHANNEL)
    const finish = () => {
      clearTimeout(timer)
      channel.close()
    }
    const timer = setTimeout(() => {
      finish()
      reject(new GoogleSignInError('timeout'))
    }, WAIT_MS)
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const answer = event.data as { state?: unknown; accessToken?: unknown; error?: unknown } | null
      if (!answer || answer.state !== state) return
      finish()
      if (typeof answer.accessToken === 'string' && answer.accessToken) resolve(answer.accessToken)
      else reject(new GoogleSignInError(typeof answer.error === 'string' ? answer.error : 'failed'))
    }
  })
}

/** What to tell the person when signing in didn't work, or null when there's nothing to say. */
export function googleSignInProblem(err: unknown): string | null {
  if (!(err instanceof GoogleSignInError)) return 'Google sign-in didn’t work. Try again.'
  switch (err.code) {
    case 'access_denied':
    case 'superseded':
    case 'unavailable':
      return null
    case 'blocked':
      return 'The Google sign-in window was blocked. Allow pop-ups for this site, then try again.'
    case 'timeout':
      return 'Google sign-in took too long. Try again.'
    case 'refused':
      return 'Google sign-in couldn’t be opened. Try again.'
    default:
      return 'Google sign-in didn’t work. Try again.'
  }
}
