# Running a Trioditis server

A Trioditis server is a Docker Compose bundle you run on your own machine: a Linux box, a
VM, a Proxmox host or a VPS, on x86_64 or arm64. One command installs it, and the same
command upgrades it.

## Install

You need Docker Engine with the Compose plugin, git, and at least 8 GiB free where Docker
keeps its data.

```sh
git clone https://github.com/NotAKerbal/trioditis.git
cd trioditis
deploy/install/install.sh
```

The installer:

1. checks Docker, the CPU architecture, free space, and whether Docker's data is on an
   encrypted volume;
2. generates the server's secrets and key pairs into `deploy/.env` (readable only by you);
3. builds the images from this checkout;
4. starts Postgres and the Convex backend, creates their databases and the Convex admin key;
5. deploys the backend's functions and starts the gateway, one bridge host per network, and
   Caddy;
6. waits until everything is healthy, then prints the server's address and the **admin setup
   link**.

Open the setup link to create the admin account. It carries the setup token in the part of
the URL after `#`, which browsers never send to the server, and it works once: as soon as an
account exists, it stops working. The token itself is in `deploy/.env`
(`TRIODITIS_SETUP_TOKEN`); running the installer again prints the link again.

### Local mode

The default. Caddy serves plain HTTP on a port, with no domain and no certificates, for a
server you reach on your LAN or over Tailscale:

```sh
deploy/install/install.sh                              # http://<address>:8080
deploy/install/install.sh --port 9000 --host 192.168.1.20
```

The address defaults to this machine's Tailscale IP when Tailscale is running, and its first
LAN IP otherwise. Pick one address and use it everywhere: sign-in is tied to one origin, so
the server answers at its address and not at others. Run the installer again with `--host`
to change it.

#### HTTPS in local mode

Browsers treat a plain-HTTP page as insecure unless it's on `localhost`, and an insecure
page can't use the Web Crypto API the web app keeps each person's key with. So over plain
HTTP from another device, sign-up works but setting up or unlocking the key fails. Serve
local mode over HTTPS instead. With Tailscale, Tailscale Serve gives the machine a
certificate for its tailnet name and forwards to the port:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8080
deploy/install/install.sh --public-url https://<machine>.<tailnet>.ts.net:8443
```

`--public-url` makes that the server's address, and binds the port to `127.0.0.1` so it's
only reachable through the proxy (pass `--bind` for a proxy on another machine). Any reverse
proxy that serves HTTPS works the same way. Reruns keep it; `--public-url ''` goes back to
plain HTTP.

### Domain mode

```sh
deploy/install/install.sh --domain chat.example.com
```

Caddy listens on ports 80 and 443 and gets a certificate for the domain with ACME, so the
domain's DNS must point at this machine and both ports must be reachable from the internet.

### Networks

```sh
deploy/install/install.sh --networks whatsapp          # the default
deploy/install/install.sh --networks whatsapp,fake     # also the fake network
```

Each network gets its own bridge host. The fake network logs in with any username and never
talks to anything real: use it to try the server out. Signal and Google Messages join the
list when the bridge host runs their connectors.

## What's running

| Service            | What it is                                                    | Exposed                      |
| ------------------ | ------------------------------------------------------------- | ---------------------------- |
| `caddy`            | The web app, and the proxy to everything below                | Yes: the only published port |
| `backend`          | The Convex backend, on Postgres                               | No                           |
| `postgres`         | Postgres 17: Convex's data and each bridge host's             | No                           |
| `functions`        | One-shot: sets Convex's environment and deploys the functions | No                           |
| `gateway`          | Moves events between bridge hosts and Convex                  | No                           |
| `bridge-<network>` | A bridge host: runs that network's connector                  | No                           |

`deploy/trioditis` is `docker compose` for this install, with its settings:

```sh
deploy/trioditis ps
deploy/trioditis logs -f gateway
deploy/trioditis restart bridge-whatsapp
deploy/trioditis down          # stop everything; data stays in Docker volumes
deploy/trioditis up -d         # start it again
```

### Routing

Everything is on one origin, so the web app's auth cookies are first-party:

| Path                                     | Goes to                                                                                                                                                                      |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/convex/*`                              | The Convex client API and its websocket (port 3210), prefix stripped. The client is given `<origin>/convex` and keeps the prefix (`ws://<origin>/convex/api/<version>/sync`) |
| `/api/auth/*`                            | Better Auth, in Convex's HTTP actions (port 3211)                                                                                                                            |
| `/mcp`, `/mcp/*`, `/.well-known/oauth-*` | The MCP server and its OAuth discovery, in Convex's HTTP actions                                                                                                             |
| `/config.json`                           | The web app's runtime config, written by the installer: `{ "convexUrl": "<origin>/convex", "convexSiteUrl": "<origin>", "environment": "selfhosted" }`. Never cached         |
| Everything else                          | The web app's static files, falling back to `index.html`                                                                                                                     |

The Convex backend also calls its own public origin: it checks sign-in tokens against the
signing keys Better Auth publishes at `<origin>/api/auth/convex/jwks`. The bundle maps the
public host name to this machine inside the backend's container, so that works without the
router looping traffic back.

### The web app

Caddy serves `apps/desktop`'s static build (`pnpm --filter @trioditis/desktop build`),
which the image builds whenever the checkout has `apps/desktop`. Until it does, it serves a
placeholder that shows whether the server is up and turns the setup and invite links into a
sign-up form.

## Upgrade

```sh
git pull
deploy/install/install.sh
```

The rerun keeps every secret, rebuilds the images from the new checkout, redeploys the
functions and restarts what changed. The Convex backend migrates its database in place on
start; the image is pinned, and only moves when the bundle changes it.

Back up before upgrading (below).

## Encryption at rest

Trioditis seals stored messages, chat names and contact names to each person's own keys, so
the Convex database holds ciphertext. The network connectors are different: they keep their
own state in the bridge database, and some of it is plaintext, including chat names, contact
names, phone numbers, and history the connector has received but not yet imported.

So in this version, **the server's disk must be encrypted**, and so must its backups.
The installer warns when Docker's data isn't on an encrypted volume (LUKS / dm-crypt). On a
VM, encrypt the guest's disk or the storage it lives on. On Proxmox, use encrypted storage
for the VM. Encrypting those connector tables with a server-held key is planned for Phase 1
(`docs/PLAN.md`, Known follow-ups).

## Backup and restore

Built-in `backup` and `restore` commands are Phase 1. Until then, back up while the server
is stopped, so the databases are consistent:

```sh
deploy/trioditis down
sudo tar -C /var/lib/docker/volumes -czf trioditis-$(date +%F).tgz \
  trioditis_postgres trioditis_convex trioditis_bridge-whatsapp trioditis_caddy-data
cp deploy/.env trioditis-$(date +%F).env      # the secrets: keep them with the backup, encrypted
deploy/trioditis up -d
```

Restore by stopping the server, extracting the archive back into
`/var/lib/docker/volumes`, putting `deploy/.env` back, and running the installer. Keep
backups encrypted: they contain the connector state above, and `deploy/.env` holds every
secret the server has.

## Proxmox

`deploy/install/proxmox.sh`, run as root on a Proxmox VE host, creates an Ubuntu 24.04 VM
(or, with `--lxc`, an unprivileged container with nesting) and installs Trioditis in it:

```sh
bash deploy/install/proxmox.sh                         # VM 9100: 2 cores, 8 GiB, 64 GiB disk
bash deploy/install/proxmox.sh --lxc --id 9101
bash deploy/install/proxmox.sh --storage local-zfs --bridge vmbr1
```

A VM is the default: Docker in an LXC depends on the host's kernel and storage driver, and an
encrypted disk is simpler to give a VM. The script isn't exercised in CI.

## Verifying an install

The end-to-end check (`apps/gateway/scripts/e2e-fake.ts`) runs against an installed server
with the fake network. The fake network's control endpoint only listens on its container's
loopback, so install with `--e2e`: it adds a sidecar that forwards that endpoint to this
machine's loopback (`127.0.0.1:18621`), and nowhere else.

```sh
deploy/install/install.sh --networks whatsapp,fake --e2e
# create the admin account with the setup link, then:
cd apps/gateway
SITE_URL=http://<address>:8080 CONVEX_URL=http://<address>:8080/convex \
  BRIDGE_FAKE_CONTROL_ADDR=127.0.0.1:18621 \
  TRIODITIS_INTERNAL_TOKEN=<from deploy/.env> \
  E2E_IDENTITY_FILE=/tmp/e2e-identity.json \
  node scripts/e2e-fake.ts <admin email> <password>
```

It signs in, connects the fake network through a sealed login, receives a message, sends a
reply, and checks that nothing readable reached Convex. Run the installer again without
`--e2e` afterwards to remove the test endpoint.
