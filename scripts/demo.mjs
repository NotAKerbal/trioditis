// Demo data for backends on Convex's cloud (previews and nightly), which run no bridge host
// and must never hold a real account or a real message. It is made up, and sealed exactly as
// the bridge host seals real data (docs/architecture/sealing.md), so the app shows it the
// way it shows anything else.
//
// The test account gets a fresh identity key on each backend. Its key backup is made here,
// with the test account's password, so the browser unlocks it the way it unlocks any account;
// the private key never leaves this script except inside that backup.
//
// Loading needs the backend's `demo:load` function and packages/crypto's `makeKeyBackup` (the
// client API work). On a backend without them, `seedDemo` says so and leaves the backend
// with just the test account.
import { randomUUID } from 'node:crypto'
import { TESTER } from './lib.mjs'

const NETWORK = 'fake'
const LOGIN = 'demo'

const contacts = [
  { ghostId: 'g_mom', profile: { name: 'Mom' } },
  { ghostId: 'g_alex', profile: { name: 'Alex Rivera', handle: '+1 555 0100' } },
  { ghostId: 'g_sam', profile: { name: 'Sam' } },
]

const chats = [
  {
    portalId: 'p_mom',
    kind: 'dm',
    meta: { name: 'Mom' },
    messages: [
      { from: 'g_mom', text: 'Are you coming for dinner on Sunday?', minutesAgo: 180 },
      { from: 'self', text: 'Yes! I’ll bring dessert.', minutesAgo: 170 },
      { from: 'g_mom', text: 'Perfect, see you at 6', minutesAgo: 165 },
    ],
  },
  {
    portalId: 'p_family',
    kind: 'group',
    meta: { name: 'Family', topic: 'Everyone' },
    messages: [
      { from: 'g_sam', text: 'Who has the photos from the lake?', minutesAgo: 90 },
      { from: 'g_mom', text: 'I do, sending them tonight', minutesAgo: 60 },
      { from: 'g_sam', text: 'Thanks 🙌', minutesAgo: 58 },
    ],
  },
  {
    portalId: 'p_alex',
    kind: 'dm',
    meta: { name: 'Alex Rivera' },
    messages: [
      { from: 'g_alex', text: 'Did you see the game last night?', minutesAgo: 20 },
      { from: 'g_alex', text: 'That last minute goal 😮', minutesAgo: 19 },
    ],
  },
]

/** The sealed rows `demo:load` takes, for `userId`, sealed to `identity`. */
export function demoRows(crypto, userId, identity) {
  const recipients = [identity]
  const now = Date.now()
  return {
    network: NETWORK,
    loginId: LOGIN,
    contacts: contacts.map(({ ghostId, profile }) => ({
      ghostId,
      sealed: crypto.sealJson(profile, recipients, { kind: 'contact', ownerUserId: userId, objectId: ghostId }),
    })),
    chats: chats.map(({ portalId, kind, meta, messages }) => ({
      portalId,
      kind,
      sealed: crypto.sealJson(meta, recipients, { kind: 'chat', ownerUserId: userId, objectId: portalId }),
      messages: messages.map(({ from, text, minutesAgo }) => {
        const eventId = `demo_${randomUUID()}`
        return {
          eventId,
          networkTs: now - minutesAgo * 60_000,
          sender: from === 'self' ? { self: true } : { ghostId: from },
          sealed: crypto.sealJson({ type: 'text', body: text }, recipients, {
            kind: 'message',
            ownerUserId: userId,
            objectId: eventId,
          }),
        }
      }),
    })),
  }
}

/**
 * Loads the demo data for the test account, `userId`. `convexRun(name, args)` runs a backend
 * function with deploy credentials and returns its output. Returns whether it loaded.
 */
export async function seedDemo(convexRun, userId) {
  const crypto = await import('@trioditis/crypto')
  if (typeof crypto.makeKeyBackup !== 'function') {
    console.log('Skipped: packages/crypto has no makeKeyBackup yet, so the browser could not unlock demo data.')
    return false
  }
  await crypto.ready()
  const identity = crypto.generateKeyPair()
  const keyBackup = await crypto.makeKeyBackup(identity.privateKey, TESTER.password)
  try {
    convexRun('demo:load', {
      userId,
      identityPublicKey: crypto.toBase64Url(identity.publicKey),
      keyBackup,
      ...demoRows(crypto, userId, identity),
    })
  } catch (error) {
    if (/Could not find/.test(error.message)) {
      console.log('Skipped: this backend has no demo:load yet.')
      return false
    }
    throw error
  }
  console.log(`Loaded ${chats.length} demo chats.`)
  return true
}
