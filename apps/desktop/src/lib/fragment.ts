/** What reading a fragment token touches, given so tests can stand in for the browser. */
export interface FragmentEnv {
  location: Pick<Location, 'hash' | 'pathname' | 'search'>
  history: Pick<History, 'state' | 'replaceState'>
  /** The tab's sessionStorage, or null where the browser refuses it. */
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
}

function browserEnv(): FragmentEnv {
  let storage: FragmentEnv['storage'] = null
  try {
    storage = window.sessionStorage
  } catch {
    // Blocked site data: the token then lasts only as long as the page.
  }
  return { location: window.location, history: window.history, storage }
}

const storageKey = (name: string) => `trioditis-fragment:${name}`

/**
 * Reads a secret from the URL fragment (`#token=…`), and removes the fragment from the address
 * bar. Fragments never reach a server or a proxy's logs, which is why setup and invitation links
 * put their tokens there.
 *
 * With `remember`, the token is also kept in this tab's sessionStorage under that name until
 * `forgetFragmentToken` drops it, and read from there when the address no longer has it: so
 * reloading a link that hasn't been used yet still works. sessionStorage stays in this tab, is
 * never sent anywhere, and is gone when the tab closes.
 */
export function takeFragmentToken(remember?: string, env: FragmentEnv = browserEnv()): string {
  const params = new URLSearchParams(env.location.hash.slice(1))
  const token = params.get('token') ?? ''
  if (token) {
    env.history.replaceState(env.history.state, '', env.location.pathname + env.location.search)
    if (remember) {
      try {
        env.storage?.setItem(storageKey(remember), token)
      } catch {
        // Storage full or refused: the link works until this page is left, as before.
      }
    }
    return token
  }
  if (!remember) return ''
  try {
    return env.storage?.getItem(storageKey(remember)) ?? ''
  } catch {
    return ''
  }
}

/** Drops a token `takeFragmentToken` remembered, once it has been used. */
export function forgetFragmentToken(remember: string, env: FragmentEnv = browserEnv()) {
  try {
    env.storage?.removeItem(storageKey(remember))
  } catch {
    // Nothing more can be done; the tab's storage goes when it closes.
  }
}
