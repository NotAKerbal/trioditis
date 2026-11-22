// Simulated desktop clients: each a Convex websocket client signed in as the person, holding
// the live queries the desktop app holds (apps/desktop/src/data, features/shell/sidebar.tsx,
// features/chat/warm-chats.tsx) with the same arguments, and clicking around as a person does.
//
// - At start, Focused layout: the inbox by recency and the snoozed, requests, archived and
//   blocked lists (50 a page), the badge counts, arrivals, labels, preferences, scheduled
//   messages, the server's and networks' state, People (every page), and a media token per
//   network for the sidebar's pictures. Unread loads inbox pages by the desktop's own rule
//   (unread-fill.ts), again whenever the counts change.
// - Fetch-ahead: up to six warm chats, each its first page of messages, their reactions, a
//   group's senders' profiles, its scheduled and cancelled messages (data/chat-content.ts); the
//   first three unread chats are warmed 1.5 s after the list settles.
// - Clicks: open a chat (chats.get, typing, the warm queries, markRead when unread), scroll
//   back through it, open People (people, contacts and identifiers, every page), hover a chat
//   (warm it), mute or pin one, and now and then send a message. A chat let go stays
//   subscribed for five minutes, as the desktop's query cache keeps it (main.tsx).
import { ConvexClient } from 'convex/browser'
import { anyApi } from 'convex/server'
import { reactionGroups, reactionRequests } from '../../apps/desktop/src/data/reaction-requests.ts'
import { unreadIncomplete } from '../../apps/desktop/src/features/shell/unread-fill.ts'
import { random } from './inbox.mjs'

const PAGE = 50
const WARM = 6
const WARM_UNREAD = 3
/** How long the desktop's query cache keeps what it was let go of (main.tsx). */
const KEEP_MS = 5 * 60_000
/** How long a replaced reactions request stays watched (data/messages.ts, REACTIONS_GC_MS). */
const REACTIONS_GC_MS = 10_000
/** A pane shows its messages once what goes with them is in, or this long after (chat-content.ts). */
const SETTLE_MS = 400
/** The most inbox pages the Unread fill loads; the nightly inbox has 60. */
const MAX_INBOX_PAGES = 400
/** A query that hasn't answered by then counts as failed (the app would show it loading). */
const ANSWER_MS = 60_000
/** A click that hasn't finished by then counts as failed, so a stuck one can't hold up the run. */
const ACTION_MS = 120_000

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
    failedOpens: 0,
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

const sleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })

const unreadRow = (c) => (c.unreadCount > 0 || c.markedUnread) && c.mutedUntil === null

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
    /** Chats whose messages this client holds (warm or open), by ID. */
    this.chats = new Map()
    this.warm = []
    this.open = null
    this.released = new Map()
    this.seenEvents = new Set()
    this.timers = []
    this.inboxPages = 0
    this.filling = false
  }

  error(where, error) {
    const kind = `${where}: ${shortError(error)}`
    this.metrics.errors++
    this.metrics.errorKinds[kind] = (this.metrics.errorKinds[kind] ?? 0) + 1
  }

  /**
   * Subscribes under `key` (once; a second ask shares it, as the app's cache does) and
   * resolves with the first answer, or null if it failed or didn't come within ANSWER_MS.
   */
  watch(key, name, args, onValue = () => {}) {
    const held = this.subs.get(key)
    if (held) {
      this.released.delete(key)
      if (!held.listeners.has(onValue)) {
        held.listeners.add(onValue)
        if (held.value !== undefined) onValue(held.value)
      }
      return held.first
    }
    const started = performance.now()
    let resolveFirst
    const sub = {
      name,
      value: undefined,
      readyAt: null,
      listeners: new Set([onValue]),
      first: new Promise((r) => (resolveFirst = r)),
    }
    this.subs.set(key, sub)
    this.metrics.subscriptions++
    this.metrics.peakSubscriptions = Math.max(this.metrics.peakSubscriptions, this.subs.size)
    let answered = false
    const deadline = setTimeout(() => {
      if (answered) return
      answered = true
      this.error(name, `no answer within ${ANSWER_MS / 1000} s`)
      resolveFirst(null)
    }, ANSWER_MS)
    deadline.unref?.()
    sub.unsubscribe = this.client.onUpdate(
      ref(name),
      args,
      (value) => {
        sub.value = value
        sub.readyAt ??= Date.now()
        if (!answered) {
          answered = true
          clearTimeout(deadline)
          ;(this.metrics.firstResult[name] ??= []).push(performance.now() - started)
          resolveFirst(value)
        }
        for (const listener of sub.listeners) listener(value)
      },
      (error) => {
        this.error(name, error)
        if (!answered) {
          answered = true
          clearTimeout(deadline)
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

  /** Lets go of `key` after `ms` (the cache's five minutes), unless it's asked for again first. */
  release(key, ms = this.keepMs) {
    if (!this.subs.has(key)) return
    this.released.set(key, Date.now() + ms)
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
    for (const view of ['snoozed', 'requests', 'archived', 'blocked']) {
      p.push(this.pages(`list:${view}`, 'chats:list', { view }, PAGE, { maxPages: 1 }))
    }
    p.push(this.pages('people', 'people:list', {}, 100, { more: () => true }))
    for (const network of this.networks) p.push(this.mutate('media:access', { network }))
    // Unread fills itself whenever the counts or the pages change, as the sidebar's effect does.
    p.push(this.watch('counts', 'chats:counts', {}, () => void this.fillInbox()))
    p.push(this.fillInbox())
    await Promise.all(p)
    await this.fillInbox()
    const warmTimer = setTimeout(() => {
      for (const chat of this.inbox().filter(unreadRow).slice(0, WARM_UNREAD).reverse()) this.warmChat(chat)
    }, 1500)
    this.timers.push(
      warmTimer,
      setInterval(() => this.sweep(), 5000),
    )
  }

  /** The inbox pages loaded so far, newest first, as they are now. */
  inbox() {
    const rows = []
    for (let i = 0; i < Math.max(1, this.inboxPages); i++)
      rows.push(...(this.subs.get(`list:inbox#${i}`)?.value?.page ?? []))
    return rows
  }

  /** Loads inbox pages while Unread may still be missing chats (features/shell/unread-fill.ts). */
  async fillInbox() {
    if (this.filling) return
    this.filling = true
    try {
      for (;;) {
        if (this.inboxPages === 0) {
          const first = await this.watch('list:inbox#0', 'chats:list', {
            view: 'inbox',
            order: 'recent',
            paginationOpts: { numItems: PAGE, cursor: null, id: 0 },
          })
          if (!first) return
          this.inboxPages = 1
        }
        const last = this.subs.get(`list:inbox#${this.inboxPages - 1}`)?.value
        if (!last) return
        const count = this.subs.get('counts')?.value?.inbox
        const incomplete = unreadIncomplete({
          more: !last.isDone,
          loadedUnread: this.inbox().filter(unreadRow).length,
          count,
        })
        if (!incomplete || this.inboxPages >= MAX_INBOX_PAGES) return
        const n = this.inboxPages
        const next = await this.watch(`list:inbox#${n}`, 'chats:list', {
          view: 'inbox',
          order: 'recent',
          paginationOpts: { numItems: PAGE, cursor: last.continueCursor, id: n },
        })
        if (!next) return
        this.inboxPages = n + 1
      }
    } finally {
      this.filling = false
    }
  }

  /**
   * What data/chat-content.ts's useWarmChat asks for a chat, kept in step with its loaded pages
   * as they change: reactions in the desktop's own groups and requests, and a group's senders.
   */
  warmChat(chat) {
    let state = this.chats.get(chat._id)
    if (!state) {
      state = { chat, pages: [], reactionKeys: new Set(), contactKeys: new Set(), extras: Promise.resolve() }
      // One listener per chat, so watching a request again never adds another.
      state.onChange = () => this.chats.get(chat._id) === state && this.reconcile(state)
      this.chats.set(chat._id, state)
      state.fixed = [`scheduled:${chat._id}`, `cancelled:${chat._id}`]
      void this.watch(state.fixed[0], 'scheduled:list', { chatId: chat._id })
      void this.watch(state.fixed[1], 'scheduled:cancelled', { chatId: chat._id })
      state.first = this.loadPage(state, null)
    }
    // At most six warm chats; the oldest is let go to the cache.
    this.warm = [state, ...this.warm.filter((w) => w !== state)]
    for (const gone of this.warm.splice(WARM)) if (gone !== this.open?.state) this.letGo(gone)
    return state
  }

  /** Subscribes to the chat's next page of messages; resolves with its first answer. */
  loadPage(state, cursor) {
    const n = state.pages.length
    const key = `messages:${state.chat._id}#${n}`
    state.pages.push(key)
    return this.watch(
      key,
      'messages:list',
      { chatId: state.chat._id, paginationOpts: { numItems: PAGE, cursor, id: n } },
      (value) => {
        if (this.chats.get(state.chat._id) !== state) return
        if (n === 0) this.noticeMessages(this.subs.get(key)?.readyAt ?? Date.now(), value.page)
        this.reconcile(state)
      },
    )
  }

  /** Lets go of everything a chat held, to the cache. */
  letGo(state) {
    if (this.chats.get(state.chat._id) === state) this.chats.delete(state.chat._id)
    for (const key of [...state.pages, ...state.fixed, ...state.reactionKeys, ...state.contactKeys]) this.release(key)
  }

  /** The reactions and senders' requests the chat's loaded messages call for now. */
  reconcile(state) {
    const { chat } = state
    const messages = state.pages
      .flatMap((key) => this.subs.get(key)?.value?.page ?? [])
      .filter((m) => !m.redactedAt && !m.eventId.startsWith('pending:'))
      .map((m) => ({ id: m._id, at: m.networkTs, sender: m.sender }))
      .reverse()
    const reactionKey = (asked) => `reactions:${chat._id}:${asked.join()}`
    const wanted = new Set()
    const waits = []
    for (const group of reactionGroups(messages)) {
      const requests = reactionRequests(group, (asked) => this.subs.get(reactionKey(asked))?.value)
      for (const asked of requests) {
        const key = reactionKey(asked)
        wanted.add(key)
        waits.push(this.watch(key, 'messages:reactions', { chatId: chat._id, messageIds: asked }, state.onChange))
      }
    }
    for (const key of state.reactionKeys) if (!wanted.has(key)) this.release(key, REACTIONS_GC_MS)
    state.reactionKeys = wanted
    const contacts = new Set()
    if (chat.kind === 'group') {
      const ghosts = [...new Set(messages.flatMap((m) => ('ghostId' in m.sender ? [m.sender.ghostId] : [])))].sort(
        (a, b) => (a < b ? -1 : a > b ? 1 : 0),
      )
      for (let i = 0; i < ghosts.length; i += 100) {
        const ids = ghosts.slice(i, i + 100)
        const key = `contacts:${chat.network}:${ids.join()}`
        contacts.add(key)
        waits.push(this.watch(key, 'contacts:get', { network: chat.network, ghostIds: ids }))
      }
    }
    for (const key of state.contactKeys) if (!contacts.has(key)) this.release(key)
    state.contactKeys = contacts
    state.extras = Promise.all([...waits, ...state.fixed.map((k) => this.subs.get(k)?.first)])
  }

  /**
   * Times a live message from when its bridge host journaled it to when this client has it,
   * only for a chat whose messages were already live then: a chat opened later just loads it.
   */
  noticeMessages(liveSince, rows) {
    const now = Date.now()
    for (const m of rows) {
      if (this.seenEvents.has(m.eventId)) continue
      this.seenEvents.add(m.eventId)
      const sent = this.sent.get(m.eventId)
      if (sent && sent.at >= liveSince) this.metrics.visible.push(now - sent.at)
    }
  }

  count(action) {
    this.metrics.actions[action] = (this.metrics.actions[action] ?? 0) + 1
  }

  visibleChats() {
    return this.inbox()
  }

  async openChat(chat) {
    this.count('open chat')
    const started = performance.now()
    const previous = this.open
    const keys = [`chat:${chat._id}`, `typing:${chat._id}`]
    const got = this.watch(keys[0], 'chats:get', { chatId: chat._id })
    void this.watch(keys[1], 'messages:typing', { chatId: chat._id })
    const state = this.warmChat(chat)
    this.open = { chat, state, keys }
    if (previous && previous.state !== state) {
      for (const k of previous.keys) this.release(k)
      if (!this.warm.includes(previous.state)) this.letGo(previous.state)
    }
    const [row, page] = await Promise.all([got, state.first])
    if (!row || !page) {
      this.metrics.failedOpens++
      return
    }
    // Shown once its reactions, senders and scheduled messages are in, or SETTLE_MS after.
    await Promise.race([state.extras, sleep(SETTLE_MS)])
    this.metrics.opens.push(performance.now() - started)
    if (row.unreadCount > 0 || row.markedUnread) await this.mutate('chats:markRead', { chatId: chat._id })
  }

  async scrollBack() {
    const state = this.open?.state
    const last = state && this.subs.get(state.pages.at(-1))?.value
    if (!last || last.isDone) return this.openSomething()
    this.count('scroll back')
    const value = await this.loadPage(state, last.continueCursor)
    if (value) await state.extras
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
        await this.warmChat(chats[this.rand.int(Math.min(chats.length, 30))]).first
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

  /** Clicks every `everyMs` (± half) until stopped; a click that takes over ACTION_MS is a failure. */
  runClicks(everyMs) {
    let stopped = false
    const loop = (async () => {
      while (!stopped) {
        await sleep(everyMs * (0.5 + this.rand.next()))
        if (stopped) break
        const started = performance.now()
        let timedOut = false
        try {
          await Promise.race([
            this.act(),
            sleep(ACTION_MS).then(() => {
              timedOut = true
            }),
          ])
        } catch (error) {
          this.error('click', error)
        }
        if (timedOut) this.error('click', `not finished within ${ACTION_MS / 1000} s`)
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
