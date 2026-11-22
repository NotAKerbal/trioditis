// Simulated desktop clients: each a Convex websocket client signed in as the person, holding
// the live queries the desktop app holds (apps/desktop/src/data, features/shell/sidebar.tsx,
// features/chat/warm-chats.tsx) with the same arguments, and clicking around as a person does.
//
// - At start, Focused layout: the inbox by recency and the snoozed, requests, archived and
//   blocked lists (50 a page), the badge counts, arrivals, labels, preferences, scheduled
//   messages, the server's and networks' state, People (every page), and a media token per
//   network for the sidebar's pictures. Unread loads inbox pages until the count is met.
// - Fetch-ahead: up to six warm chats, each its first page of messages, their reactions, a
//   group's senders' profiles, its scheduled and cancelled messages (data/chat-content.ts); the
//   first three unread chats are warmed 1.5 s after the list settles.
// - Clicks: open a chat (chats.get, typing, the warm queries, markRead when unread), scroll
//   back through it, open People (people, contacts and identifiers, every page), hover a chat
//   (warm it), mute or pin one, and now and then send a message. A chat let go stays
//   subscribed for five minutes, as the desktop's query cache keeps it (main.tsx).
import { ConvexClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { random } from './inbox.mjs'

const PAGE = 50
const WARM = 6
const WARM_UNREAD = 3
const KEEP_MS = 5 * 60_000
const MAX_UNREAD_PAGES = 40

const ref = (name) => {
  const [module, fn] = name.split(':')
  return anyApi[module][fn]
}

/** What every client saw, together: errors, how long things took to show. */
export function clientMetrics() {
  return {
    errors: 0,
    errorKinds: {},
    firstResult: {},
    actions: {},
    opens: [],
    visible: [],
    subscriptions: 0,
    peakSubscriptions: 0,
  }
}

const shortError = (error) =>
  String(error?.message ?? error)
    .split('\n')[0]
    .replace(/\[Request ID: [^\]]+\]\s*/g, '')
    .slice(0, 200)

export class SimClient {
  constructor({ id, convexUrl, person, crypto, metrics, sent, rand, bridgeKey, networks, keepMs = KEEP_MS }) {
    this.id = id
    this.person = person
    this.crypto = crypto
    this.metrics = metrics
    this.sent = sent
    this.rand = rand
    this.bridgeKey = bridgeKey
    this.networks = networks
    this.keepMs = keepMs
    this.client = new ConvexClient(convexUrl, { skipConvexDeploymentUrlCheck: true, unsavedChangesWarning: false })
    this.client.setAuth(() => person.token().catch(() => null))
    this.subs = new Map()
    this.lists = {}
    this.warm = []
    this.open = null
    this.released = new Map()
    this.seenEvents = new Set()
    this.timers = []
  }

  error(where, error) {
    const kind = `${where}: ${shortError(error)}`
    this.metrics.errors++
    this.metrics.errorKinds[kind] = (this.metrics.errorKinds[kind] ?? 0) + 1
  }

  /**
   * Subscribes under `key` (once; a second ask shares it, as the app's cache does) and
   * resolves with the first answer, or null if it failed.
   */
  watch(key, name, args, onValue = () => {}) {
    const held = this.subs.get(key)
    if (held) {
      this.released.delete(key)
      held.listeners.push(onValue)
      if (held.value !== undefined) onValue(held.value)
      return held.first
    }
    const started = performance.now()
    let resolveFirst
    const sub = { name, value: undefined, listeners: [onValue], first: new Promise((r) => (resolveFirst = r)) }
    this.subs.set(key, sub)
    this.metrics.subscriptions++
    this.metrics.peakSubscriptions = Math.max(this.metrics.peakSubscriptions, this.subs.size)
    let answered = false
    sub.unsubscribe = this.client.onUpdate(
      ref(name),
      args,
      (value) => {
        if (!answered) {
          answered = true
          ;(this.metrics.firstResult[name] ??= []).push(performance.now() - started)
          resolveFirst(value)
        }
        sub.value = value
        for (const listener of sub.listeners) listener(value)
      },
      (error) => {
        this.error(name, error)
        if (!answered) {
          answered = true
          resolveFirst(null)
        }
      },
    )
    return sub.first
  }

  drop(key) {
    const sub = this.subs.get(key)
    if (!sub) return
    sub.unsubscribe()
    this.subs.delete(key)
  }

  /** Lets go of `key` after the cache's five minutes, unless it's asked for again first. */
  release(key) {
    if (!this.subs.has(key)) return
    this.released.set(key, Date.now() + this.keepMs)
  }

  sweep() {
    const now = Date.now()
    for (const [key, until] of this.released) {
      if (until <= now) {
        this.released.delete(key)
        this.drop(key)
      }
    }
  }

  async mutate(name, args) {
    const started = performance.now()
    try {
      const value = await this.client.mutation(ref(name), args)
      ;(this.metrics.firstResult[name] ??= []).push(performance.now() - started)
      return value
    } catch (error) {
      this.error(name, error)
      return null
    }
  }

  /** A paginated list's pages, each a subscription, as usePaginatedQuery holds them. */
  async pages(key, name, args, numItems, { more = () => false, maxPages = 100 } = {}) {
    const loaded = []
    let cursor = null
    for (let page = 0; page < maxPages; page++) {
      const value = await this.watch(`${key}#${page}`, name, {
        ...args,
        paginationOpts: { numItems, cursor, id: page },
      })
      if (!value) break
      loaded.push(...value.page)
      if (value.isDone || !more(loaded)) break
      cursor = value.continueCursor
    }
    return loaded
  }

  async start() {
    const p = []
    for (const [key, name] of [
      ['me', 'members:me'],
      ['identity', 'keys:identity'],
      ['bridgeKey', 'keys:bridge'],
      ['server', 'server:info'],
      ['preferences', 'preferences:get'],
      ['labels', 'labels:list'],
      ['networks', 'networks:list'],
      ['health', 'networks:health'],
      ['accounts', 'logins:accounts'],
      ['updates', 'updates:status'],
      ['arrivals', 'messages:arrivals'],
      ['scheduled', 'scheduled:list'],
      ['cancelled', 'scheduled:cancelled'],
      ['peopleRevision', 'people:revision'],
    ]) {
      p.push(this.watch(key, name, {}))
    }
    const counts = this.watch('counts', 'chats:counts', {})
    for (const view of ['snoozed', 'requests', 'archived', 'blocked']) {
      p.push(this.pages(`list:${view}`, 'chats:list', { view }, PAGE, { maxPages: 1 }))
    }
    p.push(this.pages('people', 'people:list', {}, 100, { more: () => true }))
    for (const network of this.networks) p.push(this.mutate('media:access', { network }))
    // Unread: inbox pages until every unread chat the count says there is has loaded.
    const target = (await counts)?.inbox?.count ?? 0
    const unreadOf = (rows) => rows.filter((c) => (c.unreadCount > 0 || c.markedUnread) && c.mutedUntil === null)
    const inbox = await this.pages('list:inbox', 'chats:list', { view: 'inbox', order: 'recent' }, PAGE, {
      more: (rows) => unreadOf(rows).length < target,
      maxPages: MAX_UNREAD_PAGES,
    })
    this.lists.inbox = inbox
    this.lists.unread = unreadOf(inbox)
    await Promise.all(p)
    this.timers.push(
      setTimeout(() => {
        for (const chat of this.lists.unread.slice(0, WARM_UNREAD).reverse()) this.warmChat(chat)
      }, 1500),
    )
    this.timers.push(setInterval(() => this.sweep(), 5000))
  }

  /** What data/chat-content.ts's useWarmChat asks for a chat. */
  warmChat(chat) {
    const keys = []
    const pageKey = `messages:${chat._id}#0`
    keys.push(pageKey)
    const page = this.watch(
      pageKey,
      'messages:list',
      { chatId: chat._id, paginationOpts: { numItems: PAGE, cursor: null, id: 0 } },
      (value) => this.noticeMessages(value.page),
    )
    for (const [key, name, args] of [
      [`scheduled:${chat._id}`, 'scheduled:list', { chatId: chat._id }],
      [`cancelled:${chat._id}`, 'scheduled:cancelled', { chatId: chat._id }],
    ]) {
      keys.push(key)
      void this.watch(key, name, args)
    }
    const extras = page.then((value) => {
      if (!value) return
      const ids = value.page.filter((m) => !m.redactedAt && !m.eventId.startsWith('pending:')).map((m) => m._id)
      const waits = []
      for (let i = 0; i < ids.length; i += 100) {
        const key = `reactions:${chat._id}:${ids[i]}`
        keys.push(key)
        waits.push(this.watch(key, 'messages:reactions', { chatId: chat._id, messageIds: ids.slice(i, i + 100) }))
      }
      if (chat.kind === 'group') {
        const ghosts = [...new Set(value.page.flatMap((m) => ('ghostId' in m.sender ? [m.sender.ghostId] : [])))].sort(
          (a, b) => (a < b ? -1 : a > b ? 1 : 0),
        )
        for (let i = 0; i < ghosts.length; i += 100) {
          const key = `contacts:${chat.network}:${ghosts.slice(i, i + 100).join()}`
          keys.push(key)
          waits.push(this.watch(key, 'contacts:get', { network: chat.network, ghostIds: ghosts.slice(i, i + 100) }))
        }
      }
      return Promise.all(waits)
    })
    // At most six warm chats; the oldest is let go to the cache.
    this.warm = [{ chat, keys }, ...this.warm.filter((w) => w.chat._id !== chat._id)]
    for (const gone of this.warm.splice(WARM))
      if (gone.chat._id !== this.open?.chat._id) for (const k of gone.keys) this.release(k)
    return { page, extras, keys }
  }

  /** Times a live message from when its bridge host journaled it to when this client has it. */
  noticeMessages(rows) {
    const now = Date.now()
    for (const m of rows) {
      if (this.seenEvents.has(m.eventId)) continue
      this.seenEvents.add(m.eventId)
      const sent = this.sent.get(m.eventId)
      if (sent) this.metrics.visible.push(now - sent.at)
    }
  }

  count(action) {
    this.metrics.actions[action] = (this.metrics.actions[action] ?? 0) + 1
  }

  visibleChats() {
    const inbox = this.subs.get('list:inbox#0')?.value?.page ?? this.lists.inbox ?? []
    return inbox
  }

  async openChat(chat) {
    this.count('open chat')
    const started = performance.now()
    if (this.open) for (const k of this.open.keys) this.release(k)
    const keys = [`chat:${chat._id}`, `typing:${chat._id}`]
    const got = this.watch(keys[0], 'chats:get', { chatId: chat._id })
    void this.watch(keys[1], 'messages:typing', { chatId: chat._id })
    const warmed = this.warmChat(chat)
    this.open = { chat, keys: [...keys, ...warmed.keys], pages: 1 }
    const [row, page] = await Promise.all([got, warmed.page])
    this.metrics.opens.push(performance.now() - started)
    await warmed.extras
    this.open.keys.push(...warmed.keys.filter((k) => !this.open.keys.includes(k)))
    if (row && (row.unreadCount > 0 || row.markedUnread)) await this.mutate('chats:markRead', { chatId: chat._id })
    this.open.cursor = page?.isDone ? null : page?.continueCursor
  }

  async scrollBack() {
    if (!this.open?.cursor) return this.openSomething()
    this.count('scroll back')
    const { chat } = this.open
    const n = this.open.pages++
    const key = `messages:${chat._id}#${n}`
    const value = await this.watch(key, 'messages:list', {
      chatId: chat._id,
      paginationOpts: { numItems: PAGE, cursor: this.open.cursor, id: n },
    })
    this.open.keys.push(key)
    if (!value) return
    this.open.cursor = value.isDone ? null : value.continueCursor
    const ids = value.page.filter((m) => !m.redactedAt).map((m) => m._id)
    for (let i = 0; i < ids.length; i += 100) {
      const rkey = `reactions:${chat._id}:${ids[i]}`
      this.open.keys.push(rkey)
      await this.watch(rkey, 'messages:reactions', { chatId: chat._id, messageIds: ids.slice(i, i + 100) })
    }
  }

  async openPeople() {
    this.count('open People')
    await Promise.all([
      this.pages('people', 'people:list', {}, 100, { more: () => true }),
      this.pages('contacts', 'contacts:list', {}, 500, { more: () => true }),
      this.pages('identifiers', 'contacts:identifiers', {}, 500, { more: () => true }),
    ])
    // Closed again; its lists stay in the cache.
    for (const key of this.subs.keys())
      if (key.startsWith('contacts#') || key.startsWith('identifiers#')) this.release(key)
  }

  async openSomething() {
    const chats = this.visibleChats()
    if (chats.length === 0) return
    // Mostly the unread ones near the top, as a person goes through them.
    const unread = chats.filter((c) => c.unreadCount > 0)
    const chat = unread.length && this.rand.chance(0.6) ? unread[0] : chats[this.rand.int(Math.min(chats.length, 30))]
    await this.openChat(chat)
  }

  async send() {
    if (!this.open || !this.bridgeKey) return
    this.count('send')
    const clientMessageId = `load-${this.id}-${Date.now()}-${this.rand.int(1e9)}`
    const plaintext = { type: 'text', body: 'Sent from the load test' }
    const copy = this.crypto.sealJson(plaintext, [{ publicKey: this.person.publicKey }], {
      kind: 'message',
      ownerUserId: this.person.userId,
      objectId: clientMessageId,
    })
    const forBridge = this.crypto.sealJson(plaintext, [{ publicKey: this.bridgeKey }], {
      kind: 'outbound',
      ownerUserId: this.person.userId,
      objectId: clientMessageId,
    })
    await this.mutate('messages:send', { chatId: this.open.chat._id, clientMessageId, forBridge, copy })
  }

  /** One click, chosen as a person's would be. */
  async act() {
    const r = this.rand.next()
    if (r < 0.4) return this.openSomething()
    if (r < 0.6) return this.scrollBack()
    if (r < 0.75) {
      const chats = this.visibleChats()
      if (chats.length) {
        this.count('hover')
        const { page } = this.warmChat(chats[this.rand.int(Math.min(chats.length, 30))])
        await page
      }
      return
    }
    if (r < 0.82) return this.openPeople()
    if (r < 0.9) {
      const chats = this.visibleChats()
      const chat = chats[this.rand.int(Math.max(1, Math.min(chats.length, 30)))]
      if (!chat) return
      this.count('mute or pin')
      return this.rand.chance(0.5)
        ? this.mutate('chats:setMuted', { chatId: chat._id, muted: chat.mutedUntil === null })
        : this.mutate('chats:setPinned', { chatId: chat._id, pinned: !chat.pinned })
    }
    return this.send()
  }

  /** Clicks every `everyMs` (± half) until stopped. */
  runClicks(everyMs) {
    let stopped = false
    const loop = (async () => {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, everyMs * (0.5 + this.rand.next())))
        if (stopped) break
        const started = performance.now()
        const action = this.act()
        try {
          await action
        } catch (error) {
          this.error('click', error)
        }
        ;(this.metrics.actionMs ??= []).push(performance.now() - started)
      }
    })()
    return async () => {
      stopped = true
      await loop
    }
  }

  async close() {
    for (const t of this.timers) {
      clearTimeout(t)
      clearInterval(t)
    }
    for (const key of this.subs.keys()) this.drop(key)
    await this.client.close()
  }
}

/** Starts `count` clients, each opening the app as the desktop does. */
export async function startClients({ count, convexUrl, person, crypto, sent, networks, seed = 11 }) {
  const metrics = clientMetrics()
  const bridgeKeyText = (await person.http.query(anyApi.keys.bridge, {}))?.publicKey
  const bridgeKey = bridgeKeyText ? crypto.fromBase64Url(bridgeKeyText) : null
  const clients = Array.from(
    { length: count },
    (_, i) =>
      new SimClient({ id: i, convexUrl, person, crypto, metrics, sent, rand: random(seed + i), bridgeKey, networks }),
  )
  await Promise.all(clients.map((c) => c.start()))
  return { clients, metrics }
}
