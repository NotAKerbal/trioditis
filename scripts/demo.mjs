// The test account on a preview: its sign-in, its keys and its demo data. Previews are
// short-lived and per-branch, so they get a known account to sign in with; nightly never does
// (scripts/vercel-build.mjs).
//
// The demo data itself is made by the backend, `demo.seedForMe`, sealed to the signed-in
// person's own identity key, on backends with TRIODITIS_DEMO=1. Nothing readable is sent.
import { ConvexHttpClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { TESTER } from './lib.mjs'

/** packages/crypto, once it has what signing in and key setup need (the client API work). */
export async function clientCrypto() {
  const crypto = await import('@trioditis/crypto')
  const missing = ['authPassword', 'newPasswordParams', 'passwordKey', 'generateRecoveryKey', 'wrapIdentityKey'].filter(
    (name) => typeof crypto[name] !== 'function',
  )
  if (missing.length > 0) {
    throw new Error(
      `packages/crypto doesn't have ${missing.join(', ')} yet (the client API work), so a preview's test account can't be set up.`,
    )
  }
  await crypto.ready()
  return crypto
}

/** Signs in as the test account at `siteUrl` and returns a Convex client acting as it. */
export async function signInAsTester(siteUrl, convexUrl, authPassword) {
  const signIn = await fetch(`${siteUrl}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: siteUrl },
    body: JSON.stringify({ email: TESTER.email, password: authPassword }),
  })
  if (!signIn.ok) throw new Error(`Signing in as the test account failed (${signIn.status}).`)
  const { user } = await signIn.json()
  const cookie = signIn.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const tokenResponse = await fetch(`${siteUrl}/api/auth/convex/token`, { headers: { cookie, origin: siteUrl } })
  if (!tokenResponse.ok) throw new Error(`Getting the test account's Convex token failed (${tokenResponse.status}).`)
  const client = new ConvexHttpClient(convexUrl)
  client.setAuth((await tokenResponse.json()).token)
  return { client, userId: user.id }
}

/**
 * Sets up the test account's identity key the way the app's first device does
 * (docs/architecture/client-api.md, Keys): wrapped by its password and by a recovery key,
 * which is printed. Does nothing if the account already has a key.
 */
export async function setUpTesterKeys(crypto, client, userId) {
  const existing = await client.query(anyApi.keys.identity, {})
  if (existing?.publicKey) {
    console.log('Its key is already set up.')
    return
  }
  const identity = crypto.generateKeyPair()
  const kid = crypto.keyId(identity.publicKey)
  const params = crypto.newPasswordParams()
  const recovery = crypto.generateRecoveryKey()
  const password = crypto.wrapIdentityKey(identity.privateKey, crypto.passwordKey(TESTER.password, params), {
    userId,
    kid,
    kind: 'password',
  })
  const recoveryWrap = crypto.wrapIdentityKey(identity.privateKey, recovery.bytes, { userId, kid, kind: 'recovery' })
  await client.mutation(anyApi.keys.setup, {
    publicKey: crypto.toBase64Url(identity.publicKey),
    password: { ...password, params },
    recovery: recoveryWrap,
  })
  console.log(`Set up. Its recovery key: ${recovery.text}`)
}

/** Asks the backend for demo data for the signed-in test account. */
export async function seedTesterDemo(client) {
  await client.action(anyApi.demo.seedForMe, {})
  console.log('Loaded the demo data.')
}
