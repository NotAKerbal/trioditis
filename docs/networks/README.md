# Networks

Each network is a mautrix bridgev2 connector that the bridge host runs, one process per
network. This folder has a page per network: how to connect an account, what the
connector needs from the operator, what it keeps on disk, and what to check by hand.

| Network         | ID          | Connector                    | Page                         |
| --------------- | ----------- | ---------------------------- | ---------------------------- |
| WhatsApp        | `whatsapp`  | mautrix-whatsapp             |                              |
| Signal          | `signal`    | mautrix-signal               | [signal.md](signal.md)       |
| Google Messages | `gmessages` | mautrix-gmessages            | [gmessages.md](gmessages.md) |
| Google Voice    | `gvoice`    | mautrix-gvoice               | [gvoice.md](gvoice.md)       |
| Telegram        | `telegram`  | mautrix-telegram             | [telegram.md](telegram.md)   |
| Messenger       | `meta`      | mautrix-meta                 | [meta.md](meta.md)           |
| Instagram       | `instagram` | mautrix-meta (`igconnector`) | [instagram.md](instagram.md) |
| Slack           | `slack`     | mautrix-slack                | [slack.md](slack.md)         |
| GroupMe         | `groupme`   | beeper/groupme               | [groupme.md](groupme.md)     |
| LinkedIn        | `linkedin`  | mautrix-linkedin             | [linkedin.md](linkedin.md)   |
| X               | `twitter`   | mautrix-twitter              | [twitter.md](twitter.md)     |
| Bluesky         | `bluesky`   | mautrix-bluesky              | [bluesky.md](bluesky.md)     |

Discord isn't here yet: mautrix-discord still uses the legacy bridge framework, not
bridgev2 (docs/PLAN.md, Bridge host).

Every network here gets a bridge host on a self-hosted server (unless the operator narrows
that with the installer's `--networks`; Telegram also needs its API ID and hash), and admins
install the ones people can connect in the app, under Admin settings → Networks.

## Adding a network

1. Its file in `apps/bridge-host/internal/networks/`, registering how to make the
   connector and any background work it needs.
2. Its ID in `NETWORKS` (`packages/core/src/index.ts`) and its entry in `NETWORK_INFO`
   (`packages/core/src/client.ts`), with the login flows the connector really offers.
3. Its badge colour (`packages/ui/src/styles/tokens.css`) and mark
   (`packages/ui/src/components/network-badge.tsx`).
4. Its compose service (`deploy/compose/compose.yml`), its name in the installer's list
   (`deploy/install/install.sh`), and its dev port (`scripts/lib.mjs`, `scripts/dev.mjs`).
5. A page here, including everything the connector stores in plaintext and what bounds it
   (docs/architecture/sealing.md).
