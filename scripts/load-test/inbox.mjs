// A made-up inbox for the load test, the same every time for the same seed: chats on several
// networks, contacts, messages with attachments' metadata, reactions, an address book and
// labels. It is demo-style text, never anyone's real messages, and it is sealed before it
// leaves the test (bridges.mjs, clients.mjs) just as real content is.

const FIRST = [
  'Alice',
  'Bob',
  'Carol',
  'Dan',
  'Eve',
  'Frank',
  'Grace',
  'Hiro',
  'Ines',
  'Jon',
  'Kemi',
  'Liam',
  'Mira',
  'Noor',
  'Omar',
  'Pia',
  'Quinn',
  'Rosa',
  'Sam',
  'Tara',
  'Uma',
  'Vik',
  'Wren',
  'Yara',
  'Zed',
]
const LAST = [
  'Moreno',
  'Chen',
  'Singh',
  'Okafor',
  'Laurent',
  'Ito',
  'Novak',
  'Haddad',
  'Silva',
  'Berg',
  'Adeyemi',
  'Kowalski',
  'Reyes',
  'Tanaka',
  'Murphy',
  'Costa',
  'Nair',
  'Fischer',
  'Ahmed',
  'Larsen',
]
const GROUPS = [
  'Family',
  'Book club',
  'Climbing crew',
  'Project Falcon',
  'Flatmates',
  'Weekend plans',
  'Choir',
  'Five-a-side',
  'Neighbours',
  'Old school friends',
  'Design review',
  'Road trip',
]
const LINES = [
  'Are we still on for lunch?',
  'Running five minutes late, sorry!',
  'Sounds good to me',
  'Can you send me the photos from Saturday?',
  'Haha yes exactly',
  'I’ll pick up bread on the way',
  'Did you see the match last night?',
  'Meeting moved to 3pm',
  'Thanks so much 🙏',
  'Let me check and get back to you',
  'Who’s bringing the speaker?',
  'On my way',
  'That’s hilarious',
  'Happy birthday!! 🎉',
  'Can we push it to next week?',
  'Here’s the link I mentioned: https://example.com/notes',
  'Love it',
  'Good morning ☀️',
  'Same time tomorrow?',
  'I left my keys at yours I think',
]
const EMOJI = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🎉']

/** A small, fast, seeded PRNG (mulberry32): the same seed always makes the same inbox. */
export function random(seed) {
  let a = seed >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (list) => list[Math.floor(next() * list.length)],
    chance: (p) => next() < p,
  }
}

/** Opaque-looking IDs of a fixed shape, from the PRNG (base64url, like the real ones). */
function b64(rand, bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let out = ''
  for (let i = 0; i < Math.ceil((bytes * 4) / 3); i++) out += alphabet[rand.int(64)]
  return out
}

/**
 * Splits `total` across `n` buckets with a long tail, as real inboxes have: a few chats with
 * thousands of messages, most with a handful. Every bucket gets at least one.
 */
export function longTail(total, n, rand, skew = 1.1) {
  if (n <= 0) return []
  const weights = Array.from({ length: n }, (_, i) => 1 / Math.pow(i + 1, skew))
  // Shuffle so the busiest chats aren't all on the first network.
  for (let i = n - 1; i > 0; i--) {
    const j = rand.int(i + 1)
    ;[weights[i], weights[j]] = [weights[j], weights[i]]
  }
  const sum = weights.reduce((a, b) => a + b, 0)
  const rest = Math.max(0, total - n)
  const counts = weights.map((w) => 1 + Math.floor((w / sum) * rest))
  let left = total - counts.reduce((a, b) => a + b, 0)
  for (let i = 0; left > 0; i = (i + 1) % n, left--) counts[i]++
  return counts
}

export const DEFAULT_SHAPE = {
  seed: 1,
  chats: 3000,
  messages: 40_000,
  /** Each network's share of the chats. */
  networks: { signal: 0.35, whatsapp: 0.25, groupme: 0.15, bluesky: 0.1, telegram: 0.15 },
  groupShare: 0.25,
  /** Chats whose newest messages came live (not imported), so they order the inbox and count unread. */
  liveShare: 0.3,
  /** Of the live chats, those with unread messages. */
  unreadShare: 0.4,
  pinned: 5,
  archivedShare: 0.08,
  snoozedShare: 0.02,
  requestsShare: 0.03,
  mutedShare: 0.06,
  /** Messages that carry an attachment's metadata (the file itself is never fetched). */
  attachmentShare: 0.06,
  reactionShare: 0.12,
  /** Address-book cards, each linking one to three network contacts. */
  people: 800,
  labels: 8,
  labelledShare: 0.15,
  /** How far back the inbox's history reaches. */
  days: 365,
}

/**
 * The inbox: `{ accounts, contacts, chats, people, labels }`. Each chat holds its messages,
 * oldest first, and each message the reactions on it. `now` anchors the timeline.
 */
export function makeInbox(shapeIn = {}, now = Date.now()) {
  const shape = { ...DEFAULT_SHAPE, ...shapeIn }
  const rand = random(shape.seed)
  const networks = Object.entries(shape.networks).filter(([, share]) => share > 0)
  const shareSum = networks.reduce((a, [, s]) => a + s, 0)
  const accounts = networks.map(([network]) => ({ network, hostId: `${network}-load-1`, loginId: `l_load_${network}` }))

  const contacts = []
  const chats = []
  const perNetwork = networks.map(([network, share], i) => {
    const n =
      i === networks.length - 1
        ? shape.chats - networks.slice(0, -1).reduce((a, [, s]) => a + Math.round((s / shareSum) * shape.chats), 0)
        : Math.round((share / shareSum) * shape.chats)
    return { network, n: Math.max(0, n) }
  })
  for (const { network, n } of perNetwork) {
    const ghosts = []
    const ghostCount = Math.max(1, Math.ceil(n * 1.3))
    for (let g = 0; g < ghostCount; g++) {
      const name = `${rand.pick(FIRST)} ${rand.pick(LAST)}`
      const ghost = {
        network,
        ghostId: `g_${network}_${g}_${b64(rand, 6)}`,
        name,
        handle:
          network === 'bluesky' || network === 'telegram'
            ? `@${name.toLowerCase().replace(' ', '.')}`
            : `+1 555 ${String(1000 + (g % 9000)).padStart(4, '0')}`,
      }
      ghosts.push(ghost)
      contacts.push(ghost)
    }
    for (let c = 0; c < n; c++) {
      const group = rand.chance(shape.groupShare)
      const members = group
        ? Array.from({ length: 3 + rand.int(10) }, () => rand.pick(ghosts).ghostId)
        : [ghosts[c % ghosts.length].ghostId]
      chats.push({
        network,
        portalId: `p_${network}_${c}_${b64(rand, 6)}`,
        kind: group ? 'group' : 'dm',
        name: group ? `${rand.pick(GROUPS)} ${c}` : ghosts[c % ghosts.length].name,
        members: [...new Set(members)],
        messages: [],
      })
    }
  }

  // Messages: a long tail of chat sizes, spread over `days`, oldest first in each chat.
  const counts = longTail(shape.messages, chats.length, rand)
  const span = shape.days * 24 * 3600_000
  chats.forEach((chat, i) => {
    const count = counts[i]
    const live = rand.chance(shape.liveShare)
    // A live chat's newest messages are recent; an imported one's stop some time ago.
    const newest = now - (live ? rand.int(3 * 24 * 3600_000) : rand.int(span))
    const step = Math.max(1000, Math.floor((span / Math.max(count, 1)) * rand.next()))
    const liveTail = live ? 1 + rand.int(5) : 0
    const unread = live && rand.chance(shape.unreadShare)
    for (let k = 0; k < count; k++) {
      const networkTs = newest - (count - 1 - k) * step - rand.int(Math.max(step / 2, 1))
      const tail = k >= count - liveTail
      // In an unread chat the tail is from someone else; otherwise anyone.
      const self = tail && unread ? false : rand.chance(0.35)
      chat.messages.push(makeMessage(rand, shape, chat, k, networkTs, self, !tail))
    }
    chat.live = live
    chat.unread = unread
    chat.isRequest = rand.chance(shape.requestsShare)
  })

  // The client's own state on chats: pins, archive, snoozes, mutes, labels.
  const order = chats.map((_, i) => i)
  const take = (share) => order.filter(() => rand.chance(share)).map((i) => chats[i])
  for (const chat of chats.filter((c) => c.live).slice(0, shape.pinned)) chat.pinned = true
  for (const chat of take(shape.archivedShare)) chat.archived = true
  for (const chat of take(shape.snoozedShare)) if (!chat.archived) chat.snoozed = true
  for (const chat of take(shape.mutedShare)) chat.muted = true
  const labels = Array.from({ length: shape.labels }, (_, i) => ({
    labelKey: `label_load_${String(i).padStart(4, '0')}_${b64(rand, 6)}`,
    name: ['Work', 'Family', 'Friends', 'Travel', 'Sport', 'Music', 'Home', 'Later'][i % 8],
    color: ['red', 'blue', 'green', 'amber', 'purple', 'teal', 'pink', 'grey'][i % 8],
  }))
  if (labels.length) for (const chat of take(shape.labelledShare)) chat.labels = [rand.pick(labels).labelKey]

  // The address book: cards linking contacts, most on one network, some across several.
  const people = []
  const unlinked = [...contacts]
  for (let p = 0; p < Math.min(shape.people, contacts.length); p++) {
    const first = unlinked.splice(rand.int(unlinked.length), 1)[0]
    if (!first) break
    const links = [{ network: first.network, ghostId: first.ghostId }]
    for (let extra = rand.int(3); extra > 0 && unlinked.length; extra--) {
      const other = unlinked.find((c) => c.network !== first.network && c.name === first.name) ?? null
      if (!other) break
      unlinked.splice(unlinked.indexOf(other), 1)
      links.push({ network: other.network, ghostId: other.ghostId })
    }
    const [given, family] = first.name.split(' ')
    people.push({
      personKey: `person_load_${String(p).padStart(6, '0')}_${b64(rand, 6)}`,
      card: { name: first.name, given, family, phones: [{ value: first.handle, label: 'mobile' }], links },
    })
  }
  return { shape, accounts, contacts, chats, people, labels }
}

/** One message: its plaintext (sealed later), who sent it, when, and the reactions on it. */
export function makeMessage(rand, shape, chat, k, networkTs, self, historical) {
  const sender = self ? { self: true } : { ghostId: rand.pick(chat.members) }
  const eventId = `$load_${chat.portalId}_${k}_${b64(rand, 4)}`
  let plaintext
  if (rand.chance(shape.attachmentShare)) {
    const image = rand.chance(0.8)
    plaintext = {
      type: image ? 'image' : 'file',
      body: image ? 'photo.jpg' : 'notes.pdf',
      attachments: [
        {
          mediaId: `m_load_${b64(rand, 12)}`,
          mime: image ? 'image/jpeg' : 'application/pdf',
          size: 40_000 + rand.int(2_000_000),
          name: image ? 'photo.jpg' : 'notes.pdf',
          key: b64(rand, 32),
          nonce: b64(rand, 24),
          ...(image ? { width: 1200, height: 900 } : {}),
        },
      ],
    }
  } else {
    plaintext = { type: 'text', body: rand.pick(LINES) }
  }
  const reactions = rand.chance(shape.reactionShare)
    ? Array.from({ length: 1 + rand.int(3) }, (_, r) => ({
        eventId: `${eventId}_r${r}`,
        key: rand.pick(EMOJI),
        sender: rand.chance(0.3) || chat.members.length === 0 ? { self: true } : { ghostId: rand.pick(chat.members) },
      }))
    : []
  return { eventId, networkTs, sender, historical, plaintext, reactions }
}

/** What the inbox adds up to, for the report. */
export function inboxSummary(inbox) {
  const messages = inbox.chats.reduce((a, c) => a + c.messages.length, 0)
  const reactions = inbox.chats.reduce((a, c) => a + c.messages.reduce((b, m) => b + m.reactions.length, 0), 0)
  const attachments = inbox.chats.reduce((a, c) => a + c.messages.filter((m) => m.plaintext.attachments).length, 0)
  const byNetwork = {}
  for (const chat of inbox.chats) byNetwork[chat.network] = (byNetwork[chat.network] ?? 0) + 1
  return {
    chats: inbox.chats.length,
    chatsByNetwork: byNetwork,
    groups: inbox.chats.filter((c) => c.kind === 'group').length,
    messages,
    biggestChat: Math.max(0, ...inbox.chats.map((c) => c.messages.length)),
    reactions,
    attachments,
    contacts: inbox.contacts.length,
    people: inbox.people.length,
    labels: inbox.labels.length,
    unreadChats: inbox.chats.filter((c) => c.unread).length,
    pinned: inbox.chats.filter((c) => c.pinned).length,
    archived: inbox.chats.filter((c) => c.archived).length,
    snoozed: inbox.chats.filter((c) => c.snoozed).length,
    muted: inbox.chats.filter((c) => c.muted).length,
    requests: inbox.chats.filter((c) => c.isRequest).length,
  }
}
