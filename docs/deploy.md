# Running a Trioditis server

A Trioditis server is a Docker Compose bundle you run on your own machine: a Linux box, a
VM, a Proxmox host or a VPS, on x86_64 or arm64. One command installs it, and the same
command upgrades it.

## Install

You need Docker Engine 28 or later with the Compose plugin, git, and at least 8 GiB free where Docker
keeps its data.

```sh
git clone --branch dev https://github.com/NotAKerbal/trioditis.git
cd trioditis
deploy/install/install.sh
```

The bundle is on the `dev` branch until the first release, hence `--branch dev`. The app's
updates start on the **Stable** channel, which follows `main` and is behind `dev` until then,
so after installing from `dev` choose **Nightly** in **Admin settings → Updates** (the
installer says so, and the updater says so too while the server is ahead of its channel).
Otherwise the server stays where it is until Stable catches up. See [Updates](#updates).

The installer:

1. checks Docker, the CPU architecture, free space, and whether Docker's data is on an
   encrypted volume;
2. generates the server's secrets and key pairs into `deploy/.env` (readable only by you);
3. builds the images from this checkout;
4. starts Postgres and the Convex backend, creates their databases and the Convex admin key;
5. deploys the backend's functions and starts the gateway, a bridge host for every network
   (see [Networks](#networks)), and Caddy;
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

The server runs a bridge host for every network this version supports: WhatsApp, Signal,
Google Messages, Google Voice, Telegram, Meta (Facebook Messenger), Instagram, Slack, GroupMe,
LinkedIn, X (Twitter) and Bluesky. Which of them people can connect is up to the admins, in
the app: **Admin settings → Networks** installs a network, so it's offered to members, and
removes it again, with nothing to change on the server. A bridge host for a network nobody
has installed or connected sits idle.

Running them all takes memory, and Signal's bridge host links libsignal, which the first
install builds from source (Rust): that adds several minutes and a few GiB of memory to the
first build. On a small machine, `--networks` limits the bridge hosts to the ones you name,
and with that the networks admins can install:

```sh
deploy/install/install.sh                              # every network (the default)
deploy/install/install.sh --networks whatsapp,signal   # only these
deploy/install/install.sh --networks all               # every network again
```

The choice is kept for later reruns (`INSTALL_NETWORKS` in `deploy/.env`). Dropping a network
from it stops and removes its bridge host; its volume and database stay, in case you add it
back. The backend is told which networks have a bridge host (`TRIODITIS_NETWORKS`), so admins
can only install those.

Telegram also needs your own app credentials from <https://my.telegram.org/apps>, which the
installer keeps for later reruns (docs/networks/telegram.md). Without them, the default leaves
Telegram out and says so; with them, it's included:

```sh
deploy/install/install.sh --telegram-api-id <api_id> --telegram-api-hash <api_hash>
```

Naming `telegram` in `--networks` without them stops the install.

#### The sign-in browser

Messenger, Instagram, Google Messages, Google Voice, Slack, LinkedIn and X log in on their own
website. The `login-browser` service shows that page to the person inside the app, and their
bridge host collects what the network needs once they have signed in
(docs/architecture/signin-browser.md). Its image is Debian's Chromium with a small launcher,
built by the installer like the others.

Each login gets its own Chromium, about 0.5 GiB of memory while it's open, and none when no
one is signing in. At most `LOGIN_BROWSER_MAX` (default 4) run at once;
the rest are told to try again. Chromium runs in a container with no secret but its own
`LOGIN_BROWSER_TOKEN` (the installer makes it; it only starts browsers), read-only, with its
profiles in `/dev/shm`. Each login's Chromium runs as a user of its own, so one person's
browser can't read another's; for that the launcher keeps four capabilities (setting a
user and group, giving the profile to that user, and ending its processes) and every other
one is dropped. It is only on the `signin` network, which is internal and holds just it and
the bridge hosts of the networks that sign in on a website: it can't reach the internet or
the server's other services, and those bridge hosts refuse its address everything but the
egress proxies of the one whose login it runs (one per browser), which only connect to public
addresses on ports 80 and 443. If this server's network routes some public-looking range somewhere local (a provider's
host service), add it to `BRIDGE_EGRESS_DENY` in `deploy/.env` (comma-separated ranges) and
run the installer again. With `META_PROXY` or
`INSTAGRAM_PROXY` set, that proxy goes out through it too, so the sign-in comes from the
bridge's address.

Without the sign-in browser (a server that doesn't run it), the app asks for the cookies to
be pasted, as before.

An install from before networks were chosen in the app kept the networks it offered in
`TRIODITIS_NETWORKS`. The installer no longer reads that as its choice, so the first rerun
moves it to every network (pass `--networks` to limit it again), and admins install the ones
they want in the app. It also removes the fake network, which this version no longer has: its
bridge host, its database and its volume, which only ever held made-up chats, and the test
endpoint that `--e2e` added.

## What's running

| Service            | What it is                                                                         | Exposed                       |
| ------------------ | ---------------------------------------------------------------------------------- | ----------------------------- |
| `caddy`            | The web app, and the proxy to everything below                                     | Yes: the only published port  |
| `hairpin`          | Only behind a proxy on this machine: see HTTPS in local mode                       | On Docker's host address      |
| `loopback`         | Only on a loopback address: see Local mode                                         | No: in the backend's network  |
| `backend`          | The Convex backend, on Postgres                                                    | No                            |
| `postgres`         | Postgres 17: Convex's data and each bridge host's                                  | No                            |
| `functions`        | One-shot: sets Convex's environment, deploys the functions and runs the migrations | No                            |
| `gateway`          | Moves events between bridge hosts and Convex                                       | No                            |
| `bridge-<network>` | A bridge host: runs that network's connector                                       | No                            |
| `login-browser`    | The sign-in browser: a Chromium for each website login (see Networks)              | No: only the `signin` network |

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
| `/login-browser`                         | The sign-in browser's websocket, to the gateway's public listener (port 8602), which checks the ticket and relays it to the bridge host running the login                    |
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
else (`deploy/scripts/check-ports.sh`).

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

With the updater on (the default), update from the app: **Admin settings → Updates**. It backs
the server up first and puts that backup back if the update fails (see [Updates](#updates)).
By hand, with the updater off:

```sh
deploy/trioditis backup ~/trioditis-backups
git pull --ff-only
deploy/install/install.sh
```

The checkout is on a branch (`dev` from the install above; the updater keeps it on the
channel's branch, `main` or `dev`), so `git pull` moves it forward. A checkout an older updater
left detached (`git status` says `HEAD detached`) needs `git checkout dev` (or `main`) first.

The rerun keeps every secret and every setting the last run saved in `deploy/.env`: the
mode, the domain or public URL, the port, the bind address and host, the networks
(`--networks`) and `--updater`. Pass an option only to change that one. It rebuilds the images from the new
checkout, redeploys the functions, restarts what changed, and removes services that are no
longer enabled. After each deploy of the functions, it runs pending migrations, which fix rows
an older version wrote, so an upgrade needs nothing run by hand. It calls their one entry
point, `migrations:runAll` in `packages/backend/convex/migrations.ts`, directly on this
install's backend with its admin key. That runs every migration in order, every deploy,
since each is safe to run again. A backend without `runAll` (an older version) is skipped
with a note. `runAll` waits for the first batch of each migration, and a failure there stops
the install with its error (`deploy/trioditis logs functions`, and the backend's log for the
details). Later batches run in the background, so a failure in one of those shows in the
backend's log (`deploy/trioditis logs backend`) rather than failing the install.

Schema changes and migrations only go forward. A new version's schema is deployed onto the data
as it is, its migrations rewrite rows into the new shape, and the Convex backend migrates its
own database in place the first time a new backend image starts. An older version's functions
may then refuse to deploy onto that data. So going back to an older version means restoring a
backup made at that version, not just checking it out: that's what the updater does after a
failed update, and why you back up before upgrading by hand.

The database images are pinned and move only when the bundle changes them. Postgres opens only
data from its own major version and the bundle doesn't upgrade it in place, so the installer
stops, changing nothing, if this install's database is from another major version. An upgrade
that changes the Postgres or Convex backend image runs only once there's a backup made at the
version installed now (backup records it in `deploy/.last-backup`), so there's one to go back
to; pass `--without-backup` to go on without one.

## Updates

Admins update the server from the app: **Admin settings → Updates**. The updater that does it
is on by default, and the installer turns it off or back on (the setting is kept, like the
others):

```sh
deploy/install/install.sh --no-updater    # stops and removes it, to update by hand (Upgrade)
deploy/install/install.sh --updater       # turns it on again
```

It needs systemd and a git checkout with an `origin` remote to fetch from. Where it can't run
(no systemd, a shell that can't reach the operator's systemd user manager, as from `sudo` or
`su`, a unit directory it can't write, or a checkout that isn't a git clone of its own), a new
install turns it off and says why, and `--updater` stops the install before it saves a setting
or touches the server, until it can. If the service still can't be installed once the server is
up, an install that has the updater on by default, not asked for, keeps the server running and
turns the updater off, saying why. An install from before the updater gets it on at its next
upgrade, as a new one would; one that turned it off keeps it off. Until its service has been
installed once, the updater is only on by default, so a first install that was cut off and is
run again from a shell where it can't run goes on with it off rather than stopping.

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
**Release notes** lists, by label, the notes of the changes an available update brings, and
once the updater has installed one, **What's new** lists that update's notes until the server
moves on. Each change writes its own note in `release-notes/` (docs/CONTRIBUTING.md, Release
notes); the updater collects the note lines the new commit adds, so an update made by hand,
with the installer, shows none.

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
3. To update, it backs the server up first, with `deploy/trioditis backup --keep-stopped` (see
   [Backup and restore](#backup-and-restore)): the server stops for the backup and stays
   stopped until the new version starts, so nothing it does after the backup could be lost by
   going back to it. If the backup fails, the server starts again, nothing is installed and the
   page says why. Its backups go in an `updater-backups` directory of its own, inside
   `UPDATE_BACKUP_DIR` from `deploy/.env` if you set one (an absolute path, outside the
   checkout), else inside `~/.local/state/trioditis/<project>` of the operator's user; it keeps
   the newest three there, and never touches anything else in that directory. They're
   encrypted like any backup, and need room: about the size of the server's data each.
4. It moves the checkout's local branch for the channel (`main` or `dev`, following the
   remote's) to that commit, so the checkout stays one `git pull` works in, and runs the
   installer, the same as [Upgrade](#upgrade): every setting is kept, and only what changed
   restarts. Then it exits, and systemd starts the new version of the updater. A local branch of
   that name with commits the channel doesn't have is left alone, and the checkout is moved
   detached instead.

It only ever moves forward: it installs a commit only when the checkout is behind the branch
and has nothing the branch lacks, so switching from Nightly to an older Stable leaves the
server where it is until Stable passes it, and a branch that was rewritten or diverged is
never installed. A server ahead of its channel says so on the page (after a check, an
update, or the hourly look), and, when it's on the other channel's branch (as after installing from `dev` while admins have Stable), names that
channel to choose. It won't move a checkout with changes to tracked files. It takes the
install's lock before it moves the checkout and holds it until the installer is done (the
installer it runs uses that lock rather than taking its own), so a backup or an install the
operator starts can't run in between; if one is already running, the update says so and
doesn't start. If the installer fails, it checks out the commit it was on and restores the
backup from before the update, data and settings (`deploy/trioditis restore`, which first keeps a
backup of the failed state beside it and then runs the installer), since the failed version's
migrations or database images may have changed the data in ways the older code can't read. The
older code never runs on that data otherwise: if the backup is gone or can't be restored, the
updater stops the server, checks with Docker that nothing of it is still running, and the report
says so, for you to restore the backup by hand; if it can't confirm the server stopped, the update
stays in progress, as going back, and the updater tries again when it next starts. An update cut
off while the server was being backed up (before anything was installed) starts the server again
as it was when the updater next starts, and is reported as not installed; until the server
starts, the update stays in progress and the updater tries again on each start. While going
back can't be confirmed, the page shows the update as still updating, so it can't be cancelled
or replaced. It
reports both the failure and the way back; a commit whose update failed
isn't tried again automatically (Update now still tries it). The installer runs with `--no-setup-link`, since its
output goes to the journal.

A request can be cancelled until the updater claims it, just before it moves the checkout;
after that the update runs to the end. The claim names the channel too, so an update, automatic
or asked for, doesn't start for a channel admins have switched away from meanwhile, nor an
automatic one once they've been turned off (switching
also makes a waiting request again, for the new channel). What must outlast a restart is in
`deploy/.updater-state`: the update in progress, its backup, and whether it was installing or going back,
how the last one ended until the backend has that report, the day of the last automatic
update, and the commit whose update last failed. An update cut off midway (the machine or the
service stopped, or its state couldn't be saved) goes back to the commit it was on when the
updater next starts, before anything else, restoring its backup, since how it would have ended isn't known; it counts
as failed, so it isn't tried again on its own. A request whose update is over is reported done,
and never run a second time: until the backend has that report, the updater sends it again and
starts no other update.

While the updater is on, update from the app rather than pulling by hand: a pull skips the
backup the updater takes first. Don't edit tracked files in the checkout; the updater won't move
one that has changes. A private repository needs a `git fetch` that works without a prompt for
the operator's user (a deploy key or a credential helper).

### Updating live

An update doesn't sign anyone out, but it does stop the server: from the backup before it
until the new version's functions and migrations have run. The installer then starts the
gateway, Caddy and the sidecars, and the bridge hosts once the gateway is healthy, so a version
whose functions or migrations fail never takes a write or sends anything. What's left is the
installer's last checks, that the gateway, Caddy and the bridge hosts become healthy (up to 90
seconds each): if one fails there, going back restores the backup, so what people did in those
seconds is lost from the server, and a send that went out then comes back from the backup as
never sent (the person still has the message they wrote; the network has it too). A manual
upgrade with the installer starts in the same order, without the stop. Within a run, as before:

- On a manual upgrade, the Convex backend and Postgres keep running (their images are pinned, and move only when
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
  its own, then reloads by itself if it's in the background with nothing unsaved (no draft or send under way, nothing typed in any field) and no settings, dialog or menu open,
  and otherwise offers a reload.

## Encryption at rest

Trioditis seals stored messages, chat names and contact names to each person's own keys, so
the Convex database holds ciphertext. The network connectors are different: they keep their
own state in the bridge database, and some of it is plaintext, including chat names, contact
names, phone numbers, and history the connector has received but not yet imported.

So in this version, **the server's disk must be encrypted**. Backups are encrypted by
`deploy/trioditis backup` itself, with the install's `BACKUP_KEY` (see
[Backup and restore](#backup-and-restore)), so that state is never in a backup in the clear.
The installer warns when Docker's data isn't on an encrypted volume (LUKS / dm-crypt). It
only sees dm-crypt on this machine's own block devices, so it warns about a VM whose host
encrypts its storage, or about encryption it doesn't recognise (such as ZFS native
encryption or a self-encrypting drive): treat it as a reminder, not a guarantee. On a VM, encrypt the guest's disk or the storage it lives on. On
Proxmox, use encrypted storage for the VM. Encrypting those connector tables with a server-held key is planned for Phase 1
(`docs/PLAN.md`, Known follow-ups).

## Backup and restore

Online and scheduled backups are Phase 1. For now, `deploy/trioditis` takes a consistent,
encrypted backup while the server is stopped, and restores one:

```sh
deploy/trioditis backup ~/trioditis-backups
deploy/trioditis restore ~/trioditis-backups/trioditis-20261120-040000
```

A backup is a directory, `<project>-<date>-<time>` (with `-2`, `-3`… added rather than
replace an earlier one), 0700, holding three 0600 files, readable only by you:
`archive.enc` (every Docker volume of this install's Compose project, found by the label
Compose gives them, so never another install's, and including the volume of a network you've
dropped), `secrets.env.enc` (`deploy/.env` without the server's keys: see
[The server's keys](#the-servers-keys)), and `backup.info` (unencrypted: the format, the
project, the version the backup is from and when it was taken, which is what a restore needs to
know first). The archive's last entry is a manifest of every volume with its number of entries
and bytes, when the backup was taken, the version, and the Postgres major version of its data.
The backup stops the server, writes the files in a private directory beside the destination,
reserves the name with `mkdir` (which fails if anything is there, so it moves on to the next
suffix), renames the private directory onto it in one step, checks the files are there, and
starts again the containers that were running (only those: not the finished functions job, nor
a service you'd stopped), in the order their dependencies need, each healthy within two minutes
before the next starts (one that's running but briefly unhealthy is waited for; one that stops
isn't); if one isn't healthy in time, it stops there, names it, and the backup counts as failed
(`deploy/trioditis up -d` starts the rest). So there's
either a whole backup at the name or none: an interrupted backup (Ctrl-C), even while the
server is still stopping, leaves nothing behind, and if the server doesn't start again the
backup counts as failed. The destination must be outside the checkout (symlinks resolved,
before anything is made there): image builds copy the checkout.

The backup's copy of `deploy/.env` (keys included), and the settings it puts together, checks and
encrypts, stay in a private directory in memory (the user's runtime directory, or `/dev/shm`),
so neither the checkout nor the destination ever gets them: the destination only gets the
encrypted files and `backup.info`. Both files are encrypted with `BACKUP_KEY`, a random key the installer makes into
`deploy/.env` (`deploy/scripts/backup-crypt.mjs`, run in the bundle's Node image with no
network: AES-256-GCM in 64 KiB chunks under a key derived for each file, so a file that's
damaged, cut short or reordered doesn't decrypt). The archive goes straight from the volumes
into the encryption and never reaches the disk in the clear. That covers what the network
connectors keep in plaintext in the bridge database (see
[Encryption at rest](#encryption-at-rest)): it's in the backup, so a restored server still has
its logins, but only encrypted. Like the private keys, `BACKUP_KEY` is never in a backup;
`keys export` keeps it with them. Without it a backup can't be opened, so export the keys again
after this upgrade (the installer makes `BACKUP_KEY` on its next run, and backup refuses to run
until it has).

`secrets.env` holds only the settings the installer writes, as `NAME=value` lines: the names
listed in `deploy/install/env-names`, never the private keys or `BACKUP_KEY`, and nothing else,
not even a comment. Anything else in `deploy/.env` (a setting you added yourself) stays out of
the backup, and the backup names it, without its value, so you can keep it yourself. Before it
is encrypted, a second reader checks that `secrets.env` holds every listed setting from
`deploy/.env` exactly once, with its value, and nothing else; and, as a last check, the backup
won't be published if any key's value appears anywhere in it. If a check can't run, nothing is
published.

`deploy/.env` has one form, which the installer, backup, restore and `keys` all read the same way
(`deploy/scripts/env.sh`): `NAME=value` lines, each name once, no carriage returns, and
every value literal, made only of `A-Z a-z 0-9 . _ ~ : / @ + = , % -`. So there's nothing for
Compose to read differently: no `${…}` to fill in, no quotes, no spaces to trim, no `#` to
start a comment. Three settings are a little wider, each only as far as the value the
installer writes needs: `CONVEX_ADMIN_KEY` may hold `|`; `CADDY_GLOBAL_OPTIONS`,
`CADDY_TRUSTED_PROXIES` and `INSTALL_TRUSTED_PROXIES` may be several words separated by
single spaces; and the two private keys and `BACKUP_KEY` must each be exactly a key (43
characters of unpadded base64url). The settings you may add by hand are narrower, so a typo
stops the installer rather than the service that reads it: `LOGIN_BROWSER_MAX` is a whole number
from 1 to 64, `DEBIAN_SNAPSHOT` a snapshot time such as `20261101T000000Z`, and
`UPDATE_BACKUP_DIR` an absolute path. Comments (`#` lines) and blank lines are allowed.
Anything else is refused: by the installer, which also refuses any option's value outside that
form (a space in `--bind`, or a value spanning lines, which would read as a second setting), by
backup and restore before they make anything, and by every `deploy/trioditis` command that can
start a service. A NUL or a carriage return anywhere in the file is refused before it's read at
all. Everything the installer writes goes through one writer, which saves only names
`deploy/install/env-names` lists, the two private keys, or `BACKUP_KEY`.

### Restore

`deploy/trioditis restore <backup>` puts a backup back: the data of every volume and the
settings. It asks before it changes anything (`--yes` skips that). In order:

1. **It checks the backup through, before anything stops.** The backup must open with this
   install's `BACKUP_KEY`, be of this install's Compose project, and be sealed to this server's
   keys: its bridge and agent-access public keys must be the ones in `deploy/.env`, whose
   private halves open the sends, login input and agent grants in it, so those come back as
   they were, sealed, and agents keep exactly the access people granted. It must be from the
   version this checkout is at, whose schema wrote its data; if it isn't, the restore says which
   version to check out (`backup.info` names it too) and changes nothing. A backup from an older
   version this one descends from restores with `--from-older-version`, and the installer then
   runs this version's migrations on it; a newer one never does. Each private key in
   `deploy/.env` (or the key file) must be its public key's private half, derived to check. Then
   the whole archive is decrypted and read: its manifest, every entry inside a volume it lists,
   and its Postgres major version the one this bundle runs (read from the archived data for a
   backup whose manifest doesn't say). Both files are bound to the backup's ID in `backup.info`,
   so one backup's archive beside another's settings doesn't open, and the manifest must name
   the same ID and version as the settings.
2. **It stops the server and backs it up as it is**, with `deploy/trioditis backup`, beside the
   backup being restored (or in `--recovery-dir <dir>`), so the restore can be undone with
   `deploy/trioditis restore <that backup>`. If that backup fails, the server starts again and
   nothing has changed.
3. **It replaces the data.** From here interrupts are held off. First it closes the gate:
   it writes `deploy/.restore-settle` (saying `loading`) and `RESTORE_PENDING` into
   `deploy/.env`, and removes the gateway's container and every bridge host's (those of
   networks no longer enabled too), checking with Docker that none is left: each was made with
   the settings from before, and anything that makes them again makes them from `deploy/.env` as
   it is now. While the marker says `loading` the
   installer starts nothing, not even Postgres, since the data may be half one and half the
   other; it says `ready` only once the volumes and the settings are the backup's and checked. Until the installer has settled the restored sends, `deploy/trioditis`
   refuses `up`, `start`, `restart`, `run` and the like, and Compose hands the gateway
   `RESTORE_PENDING`, which it refuses to start with, however it's started. Then it empties
   every volume the backup has (making any that's missing), fills it from the archive, owners and
   modes as they were, and checks each against the manifest's count of entries and bytes. If that
   fails partway, it puts the copy from step 2 back and checks it the same way, and only then
   opens the gate and starts the server as it was; if that fails too, the gate stays closed.
   Volumes the backup doesn't have (a network added since) are left as they are. Every restore has an ID of its own, kept for good in `deploy/.env` as `RESTORE_ID` and
   given to every bridge host. Each bridge host's own queue of commands, in its database, is the
   backup's too, and its database keeps the last restore it settled: on a start with a
   `RESTORE_ID` it hasn't, it records every send in the queue, queued or started, as `unknown`
   instead of running it (and ends logins in progress), reports that through its journal like
   any send status, and only then records the ID. That follows the database itself, whichever
   volumes the backup had.
4. **It restores the settings**: the backup's, with this server's private keys and
   `BACKUP_KEY` (the backup has only the public halves, the same ones) and any setting you
   added by hand, which backups leave out.
5. **It starts the server through the installer**, which builds this version's images and,
   while the gate is closed, deploys the functions and settles the restored sends (the marker
   then says `settled`), starts the gateway (below), and opens the gate only once Docker shows
   every bridge host's container made with this restore's `RESTORE_ID`; then checks everything is healthy. Its check that an
   upgrade changing the database images has a backup doesn't apply: the data is the backup's.
   If the installer fails, the data and settings are the backup's and the gate stays closed: fix
   the cause and run the installer again, which settles before it starts anything that sends.

**Sends in a backup are never sent twice.** The backup is a moment in the past, and the server
ran on after it, so a send it holds as still on its way (queued, handed to the gateway, or
accepted by a bridge host without an outcome) may have gone out since. Before the gateway
starts, every such send becomes `unknown` (`gateway.settleAfterRestore`, through
`deploy/scripts/settle-restore.mjs`): it isn't sent again, and the person sees it and decides,
as with any send whose outcome isn't known (docs/PLAN.md, Reliability). So does every
scheduled message, even one whose time is still to come, since one sent early with **Send now**
after the backup can't be told apart: each shows in its chat as a send whose outcome isn't
known, for the person to send again or discard, and none goes out on its own. So does a send
the backend marked failed as it started because its deadline passed while the backup sat on
disk (it may have gone out meanwhile). Logins, logouts and new chats waiting on such a command
end as if it expired, and can be started again. A removed member's logout, or the logout a
cancelled login's account gets, isn't queued again while the queue is settled (it would only be
expired with the rest); each is queued once, after.

What a restore can't bring back: anything that happened after the backup (messages that arrived
since come in again only if the network sends its history again), and the networks' own view of
the connector state. A connector restored to an older state may need signing in to that network
again, and Signal, whose sessions move forward with every message, usually does.

**After losing the server**, check out the version the backup is from (`backup.info` says) in
a new clone, and restore onto it with the key file you exported:

```sh
git clone https://github.com/NotAKerbal/trioditis.git && cd trioditis
git checkout <version from backup.info>
deploy/trioditis restore --keys ~/trioditis-server-keys.env <backup>
```

With no install there, `--keys` brings the server's keys: each pair must be the one the backup
is sealed to, and the file's `BACKUP_KEY` opens the backup. A checkout with no install can't
stop or back up another checkout's server, so if the backup's project already has volumes or
containers on this Docker, or a volume of any of the names the backup's would take (labelled by
Compose or not), the restore refuses: restore from that install's own checkout. If Docker's
volumes or containers can't be listed, it refuses too. The volumes it makes carry its restore
ID (`trioditis.restore`), and it only ever empties one that does. If it's cut off, running it
again with the same backup carries on from the volumes that run made (its marker,
`deploy/.restore-settle`, names the backup, by its ID or, for an older backup without one, a
fingerprint of its files, and the run), even once it has written `deploy/.env`. The restore writes `deploy/.env`
from the backup's settings and those keys, restores the volumes, and runs the installer, which
builds the images and starts the server. Then update from the app as usual.

An older, unencrypted backup (`archive.tgz` and `secrets.env`, from before backups were
encrypted) still restores, with a warning; back up again once it has, and delete it.

Backup, restore, the installer, `create-admin`, `keys import`, and every `deploy/trioditis`
Compose command that can start, stop or change services take a lock in `deploy/`, so only one of
them runs at a time for an install; the backup and installer a restore or the updater runs use
the lock they're handed. Only read-only commands (`ps`, `logs`, `config`, `top`,
`images`, `ls`, `port`, `version`, `events`) run beside them. A backup takes the lock before
it reads `deploy/.env`, and uses that one reading throughout.

### The server's keys

The server has two private keys, in `deploy/.env`: `BRIDGE_PRIVATE_KEY`, which opens what
clients seal to the bridge host (sends, including scheduled ones waiting for their time, and
login input), and `AGENT_ACCESS_PRIVATE_KEY`, which opens the chats people grant to agents.
A backup holds that sealed content, so a backup that also held the keys could be read by
anyone who got it. Backups leave both keys out, and `BACKUP_KEY`, which opens the backups
themselves (and nothing in the volumes holds them: the bridge host reads its key from the
environment, and the Convex backend only gets the public halves). Keep a copy of the keys
apart from the backups instead:

```sh
deploy/trioditis keys export ~/trioditis-server-keys.env
```

It writes the two pairs and `BACKUP_KEY` to a new file, readable only by you, and never over
an existing one or inside the checkout. Keep that file somewhere the backups aren't, such as a password
manager or offline media, and delete the copy on the server. Without it, a lost server's
backups can't be opened. `keys import <file>` puts the private keys (and the file's
`BACKUP_KEY`, if it has one) back into a `deploy/.env` that has only the public ones; after
losing the server, `restore --keys <file>` does that as part of the restore. It refuses a pair whose
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
their `.env`, and by 15f1f45, in `secrets.env`) contain both private keys, and backups made
before backups were encrypted hold the connectors' plaintext state in the clear. Keep them as
carefully as the server itself, or replace them with new backups and delete them.

### Building the same images again

Every base image is pinned by digest (`deploy/docker/*.Dockerfile`, and the Postgres, Convex
backend and Alpine images in the compose files), the Node packages install exactly as
`pnpm-lock.yaml` locks them (`--frozen-lockfile`, with the pnpm version `package.json` pins),
the Go modules as `go.sum` checks them, and libsignal from a tag checked against its commit with
`cargo build --locked`. The Debian packages the bridge host and sign-in browser images install
are the newest by default, so they get security fixes (Chromium's above all); to build exactly
the same ones again, set `DEBIAN_SNAPSHOT=<time>` in `deploy/.env` (a
[snapshot.debian.org](https://snapshot.debian.org) time, such as `20261101T000000Z`) and run the
installer: it takes the packages as they were then. Unset it again to get fixes.

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
and the bundle's Node image (pulled if missing), and `flock`; `restore.sh` also needs git.
`install-settings.sh` runs the installer against a stub `docker` and needs none of that,
`updater.sh` a stub `docker` and git, and `backup-crypt.sh` only node.

| Test                  | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup-crypt.sh`     | What the backup encryption encrypts decrypts to the same bytes at every size around its chunk boundary; a file cut short, changed, or opened with another key fails; a `BACKUP_KEY` that isn't exactly a key is refused (needs node, not Docker)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `restore.sh`          | A restore refuses, changing nothing, without `--yes` and a terminal, with another `BACKUP_KEY`, another server's keys, a damaged archive, another version (an older one only with `--from-older-version`), or another Postgres major version; it restores every volume, owners and modes included, keeps the server's keys and hand-added settings, backs the server up first (and that copy restores it), and runs the installer holding the lock with the settle marker; a failing installer leaves the gate closed, and while it is `up`, `start`, `restart` and `run` are refused and the gateway would get `RESTORE_PENDING`; one backup's archive beside another's settings, and a private key that isn't its public key's half, are refused; with no install, it won't overwrite a project another checkout has on this Docker; volumes that don't match the manifest put the server back as it was; an older unencrypted backup restores; with no install, it restores with `--keys` |
| `backup-publish.sh`   | A cold backup works and starts nothing; it is a 0700 directory of 0600 files, both encrypted with `BACKUP_KEY` and opening with it, and neither holds a key; one without a `BACKUP_KEY` is refused; a name taken by a file, directory or symlink moves the backup to the next one; a rename that silently does nothing fails it; Ctrl-C while it streams leaves nothing behind; so does Ctrl-C after it reserved its name; a `deploy/.env` not in `NAME=value` form (which could hide a private key) is refused                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `backup-restart.sh`   | A backup starts again only the containers that were running: not a finished one-shot job a running service depends on, nor a stopped service                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `keys.sh`             | `keys export` writes the keys and `BACKUP_KEY` to a new 0600 file, never over another or inside the checkout; `keys import` adds the private keys, and refuses a pair that isn't this server's or whose private key isn't the saved public key's half (mixed pairs); neither prints a key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `lock.sh`             | Nothing may come before the command (`-p`, `-f`, `--env-file`, `--project-directory`, `--dry-run`, an unknown option) and unknown commands are refused; `logs -f` passes; while the lock is held, `start`, `up`, `stop`, `create-admin` and `backup` are refused and `ps`, `config` and `logs` run; a command that can start a service is refused while `deploy/.env` has a setting out of its form (`LOGIN_BROWSER_MAX=lots`); `restore` with no install asks for the key file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `env-source.sh`       | Exported variables, `COMPOSE_*` ones included, don't override `deploy/.env` for Compose, with several compose files saved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `caddy-headers.sh`    | The backend is told the address Caddy saw, never one a client sent (on `/api/auth/*` and `/convex/http/*`); a trusted proxy's `X-Forwarded-For` is used, rightmost first, and an untrusted peer's is ignored; and, published as each mode publishes it, the client address in each mode, IPv6 included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `ports.sh`            | Only Caddy is published, for every combination of compose files, and no sidecar forwards to the backend's ports; the check catches a published backend                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `install-settings.sh` | An unreadable `deploy/.env` stops the installer unchanged; a symlinked `runtime/config.json` is replaced, not followed; Compose gets no exported value; half a key pair stops the installer, and only `--new-server-keys` makes a new one; every network is bridged by default, but Telegram only with its credentials; `--networks` limits them and is kept, and an unknown one (`fake`) stops the installer; an install from before moves to every network and loses the fake network and `--e2e`; the updater is on by default in a git checkout with an `origin` remote, off (saying why) outside one, kept off once turned off, and `--updater` where it can't run stops the installer unchanged; a fresh install makes `BACKUP_KEY`; a symlinked `deploy/runtime` is refused before anything is made there; `LOGIN_BROWSER_MAX`, `DEBIAN_SNAPSHOT` and `UPDATE_BACKUP_DIR` out of their form stop it, unchanged                                                                        |
| `updater.sh`          | Against a throwaway git remote, a stub installer and a stub `deploy/trioditis`: the updater backs up first, leaving the server stopped (and installs nothing if that fails), moves the channel's local branch to its newest commit, installs it and reports it done; after a failed install it goes back to the commit it was on, restores the backup from before, and reports the installer's error (and, if the restore fails, stops the server rather than run the older code, and says so); an update cut off after its backup goes back by restoring it; it keeps three backups, in its own directory, never touching one the operator put beside them; the hourly look names the channel a server ahead of its own is on; it leaves a checkout that's up to date, ahead of the channel (naming the channel it's on), diverged from it, or has local changes where it is                                                                                                                |

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

## A second, test install

To run a second, throwaway install on the same machine without touching the first, give it
its own Compose project (which also names its images and volumes) and port, from a separate
checkout so it has its own `deploy/.env`. `TRIODITIS_PROJECT` only names a new install: an
existing one keeps the project it was installed with (`trioditis` for one from before the
name was saved), and the installer refuses a different one, which would start an empty
server beside it. `deploy/trioditis` always uses the saved project, whatever
`COMPOSE_PROJECT_NAME` says.

```sh
TRIODITIS_PROJECT=trioditis-test deploy/install/install.sh --host 127.0.0.1 --bind 127.0.0.1 --port 18080 --no-updater
```

`--no-updater` keeps it from starting an updater of its own, a systemd service that removing
its containers would leave behind. Remove it with `deploy/trioditis down -v` in that checkout
(and, if it has an updater, `deploy/install/install.sh --no-updater` first).
