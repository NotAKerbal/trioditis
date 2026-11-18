// End to end on the dev stack with the fake network: Convex, the gateway and a fake-network
// bridge host must be running (docs/CONTRIBUTING.md, Run the stack locally; the bridge host
// with BRIDGE_FAKE_CONTROL_ADDR set). It signs in as the dev admin, sets an identity key,
// connects the fake network through a sealed login, receives a message, sends one, and checks
// that what reached Convex is sealed.
//
// The identity key it sets is kept (E2E_IDENTITY_FILE, default ../../.data/e2e-identity.json)
// so the script can run again on the same account; a fresh fake login each run gives it a new
// chat.
//
//   node --env-file=../../.data/dev.env scripts/e2e-fake.ts <admin email> <password>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ConvexHttpClient } from 'convex/browser'
import { api } from '@trioditis/backend/api'
import { fromBase64Url, generateKeyPair, keyId, openJson, ready, sealJson, toBase64Url, type KeyPair } from '@trioditis/crypto'

const [email, password] = process.argv.slice(2)
if (!email || !password) throw new Error('Usage: e2e-fake.ts <admin email> <password>')
const site = process.env.SITE_URL!
const convexUrl = process.env.CONVEX_URL!
const fakeControl = `http://${process.env.BRIDGE_FAKE_CONTROL_ADDR ?? '127.0.0.1:8621'}`
const internalToken = process.env.TRIODITIS_INTERNAL_TOKEN!

await ready()

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

function step(message: string) {
  console.log(`✔ ${message}`)
}

// Sign in, then trade the session for the Convex token the client uses.
const signIn = await fetch(`${site}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: site },
  body: JSON.stringify({ email, password }),
})
if (!signIn.ok) throw new Error(`Sign-in failed: ${signIn.status}`)
const cookie = signIn.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
const tokenResponse = await fetch(`${site}/api/auth/convex/token`, { headers: { cookie, origin: site } })
const { token } = (await tokenResponse.json()) as { token: string }
const client = new ConvexHttpClient(convexUrl)
client.setAuth(token)
step('Signed in')

const identityFile = process.env.E2E_IDENTITY_FILE ?? new URL('../../../.data/e2e-identity.json', import.meta.url).pathname
const me = await client.query(api.members.me, {})
if (!me) throw new Error('Not a member')
let userIdentity: KeyPair
if (me.identityKid) {
  // The account's key from an earlier run; it can't be replaced, only reused.
  if (!existsSync(identityFile)) throw new Error(`The account has an identity key but ${identityFile} doesn't hold it`)
  const saved = JSON.parse(readFileSync(identityFile, 'utf8')) as { publicKey: string; privateKey: string }
  userIdentity = { publicKey: fromBase64Url(saved.publicKey), privateKey: fromBase64Url(saved.privateKey) }
  if (keyId(userIdentity.publicKey) !== me.identityKid) throw new Error(`${identityFile} isn't this account's identity key`)
  step('Identity key reused')
} else {
  userIdentity = generateKeyPair()
  await client.mutation(api.members.setIdentityKey, { publicKey: toBase64Url(userIdentity.publicKey) })
  mkdirSync(dirname(identityFile), { recursive: true })
  writeFileSync(
    identityFile,
    JSON.stringify({ publicKey: toBase64Url(userIdentity.publicKey), privateKey: toBase64Url(userIdentity.privateKey) }),
    { mode: 0o600 },
  )
  step('Identity key set')
}

const bridge = await client.query(api.keys.bridge, {})
if (!bridge) throw new Error('BRIDGE_PUBLIC_KEY is not set on Convex')
const bridgeKey = { publicKey: fromBase64Url(bridge.publicKey) }

// Connect the fake network: the login's input is sealed to the bridge key.
const loginSessionId = await client.mutation(api.logins.start, { network: 'fake' })
const input = await until('the login’s first step', async () => {
  const session = await client.query(api.logins.session, { loginSessionId })
  return session?.state === 'active' && session.step?.type === 'userInput' ? session.step : null
})
const loginUser = `e2e-${Date.now()}`
await client.mutation(api.logins.submit, {
  loginSessionId,
  stepId: input.stepId,
  sealed: sealJson({ input: { username: loginUser } }, [bridgeKey], {
    kind: 'outbound',
    ownerUserId: me.userId,
    objectId: `${loginSessionId}/${input.stepId}`,
  }),
})
await until('the login to complete', async () => {
  const session = await client.query(api.logins.session, { loginSessionId })
  if (session?.state === 'error') throw new Error(`Login failed: ${session.step?.error}`)
  return session?.state === 'complete'
})
const loginId = await until('the login ID', async () => (await client.query(api.logins.session, { loginSessionId }))?.loginId)
await until('the account to connect', async () => {
  const accounts = await client.query(api.logins.accounts, {})
  return accounts.find((account) => account.loginId === loginId && account.state === 'CONNECTED')
})
step('Fake network connected through a sealed login')

// Someone on the network messages the person.
const secretText = `hello from alice ${Date.now()}`
const incoming = await fetch(`${fakeControl}/fake/incoming`, {
  method: 'POST',
  headers: { authorization: `Bearer ${internalToken}`, 'content-type': 'application/json' },
  body: JSON.stringify({ loginId: loginUser, chatId: 'chat-alice', senderId: 'alice', messageId: 'm1', text: secretText }),
})
if (incoming.status !== 202) throw new Error(`Fake incoming failed: ${incoming.status}`)
// This run's chat: on this run's login.
// The inbox is paged; this run's chat is among the most recent.
const inbox = async () => (await client.query(api.chats.list, { paginationOpts: { numItems: 50, cursor: null } })).page
const findChat = async () => (await inbox()).find((c) => c.network === 'fake' && c.loginId === loginId)
const chat = await until('the chat to appear', findChat)
const received = await until('the message to arrive', async () => {
  const page = await client.query(api.messages.list, { chatId: chat._id, paginationOpts: { numItems: 10, cursor: null } })
  return page.page.find((message) => 'ghostId' in message.sender)
})
const opened = openJson<{ body: string }>(received.sealed!, userIdentity, {
  kind: 'message',
  ownerUserId: me.userId,
  objectId: received.sealedObjectId,
})
if (opened.body !== secretText) throw new Error("The incoming message didn't decrypt to what was sent")
// Read the chat again: the snapshot above can be from before the message was counted.
const unread = (await findChat())?.unreadCount
if (unread !== 1) throw new Error(`Unread count ${unread}`)
step('Incoming message arrived sealed, and opens with the identity key')

// The person replies from Trioditis.
const clientMessageId = `e2e-${crypto.randomUUID().replaceAll('-', '')}`
const reply = { type: 'text', body: `reply ${Date.now()}` }
await client.mutation(api.messages.send, {
  chatId: chat._id,
  clientMessageId,
  forBridge: sealJson(reply, [bridgeKey], { kind: 'outbound', ownerUserId: me.userId, objectId: clientMessageId }),
  copy: sealJson(reply, [userIdentity], { kind: 'message', ownerUserId: me.userId, objectId: clientMessageId }),
})
const echoed = await until('the send to be echoed', async () => {
  const page = await client.query(api.messages.list, { chatId: chat._id, paginationOpts: { numItems: 10, cursor: null } })
  const mine = page.page.find((message) => message.clientMessageId === clientMessageId)
  return mine && !mine.eventId.startsWith('pending:') && mine.delivery === 'sent' ? mine : null
})
const echoOpened = openJson<{ body: string }>(echoed.sealed!, userIdentity, {
  kind: 'message',
  ownerUserId: me.userId,
  objectId: echoed.sealedObjectId,
})
if (echoOpened.body !== reply.body) throw new Error("The sent message's echo didn't decrypt to what was sent")
const all = await client.query(api.messages.list, { chatId: chat._id, paginationOpts: { numItems: 10, cursor: null } })
if (all.page.length !== 2) throw new Error(`Expected 2 messages, found ${all.page.length}`)
step('Reply sent, echoed once, delivery "sent", and its sealed copy opens')

// Nothing a person wrote is readable in what Convex returned.
const everything = JSON.stringify([await inbox(), all, await client.query(api.logins.accounts, {})])
for (const plaintext of [secretText, reply.body, loginUser, 'alice']) {
  if (everything.includes(plaintext)) throw new Error('Plaintext content or a name reached Convex')
}
step('No plaintext in chats, messages or accounts')
console.log('End to end: passed')
