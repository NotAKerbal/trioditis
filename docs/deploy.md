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
6. waits until everything is healthy, checks the backend can reach the server's public
   address, then prints the address and, until the admin account exists, the **admin setup
   link**.

Open the setup link to create the admin account. It carries the setup token in the part of
the URL after `#`, which browsers never send to the server, and it works once: as soon as an
account exists, it stops working. The token itself is in `deploy/.env`
(`TRIODITIS_SETUP_TOKEN`); running the installer again prints the link again until the
account exists, and says setup is done after that.

The setup form sends the token and the admin's password to the server over whatever the
address uses. Over plain HTTP from another device, anyone on the path can read them, so serve
the server over HTTPS ([HTTPS in local mode](#https-in-local-mode), or
[domain mode](#domain-mode)) before the first sign-up from anywhere but this machine.

Every option is saved in `deploy/.env` and kept on later runs, so a rerun with no options
leaves the install as it is, and an option changes only its own setting. See
[Upgrade](#upgrade).

### Local mode

The default. Caddy serves plain HTTP on a port, with no domain and no certificates, for a
server you reach on your LAN or over Tailscale:

```sh
deploy/install/install.sh                              # http://<address>:8080
deploy/install/install.sh --port 9000 --host 192.168.1.20
```

The address defaults to this machine's Tailscale IP when Tailscale is running, and its first
LAN IP otherwise, and is kept from then on. Pick one address and use it everywhere: sign-in
is tied to one origin, so the server answers at its address and not at others. Run the
installer again with `--host` to change it (`--host ''` detects it again). `--bind` picks
the interface the port listens on (default all of them).

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

`--public-url` makes that the server's address. It must be an `https://` origin, with no
path. The port is bound to `127.0.0.1`, so it's only reachable through the proxy; for a
proxy on another machine, pass `--bind` with an address that proxy can reach, and keep the
port firewalled from everything else. Caddy trusts the `X-Forwarded-For` and
`X-Forwarded-Proto` headers from private addresses in this mode, since requests come through
the proxy, so anything else that can reach the port could set them.

The backend has to reach the public address to check sign-ins. When the proxy runs on this
machine, as Tailscale Serve does, it only answers people on the tailnet, so the installer
also starts a small `hairpin` forwarder (`compose.hairpin.yml`) and points the public host
name at it inside the backend's container. A proxy on another machine is reached the
ordinary way. Any reverse proxy that serves HTTPS works the same way. Reruns keep the
address; `--public-url ''` goes back to plain HTTP.

### Domain mode

```sh
deploy/install/install.sh --domain chat.example.com
```

Caddy listens on ports 80 and 443 and gets a certificate for the domain with ACME, so the
domain's DNS must point at this machine and both ports must be reachable from the internet.
`--local` (or `--public-url`) switches back to local mode.

### Networks

```sh
deploy/install/install.sh --networks whatsapp          # the default
deploy/install/install.sh --networks whatsapp,fake     # also the fake network
```

Each network gets its own bridge host. The fake network logs in with any username and never
talks to anything real: use it to try the server out. Signal and Google Messages join the
list when the bridge host runs their connectors. Dropping a network from the list stops and
removes its bridge host; its volume and database stay, in case you add it back.

## What's running

| Service            | What it is                                                    | Exposed                      |
| ------------------ | ------------------------------------------------------------- | ---------------------------- |
| `caddy`            | The web app, and the proxy to everything below                | Yes: the only published port |
| `hairpin`          | Only behind a proxy on this machine: see HTTPS in local mode  | On Docker's host address     |
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
signing keys Better Auth publishes at `<origin>/api/auth/convex/jwks`. In domain mode the
bundle maps the domain to this machine inside the backend's container, so that works without
the router looping traffic back; behind a proxy on this machine it maps it to the `hairpin`
forwarder. Otherwise the name resolves as it does anywhere else. The installer checks the
backend can reach the address and warns if it can't.

Caddy also listens on `127.0.0.1:8090` inside its container, for its healthcheck only: the
site itself may only answer HTTPS for its domain.

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

The rerun keeps every secret and every setting the last run saved in `deploy/.env`: the
mode, the domain or public URL, the port, the bind address and host, the networks, and
`--e2e`. Pass an option only to change that one. It rebuilds the images from the new
checkout, redeploys the functions, restarts what changed, and removes services that are no
longer enabled. The Convex backend migrates its database in place on start; the image is
pinned, and only moves when the bundle changes it.

Back up before upgrading (below).

## Encryption at rest

Trioditis seals stored messages, chat names and contact names to each person's own keys, so
the Convex database holds ciphertext. The network connectors are different: they keep their
own state in the bridge database, and some of it is plaintext, including chat names, contact
names, phone numbers, and history the connector has received but not yet imported.

So in this version, **the server's disk must be encrypted**, and so must its backups.
The installer warns when Docker's data isn't on an encrypted volume (LUKS / dm-crypt). It
only sees dm-crypt on this machine's own block devices, so it warns about a VM whose host
encrypts its storage, or about encryption it doesn't recognise (such as ZFS native
encryption or a self-encrypting drive), and it doesn't check backups: treat it as a
reminder, not a guarantee. On a VM, encrypt the guest's disk or the storage it lives on. On
Proxmox, use encrypted storage for the VM. Encrypting those connector tables with a server-held key is planned for Phase 1
(`docs/PLAN.md`, Known follow-ups).

## Backup and restore

Built-in `backup` and `restore` commands are Phase 1. Until then, back up while the server
is stopped, so the databases are consistent:

```sh
mkdir -p ~/trioditis-backups && chmod 700 ~/trioditis-backups
deploy/trioditis down
sudo tar -C /var/lib/docker/volumes -czf ~/trioditis-backups/trioditis-$(date +%F).tgz \
  trioditis_postgres trioditis_convex trioditis_caddy-data \
  $(deploy/trioditis config --volumes | grep '^bridge-' | sed 's/^/trioditis_/')
cp deploy/.env ~/trioditis-backups/trioditis-$(date +%F).env   # the secrets
deploy/trioditis up -d
```

The archive takes every enabled network's bridge volume (`trioditis_bridge-whatsapp`, and
`trioditis_bridge-fake` with the fake network); add the volume of a network you've dropped
if you want to keep its state. Keep backups outside the checkout, as above: the image builds
copy the checkout, and although the ignore files exclude `deploy/.env*`, `*.env` and
`*.tgz`, a backup elsewhere can't end up in an image or a commit by mistake.

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
encrypted disk is simpler to give a VM. The script drives the VM through the QEMU guest
agent, which cloud-init installs on first boot from a snippet, so the storage named by
`--snippets` (default `local`) must allow the snippets content type
(`pvesm set local --content iso,vztmpl,backup,snippets`). It checks the cloud image against
Ubuntu's published checksum. If a step fails after the VM exists, it says how to look at the
VM and remove it. The script isn't exercised in CI.

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
reply, and checks that nothing readable reached Convex. `--e2e` is kept for reruns like
every option: run the installer again with `--no-e2e` afterwards to remove the test
endpoint.
