---
title: Server Load
description: What makes a Convex function expensive on a self-hosted server, the rules the backend follows to stay cheap, and the sync log that could replace most live queries.
---

A self-hosted server is often a small machine, two vCPUs or so, and Convex stops any query or mutation after one second. When the backend runs out of CPU, every function waits, even trivial ones, and the app sees `Server Error` with `Function execution timed out (maximum duration: 1s)` on whatever it asked for. Keeping each call cheap, and running as few of them as possible, is what keeps a server answering.

## Where the time went

On 2026-11-21 a live server (2 vCPUs, the Signal, GroupMe and Bluesky bridges busy) logged about 110 timeouts a minute in bursts, across `messages:list`, `people:list`, `contacts:list`, `messages:reactions`, `media:access`, `keys:bridge` and others. `convex-backend` was using all the CPU while I/O and memory were idle. Nine minutes of its function logs (`npx convex logs --jsonl`) ranked these by total time: `people:list` (259 runs), `messages:reactions` (138), `contacts:list` (113), `chats:list` (65) and `contacts:get` (47). Functions that only sign a token took 600 to 1,000 ms.

A copy of that server's data shape (291 cards, 1,611 contacts, 179 chats with 120 messages each) on a local backend limited to two CPUs (`docker run --cpus=2`) showed why:

| What one call does                                                | Cost   |
| ----------------------------------------------------------------- | ------ |
| A query in a module that imports little, reading one row          | 20 ms  |
| The same, importing `auth.ts` (Better Auth and its plugins)       | 95 ms  |
| The session check through `components.betterAuth.adapter.findOne` | 230 ms |
| The same check through `components.betterAuth.sessions.live`      | 20 ms  |

Convex evaluates a function's modules for each call, as the second row shows. `adapter.ts` builds Better Auth's options to answer any call, so every query that checked who was signed in paid about 200 ms of CPU before it read anything, and on two vCPUs that capped the server at about ten queries a second. On top of that:

- `people.put` wrote the person's `members` row, which every query reads to check membership, so each address book save ran every one of the person's subscriptions again.
- `messages.reactions` read the chat row, which changes with every message, so each new message ran every open chat's reactions again although none had changed.
- Each chat opened loaded the whole address book again (`usePeople` asked afresh in the chat pane).
- Lookups made one after another (200 reads for a page's reactions, 100 for its senders' contacts, two per chat in the chat list) each waited for the last.

### Before and after

The same local backend at two CPUs, before and after the changes in this section:

| Scenario                                                        | Before            | After          |
| --------------------------------------------------------------- | ----------------- | -------------- |
| `members:me` alone                                              | 263 ms            | 44 ms          |
| `messages:reactions` for 100 messages                           | 556 ms            | 186 ms         |
| `chats:list` page of 50                                         | 451 ms            | 162 ms         |
| Reconnect burst: 3 clients' 390 queries at once, 5 times        | 367 timed out     | none timed out |
| The same burst's CPU time                                       | 106 s             | 45 s           |
| 2 clients' 52 subscriptions while ingesting 5 messages a second | 47 failed to load | all live       |
| 10 address book saves with those subscriptions open             | 18.6 s of CPU     | 2.5 s of CPU   |

With every subscription live, ingesting five single-event batches a second (about thirteen times the live server's rate of ingest calls) still kept two CPUs busy. Most of that is `chats:list`, `chats:counts` and `messages:arrivals` running again for each new message, which the sync log below would remove.

## Rules for the backend

- **Check sign-in through `lib/session.ts`.** It asks `components.betterAuth.sessions.live`, which reads one row. Never call `components.betterAuth.adapter.*` on a path every query takes, and don't import `auth.ts` into a module with queries the app subscribes to: only modules that need Better Auth itself (`account.ts`, `http.ts`, the component) import it.
- **Keep often-written fields off rows that every query reads.** The `members` row is read by every signed-in query: write it only when membership or keys change. The address book's count and revision live in `addressBooks`.
- **Don't read a row a query doesn't need.** A row in a query's read set runs it again whenever any field of that row changes. A chat row changes with every message, so a query that only needs to know the chat is the person's can often show the person's own rows instead (`messages.reactions`).
- **Read independent rows together.** Start lookups that don't depend on each other at once (`Promise.all`), in batches that keep the read bounds the query already had.
- **Share subscriptions on the client.** Two components asking the same thing with `convexQuery`, or the cached paginated hook, share one subscription. Convex's own `usePaginatedQuery` makes a new set of pages for each component that mounts it.

## Toward a sync log

Most of what still costs CPU is live queries running again because something they read changed: a message arrives, its chat row changes, and every client's chat list page, unread counts and arrivals feed run again, each reading tens of rows to send back mostly what the client already has. The cost grows with writes × subscriptions × rows per query.

A per-person sync log would make it grow with writes alone. Every mutation that changes what a person sees appends to one table in the same transaction:

```ts
syncLog: defineTable({
  userId: v.string(),
  /** One more than the person's last entry, from their `syncHeads` row. */
  seq: v.number(),
  kind: v.union(
    v.literal('chat'),
    v.literal('message'),
    v.literal('reaction'),
    v.literal('contact'),
    v.literal('person') /* … */,
  ),
  objectId: v.string(),
  op: v.union(v.literal('put'), v.literal('delete')),
  /** The object as stored: opaque IDs and sealed envelopes only. */
  row: v.optional(v.any()),
}).index('by_user_seq', ['userId', 'seq'])
```

A client keeps a local store and asks `sync.since({ cursor, limit })` for the entries after the last `seq` it applied: one index range, bounded by rows and bytes, that it subscribes to only from its current cursor. A write runs each device's subscription once, and that run reads only the new entries. The chat list, unread counts, arrivals and reactions are then worked out on the device from its store, which already holds what it needs for search and offline use.

What it needs:

- **Sealing stays as it is.** Entries hold what the tables hold today, opaque IDs and envelopes, so the server learns nothing new. The local store keeps entries sealed on disk and opens them in memory, as `sealing.md` requires.
- **Order without contention.** `seq` comes from a per-person `syncHeads` row that each appending transaction increments. Each bridge host's writes already come one batch at a time, so the conflicts this adds are between one person's networks and devices, which Convex retries. `_creationTime` can't stand in for it, since transactions can commit in a different order from their timestamps.
- **A first sync and a way back.** A new device loads current state a page at a time, as the app does now, starting from the head it saw first. Old entries are pruned, keeping the newest per object. A client whose cursor is older than what's kept is told to load everything again.
- **One step at a time.** Start with a chat's messages, reactions and receipts behind one subscription per open chat, then the chat list and counts, keeping today's queries until each step is proven.

The costs are a second write for each change, storage until entries are pruned, and a client that has to apply entries in order and recover from gaps. For a server where bridges write all the time and each person has several devices open, that trade is what keeps CPU use proportional to new data rather than to everything shown on screen.

## Not done yet

- `chats.counts` reads up to 396 inbox chats each time any of them changes. A stored count per person, kept wherever `unreadCount`, `markedUnread`, `mutedUntil`, `woke` or `view` changes, would run it again only when a count changes. It isn't hot on the live server today, so it waits for the sync log or for a measurement that says otherwise.
