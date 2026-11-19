# Running a Trioditis server

A Trioditis server is a Docker Compose bundle you run on your own machine: a Linux box, a
VM, a Proxmox host or a VPS, on x86_64 or arm64. One command installs it, and the same
command upgrades it.

## Install

You need Docker Engine with the Compose plugin, git, and at least 8 GiB free where Docker
keeps its data.

```sh
git clone --branch dev https://github.com/NotAKerbal/trioditis.git
cd trioditis
deploy/install/install.sh
```

The bundle is on the `dev` branch until the first release, hence `--branch dev`.

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

Until the checkout has the web app (`apps/desktop`, see [The web app](#the-web-app)), there's
no setup screen, and the installer says to create the admin account on the server instead:

```sh
deploy/trioditis create-admin you@example.com    # asks for the password, twice
```

It signs up with the setup token as the app would, sending the password derived from yours
(Argon2id, salted by the email) rather than the password itself, so the account signs in from
the app later. It prints no secret.

The setup screen sends the token and the admin's (derived) password to the server over
whatever the address uses. Over plain HTTP from another device, anyone on the path can read them, so serve
the server over HTTPS ([HTTPS in local mode](#https-in-local-mode), or
[domain mode](#domain-mode)) before the first sign-up from anywhere but this machine.

Every option is saved in `deploy/.env` and kept on later runs, so a rerun with no options
leaves the install as it is, and an option changes only its own setting. See
[Upgrade](#upgrade).

`deploy/.env` is the only source of the install's settings and secrets: the installer and
`deploy/trioditis` drop any exported variable of the same name (and every `COMPOSE_*` one), so the
running server always matches the file a backup saves. To change one, such as the setup
token, edit `deploy/.env` and run the installer again; the new value replaces the saved one.

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

For a server only used on this machine, `--host 127.0.0.1 --bind 127.0.0.1` (or
`localhost`; other `127.*` addresses aren't supported) works too; browsers treat loopback as
secure, so it needs no HTTPS. Inside the backend's
container that address is the container itself, so the installer adds a small `loopback`
forwarder there (`compose.loopback.yml`) that serves the port by passing it on to Caddy.
Ports 3210 and 3211 can't be used for it. IPv6 addresses aren't supported for `--host`.

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

`--public-url` makes that the server's address. It must be an `https://` origin with a host
name (not an IPv6 address or a loopback name) and no path. The port is bound to `127.0.0.1`,
so it's only reachable through the proxy.

Caddy takes the client's address and scheme from the proxy's `X-Forwarded-For` and
`X-Forwarded-Proto` headers in this mode, from the addresses in `--trusted-proxies`. On the
default loopback bind only this machine can connect, and the proxy arrives through Docker
from the network's gateway, so by default only those hops are trusted: the loopback and the
server network's gateway. The installer reads the gateway on every run, since a run can make
the network again; if you make it again yourself (`deploy/trioditis down`, then `up`), run
the installer again, or requests through the proxy count as the gateway's until you do.
Caddy takes the rightmost address in `X-Forwarded-For` that it doesn't trust, so the proxy
in front (Tailscale Serve, or another) should overwrite any `X-Forwarded-For` its clients
send if their addresses could fall in a trusted range; Tailscale clients' `100.64.0.0/10`
addresses don't.
For a proxy on another machine, pass `--bind` with an address that proxy can reach, and
then:

- pass `--trusted-proxies <its address>/32` (the installer refuses a non-loopback `--bind`
  without it: any machine that can reach the port could send its own `X-Forwarded-For`, and
  most LAN addresses are private);
- let only the proxy reach the port (a firewall rule allowing just its address);
- have the proxy overwrite `X-Forwarded-Proto`; for `X-Forwarded-For`, Caddy uses the
  rightmost address the proxy didn't add, so one a client put first is ignored.

The backend has to reach the public address to check sign-ins. When the public host name
resolves to this machine, the installer points it at Docker's host address inside the
backend's container (`compose.hostmap.yml`). A proxy that listens on all interfaces is then
reached directly. One that only listens where people connect, as Tailscale Serve does on
the tailnet address, also gets a small `hairpin` forwarder (`compose.hairpin.yml`) on Docker's
host address. The installer tries the connection first and only adds the forwarder when it's
needed. A proxy on another machine is reached the ordinary way. Any reverse proxy that serves
HTTPS works the same way. Reruns keep the address; `--public-url ''` goes back to plain HTTP.

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

| Service            | What it is                                                                         | Exposed                      |
| ------------------ | ---------------------------------------------------------------------------------- | ---------------------------- |
| `caddy`            | The web app, and the proxy to everything below                                     | Yes: the only published port |
| `hairpin`          | Only behind a proxy on this machine: see HTTPS in local mode                       | On Docker's host address     |
| `loopback`         | Only on a loopback address: see Local mode                                         | No: in the backend's network |
| `backend`          | The Convex backend, on Postgres                                                    | No                           |
| `postgres`         | Postgres 17: Convex's data and each bridge host's                                  | No                           |
| `functions`        | One-shot: sets Convex's environment, deploys the functions and runs the migrations | No                           |
| `gateway`          | Moves events between bridge hosts and Convex                                       | No                           |
| `bridge-<network>` | A bridge host: runs that network's connector                                       | No                           |

`deploy/trioditis` is `docker compose` for this install, with its settings:
`deploy/trioditis <command> [the command's own options]`. It sets the project, the compose
files, the project directory and the env file itself, so it takes no Compose options before
the command (`-p`, `-f`, `--env-file`, `--profile` and the rest are refused), and passes on
only Compose's own commands. `config` shows the settings, secrets included, on the terminal
only: it refuses `-o`/`--output` in any spelling.

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
signing keys Better Auth publishes at `<origin>/api/auth/convex/jwks`, so the issuer in
every token is the public origin. In domain mode and behind a proxy on this machine, the
bundle maps the public host name to this machine inside the backend's container, so that
works without the router looping traffic back; on a loopback address the `loopback`
forwarder serves it inside the container. Otherwise the name resolves as it does anywhere
else. The installer checks that the backend gets the key set from the address and warns if
it doesn't.

Caddy tells the backend each client's address in `X-Trioditis-Client-IP`, which it sets on
every request and overwrites if a client sent one; the backend's auth rate limits take the
client address from that header only. Behind a proxy (`--public-url`), Caddy takes the
address from the proxy's `X-Forwarded-For`, and only from `--trusted-proxies` addresses, using
the rightmost entry the proxy didn't add (`trusted_proxies_strict`), not the leftmost one,
which the client controls. So the Convex backend must never be reachable except through
Caddy: the bundle publishes only Caddy's port, and anything else in front of the backend
could set the header to any address. The installer checks the compose files publish nothing
else (`deploy/scripts/check-ports.sh`; the one exception is `--e2e`'s test endpoint, on the
loopback).

What Caddy takes as the client's address, as observed with Docker 29 (`deploy/test/caddy-headers.sh`):

| Mode                                            | A request                                                                 | Client address                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `--public-url`, loopback bind (Tailscale Serve) | from the proxy, `X-Forwarded-For: 100.64.1.2`                             | `100.64.1.2` (Caddy's peer is the network's gateway, such as `172.18.0.1`)                                                                  |
|                                                 | with a client's address put first, `X-Forwarded-For: 6.6.6.6, 100.64.1.2` | `100.64.1.2`                                                                                                                                |
|                                                 | with no `X-Forwarded-For` (from this machine)                             | the network's gateway                                                                                                                       |
| Local mode, direct                              | from a LAN client                                                         | the client's own address; any `X-Forwarded-For` is ignored                                                                                  |
|                                                 | from an IPv6 client                                                       | can't connect: local mode publishes on IPv4 only                                                                                            |
| Domain mode                                     | from an IPv4 client                                                       | the client's own address                                                                                                                    |
|                                                 | from an IPv6 client, on a machine with IPv6                               | its own address: the network has IPv6 on (`compose.ipv6.yml`); without it, Docker's proxy would bring every IPv6 client in from the gateway |

Behind a proxy, every request without `X-Forwarded-For` (only this machine can send one)
counts as the gateway's. Before the default trust was narrowed to those hops,
`X-Forwarded-For: 7.7.7.7, 192.168.23.45` from the proxy gave `7.7.7.7` (a client with a
private address chose its own); now it gives `192.168.23.45`.

Caddy also listens on `127.0.0.1:8090` inside its container, for its healthcheck only: the
site itself may only answer HTTPS for its domain.

### The web app

Caddy serves `apps/desktop`'s static build (`pnpm --filter @trioditis/desktop build`),
which the image builds whenever the checkout has `apps/desktop`. Until it does, it serves a
placeholder that only shows whether the server is up: it creates no accounts, since an
account made with the raw password couldn't sign in from the app. Create the admin account
with `deploy/trioditis create-admin` until then.

## Upgrade

```sh
git pull
deploy/install/install.sh
```

The rerun keeps every secret and every setting the last run saved in `deploy/.env`: the
mode, the domain or public URL, the port, the bind address and host, the networks, `--e2e`
and `--updater`. Pass an option only to change that one. It rebuilds the images from the new
checkout, redeploys the functions, restarts what changed, and removes services that are no
longer enabled. After each deploy of the functions, it runs pending migrations, which fix rows
an older version wrote, so an upgrade needs nothing run by hand. It calls their one entry
point, `migrations:runAll` in `packages/backend/convex/migrations.ts`, directly on this
install's backend with its admin key. That runs every migration in order, every deploy,
since each is safe to run again. A backend without `runAll` (an older version) is skipped
with a note. `runAll` waits for the first batch of each migration, and a failure there stops
the install with its error (`deploy/trioditis logs functions`, and the backend's log for the
details). Later batches run in the background, so a failure in one of those shows in the
backend's log (`deploy/trioditis logs backend`) rather than failing the install. The Convex backend migrates its database in place on start; the image is
pinned, and only moves when the bundle changes it.

Back up before upgrading (below).

## Updates

With the updater on, admins update the server from the app instead: **Admin settings →
Updates**. Turn it on with the installer (the setting is kept, like the others):

```sh
deploy/install/install.sh --updater       # --no-updater stops and removes it
```

The updater is a systemd service on the host, `trioditis-updater-<project>`: a system service
when the installer runs as root, and otherwise a user service of the operator, which keeps
running after they log out only with lingering on (`loginctl enable-linger <user>`; the
installer warns when it's off). Its log is the service's journal:
`journalctl --user -u trioditis-updater-<project>` (without `--user` as root).

In the app, admins choose:

- **The channel.** **Stable** follows the repository's `main` branch; **Nightly** follows
  `dev`, every change as soon as it's merged. Stable is the default.
- **Automatic updates**, off by default: when on, the updater installs the channel's newest
  version once a night, during the 4 AM hour of the host's local time.
- **Check now** and **Update now**, and **Cancel** for a request the updater hasn't started.

The page shows the version the server runs, whether an update is available, and what the
last update did: one that failed says why, with the installer's error. It warns when the
updater hasn't reported for 25 minutes (it reports every ten), since it may be stopped.

What the updater does:

1. It watches the backend for the admins' choices and requests, through
   `deploy/scripts/updater-agent.mjs` in a one-off container from the bundle's Node image on
   the server's internal network, so it needs nothing published. It signs its calls with
   `UPDATER_SECRET`, which the installer generates into `deploy/.env` and gives the backend
   only while the updater is on. With it off, the backend refuses the updater's calls and
   admins can't ask for updates.
2. Every hour, when asked, and when the channel changes, it fetches the channel's branch from
   the checkout's `origin` remote and compares its newest commit with the one the checkout
   is at.
3. To update, it checks that commit out (detached) and runs the installer, the same as
   [Upgrade](#upgrade): every setting is kept, and only what changed restarts. Then it exits,
   and systemd starts the new version of the updater.

It only ever moves forward: it installs a commit only when the checkout is behind the branch
and has nothing the branch lacks, so switching from Nightly to an older Stable leaves the
server where it is until Stable passes it, and a branch that was rewritten or diverged is
never installed. It won't move a checkout with changes to tracked files. It takes the
install's lock before it moves the checkout and holds it until the installer is done (the
installer it runs uses that lock rather than taking its own), so a backup or an install the
operator starts can't run in between; if one is already running, the update says so and
doesn't start. If the installer fails, it checks out the commit it was on and runs the
installer again, and reports both; a commit whose update failed isn't tried again
automatically (Update now still tries it). The installer runs with `--no-setup-link`, since its
output goes to the journal.

A request can be cancelled until the updater claims it, just before it moves the checkout;
after that the update runs to the end. The claim names the channel too, so an update, automatic
or asked for, doesn't start for a channel admins have switched away from meanwhile, nor an
automatic one once they've been turned off (switching
also makes a waiting request again, for the new channel). What must outlast a restart is in
`deploy/.updater-state`: the update in progress and whether it was installing or going back,
how the last one ended until the backend has that report, the day of the last automatic
update, and the commit whose update last failed. An update cut off midway (the machine or the
service stopped, or its state couldn't be saved) goes back to the commit it was on when the
updater next starts, before anything else, since how it would have ended isn't known; it counts
as failed, so it isn't tried again on its own. A request whose update is over is reported done,
and never run a second time: until the backend has that report, the updater sends it again and
starts no other update.

The checkout belongs to the updater: leave it on the commit the updater put it on, and don't
pull or edit it by hand. A private repository needs a `git fetch` that works without a
prompt for the operator's user (a deploy key or a credential helper).

### Updating live

An update doesn't sign anyone out or restart the whole server:

- The Convex backend and Postgres keep running (their images are pinned, and move only when
  the bundle changes them). New functions are deployed into the running backend, and open
  pages get their results straight away.
- The installer rebuilds the images and Compose recreates only the containers whose image
  or settings changed, and those that wait for them. Caddy restarts when the web app changed,
  and pages reconnect to the backend by themselves. The gateway restarts when its code or the
  backend's changed (they share the Node image), and the bridge hosts with it, since they
  wait for it; otherwise they keep running. A bridge host reconnects to its network in
  seconds and catches up on what arrived meanwhile.
- Open pages move to the new web app on their own. The image is built with the commit it's
  from (`TRIODITIS_VERSION`, written to `deploy/.env` on every run), which the app has built
  in, Caddy serves as `/version.json` and the functions return in `server.info`. The
  functions job reads it from `deploy/runtime/version`, not its environment, so a new commit
  alone doesn't make Compose recreate the job and everything that waits for it. When a page
  sees the server's version change, it waits for `/version.json` to name a build other than
  its own, then reloads by itself if it's in the background with no draft or settings open,
  and otherwise offers a reload.

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

Fuller backup commands (online, encrypted, scheduled) are Phase 1. For now,
`deploy/trioditis` takes a consistent backup while the server is stopped:

```sh
deploy/trioditis backup ~/trioditis-backups
```

A backup is a directory, `<project>-<date>-<time>` (with `-2`, `-3`… added rather than
replace an earlier one), 0700, holding two 0600 files, readable only by you: `archive.tgz`
(every Docker volume of this install's Compose project, found by the label Compose gives
them, so never another install's, and including the volume of a network you've dropped) and
`secrets.env` (`deploy/.env` without the server's private keys: see
[The server's keys](#the-servers-keys)). The archive's last entry is a manifest of every
volume with its number of entries and bytes. The backup stops the server, writes both files
in a private directory beside the destination, reserves the name with `mkdir` (which fails
if anything is there, so it moves on to the next suffix), renames the private directory onto
it in one step, checks both files are there, and starts again the containers that were
running (only those: not the finished functions job, nor a service you'd stopped), in the
order their dependencies need, each healthy within two minutes before the next starts (one
that's running but briefly unhealthy is waited for; one that stops isn't); if one isn't
healthy in time, it stops there, names it, and the backup counts as failed
(`deploy/trioditis up -d` starts the rest). So there's
either a whole backup at the name or none: an interrupted backup (Ctrl-C), even while the
server is still stopping, leaves nothing behind, and if the server doesn't start again the
backup counts as failed. The destination must be outside the checkout (symlinks resolved):
image builds copy the checkout.

`secrets.env` holds only the settings the installer writes, as `NAME=value` lines: the names
listed in `deploy/install/env-names`, never the two private keys, and nothing else, not even
a comment. Anything else in `deploy/.env` (a setting you added yourself) stays out of the
backup, and the backup names it, without its value, so you can keep it yourself. Before it
publishes, a second reader checks that `secrets.env` holds every listed setting from
`deploy/.env` exactly once, with its value, and nothing else; and, as a last check, it
won't publish a backup in which either private key's value appears anywhere. If a check
can't run, nothing is published.

`deploy/.env` has one form, which the installer, backup and `keys` all read the same way
(`deploy/scripts/env.sh`): `NAME=value` lines, each name once, no carriage returns, and
every value literal, made only of `A-Z a-z 0-9 . _ ~ : / @ + = , % -`. So there's nothing for
Compose to read differently: no `${…}` to fill in, no quotes, no spaces to trim, no `#` to
start a comment. Three settings are a little wider, each only as far as the value the
installer writes needs: `CONVEX_ADMIN_KEY` may hold `|`; `CADDY_GLOBAL_OPTIONS`,
`CADDY_TRUSTED_PROXIES` and `INSTALL_TRUSTED_PROXIES` may be several words separated by
single spaces; and the two private keys must each be exactly a key (43 characters of
unpadded base64url). Comments (`#` lines) and blank lines are allowed. Anything else is
refused: by the installer, which also refuses any option's value outside that form (a space
in `--bind`, or a value spanning lines, which would read as a second setting), and by
backup, before it makes anything. A NUL or a carriage return anywhere in the file is refused
before it's read at all. Everything
the installer writes goes through one writer, which saves only names
`deploy/install/env-names` lists or the two private keys.

Keep backups encrypted: they contain the connector state above, and `secrets.env` holds every
other secret the server has. Keep the private keys apart from them, with
`deploy/trioditis keys export` (below).

**Restoring comes in a later version.** `deploy/trioditis restore` says so and changes
nothing; keep your backups, which that version restores. Until then, these are the steps it
will take, and they need that version:

- on the same server, keep its `deploy/.env` (its private keys are still there), restore the
  backup, and run the installer;
- after losing the server, in a checkout of the same version, put the backup's `secrets.env`
  back as `deploy/.env`, bring back the keys you exported with
  `deploy/trioditis keys import <key file>`, restore the backup, and run the installer.
  Until the keys are imported, the installer stops and says so.

Backup, the installer, `create-admin`, `keys import`, and every `deploy/trioditis` Compose
command that can start, stop or change services take a lock in `deploy/`, so only one of
them runs at a time for an install. Only read-only commands (`ps`, `logs`, `config`, `top`,
`images`, `ls`, `port`, `version`, `events`) run beside them. A backup takes the lock before
it reads `deploy/.env`, and uses that one reading throughout.

### The server's keys

The server has two private keys, in `deploy/.env`: `BRIDGE_PRIVATE_KEY`, which opens what
clients seal to the bridge host (sends, including scheduled ones waiting for their time, and
login input), and `AGENT_ACCESS_PRIVATE_KEY`, which opens the chats people grant to agents.
A backup holds that sealed content, so a backup that also held the keys could be read by
anyone who got it. Backups leave both keys out (and nothing in the volumes holds them: the
bridge host reads its key from the environment, and the Convex backend only gets the public
halves). Keep a copy of the keys apart from the backups instead:

```sh
deploy/trioditis keys export ~/trioditis-server-keys.env
```

It writes the two pairs to a new file, readable only by you, and never over an existing one
or inside the checkout. Keep that file somewhere the backups aren't, such as a password
manager or offline media, and delete the copy on the server. `keys import <file>` puts the
private keys back into a `deploy/.env` that has only the public ones. It refuses a pair whose
public key isn't the one there, one whose private key isn't exactly a key (43 characters of
unpadded base64url, nothing more), and one whose private key isn't that public key's private
half (it derives each, in the bundle's Node image with no network). Neither command prints a
key.

**If the keys are lost**, run the installer with `--new-server-keys`. It makes a new pair for
each key whose private half is missing, and is the only way it ever replaces a key. What it
costs:

- Sends sealed to the old bridge key can't be opened: scheduled messages waiting for their
  time, and sends and login input still in flight. The bridge host refuses each such command
  (`invalid_command`), and the backend marks it failed and the person's copy of the message
  failed, so they see it didn't go and can send it again. Nothing is dropped silently.
- Chats granted to agents were sealed to the old agent-access key, so they must be granted
  again.

Clients seal to the new public key once the functions are deployed with it, which the
installer does.

**Older backups hold the keys.** Backups made before this change (by 88eed87 or earlier, in
their `.env`, and by 15f1f45, in `secrets.env`) contain both private keys. Keep them as
carefully as the server itself, or replace them with new backups and delete them.

### What backup guards against

The checkout and the backup directory must be writable only by you, the operator. Within
that, backup is built to stay safe through your own mistakes, a second `deploy/trioditis` or
installer run at the same time, other Compose projects on the same Docker, interrupts, full
disks and read-only filesystems, and steps that fail partway. It doesn't guard against a
hostile process running as your user that rewrites paths while it runs: anything that can do
that can already read and change the install.

### Testing the bundle

`deploy/test/` checks the guarantees above, and the installer's file handling:

```sh
deploy/test/run.sh          # all of them, about five minutes; or one, e.g. deploy/test/backup-publish.sh
```

Each test makes its own throwaway install directory and Compose project
(`trioditis-test-<random>`) with volumes it fills itself, so it builds and starts nothing and
never touches an install; it removes everything it made when it ends. They need Docker (run
them as a user in the `docker` group, or under `sg docker -c`), the bundle's Alpine image
(pulled if missing), and `flock`. `install-settings.sh` runs the installer against a stub
`docker` and needs none of that, and `updater.sh` a stub `docker` and git.

| Test                  | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup-publish.sh`   | A cold backup works and starts nothing; it is a 0700 directory of 0600 files, and neither `secrets.env` nor the archive holds a private key; a name taken by a file, directory or symlink moves the backup to the next one; a rename that silently does nothing fails it; Ctrl-C while it streams leaves nothing behind; so does Ctrl-C after it reserved its name; a `deploy/.env` not in `NAME=value` form (which could hide a private key) is refused |
| `backup-restart.sh`   | A backup starts again only the containers that were running: not a finished one-shot job a running service depends on, nor a stopped service                                                                                                                                                                                                                                                                                                             |
| `keys.sh`             | `keys export` writes a new 0600 file, never over another or inside the checkout; `keys import` adds the private keys, and refuses a pair that isn't this server's or whose private key isn't the saved public key's half (mixed pairs); neither prints a key                                                                                                                                                                                             |
| `lock.sh`             | Nothing may come before the command (`-p`, `-f`, `--env-file`, `--project-directory`, `--dry-run`, an unknown option) and unknown commands are refused; `logs -f` passes; while the lock is held, `start`, `up`, `stop`, `create-admin` and `backup` are refused and `ps`, `config` and `logs` run; `restore` with no install says it isn't available yet                                                                                                |
| `env-source.sh`       | Exported variables, `COMPOSE_*` ones included, don't override `deploy/.env` for Compose, with several compose files saved                                                                                                                                                                                                                                                                                                                                |
| `caddy-headers.sh`    | The backend is told the address Caddy saw, never one a client sent (on `/api/auth/*` and `/convex/http/*`); a trusted proxy's `X-Forwarded-For` is used, rightmost first, and an untrusted peer's is ignored; and, published as each mode publishes it, the client address in each mode, IPv6 included                                                                                                                                                   |
| `ports.sh`            | Only Caddy is published, for every combination of compose files, and no sidecar forwards to the backend's ports; the check catches a published backend                                                                                                                                                                                                                                                                                                   |
| `install-settings.sh` | An unreadable `deploy/.env` stops the installer unchanged; a symlinked `runtime/config.json` is replaced, not followed; Compose gets no exported value; half a key pair stops the installer, and only `--new-server-keys` makes a new one                                                                                                                                                                                                                |
| `updater.sh`          | Against a throwaway git remote and a stub installer: the updater moves the checkout to the channel's newest commit, installs it and reports it done; after a failed install it goes back to the commit it was on, installs that, and reports the installer's error; it leaves a checkout that's up to date, ahead of the channel, diverged from it, or has local changes where it is                                                                     |

`TRIODITIS_WRAPPER=<path>` (or `TRIODITIS_INSTALLER=<path>` for `install-settings.sh`) runs
a test against another version of `deploy/trioditis` (or `install.sh`).

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
# create the admin account with the setup link, or, before the checkout has the web app,
# deploy/trioditis create-admin <admin email>; then:
cd apps/gateway
SITE_URL=http://<address>:8080 CONVEX_URL=http://<address>:8080/convex \
  BRIDGE_FAKE_CONTROL_ADDR=127.0.0.1:18621 \
  TRIODITIS_INTERNAL_TOKEN=<from deploy/.env> \
  E2E_IDENTITY_FILE=/tmp/e2e-identity.json \
  node scripts/e2e-fake.ts <admin email> <password>
```

It signs in, connects the fake network through a sealed login, receives a message, sends a
reply, and checks that nothing readable reached Convex.

To run a second, throwaway install on the same machine without touching the first, give it
its own Compose project (which also names its images and volumes) and port, from a separate
checkout so it has its own `deploy/.env`. `TRIODITIS_PROJECT` only names a new install: an
existing one keeps the project it was installed with (`trioditis` for one from before the
name was saved), and the installer refuses a different one, which would start an empty
server beside it. `deploy/trioditis` always uses the saved project, whatever
`COMPOSE_PROJECT_NAME` says.

```sh
TRIODITIS_PROJECT=trioditis-test deploy/install/install.sh --host 127.0.0.1 --bind 127.0.0.1 --port 18080
```

Remove it with `deploy/trioditis down -v` in that checkout. `--e2e` is kept for reruns like
every option: run the installer again with `--no-e2e` afterwards to remove the test
endpoint.
