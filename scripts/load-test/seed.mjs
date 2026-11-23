// What the person does to their inbox from the app, on top of what the bridge hosts sent: their
// address book, labels, and pins, archives, snoozes and mutes. Through the app's own mutations,
// sealed as the app seals (kind `person`, `label`), so the rows are what a real client leaves.
import { ConvexClient } from 'convex/browser'
import { anyApi } from 'convex/server'

/** Every chat's ID, by `<network>/<portalId>`, from the lists the app pages through. */
export async function chatIds(http) {
  const ids = new Map()
  for (const view of ['inbox', 'requests', 'archived', 'snoozed']) {
    let cursor = null
    for (;;) {
      const page = await http.query(anyApi.chats.list, { view, paginationOpts: { numItems: 50, cursor } })
      for (const row of page.page) ids.set(`${row.network}/${row.portalId}`, row._id)
      if (page.isDone) break
      cursor = page.continueCursor
    }
  }
  return ids
}

export async function seedClientState(crypto, person, inbox, convexUrl, log = console.log) {
  // Over a websocket, signed in once, as the app is: each call over HTTP has the backend check
  // its token afresh, fetching Better Auth's keys each time, which makes seeding crawl.
  const raw = new ConvexClient(convexUrl, { skipConvexDeploymentUrlCheck: true, unsavedChangesWarning: false })
  // A token that can't be had means signed out, so the calls below fail where they're awaited,
  // rather than as a rejection the client never catches.
  raw.setAuth(() => person.token().catch(() => null))
  // Each call gives up after a minute, so a socket that keeps reconnecting can't stall seeding.
  const bounded = (call) => (ref, args) => {
    let timer
    return Promise.race([
      call(ref, args),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('A seeding call got no answer within 60 s.')), 60_000)
      }),
    ]).finally(() => clearTimeout(timer))
  }
  const socket = { query: bounded((r, a) => raw.query(r, a)), mutation: bounded((r, a) => raw.mutation(r, a)) }
  try {
    return await seedWith(socket, crypto, person, inbox, log)
  } finally {
    await raw.close()
  }
}

async function seedWith(http, crypto, person, inbox, log) {
  const { userId, publicKey } = person
  const seal = (value, kind, objectId) =>
    crypto.sealJson(value, [{ publicKey }], { kind, ownerUserId: userId, objectId })

  log(`Saving ${inbox.people.length} People cards`)
  let revision = await http.query(anyApi.people.revision, {})
  for (let i = 0; i < inbox.people.length; i += 100) {
    const people = inbox.people
      .slice(i, i + 100)
      .map((p) => ({ personKey: p.personKey, sealed: seal(p.card, 'person', p.personKey) }))
    revision = await http.mutation(anyApi.people.put, { people, revision })
  }

  const labelIds = new Map()
  for (const label of inbox.labels) {
    const id = await http.mutation(anyApi.labels.create, {
      labelKey: label.labelKey,
      sealed: seal({ name: label.name, color: label.color }, 'label', label.labelKey),
    })
    labelIds.set(label.labelKey, id)
  }

  const ids = await chatIds(http)
  const idOf = (chat) => ids.get(`${chat.network}/${chat.portalId}`)
  const missing = inbox.chats.filter((c) => !idOf(c)).length
  if (missing) throw new Error(`${missing} of the inbox's chats aren't in the lists after seeding.`)
  const later = Date.now() + 7 * 24 * 3600_000
  let changes = 0
  // 32 at a time, as several devices and clicks would.
  const work = []
  for (const chat of inbox.chats) {
    const chatId = idOf(chat)
    if (chat.pinned) work.push(() => http.mutation(anyApi.chats.setPinned, { chatId, pinned: true }))
    if (chat.archived) work.push(() => http.mutation(anyApi.chats.setArchived, { chatId, archived: true }))
    else if (chat.snoozed) work.push(() => http.mutation(anyApi.chats.snooze, { chatId, until: later }))
    if (chat.muted) work.push(() => http.mutation(anyApi.chats.setMuted, { chatId, muted: true }))
    if (chat.labels)
      work.push(() =>
        http.mutation(anyApi.chats.setLabels, { chatId, labelIds: chat.labels.map((k) => labelIds.get(k)) }),
      )
  }
  log(`Pinning, archiving, snoozing, muting and labelling (${work.length} changes)`)
  for (let i = 0; i < work.length; i += 32) {
    await Promise.all(work.slice(i, i + 32).map((fn) => fn()))
    changes += Math.min(32, work.length - i)
  }
  return { chats: ids.size, changes, labels: labelIds.size, people: inbox.people.length }
}
