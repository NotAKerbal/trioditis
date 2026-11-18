/**
 * Reads a secret from the URL fragment (`#token=…`) once, and removes the fragment from the
 * address bar. Fragments never reach a server or a proxy's logs, which is why setup and
 * invitation links put their tokens there.
 */
export function takeFragmentToken(): string {
  const params = new URLSearchParams(window.location.hash.slice(1))
  const token = params.get('token') ?? ''
  if (token) history.replaceState(history.state, '', window.location.pathname + window.location.search)
  return token
}
