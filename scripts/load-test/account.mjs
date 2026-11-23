// The load test's person: signed up as the server's first account (its admin), with an
// identity key set up as the app's first device sets one up. Every simulated client signs in
// as them, and every simulated bridge host seals to their key.
import { anyApi } from 'convex/server'
import { ConvexHttpClient } from 'convex/browser'

export const LOAD_PERSON = { name: 'Load Tester', email: 'load@trioditis.test', password: 'trioditis-load-tester' }

const cookiesOf = (response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')

/**
 * Signs the person up (or in, on a backend that has them) and sets up their key. Returns
 * `{ userId, keyPair, publicKey, kid, token() }`, where `token()` gives a fresh Convex JWT.
 */
export async function setUpPerson(crypto, { siteUrl, origin, convexUrl, setupToken }) {
  const password = crypto.authPassword(LOAD_PERSON.password, LOAD_PERSON.email)
  const post = (path, body, headers = {}) =>
    fetch(`${siteUrl}/api/auth/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
  let response = await post('sign-in/email', { email: LOAD_PERSON.email, password })
  if (!response.ok) {
    response = await post(
      'sign-up/email',
      { name: LOAD_PERSON.name, email: LOAD_PERSON.email, password },
      { 'x-trioditis-invite': setupToken },
    )
    if (!response.ok)
      throw new Error(`Signing up the load test's person failed (${response.status}): ${await response.text()}`)
  }
  const userId = (await response.json()).user.id
  const cookie = cookiesOf(response)
  const token = async () => {
    const answer = await fetch(`${siteUrl}/api/auth/convex/token`, {
      headers: { cookie, origin },
      signal: AbortSignal.timeout(60_000),
    })
    if (!answer.ok) throw new Error(`Getting a Convex token failed (${answer.status}).`)
    return (await answer.json()).token
  }

  const http = new ConvexHttpClient(convexUrl)
  http.setAuth(await token())
  const identity = crypto.generateKeyPair()
  const existing = await http.query(anyApi.keys.identity, {})
  if (existing?.publicKey) throw new Error('The load test needs a fresh backend: this person already has a key.')
  const { args } = crypto.makeKeySetup(identity.privateKey, LOAD_PERSON.password, userId)
  // The proof the app's first device gives (apps/desktop/src/lib/proof.ts): the challenge the
  // server seals to the new key, opened with it.
  const { sealed } = await http.mutation(anyApi.keys.challenge, { publicKey: args.publicKey })
  const proof = crypto.toBase64Url(crypto.openSealedBox(crypto.fromBase64Url(sealed), identity))
  await http.mutation(anyApi.keys.setup, { ...args, proof })
  return {
    userId,
    keyPair: identity,
    publicKey: identity.publicKey,
    kid: crypto.keyId(identity.publicKey),
    token,
    http,
    /** Gives the HTTP client a fresh token: Better Auth's Convex tokens are short-lived. */
    refresh: async () => http.setAuth(await token()),
  }
}
