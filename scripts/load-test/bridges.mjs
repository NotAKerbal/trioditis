// Simulated bridge hosts, one per network, writing through the real ingestion path: each keeps
// a journal and pushes it as apps/bridge-host's Pusher does (internal/gateway/gateway.go: up to
// 100 events per batch, as soon as there are any, a heartbeat every 30 s, backing off after a
// failure), into the gateway's own code (apps/gateway/src/events.ts `handleEvents`), which
// calls the backend's `gateway:*` functions. The gateway's dispatcher runs too, delivering
// commands to a stand-in command endpoint that accepts them all and answers sends the way a
// bridge host does: `sendStatus`, then the echo.
//
// Everything a host sends is sealed to the person's key exactly as the bridge host seals it
// (packages/crypto, docs: security/sealing.md); the plaintext is the made-up inbox's.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { handleEvents } from '../../apps/gateway/src/events.ts'
import { convexBackend } from '../../apps/gateway/src/backend.ts'
import { Dispatcher } from '../../apps/gateway/src/dispatcher.ts'
import { makeMessage, random } from './inbox.mjs'

const BATCH = 100
const HEARTBEAT_MS = 30_000
const MAX_BACKOFF_MS = 30_000

export class BridgeHost {
  constructor({ crypto, backend, account, person, metrics }) {
    this.crypto = crypto
    this.backend = backend
    this.network = account.network
    this.hostId = account.hostId
    this.loginId = account.loginId
    this.person = person
    this.metrics = metrics
    this.journal = []
    this.seq = 0
    this.acked = 0
    this.stopped = false
    this.wake = null
    this.lastContact = 0
    /** When each event was journaled, so delivery can be timed. */
    this.journaledAt = new Map()
  }

  seal(value, kind, objectId) {
    return this.crypto.sealJson(value, [{ publicKey: this.person.publicKey }], {
      kind,
      ownerUserId: this.person.userId,
      objectId,
    })
  }

  /** Journals an event; it goes out with the next push. */
  append(event) {
    const full = { ...event, seq: ++this.seq, userId: this.person.userId, loginId: this.loginId, at: Date.now() }
    this.journal.push(full)
    this.journaledAt.set(full.seq, Date.now())
    this.wake?.()
    return full
  }

  /** Pending events not yet acknowledged. */
  get backlog() {
    return this.journal.length
  }

  async post(events) {
    const started = performance.now()
    let reply
    try {
      reply = await handleEvents(this.backend, { hostId: this.hostId, network: this.network, events })
    } catch (error) {
      reply = { status: 503, body: { error: String(error?.message ?? error).slice(0, 200) } }
    }
    this.metrics.push({
      host: this.hostId,
      events: events.length,
      ms: performance.now() - started,
      status: reply.status,
    })
    return reply
  }

  /** Pushes until stopped, as the bridge host's Pusher does. */
  async run() {
    let backoff = 1000
    while (!this.stopped) {
      let reply
      if (Date.now() - this.lastContact >= HEARTBEAT_MS) {
        reply = await this.post([])
      } else if (this.journal.length > 0) {
        reply = await this.post(this.journal.slice(0, BATCH))
      } else {
        await this.sleep(Math.min(5000, HEARTBEAT_MS - (Date.now() - this.lastContact)))
        continue
      }
      if (reply.status === 200) {
        this.lastContact = Date.now()
        backoff = 1000
        this.acknowledge(reply.body.ackedThrough)
      } else if (reply.status === 409) {
        // Our journal is kept in memory and never loses events, so the gateway can only ask
        // for what's still here: nothing to rewind beyond dropping what it has.
        this.lastContact = Date.now()
        this.acknowledge(reply.body.expectedSeq - 1)
      } else {
        this.metrics.failures = (this.metrics.failures ?? 0) + 1
        await this.sleep(backoff)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
    }
  }

  acknowledge(through) {
    if (typeof through !== 'number') return
    const now = Date.now()
    while (this.journal.length && this.journal[0].seq <= through) {
      const event = this.journal.shift()
      const at = this.journaledAt.get(event.seq)
      this.journaledAt.delete(event.seq)
      if (at !== undefined) this.metrics.delivered.push({ type: event.type, ms: now - at })
    }
    this.acked = Math.max(this.acked, through)
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, Math.max(0, ms))
      function done() {
        clearTimeout(timer)
        resolve()
      }
      this.wake = () => {
        this.wake = null
        done()
      }
    })
  }

  /** Resolves once everything journaled so far is acknowledged. */
  async drained(timeoutMs = 30 * 60_000) {
    const until = Date.now() + timeoutMs
    while (this.journal.length > 0) {
      if (Date.now() > until) throw new Error(`${this.hostId} still has ${this.journal.length} events to push.`)
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  stop() {
    this.stopped = true
    this.wake?.()
  }

  // Event builders, in the shapes bridge-protocol.md gives.

  loginState(state = 'CONNECTED') {
    return this.append({
      type: 'loginState',
      state,
      sealed: this.seal({ name: `Load test on ${this.network}` }, 'account', this.loginId),
    })
  }

  contact(contact) {
    return this.append({
      type: 'contact',
      ghostId: contact.ghostId,
      sealed: this.seal({ name: contact.name, handle: contact.handle }, 'contact', contact.ghostId),
    })
  }

  chat(chat) {
    const meta = chat.kind === 'dm' ? { name: chat.name, dmGhostId: chat.members[0] } : { name: chat.name }
    return this.append({
      type: 'chat',
      portalId: chat.portalId,
      kind: chat.kind,
      sealed: this.seal(meta, 'chat', chat.portalId),
      ...(chat.isRequest ? { isRequest: true } : {}),
    })
  }

  message(chat, message, extra = {}) {
    return this.append({
      type: 'message',
      portalId: chat.portalId,
      eventId: message.eventId,
      networkTs: message.networkTs,
      sender: message.sender,
      sealed: this.seal(message.plaintext, 'message', message.eventId),
      historical: message.historical,
      ...extra,
    })
  }

  reaction(chat, message, reaction) {
    return this.append({
      type: 'reaction',
      portalId: chat.portalId,
      eventId: reaction.eventId,
      targetEventId: message.eventId,
      sender: reaction.sender,
      key: reaction.key,
      networkTs: message.networkTs + 1000,
    })
  }

  typing(chat, ghostId) {
    return this.append({ type: 'typing', portalId: chat.portalId, sender: { ghostId }, typing: true, timeoutMs: 5000 })
  }

  receipt(chat, ghostId, upToEventId, networkTs) {
    return this.append({ type: 'receipt', portalId: chat.portalId, sender: { ghostId }, upToEventId, networkTs })
  }

  edit(chat, target, eventId, networkTs) {
    return this.append({
      type: 'edit',
      portalId: chat.portalId,
      eventId,
      targetEventId: target.eventId,
      networkTs,
      sender: target.sender,
      sealed: this.seal({ type: 'text', body: `${target.plaintext.body ?? ''} (edited)` }, 'message', eventId),
    })
  }

  backfillDone(chat, more) {
    return this.append({ type: 'backfillDone', portalId: chat.portalId, direction: 'backward', more })
  }
}

/**
 * The gateway (its backend client and dispatcher) and one bridge host per account, with a
 * stand-in command endpoint. Returns `{ hosts, byNetwork, metrics, start(), stop() }`.
 */
export async function startBridges({ crypto, stack, inbox, person }) {
  const backend = convexBackend(stack.convexUrl, stack.gatewaySecret)
  const metrics = Object.assign([], { delivered: [], commands: {}, failures: 0 })
  const hosts = inbox.accounts.map((account) => new BridgeHost({ crypto, backend, account, person, metrics }))
  const byHost = new Map(hosts.map((h) => [h.hostId, h]))
  const byNetwork = new Map(hosts.map((h) => [h.network, h]))
  const token = randomBytes(24).toString('base64url')

  // Takes every command, as a bridge host queues it, and answers a send as the network would.
  const server = createServer((request, response) => {
    const host = byHost.get(decodeURIComponent((request.url ?? '').split('/')[1] ?? ''))
    const chunks = []
    request.on('data', (c) => chunks.push(c))
    request.on('end', () => {
      if (request.headers.authorization !== `Bearer ${token}` || !host) {
        response.writeHead(401).end()
        return
      }
      let command
      try {
        command = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_command"}')
        return
      }
      metrics.commands[command.type] = (metrics.commands[command.type] ?? 0) + 1
      response.writeHead(202).end()
      if (command.type === 'send') {
        const eventId = `$load_echo_${command.clientMessageId}`
        setTimeout(() => {
          host.append({ type: 'sendStatus', clientMessageId: command.clientMessageId, status: 'sent', eventId })
          host.append({
            type: 'message',
            portalId: command.portalId,
            eventId,
            networkTs: Date.now(),
            sender: { self: true },
            sealed: host.seal({ type: 'text', body: 'Sent from the load test' }, 'message', eventId),
            historical: false,
            clientMessageId: command.clientMessageId,
          })
        }, 300)
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const dispatcher = new Dispatcher(backend, {
    internalToken: token,
    bridgeHosts: new Map(hosts.map((h) => [h.hostId, `${base}/${encodeURIComponent(h.hostId)}`])),
    log: () => {},
  })

  const runs = []
  return {
    hosts,
    byNetwork,
    metrics,
    start() {
      dispatcher.start()
      for (const host of hosts) runs.push(host.run())
    },
    async drained() {
      await Promise.all(hosts.map((h) => h.drained()))
    },
    async stop() {
      dispatcher.stop()
      for (const host of hosts) host.stop()
      await Promise.allSettled(runs)
      server.close()
      await backend.close()
    },
  }
}

/** Journals the whole inbox, as a first sync and backfill would: the account, contacts, chats, then history. */
export function journalInbox(bridges, inbox) {
  for (const host of bridges.hosts) host.loginState()
  for (const contact of inbox.contacts) bridges.byNetwork.get(contact.network).contact(contact)
  for (const chat of inbox.chats) bridges.byNetwork.get(chat.network).chat(chat)
  for (const chat of inbox.chats) {
    const host = bridges.byNetwork.get(chat.network)
    for (const message of chat.messages) {
      host.message(chat, message)
      for (const reaction of message.reactions) host.reaction(chat, message, reaction)
    }
    host.backfillDone(chat, true)
  }
}

/**
 * Write load for the measured run: one network backfilling history at `backfillPerMinute`
 * messages, and live traffic on every network at `livePerMinute` messages (with typing before
 * them, and reactions, receipts and edits in proportion). Returns `stop()`, and `sent`, the
 * live messages by event ID with when they were journaled, for the clients to time.
 */
export function driveTraffic(bridges, inbox, { backfillNetwork, backfillPerMinute, livePerMinute, seed = 7 }) {
  const rand = random(seed)
  const timers = []
  const sent = new Map()
  const counters = { backfill: 0, live: 0, typing: 0, reactions: 0, receipts: 0, edits: 0 }
  const shape = { ...inbox.shape, attachmentShare: inbox.shape.attachmentShare, reactionShare: 0 }
  // Live traffic goes mostly to chats already busy, as it does: weighted by their size.
  const weighted = inbox.chats.filter((c) => !c.archived)
  const totals = []
  let sum = 0
  for (const chat of weighted) totals.push((sum += Math.sqrt(chat.messages.length) + 1))
  const busyChat = () => {
    const x = rand.next() * sum
    let lo = 0
    let hi = totals.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (totals[mid] < x) lo = mid + 1
      else hi = mid
    }
    return weighted[lo]
  }

  // Backfill goes back through the backfilling network's chats, a page of older history at a time.
  const backfillChats = inbox.chats.filter((c) => c.network === backfillNetwork)
  let backfillIndex = 0
  const backfillOne = () => {
    if (backfillChats.length === 0) return
    const chat = backfillChats[backfillIndex++ % backfillChats.length]
    const host = bridges.byNetwork.get(chat.network)
    const oldest = chat.messages[0]?.networkTs ?? Date.now()
    chat.backfilled = (chat.backfilled ?? 0) + 1
    const message = makeMessage(
      rand,
      shape,
      chat,
      -chat.backfilled,
      oldest - chat.backfilled * 60_000,
      rand.chance(0.35),
      true,
    )
    host.message(chat, message)
    counters.backfill++
  }

  const liveOne = () => {
    const chat = busyChat()
    const host = bridges.byNetwork.get(chat.network)
    const self = rand.chance(0.15)
    const k = chat.messages.length + (chat.liveCount = (chat.liveCount ?? 0) + 1)
    const message = makeMessage(rand, shape, chat, k, Date.now(), self, false)
    if (!self && 'ghostId' in message.sender) {
      host.typing(chat, message.sender.ghostId)
      counters.typing++
    }
    const event = host.message(chat, message, rand.chance(0.03) ? { mentionsMe: true } : {})
    sent.set(message.eventId, { at: Date.now(), chatPortal: chat.portalId, seq: event.seq })
    counters.live++
    chat.messages.push(message)
    if (rand.chance(0.2)) {
      const target = chat.messages[Math.max(0, chat.messages.length - 1 - rand.int(5))]
      host.reaction(chat, target, {
        eventId: `${message.eventId}_lr`,
        key: '👍',
        sender: chat.members.length ? { ghostId: rand.pick(chat.members) } : { self: true },
      })
      counters.reactions++
    }
    if (rand.chance(0.15) && chat.members.length) {
      host.receipt(chat, rand.pick(chat.members), message.eventId, Date.now())
      counters.receipts++
    }
    if (rand.chance(0.03)) {
      host.edit(chat, message, `${message.eventId}_e`, Date.now())
      counters.edits++
    }
  }

  // Steady rates, with a tick every 100 ms carrying however many are due.
  const every = (perMinute, fn) => {
    if (!(perMinute > 0)) return
    let due = 0
    let last = Date.now()
    timers.push(
      setInterval(() => {
        const now = Date.now()
        due += ((now - last) / 60_000) * perMinute
        last = now
        while (due >= 1) {
          fn()
          due--
        }
      }, 100),
    )
  }
  every(backfillPerMinute, backfillOne)
  every(livePerMinute, liveOne)
  return {
    sent,
    counters,
    stop() {
      for (const t of timers) clearInterval(t)
    },
  }
}
