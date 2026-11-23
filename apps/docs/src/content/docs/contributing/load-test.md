---
title: Load Test
description: The load test that holds the backend to the live server's two CPUs under a realistic inbox, bridge traffic and desktop clients, and what its report means.
---

The unit tests and `convex-test` run each function on a small, quiet dataset. On a real server the backend runs many functions at once on two vCPUs, with bridge hosts writing all the time. Each write re-runs the live queries it touches, and every desktop client holds dozens of them. The load test reproduces that and measures it.

```sh
pnpm load-test                     # the nightly profile, about 30 minutes
pnpm load-test --profile quick     # a smaller inbox and 3 minutes, to try a change
pnpm load-test --help              # every option
```

It needs Docker. On the dev VM, where agent shells aren't in the `docker` group, it falls back to `sg docker`. Before it starts, it checks that the disk Docker uses and the report's directory each keep 20 GiB free, plus twice what the run writes, and 10% of their inodes. A throwaway CI runner sets `LOAD_DISK_RESERVE_GIB` to keep less. It also checks for 4 GiB of available memory. It refuses to start if any check fails.

## What it runs

1. **The backend.** Postgres and the self-hosted Convex backend each run in their own container, using the pinned images from `deploy/compose/compose.yml`. The checkout's functions are deployed as `deploy-functions.sh` deploys them: the environment, the functions, then `migrations:runAll`.
2. **The person.** The test signs up the server's first account and sets up its identity key the way the app's first device does, including the key proof.
3. **The inbox.** Made-up, demo-style data, the same for every seed: thousands of chats across Signal, WhatsApp, GroupMe, Bluesky and Telegram, with a long tail of chat sizes. It has tens of thousands of messages, plus reactions, attachment metadata (files are never fetched), contacts, a People address book, labels, pins, archives, snoozes, mutes, message requests and unread chats. A simulated bridge host for each network seals everything to the person's key, as `apps/bridge-host` does, and pushes it through the real ingestion path: `apps/gateway`'s `handleEvents`, then `gateway:ingest`. The app's own state (People cards, labels and the rest) is written through the app's mutations, sealed as the app seals it.
4. **The cap.** Once the inbox is seeded, the backend is held to `--cpus` (2 by default, the live server's) with `docker update --cpus`, and restarted. The restart makes it size its thread pools for those CPUs, as it does on a two-vCPU server.
5. **The load,** for `--minutes`:
   - _Writes:_ one network backfills history (`--backfill-rate`, 150 messages a minute on Signal by default, as seen live). It comes a page of one chat at a time (`--backfill-page`, 50 by default), journaled together, as the connector's `BatchSend` journals a page. Every network also sends live messages (`--live-rate`), each with typing before it and reactions, receipts and edits in proportion. Each host pushes as the bridge host's `Pusher` does: up to 100 events as soon as there are any, a heartbeat every 30 seconds, and a backoff after a failure. The gateway's dispatcher delivers the commands that clicks queue (read receipts, sends) to a stand-in that takes them all, and answers sends with `sendStatus` and an echo.
   - _Reads:_ each client (`--clients`) is a Convex websocket client holding the live queries the desktop app holds, with the same arguments. In the Focused layout that means:
     - the five chat lists, the badge counts and arrivals
     - labels, preferences, scheduled messages, and the server's and networks' state
     - every page of People
     - a media token for each network
     - inbox pages for Unread, by the desktop's own rule (`unread-fill.ts`), loaded again whenever the counts change
     - up to six fetched-ahead chats, each with its messages, reactions (in the desktop's own request groups, `reaction-requests.ts`), senders and scheduled messages, kept in step with the loaded pages as messages arrive

     Every few seconds (`--click-ms`) a client does what a person does: opens a chat (and marks it read), scrolls back, hovers over a chat, opens People, mutes or pins a chat, or sends a message. A chat it lets go of stays subscribed for five minutes, as the desktop's cache keeps it.

## The report

`report.md` and `report.json` go to `--out`, by default `.data/load-test/<time>/`. In CI they go to the job summary and the `load-test-report` artifact. The numbers come from the backend's own function log, the stream `npx convex logs` reads, which records every execution: how long it ran, whether its answer was cached, what it read, and how it failed. The report has:

- **Checks.** The run fails, and `pnpm load-test` exits 1, if any of these fails:
  - the function log wasn't read all the way through the run, so the numbers below could be missing executions
  - any function timed out
  - a function that ran at least 20 times went over its p95 or p99 budget (250 and 500 ms by default; set per-function budgets with `--budgets budgets.json`, for example `{ "gateway:ingest": { "p95": 400 } }`)
  - a client saw an error
  - a bridge host push failed

  `--report-only` exits 0 anyway.

- **What people would notice.** How long a chat takes to open (until its messages and what goes with them are in, or 400 ms after the messages, as the pane shows them), how long a live message takes to reach a chat that was already open or warm, and how long an acknowledged push took.
- **Most expensive functions.** Every function ranked by its total execution time, with calls a minute, cached answers, p50/p95/p99/max, timeouts, errors and documents read.
- **Minute by minute.** Executions, timeouts, errors and the backend's CPU for each minute.

To measure a change, run the same profile and seed before and after it and compare the two reports. The nightly run (`.github/workflows/load-test.yml`) tests `dev` every night, and anyone can start it from the Actions tab for any branch.

## Limits

- One person. A server with several members has more of everything, all on the same two CPUs.
- The bridge hosts and the gateway run in the test's process, with no network between them and the backend, and the stand-in for the bridge hosts' command endpoint does no work. On the live server the gateway, the bridge hosts and Caddy share the two vCPUs with the backend; here only the backend is held to them.
- The clients are Node, not browsers: they ask for what the app asks for but decrypt nothing, so client CPU isn't measured.
- Files aren't fetched: the media token is asked for, but the gateway's media proxy isn't exercised.
