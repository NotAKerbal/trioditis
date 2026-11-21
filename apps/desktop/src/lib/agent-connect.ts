// The agent consent page (/agents/connect?request=…, routes/agents.connect.tsx) and the way back
// to it after signing in.

const RETURN_KEY = 'trioditis.agentConnectReturn'
/** As long as the MCP server keeps a request open; an older one would only find it expired. */
const RETURN_TTL_MS = 10 * 60_000

/** A consent request ID as the MCP server makes them: a random token, nothing else. */
export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value)
}

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function storage(): Store | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/**
 * Remembers, for this tab only, that sign-in should come back to this consent request, so an
 * agent's link still works for someone who has to sign in first.
 */
export function holdConsentReturn(requestId: string, store = storage(), now = Date.now()) {
  if (!isRequestId(requestId)) return
  try {
    store?.setItem(RETURN_KEY, JSON.stringify({ requestId, at: now }))
  } catch {
    // Without storage, sign-in goes to the app as usual and the agent's link can be opened again.
  }
}

export function dropConsentReturn(store = storage()) {
  try {
    store?.removeItem(RETURN_KEY)
  } catch {
    // Nothing kept, nothing to drop.
  }
}

/**
 * The consent request sign-in should go back to, if one was held lately. Only a request ID comes
 * back, which sign-in only ever opens on the consent page, so nothing else stored here can send
 * the person somewhere else. Only read, so rendering twice finds it twice; the consent page lets
 * go of it once it shows.
 */
export function peekConsentReturn(store = storage(), now = Date.now()): string | null {
  let raw: string | null = null
  try {
    raw = store?.getItem(RETURN_KEY) ?? null
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const held = JSON.parse(raw) as { requestId?: unknown; at?: unknown }
    if (!isRequestId(held.requestId) || typeof held.at !== 'number') return null
    if (now - held.at > RETURN_TTL_MS || held.at > now) return null
    return held.requestId
  } catch {
    return null
  }
}

/** Where approving sends the browser back to, as the person can check it: the host, or the app's scheme. */
export function returnsTo(redirectUri: string | undefined): string | null {
  if (!redirectUri) return null
  try {
    const url = new URL(redirectUri)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.host
    return `${url.protocol}//`
  } catch {
    return null
  }
}

const usedDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

/** When a connection was last used, for Settings → Agents, in the plainest words that fit. */
export function lastUsed(at: number | undefined, now = Date.now()) {
  if (at === undefined) return 'Never used'
  const days = Math.floor((now - at) / 86_400_000)
  if (days <= 0) return 'Used today'
  if (days === 1) return 'Used yesterday'
  return `Used ${usedDate.format(at)}`
}
