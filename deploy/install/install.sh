#!/usr/bin/env bash
# Installs (or upgrades) a Trioditis server on this machine with Docker Compose.
#
#   deploy/install/install.sh                         # local mode: http://<this machine>:8080
#   deploy/install/install.sh --port 9000 --host 192.168.1.20
#   deploy/install/install.sh --public-url https://box.tailnet.ts.net:8443  # behind Tailscale Serve
#   deploy/install/install.sh --domain chat.example.com   # HTTPS with ACME
#   deploy/install/install.sh --networks whatsapp,signal  # only these bridge hosts, not all
#   deploy/install/install.sh --no-updater                # update it by hand, not from the app
#
# It's safe to run again: settings and secrets are kept in deploy/.env, so a rerun with no
# options keeps the install as it is, and an option changes only its own setting. A rerun
# rebuilds the images from this checkout, redeploys the functions and restarts what changed.
# TRIODITIS_PROJECT=<name> in the environment picks another Compose project name (and image
# and volume names) for a new install, such as a second, test one on this machine. An
# install keeps its project for good. See docs/deploy.md.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/.." && pwd)
env_file="$here/.env"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'
Options (each one is kept for later reruns):
  --local              Serve plain HTTP on a port, with no domain (the default)
  --port <n>           Local mode's port (default 8080)
  --host <address>     The address people open, in local mode (default: this machine's
                       Tailscale IP if Tailscale is up, else its first LAN IP; '' detects
                       it again)
  --bind <address>     The interface local mode listens on (default 0.0.0.0, or 127.0.0.1
                       with --public-url; '' goes back to the default)
  --public-url <url>   Local mode behind something that serves HTTPS and forwards to the
                       port, such as Tailscale Serve: the https:// origin people open.
                       Pass '' to go back to plain HTTP
  --domain <name>      Domain mode: HTTPS on 80/443 for <name>, with ACME certificates
  --networks <list|all>
                       The networks this server runs a bridge host for, which admins can then
                       install in the app (Admin settings, Networks). Comma-separated:
                       whatsapp, signal, gmessages, gvoice, telegram, meta, instagram, slack,
                       groupme, linkedin, twitter, bluesky; or all (the default; Telegram
                       only with its API ID and hash). Fewer suit a small machine
  --trusted-proxies <ranges>
                       With --public-url: the addresses Caddy takes X-Forwarded-* headers
                       from, as Caddy ranges (default on a loopback bind: the loopback and
                       the server network's gateway; required with any other --bind: the
                       proxy's address)
  --new-server-keys    Only when the server's private keys are lost: make new key pairs.
                       Sends sealed to the old bridge key then fail, and agent access must
                       be granted again (docs/deploy.md, Keys lost). Not kept for reruns
  --telegram-api-id <n>, --telegram-api-hash <hash>
                       The App api_id and api_hash from https://my.telegram.org/apps, which
                       Telegram needs from whoever runs the bridge (required with telegram
                       in --networks; without them, all leaves Telegram out)
  --updater, --no-updater
                       Run the updater, a systemd service that updates this install from
                       its git remote when admins ask in the app or on their schedule, or
                       stop and remove it (default on, where systemd can run it;
                       docs/deploy.md, Updates)
  --no-setup-link      Don't print the admin setup link (the updater's runs, whose output
                       goes to a log). Not kept for reruns
  --without-backup     Upgrade even though this version changes the database images and
                       there's no backup from the version installed now (docs/deploy.md,
                       Upgrade). Not kept for reruns
EOF
}

# Each option stays unset unless it's passed, so the saved setting applies.
unset -v mode port host bind proxy_url trusted domain networks telegram_api_id telegram_api_hash updater
local_flag=0
new_server_keys=0
setup_link=1
without_backup=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port | --host | --bind | --public-url | --trusted-proxies | --domain | --networks | --telegram-api-id | --telegram-api-hash)
      [ $# -ge 2 ] || die "$1 needs a value."
      ;;
  esac
  case "$1" in
    --local) mode=local; local_flag=1 ;;
    --port) port=$2; shift ;;
    --host) host=$2; shift ;;
    --bind) bind=$2; shift ;;
    --public-url) proxy_url=$2; shift ;;
    --trusted-proxies) trusted=$2; shift ;;
    --domain) mode=domain; domain=$2; shift ;;
    --networks) networks=$2; shift ;;
    --telegram-api-id) telegram_api_id=$2; shift ;;
    --telegram-api-hash) telegram_api_hash=$2; shift ;;
    --new-server-keys) new_server_keys=1 ;;
    --updater) updater=1 ;;
    --no-updater) updater=0 ;;
    --no-setup-link) setup_link=0 ;;
    --without-backup) without_backup=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ -n "${domain+set}" ] && { [ "$local_flag" = 1 ] || [ -n "${proxy_url:-}" ]; }; then
  die "Pick one: --domain, or local mode (--local, --public-url)."
fi
# --public-url is a local-mode setting, so passing it switches to local mode.
[ -z "${proxy_url+set}" ] || [ -n "${domain+set}" ] || mode=local
local_flags_given="${port+--port }${host+--host }${bind+--bind }"

# --- Prerequisites ------------------------------------------------------------------------

command -v docker >/dev/null || die "Docker isn't installed. Install Docker Engine and the Compose plugin, then run this again."
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin isn't installed (docker compose)."
docker info >/dev/null 2>&1 || die "Can't talk to Docker. Add yourself to the docker group (and log in again), or run this as a user who can."
# The sign-in browser's network gives the server no address only from Docker 28 on
# (compose.yml, signin); an older Docker would leave the server's own services reachable from
# the browser.
docker_major=$(docker info --format '{{.ServerVersion}}' 2>/dev/null | cut -d. -f1)
case "$docker_major" in
  '' | *[!0-9]*) die "Can't tell which Docker Engine this is (docker info)." ;;
esac
[ "$docker_major" -ge 28 ] || die "Trioditis needs Docker Engine 28 or later; this is $(docker info --format '{{.ServerVersion}}'). Upgrade Docker, then run this again."

case "$(uname -m)" in
  x86_64 | amd64 | aarch64 | arm64) ;;
  *) die "Unsupported CPU architecture $(uname -m): Trioditis runs on x86_64 and arm64." ;;
esac

docker_root=$(docker info --format '{{.DockerRootDir}}')
free_kib=$(df -Pk "$docker_root" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "${free_kib:-}" ] && [ "$free_kib" -lt $((8 * 1024 * 1024)) ]; then
  die "Less than 8 GiB free where Docker keeps its data ($docker_root). Building the images needs about 4 GiB, and the server needs room to grow."
fi

# Encryption at rest is the disk's job in Phase 0: the connectors keep some state (names,
# phone numbers, history not yet imported) in plaintext in the bridge database. This only
# sees dm-crypt on this machine's own block devices, so it can't vouch for encryption below
# a VM or done some other way.
encrypted_volume() {
  local source
  source=$(findmnt -no SOURCE -T "$1" 2>/dev/null | head -1) || return 1
  [ -n "$source" ] || return 1
  lsblk -s -no TYPE "$source" 2>/dev/null | grep -qx crypt
}
if ! encrypted_volume "$docker_root"; then
  warn "Docker's data ($docker_root) doesn't look like it's on an encrypted volume. Trioditis seals stored messages, but the network connectors keep names, phone numbers and history not yet imported in plaintext, so put this server's disk (and its backups) on encrypted storage. If it's encrypted in a way this can't see, such as on the VM host, ignore this. See https://docs.trioditis.app/self-hosting/backup-and-keys/#encryption-at-rest."
fi

# One install, backup or other write command for this install at a time (deploy/trioditis
# takes the same lock): they stop and start the server under each other.
if command -v flock >/dev/null; then
  # The updater runs this holding the lock on descriptor 9, which is then used as it is: a
  # lock it holds is this run's, and one anyone else holds still stops it.
  if ! { [ -e /dev/fd/9 ] && [ /dev/fd/9 -ef "$here/.operation.lock" ]; }; then exec 9>"$here/.operation.lock"; fi
  flock -n 9 || die "Another backup, install or change to this install is running."
else
  warn "flock (util-linux) isn't installed, so nothing stops a backup running during this install."
fi

# --- Settings -----------------------------------------------------------------------------

# The one parser and writer for deploy/.env: env_check, env_value, env_names, env_write.
# shellcheck source=deploy/scripts/env.sh
. "$here/scripts/env.sh"
# shellcheck disable=SC2034 # read by env_write, in env.sh
env_names_file="$here/install/env-names"
# literal_setting NAME VALUE: whether VALUE, all of it, is a value NAME may hold: one line (no
# newline or carriage return, which could slip a second setting in) in the literal form.
literal_setting() {
  case "$2" in *$'\n'* | *$'\r'*) return 1 ;; esac
  printf '%s=%s\n' "$1" "$2" | env_check >/dev/null
}
# The options' values, checked before any is used or saved.
check_option() {
  literal_setting "$2" "$3" ||
    die "--$1 must be one line of the characters A-Z a-z 0-9 . _ ~ : / @ + = , % - (no spaces, quotes or \$)."
}
[ -z "${host+set}" ] || check_option host INSTALL_HOST "$host"
[ -z "${bind+set}" ] || check_option bind INSTALL_BIND "$bind"
[ -z "${proxy_url+set}" ] || check_option public-url PROXY_URL "$proxy_url"
[ -z "${domain+set}" ] || check_option domain INSTALL_DOMAIN "$domain"
[ -z "${networks+set}" ] || check_option networks INSTALL_NETWORKS "$networks"
[ -z "${port+set}" ] || check_option port HTTP_PORT "$port"
[ -z "${telegram_api_id+set}" ] || check_option telegram-api-id TELEGRAM_API_ID "$telegram_api_id"
[ -z "${telegram_api_hash+set}" ] || check_option telegram-api-hash TELEGRAM_API_HASH "$telegram_api_hash"
# Several ranges, separated by commas or single spaces.
[ -z "${trusted+set}" ] || literal_setting INSTALL_TRUSTED_PROXIES "${trusted//,/ }" ||
  die "--trusted-proxies must be one line of ranges (A-Z a-z 0-9 . _ ~ : / @ + = % -), separated by commas or single spaces."
# deploy/.env appears with the first setting saved, after the options are checked, so an
# install exists exactly when it does. It's read once, here, and kept in memory: a read that
# fails stops the install, rather than looking like missing settings and secrets.
existing_install=0
env_text=''
if [ -e "$env_file" ] || [ -L "$env_file" ]; then
  existing_install=1
  if [ ! -f "$env_file" ] || [ -L "$env_file" ]; then die "deploy/.env isn't a regular file. Put the install's .env back there."; fi
  # Its raw bytes first: the shell would drop a NUL from what it reads, with only a warning.
  [ -r "$env_file" ] || die "Couldn't read deploy/.env, which holds this install's settings and secrets."
  env_raw_clean "$env_file" || die "deploy/.env holds a NUL or a carriage return. Fix it and run this again."
  env_text=$(cat "$env_file") || die "Couldn't read deploy/.env, which holds this install's settings and secrets."
  # It's kept in the one form this writes (deploy/scripts/env.sh), which backup relies on;
  # anything else is for the operator to fix.
  if ! problems=$(printf '%s\n' "$env_text" | env_check); then
    die "deploy/.env has lines not in the form this writes (NAME=value with a literal value, each name once): $(echo "$problems" | tr '\n' ';' | sed 's/;$//; s/;/; /g'). Fix them and run this again."
  fi
fi

get() { printf '%s\n' "$env_text" | env_value "$1"; }
has() { printf '%s\n' "$env_text" | env_names | grep -qx "$1"; }
# A restore (deploy/trioditis restore) still replacing the volumes and settings, or cut off while
# it did, leaves the data half one and half the other: nothing starts on it, Postgres included,
# until the restore has finished (deploy/.restore-settle says `ready`) or is run again.
if [ -e "$here/.restore-settle" ]; then
  restore_state=$(sed -n 's/^state=//p' "$here/.restore-settle" 2>/dev/null | head -1)
  [ "$restore_state" = ready ] || [ "$restore_state" = settled ] ||
    die "A restore didn't finish replacing the data and settings (deploy/.restore-settle says ${restore_state:-nothing}), so nothing was started. Run the restore again, or restore the backup it made of the server first."
elif [ -n "$(get RESTORE_PENDING)" ]; then
  die "deploy/.env says a restore is under way, but deploy/.restore-settle is gone, so nothing was started. Run the restore again."
fi
# Writes the runtime config, $2, to path $1 through a private temp file beside it, then a
# rename onto the exact name, so it's never half written and a symlink at the name is
# replaced, not followed. $3 is its mode. (deploy/.env is written only by env_write.)
write_file() {
  local tmp
  tmp=$(mktemp "$1.XXXXXX")
  if ! { printf '%s\n' "$2" >"$tmp" && chmod "$3" "$tmp" && mv -T "$tmp" "$1"; }; then
    rm -f "$tmp"
    die "Couldn't write $1."
  fi
}
# Sets NAME VALUE [NAME VALUE ...] in one atomic write, so a pair (such as a key pair) is
# never saved half. env_write refuses, and the install stops, if a value isn't literal or a
# name isn't classified: listed in deploy/install/env-names (what a backup keeps) or a
# private key (what it never does).
set_var() {
  local names='' text
  for ((i = 1; i < $#; i += 2)); do
    local value_index=$((i + 1))
    env_classified "${!i}" || die "Not saving ${!i}: it isn't a setting deploy/install/env-names lists, or a private key. (A bug in the installer: classify it there.)"
    # Each value on its own, before the file is put together: one with a newline in it would
    # otherwise read as two settings there.
    literal_setting "${!i}" "${!value_index}" || die "Not saving ${!i}: its value isn't one line of literal characters."
    names="$names|${!i}"
  done
  text=$(printf '%s\n' "$env_text" | grep -vE "^(${names#|})=" | sed '/^$/d' || true)
  while [ $# -ge 2 ]; do
    text="$text${text:+$'\n'}$1=$2"
    shift 2
  done
  printf '%s\n' "$text" | env_write "$env_file" || die "Couldn't save the settings (above)."
  env_text=$text
}
# Removes NAME's setting, the same way.
drop_var() {
  local text
  text=$(printf '%s\n' "$env_text" | grep -vE "^$1=" | sed '/^$/d' || true)
  printf '%s\n' "$text" | env_write "$env_file" || die "Couldn't save the settings (above)."
  env_text=$text
}
secret() { head -c "$1" /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
hex_secret() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
keep_or() { local current; current=$(get "$1"); [ -n "$current" ] || set_var "$1" "$2"; }

# What an option leaves unset comes from the last run. Installs from before these settings
# were saved under their own names get them from what that run wrote.
saved_mode=$(get INSTALL_MODE)
saved_proxy_url=$(get PROXY_URL)
mode=${mode-${saved_mode:-local}}
proxy_url=${proxy_url-$saved_proxy_url}
if [ -z "${domain+set}" ]; then
  domain=$(get INSTALL_DOMAIN)
  [ -n "$domain" ] || [ "$saved_mode" != domain ] || domain=$(get PUBLIC_HOST)
fi
[ "${port-x}" != '' ] || die "--port needs a value."
port=${port-$(get HTTP_PORT)}
port=${port:-8080}
if [ -z "${bind+set}" ]; then
  if has INSTALL_BIND; then
    bind=$(get INSTALL_BIND)
  else
    bind=$(get HTTP_BIND)
    if [ -n "$saved_proxy_url" ]; then default_bind=127.0.0.1; else default_bind=0.0.0.0; fi
    [ "$bind" != "$default_bind" ] || bind=''
  fi
fi
if [ -z "${host+set}" ]; then
  if has INSTALL_HOST; then
    host=$(get INSTALL_HOST)
  elif [ "$saved_mode" = local ] && [ -z "$saved_proxy_url" ]; then
    host=$(get PUBLIC_HOST)
  else
    host=''
  fi
fi
trusted=${trusted-$(get INSTALL_TRUSTED_PROXIES)}
trusted=${trusted//,/ }
# The networks with a bridge host: all of them unless the operator limits them. Which of those
# members are offered is for admins to choose in the app. TRIODITIS_NETWORKS isn't read: before
# INSTALL_NETWORKS, it held the networks offered (a choice that's now the admins'), so an
# install from then moves to every network.
[ "${networks-x}" != '' ] || die "--networks needs at least one network, or all."
networks=${networks-$(get INSTALL_NETWORKS)}
networks=${networks:-all}
# The Compose project names the install's volumes, so it never changes once there is one: a
# saved name wins, and an install from before it was saved is the default, trioditis.
# TRIODITIS_PROJECT only names a new install (no deploy/.env yet), and saying anything else
# is refused, since it would start an empty server beside the real one.
saved_project=$(get COMPOSE_PROJECT_NAME)
if [ -n "$saved_project" ]; then
  project=$saved_project
elif [ "$existing_install" = 1 ]; then
  project=trioditis
else
  project=${TRIODITIS_PROJECT:-trioditis}
fi
if [ -n "${TRIODITIS_PROJECT:-}" ] && [ "$TRIODITIS_PROJECT" != "$project" ]; then
  die "This install's Compose project is $project, and TRIODITIS_PROJECT=$TRIODITIS_PROJECT would start another, empty one. Unset TRIODITIS_PROJECT, or use a separate checkout for a second install."
fi
[[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || die "TRIODITIS_PROJECT must be lowercase letters, digits, '-' and '_'."
[[ "$trusted" =~ ^[A-Za-z0-9_.:/\ ]*$ ]] || die "--trusted-proxies takes IP ranges (CIDR) or private_ranges."

# Checked as text first, so a huge number never reaches the shell's arithmetic.
if ! [[ "$port" =~ ^[0-9]{1,5}$ ]] || [ "$((10#$port))" -lt 1 ] || [ "$((10#$port))" -gt 65535 ]; then
  die "--port must be a whole number from 1 to 65535."
fi
port=$((10#$port))

supported_networks=(whatsapp signal gmessages gvoice telegram meta instagram slack groupme linkedin twitter bluesky)
if [ "$networks" = all ]; then
  network_list=("${supported_networks[@]}")
else
  IFS=',' read -r -a requested_networks <<<"$networks"
  [ "${#requested_networks[@]}" -gt 0 ] || die "Pick at least one network, or all."
  network_list=()
  for network in "${requested_networks[@]}"; do
    [[ " ${supported_networks[*]} " == *" $network "* ]] ||
      die "Unknown network '$network'. This version supports: $(IFS=,; echo "${supported_networks[*]}" | sed 's/,/, /g'); or all."
    # Once each, so a network named twice still gets one bridge host.
    [[ " ${network_list[*]} " == *" $network "* ]] || network_list+=("$network")
  done
fi
# Telegram lets a client in only with an app's credentials, issued to whoever runs it. The
# bridge host checks them too, but an install that can't start Telegram stops here instead,
# when it was asked for by name; all just leaves it out until they're given.
telegram_api_id=${telegram_api_id-$(get TELEGRAM_API_ID)}
telegram_api_hash=${telegram_api_hash-$(get TELEGRAM_API_HASH)}
[ -z "$telegram_api_id" ] || [[ "$telegram_api_id" =~ ^[1-9][0-9]{0,9}$ ]] ||
  die "--telegram-api-id must be the number my.telegram.org shows as App api_id."
[ -z "$telegram_api_hash" ] || [[ "$telegram_api_hash" =~ ^[0-9a-fA-F]{32}$ ]] ||
  die "--telegram-api-hash must be the 32 hex digits my.telegram.org shows as App api_hash."
if [[ " ${network_list[*]} " == *" telegram "* ]] && { [ -z "$telegram_api_id" ] || [ -z "$telegram_api_hash" ]; }; then
  if [ "$networks" = all ]; then
    say "Leaving Telegram out: its bridge needs your own API ID and hash. To add it, create an app at https://my.telegram.org/apps, then run this again with --telegram-api-id <api_id> --telegram-api-hash <api_hash> (https://docs.trioditis.app/networks/telegram/)."
    without_telegram=()
    for network in "${network_list[@]}"; do [ "$network" = telegram ] || without_telegram+=("$network"); done
    network_list=("${without_telegram[@]}")
  else
    die "Telegram needs your own API ID and hash: create an app at https://my.telegram.org/apps, then run this again with --telegram-api-id <api_id> --telegram-api-hash <api_hash>. See https://docs.trioditis.app/networks/telegram/."
  fi
fi
# The bridged networks, comma-separated, as Compose (profiles) and the backend (what admins
# may install) read them.
bridged=$(IFS=,; echo "${network_list[*]}")
updater_asked=${updater+1}
updater=${updater-$(get INSTALL_UPDATER)}
# A saved 1 whose service was never set up (enabled), as after a first install cut off before
# then, is still only the default, not the operator's choice.
if [ -z "$updater_asked" ] && [ "$updater" = 1 ] && ! bash "$here/updater/service.sh" installed "$project" 2>/dev/null; then
  updater=''
fi
# The updater is on unless the install turned it off. Where it can't run (no systemd, or not a
# git checkout), a new install, or one from before the updater, gets it off and says why; one
# that asks for it stops here, before any setting is saved or the server touched.
updater_default=0
if [ -z "$updater" ]; then
  if reason=$(bash "$here/updater/service.sh" check "$project" 2>&1); then
    updater=1
    updater_default=1
  else
    updater=0
    warn "The updater is off, so admins can't update the server from the app: ${reason:-its check failed}. Once it can run, run this again with --updater."
  fi
elif [ "$updater" = 1 ]; then
  reason=$(bash "$here/updater/service.sh" check "$project" 2>&1) ||
    die "The updater can't run here: ${reason:-its check failed}. Fix that, or run this with --no-updater to update by hand."
fi
# The commit this checkout is at: the web app and the functions are built from it, and an open
# page compares the two to see the server was updated under it.
version=$( (command -v git >/dev/null && git -C "$root" rev-parse --verify --quiet 'HEAD^{commit}') || true)
version=${version:-unknown}

# The sidecars' image, pinned as in the compose files.
socat_image=alpine/socat:1.8.0.3@sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e
compose_files=compose.yml
trusted_proxies=''
hairpin=0
loopback=0
http_bind=0.0.0.0
if [ "$mode" = domain ]; then
  [ -n "$domain" ] || die "Domain mode needs a name: --domain <name>."
  [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]] ||
    die "--domain must be a DNS name, such as chat.example.com."
  [ -z "$local_flags_given" ] || warn "Kept for local mode, but not used in domain mode: ${local_flags_given% }."
  public_host=$domain
  public_url="https://$domain"
  [ -z "$trusted" ] || warn "--trusted-proxies only applies with --public-url; it's kept for that."
  caddy_site=$domain
  caddy_global=''
  compose_files="$compose_files:compose.domain.yml:compose.hostmap.yml"
  # Domain mode publishes 80 and 443 on every address, IPv6 included. Into an IPv4-only
  # network, Docker's proxy brings every IPv6 client in from the network's gateway, so they'd
  # all share one client address (and one rate limit). With IPv6 on the network, Docker
  # forwards them with their own addresses; it picks the network's IPv6 subnet itself.
  [ ! -s /proc/net/if_inet6 ] || compose_files="$compose_files:compose.ipv6.yml"
elif [ -n "$proxy_url" ]; then
  proxy_url=${proxy_url%/}
  # An origin only: the web app, auth and the Convex API live at fixed paths under it.
  [[ "$proxy_url" != https://\[* ]] ||
    die "--public-url can't be an IPv6 address: give the proxy a host name."
  origin_pattern='^https://([A-Za-z0-9.-]+)(:([0-9]{1,5}))?$'
  [[ "$proxy_url" =~ $origin_pattern ]] ||
    die "--public-url must be an https:// origin with no path, such as https://box.tailnet.ts.net:8443: browsers keep keys only on secure pages."
  public_host=${BASH_REMATCH[1]}
  proxy_port=${BASH_REMATCH[3]:-443}
  if [ "$((10#$proxy_port))" -lt 1 ] || [ "$((10#$proxy_port))" -gt 65535 ]; then die "--public-url's port must be from 1 to 65535."; fi
  proxy_port=$((10#$proxy_port))
  case "$public_host" in
    localhost | 127.*) die "--public-url can't be a loopback address: the backend's container has its own loopback. Use this machine's name." ;;
  esac
  public_url=$proxy_url
  http_bind=${bind:-127.0.0.1}
  # Requests arrive through the proxy, so the scheme and client address are in its
  # X-Forwarded-* headers, which Caddy takes only from --trusted-proxies. On a loopback
  # bind only this machine can connect, and the proxy arrives through Docker from the
  # network's gateway, so by default only those hops are trusted: the loopback here, and
  # the gateway once the network exists (below, on every run, since a run can make the
  # network again). Trusting more (any private address, say) would let a client of the
  # proxy whose address is in that range pick the address Caddy uses. With the port
  # reachable from other machines, any of them could send its own X-Forwarded-For, so the
  # proxy's address must be given.
  case "$http_bind" in
    127.* | localhost | ::1) trusted_proxies=${trusted:-127.0.0.1/32 ::1/128} ;;
    *)
      [ -n "$trusted" ] || die "With --bind $http_bind, other machines can reach the port directly and send their own X-Forwarded-For. Pass --trusted-proxies <the proxy's address>/32 (and let only the proxy reach the port)."
      trusted_proxies=$trusted
      ;;
  esac
  # The backend fetches sign-in keys from the public address. If that's served on this
  # machine, compose.hostmap.yml points the backend at Docker's host address. A proxy that
  # already listens there (on all interfaces) needs nothing more. One that listens only where
  # people connect, such as Tailscale Serve on the tailnet, gets compose.hairpin.yml, which
  # forwards from there. A proxy on another machine is reached the ordinary way.
  proxy_ip=$( (getent ahostsv4 "$public_host" 2>/dev/null || true) | awk 'NR == 1 {print $1}')
  if [ -z "$proxy_ip" ]; then
    warn "Couldn't resolve $public_host to an IPv4 address here. If the proxy runs on this machine, start it (and Tailscale) and run this again, or sign-in won't work."
  elif ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -qx "$proxy_ip"; then
    compose_files="$compose_files:compose.hostmap.yml"
    # This install's own hairpin from an earlier run would answer the check, so it goes
    # first; if it's still needed, it's started again below.
    old_hairpin=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=hairpin)
    for container in $old_hairpin; do docker rm -f "$container" >/dev/null; done
    docker image inspect "$socat_image" >/dev/null 2>&1 || docker pull -q "$socat_image" >/dev/null
    if ! docker run --rm --log-driver none --add-host "$public_host:host-gateway" --entrypoint socat "$socat_image" \
      -u OPEN:/dev/null "TCP:$public_host:$proxy_port,connect-timeout=3" >/dev/null 2>&1; then
      hairpin=1
      compose_files="$compose_files:compose.hairpin.yml"
      set_var HAIRPIN_BIND "$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')" \
        HAIRPIN_PORT "$proxy_port" HAIRPIN_TARGET "$proxy_ip"
    fi
  fi
  caddy_site=':80'
  caddy_global='auto_https off'
else
  http_bind=${bind:-0.0.0.0}
  if [ -z "$host" ]; then
    host=$( (command -v tailscale >/dev/null && tailscale ip -4 2>/dev/null | head -1) || true)
    [ -n "$host" ] || host=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ -n "$host" ] || die "Couldn't find this machine's address. Pass --host <address>."
  fi
  public_host=$host
  public_url="http://$host"
  [ "$port" = 80 ] || public_url="$public_url:$port"
  case "$host" in
    127.0.0.1 | localhost)
      # Inside the backend's container, this address is the container itself:
      # compose.loopback.yml serves the port there too, on 127.0.0.1.
      loopback=1
      compose_files="$compose_files:compose.loopback.yml"
      case "$port" in
        3210 | 3211) die "Ports 3210 and 3211 are the backend's own; pick another --port for a loopback address." ;;
      esac
      ;;
    127.*) die "For a loopback address, use 127.0.0.1 or localhost." ;;
    \[* | *:*) die "--host can't be an IPv6 address: use 127.0.0.1, localhost, or an IPv4 address or name." ;;
    *) warn "Browsers treat $public_url as insecure, so the web app can't keep anyone's key there and sign-in stops at unlocking, and the setup form would send its token and password unencrypted. Serve it over HTTPS before anyone signs up from another device: --public-url with Tailscale Serve, or --domain. See https://docs.trioditis.app/self-hosting/installation/." ;;
  esac
  caddy_site=':80'
  caddy_global='auto_https off'
fi

bridge_hosts=()
for network in "${network_list[@]}"; do bridge_hosts+=("$network-1=http://bridge-$network:8611"); done

# The database images, before any setting is saved or anything is built. Postgres opens only
# data from its own major version, and the bundle doesn't upgrade it in place, so another major
# version stops the install here. A new Postgres or Convex backend image changes the data in
# place on its first start (the backend migrates its database), which the older images can't
# read, so going back afterwards needs a backup from before: such an upgrade runs only with a
# backup made at the version installed now (the updater makes one before every update), or
# when asked to with --without-backup.
image_of() { sed -n "s|^ *image: \($1[^ ]*\)\$|\1|p" "$here/compose/compose.yml" | head -1; }
postgres_image=$(image_of postgres:)
backend_image=$(image_of ghcr.io/convex/convex-backend:)
postgres_major=${postgres_image#postgres:}
postgres_major=${postgres_major%%[.-]*}
if [ "$existing_install" = 1 ] && docker volume inspect "${project}_postgres" >/dev/null 2>&1; then
  data_major=$(docker run --rm --log-driver none -v "${project}_postgres:/v:ro" --entrypoint cat "$socat_image" /v/PG_VERSION 2>/dev/null || true)
  if [[ "$data_major" =~ ^[0-9]+$ ]] && [ "$data_major" != "$postgres_major" ]; then
    die "This version runs Postgres $postgres_major, and this install's database is from Postgres $data_major, which it can't open: the bundle doesn't upgrade Postgres in place. Check out the version you had and run this again, or restore a backup made with Postgres $postgres_major."
  fi
  changed_images=''
  for service in postgres backend; do
    container=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service" 2>/dev/null | head -1 || true)
    [ -n "$container" ] || continue
    running_image=$(docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null || true)
    if [ "$service" = postgres ]; then wanted=$postgres_image; else wanted=$backend_image; fi
    [ -z "$running_image" ] || [ "$running_image" = "$wanted" ] || changed_images="$changed_images $service"
  done
  installed_version=$(get TRIODITIS_VERSION)
  last_backup_version=$(sed -n 's/^version=\([0-9a-f]*\)$/\1/p' "$here/.last-backup" 2>/dev/null || true)
  # Right after a restore (deploy/trioditis restore, which checked the backup is from this
  # version), the data is that backup's, made with this version's images, whatever the
  # containers left from before run: going back to it is what's happening.
  restoring=0
  [ ! -e "$here/.restore-settle" ] && [ -z "$(get RESTORE_PENDING)" ] || restoring=1
  if [ -n "$changed_images" ] && [ "$without_backup" = 0 ] && [ "$restoring" = 0 ] &&
    { [ -z "$installed_version" ] || [ "$last_backup_version" != "$installed_version" ]; }; then
    die "This version changes the database images ($(echo $changed_images | sed 's/ /, /g')), which change the data in place, and there's no backup from the version installed now to go back to. Back up first (deploy/trioditis backup <directory>), then run this again; or, to go on without one, run it with --without-backup."
  fi
fi

set_var \
  INSTALL_MODE "$mode" \
  INSTALL_DOMAIN "$domain" \
  PROXY_URL "${proxy_url%/}" \
  INSTALL_HOST "$host" \
  INSTALL_BIND "$bind" \
  INSTALL_NETWORKS "$networks" \
  INSTALL_UPDATER "$updater" \
  TRIODITIS_VERSION "$version" \
  HTTP_PORT "$port" \
  HTTP_BIND "$http_bind" \
  PUBLIC_HOST "$public_host" \
  PUBLIC_URL "$public_url" \
  CADDY_SITE_ADDRESS "$caddy_site" \
  CADDY_GLOBAL_OPTIONS "$caddy_global" \
  CADDY_TRUSTED_PROXIES "$trusted_proxies" \
  INSTALL_TRUSTED_PROXIES "$trusted" \
  LOOPBACK_PORT "$port" \
  COMPOSE_PROJECT_NAME "$project" \
  COMPOSE_FILE "$compose_files" \
  COMPOSE_PROFILES "$bridged" \
  TRIODITIS_NETWORKS "$bridged" \
  BRIDGE_HOSTS "$(IFS=,; echo "${bridge_hosts[*]}")" \
  TELEGRAM_API_ID "$telegram_api_id" \
  TELEGRAM_API_HASH "$telegram_api_hash"
# The fake network's test endpoint's setting, from a version that had one.
! has INSTALL_E2E || drop_var INSTALL_E2E

# --- Secrets ------------------------------------------------------------------------------

# The server's key pairs. A pair that never existed is made below. Half a pair, a public key
# without its private one, is what restoring a backup's secrets.env leaves (backups keep the
# private keys out), so the install stops for `keys import`: a new pair would make what's
# sealed to the old one unreadable, so it's made only when asked for with --new-server-keys.
new_pairs=()
for pair in BRIDGE AGENT_ACCESS; do
  public=$(get "${pair}_PUBLIC_KEY")
  private=$(get "${pair}_PRIVATE_KEY")
  if [ -n "$public" ] && [ -n "$private" ]; then
    continue
  elif [ -z "$public" ] && [ -z "$private" ]; then
    new_pairs+=("$pair")
  elif [ "$new_server_keys" = 1 ]; then
    new_pairs+=("$pair")
  else
    die "deploy/.env has only half of the server's ${pair} key pair (as after restoring a backup's secrets.env, which leaves the private keys out). Import the keys you exported: deploy/trioditis keys import <file>, then run this again. Only if they're lost, run this again with --new-server-keys: sends sealed to the old key then fail, and agent access must be granted again (https://docs.trioditis.app/self-hosting/backup-and-keys/#if-the-server-keys-are-lost)."
  fi
done
if [ "$new_server_keys" = 1 ] && [ "${#new_pairs[@]}" -eq 0 ]; then
  warn "--new-server-keys does nothing: deploy/.env has both of the server's key pairs, and they're kept."
fi
unset -v public private

keep_or POSTGRES_PASSWORD "$(secret 24)"
keep_or CONVEX_INSTANCE_SECRET "$(hex_secret 32)"
keep_or BETTER_AUTH_SECRET "$(secret 32)"
keep_or GATEWAY_SECRET "$(secret 32)"
keep_or TRIODITIS_INTERNAL_TOKEN "$(secret 32)"
# Lets a bridge host start sign-in browsers, and nothing else: the browser's container holds it.
keep_or LOGIN_BROWSER_TOKEN "$(secret 32)"
keep_or TRIODITIS_SETUP_TOKEN "$(secret 32)"
keep_or UPDATER_SECRET "$(secret 32)"
# Encrypts the backups (deploy/trioditis backup), and, like the private keys, is never in one:
# deploy/trioditis keys export keeps it with them.
keep_or BACKUP_KEY "$(secret 32)"

# Compose reads COMPOSE_FILE and COMPOSE_PROFILES from deploy/.env, relative to the compose
# directory, so it runs from there.
# Exported COMPOSE_* variables would override deploy/.env (and name the images), so they're
# dropped: this install's settings are the ones it saved.
# deploy/.env is the only source of the install's settings and secrets: every variable it
# sets, every one the compose files read, and every COMPOSE_* one (found in the environment,
# since Compose adds new ones) are dropped from the environment Compose runs in, since an
# exported one would override the file (and the running stack would no longer match the .env
# a backup saves).
compose() {
  local name scrub=()
  for name in $( {
    printf '%s\n' "$env_text" | sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p'
    grep -ohE '\$\{[A-Za-z_][A-Za-z0-9_]*' "$here"/compose/*.yml | cut -c3-
    compgen -e | grep '^COMPOSE_' || true
  } | sort -u); do
    scrub+=(-u "$name")
  done
  (cd "$here/compose" && env "${scrub[@]}" docker compose --env-file "$env_file" -p "$project" "$@")
}

# --- Images -------------------------------------------------------------------------------

say "Building the images from this checkout (the first build takes a few minutes)"
# Signal's library is only built when Signal is bridged (build-images.sh).
build_options=()
[[ " ${network_list[*]} " != *" signal "* ]] || build_options+=(--with-signal)
"$here/install/build-images.sh" --project "$project" --tag local --version "$version" \
  --debian-snapshot "$(get DEBIAN_SNAPSHOT)" "${build_options[@]}"

# Only the pairs chosen above are generated, so a kept pair (which clients may already have
# sealed to) never changes. The container logs nothing: its output is private keys.
if [ "${#new_pairs[@]}" -gt 0 ]; then
  say "Generating the server's key pairs"
  keys=$(docker run --rm --log-driver none --entrypoint node "$project/node:local" deploy/scripts/gen-keys.ts)
  for pair in "${new_pairs[@]}"; do
    public_key=$(printf '%s\n' "$keys" | grep "^${pair}_PUBLIC_KEY=" | cut -d= -f2-)
    private_key=$(printf '%s\n' "$keys" | grep "^${pair}_PRIVATE_KEY=" | cut -d= -f2-)
    if [ -z "$public_key" ] || [ -z "$private_key" ]; then die "Couldn't generate the ${pair} key pair."; fi
    set_var "${pair}_PUBLIC_KEY" "$public_key" "${pair}_PRIVATE_KEY" "$private_key"
  done
  unset -v keys public_key private_key
fi

# Caddy serves it (as another user), so it's world-readable; written like deploy/.env. Checked
# before anything is made, so a symlink there never leads mkdir elsewhere.
[ ! -L "$here/runtime" ] || die "deploy/runtime is a symlink; it must be a directory of this checkout."
[ ! -e "$here/runtime" ] || [ -d "$here/runtime" ] || die "deploy/runtime isn't a directory; it must be a directory of this checkout."
mkdir -p "$here/runtime"
write_file "$here/runtime/config.json" \
  "{ \"convexUrl\": \"$public_url/convex\", \"convexSiteUrl\": \"$public_url\", \"environment\": \"selfhosted\" }" 644
# The commit the functions are deployed from (deploy-functions.sh reads it).
write_file "$here/runtime/version" "$version" 644

# Only Caddy is published, in every mode: the Convex backend (3210, 3211) and everything
# else stay on the internal network, since the backend trusts the client address Caddy
# gives it (X-Trioditis-Client-IP).
compose --profile '*' config | sh "$here/scripts/check-ports.sh" ||
  die "The compose files publish more than Caddy's port (above). This is a bug in the bundle."

# Compose leaves a service whose profile is no longer enabled running, even with
# --remove-orphans, so a network dropped from --networks is stopped and removed here. Its
# volume and database stay, in case it's enabled again.
all_services=$(compose --profile '*' config --services)
enabled_services=" $(compose config --services | tr '\n' ' ') "
stale_services=()
for service in $all_services; do
  [[ "$enabled_services" == *" $service "* ]] || stale_services+=("$service")
done
if [ "${#stale_services[@]}" -gt 0 ] && ! removed=$(compose --profile '*' rm --stop --force "${stale_services[@]}" 2>&1); then
  warn "Couldn't remove services that are no longer enabled (${stale_services[*]}); they may still be running: $removed"
fi

# --- Database and backend -----------------------------------------------------------------

wait_healthy() {
  local service=$1 tries=${2:-60} hint=${3:-} status
  for _ in $(seq "$tries"); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$(compose ps -q "$service")" 2>/dev/null || true)
    [ "$status" = healthy ] && return 0
    sleep 2
  done
  compose logs --tail 40 "$service" >&2 || true
  die "$service didn't become healthy.${hint:+ $hint}"
}

# Over TCP, like the healthcheck, and retried: Postgres can still restart once just after it
# first reports ready, and a CREATE that went through before a dropped connection shows up
# on the next check.
psql_admin() { compose exec -T postgres psql -h 127.0.0.1 -U trioditis -d trioditis -v ON_ERROR_STOP=1 "$@"; }
ensure_database() {
  local database=$1
  for _ in $(seq 20); do
    [ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = '$database'" 2>/dev/null)" != 1 ] || return 0
    psql_admin -qc "CREATE DATABASE $database" >/dev/null 2>&1 && return 0
    sleep 2
  done
  die "Couldn't create the database $database."
}

# A network made with another IPv6 setting (the mode changed) is made again; Compose won't
# change it in place. Only containers go: the data is in volumes.
want_ipv6=false
case ":$compose_files:" in *:compose.ipv6.yml:*) want_ipv6=true ;; esac
have_ipv6=$(docker network inspect -f '{{.EnableIPv6}}' "${project}_default" 2>/dev/null || echo none)
if [ "$have_ipv6" != none ] && [ "$have_ipv6" != "$want_ipv6" ]; then
  say "Making the server's network again, with IPv6 $([ "$want_ipv6" = true ] && echo on || echo off)"
  compose --profile '*' down
fi

say "Starting the database"
compose up -d --remove-orphans postgres
wait_healthy postgres
for database in convex_self_hosted $(printf 'bridge_%s ' "${network_list[@]}"); do
  ensure_database "$database"
done
# The fake network is gone from this version. Its bridge host went with the orphans just
# above, and its database and volume, which only ever held made-up chats, go too.
if [ "$(psql_admin -tAc "SELECT 1 FROM pg_database WHERE datname = 'bridge_fake'" 2>/dev/null)" = 1 ]; then
  say "Removing the fake network's database"
  psql_admin -qc "DROP DATABASE IF EXISTS bridge_fake" >/dev/null || warn "Couldn't remove the fake network's database, bridge_fake."
fi
fake_volume=$(docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.volume=bridge-fake")
if [ -n "$fake_volume" ]; then
  say "Removing the fake network's volume"
  docker volume rm "$fake_volume" >/dev/null || warn "Couldn't remove the fake network's volume, $fake_volume."
fi

say "Starting the Convex backend"
compose up -d --remove-orphans backend
wait_healthy backend 90
if [ -z "$(get CONVEX_ADMIN_KEY)" ]; then
  admin_key=$(compose exec -T backend ./generate_admin_key.sh | tail -1 | tr -d '\r')
  [ -n "$admin_key" ] || die "Couldn't generate the Convex admin key."
  set_var CONVEX_ADMIN_KEY "$admin_key"
  unset -v admin_key
fi

# --- Everything else ----------------------------------------------------------------------

# Behind a proxy on the loopback with the default trust, the network's gateway (where the
# proxy arrives from, through Docker) is trusted too, read now that the network exists.
if [ "$mode" = local ] && [ -n "$proxy_url" ] && [ -z "$trusted" ]; then
  case "$http_bind" in
    127.* | localhost | ::1)
      gateways=$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' "${project}_default")
      ranges="127.0.0.1/32 ::1/128"
      for gateway in $gateways; do
        case "$gateway" in *:*) ranges="$ranges $gateway/128" ;; *) ranges="$ranges $gateway/32" ;; esac
      done
      [ -n "$gateways" ] || die "Couldn't read the server network's gateway, which Caddy must trust behind the proxy."
      set_var CADDY_TRUSTED_PROXIES "$ranges"
      ;;
  esac
fi

# After a restore (deploy/trioditis restore), before anything that sends starts: the restored
# backup is a moment in the past, so every send it holds as still on its way may have gone out
# since. The functions are deployed, then every such send is made `unknown` rather than sent
# again (deploy/scripts/settle-restore.mjs). The restore's gate (deploy/.restore-settle, and
# RESTORE_PENDING in deploy/.env, which keeps the gateway from starting) stays until that's done,
# so a run that stops partway settles them on the next one.
# The marker then says `settled`, and stays (deploy/trioditis still starts nothing beside it)
# until every bridge host's container is made again with this restore's ID, below.
pending=$(get RESTORE_PENDING)
restore_state=$(sed -n 's/^state=//p' "$here/.restore-settle" 2>/dev/null | head -1 || true)
if { [ -e "$here/.restore-settle" ] || [ -n "$pending" ]; } && [ "$restore_state" != settled ]; then
  backup_at=$(sed -n 's/^backup_at=\([0-9]\{1,16\}\)$/\1/p' "$here/.restore-settle" 2>/dev/null || true)
  backup_at=${backup_at:-$pending}
  [[ "$backup_at" =~ ^[0-9]{1,16}$ ]] || die "deploy/.restore-settle isn't one a restore wrote. Run the restore again."
  say "Settling the sends the restored backup holds, before anything can send them"
  compose rm -f -s gateway >/dev/null 2>&1 || true
  if ! compose run --rm --no-deps -T functions >/dev/null; then
    compose logs --no-log-prefix --tail 20 functions >&2 || true
    die "Deploying the functions after the restore failed (above). Fix the cause and run this again."
  fi
  compose run --rm --no-deps -T -e "RESTORE_BACKUP_AT=$backup_at" --entrypoint node functions deploy/scripts/settle-restore.mjs ||
    die "Settling the restored sends failed (above), so nothing that sends was started. Fix the cause and run this again."
  ! has RESTORE_PENDING || drop_var RESTORE_PENDING
  marker_tmp=$(mktemp "$here/.restore-settle.XXXXXX")
  { sed 's/^state=.*/state=settled/' "$here/.restore-settle" >"$marker_tmp" && mv -f "$marker_tmp" "$here/.restore-settle"; } ||
    { rm -f "$marker_tmp"; die "Couldn't record the restored sends as settled. Run this again."; }
fi

# The functions first (deploy, then migrations), with only the database and backend beside
# them: the gateway, bridge hosts and Caddy start only once those have finished, so a version
# whose functions or migrations fail never takes writes or sends anything.
say "Deploying the functions"
compose up -d --remove-orphans postgres backend functions || die "Starting the database and backend failed (above). Fix the cause and run this again."
functions=$(compose ps -aq functions 2>/dev/null | head -1 || true)
[ -n "$functions" ] || die "The functions job didn't start (above). Fix the cause and run this again."
functions_state=unknown
for _ in $(seq 900); do
  functions_state=$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$functions" 2>/dev/null || echo unknown)
  case "$functions_state" in exited* | dead*) break ;; esac
  sleep 1
done
if [ "$functions_state" != 'exited 0' ]; then
  compose logs --no-log-prefix --tail 20 functions >&2 || true
  die "Deploying the functions or running a migration failed (its log is above; a failing function's details are in deploy/trioditis logs backend). Fix the cause and run this again."
fi
say "Starting the server"
# Without dependencies, so the finished functions job isn't run again: the gateway, Caddy and
# the sidecars, then, once the gateway is healthy, the bridge hosts that wait for it.
mapfile -t late_services < <(compose config --services | grep -vxE 'postgres|backend|functions|bridge-.*')
mapfile -t bridge_services < <(compose config --services | grep -xE 'bridge-.*' || true)
if [ "${#late_services[@]}" -gt 0 ] && ! compose up -d --no-deps "${late_services[@]}"; then
  die "Starting the server failed (above). Fix the cause and run this again."
fi
wait_healthy gateway 90
if [ "${#bridge_services[@]}" -gt 0 ] && ! compose up -d --no-deps "${bridge_services[@]}"; then
  die "Starting the bridge hosts failed (above). Fix the cause and run this again."
fi
# After a restore, the gate comes off only once Docker shows every bridge host's container made
# with this restore's ID, so none can run its restored queue; until then deploy/trioditis starts
# nothing, and a rerun of this checks again.
if [ -e "$here/.restore-settle" ]; then
  restore_id=$(get RESTORE_ID)
  [ -n "$restore_id" ] || die "deploy/.env has no RESTORE_ID after a restore. Run the restore again."
  containers=$(docker ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null) ||
    die "Couldn't list the server's containers to check the bridge hosts. Run this again."
  for container in $containers; do
    service=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$container" 2>/dev/null) ||
      die "Couldn't check a container's settings. Run this again."
    case "$service" in bridge-*) ;; *) continue ;; esac
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$container" 2>/dev/null | grep -qxF "TRIODITIS_RESTORE_ID=$restore_id" ||
      die "$service's container wasn't made with this restore's ID, so the restore's gate stays. Run this again."
  done
  rm -f "$here/.restore-settle"
fi
ready_services=(gateway caddy)
for network in "${network_list[@]}"; do ready_services+=("bridge-$network"); done
[ "$hairpin" = 0 ] || ready_services+=(hairpin)
[ "$loopback" = 0 ] || ready_services+=(loopback)
for service in "${ready_services[@]}"; do
  hint=''
  [ "$service" != hairpin ] || hint="It forwards to the proxy at $proxy_ip:$proxy_port: is the proxy running and serving that port?"
  wait_healthy "$service" 90 "$hint"
done

# The backend checks every sign-in against keys it fetches from the public address, so check
# it gets them there: a JSON key set, not an error page from something in between.
say "Checking the backend can fetch sign-in keys from $public_url"
reachable=0
for _ in $(seq 30); do
  # The status goes on a line of its own after the body; only a 2xx counts, not a redirect.
  jwks=$(compose exec -T backend curl -sS --max-time 5 -w '\n%{http_code}' "$public_url/api/auth/convex/jwks" 2>/dev/null || true)
  http_status=${jwks##*$'\n'}
  case "$http_status:${jwks%$'\n'*}" in 2??:*'"keys"'*) reachable=1; break ;; *) sleep 2 ;; esac
done
if [ "$reachable" = 0 ]; then
  case "$mode" in
    domain) hint="the domain's DNS must point at this machine, and the certificate may still be on its way: check deploy/trioditis logs caddy" ;;
    *) hint="if it's served by a proxy, check that the proxy is running and forwards to this server" ;;
  esac
  warn "The backend can't fetch sign-in keys from $public_url, so sign-in won't work yet: $hint. Then run this again."
fi

# --- The updater --------------------------------------------------------------------------

# Installed (or kept) once the server is up, since it talks to it; never restarted here, as it
# may be the updater that's running this install. See deploy/updater/service.sh.
if [ "$updater" = 1 ]; then
  say "Starting the updater (trioditis-updater-$project)"
  if ! bash "$here/updater/service.sh" install "$project"; then
    [ "$updater_default" = 1 ] || die "Couldn't install the updater's service (above)."
    # On by default, not asked for: the server is up, so it stays up, and the updater goes off
    # instead. Its secret is taken back from the backend (deploy-functions.sh removes it with
    # the updater off), so the app doesn't offer updates that nothing would run.
    bash "$here/updater/service.sh" remove "$project" >/dev/null 2>&1 || true
    updater=0
    set_var INSTALL_UPDATER 0
    compose run --rm --no-deps -T functions >/dev/null 2>&1 ||
      warn "Couldn't take the updater's secret back from the backend: run this again."
    warn "The updater is off, so admins can't update the server from the app: its service couldn't be installed (above). Once it can, run this again with --updater."
  fi
else
  bash "$here/updater/service.sh" remove "$project" || warn "Couldn't remove the updater's service (above)."
fi

# --- Done ---------------------------------------------------------------------------------

# Whether the admin account exists, asked through the backend with the admin key (which
# stays in the functions container's environment). Prints yes, no, or unknown.
account_state() {
  local out
  out=$(compose run --rm --no-deps -T functions \
    sh -c 'cd packages/backend && npx convex data members --limit 1 --format jsonLines' 2>/dev/null) || {
    echo unknown
    return
  }
  case "$out" in *'{'*) echo yes ;; *) echo no ;; esac
}

printf '\n\033[1mTrioditis is running at %s\033[0m\n\n' "$public_url"
case "$(account_state)" in
  no)
    # The web app is built in only when the checkout has it (deploy/docker/web.Dockerfile);
    # until then nothing in the browser creates accounts.
    if [ "$setup_link" = 0 ]; then
      printf 'The admin account doesn'"'"'t exist yet. Run deploy/install/install.sh for the setup link.\n\n'
    elif [ -f "$root/apps/desktop/package.json" ]; then
      cat <<EOF
Create the admin account with this link. It works once, until the first account exists:

  $public_url/setup#token=$(get TRIODITIS_SETUP_TOKEN)

EOF
    else
      cat <<EOF
This checkout has no web app yet, so create the admin account here (it asks for the password):

  deploy/trioditis create-admin <email>

EOF
    fi
    ;;
  yes) printf 'Setup is done: the admin account exists. Invite people from the app.\n\n' ;;
  *) printf "Couldn't check whether the admin account exists. Until it does, the setup link is\n%s/setup#token=<TRIODITIS_SETUP_TOKEN from deploy/.env>.\n\n" "$public_url" ;;
esac
cat <<EOF
Networks: admins install the ones people can connect in the app (Admin settings → Networks),
from those this server bridges: ${bridged//,/, }.

Manage it with deploy/trioditis (docker compose for this install), e.g.:
  deploy/trioditis ps
  deploy/trioditis logs -f gateway
  deploy/trioditis down        # stop; data stays in Docker volumes

EOF
if [ "$updater" = 1 ]; then
  cat <<EOF
Updates: admins choose the channel and update from the app (Admin settings → Updates). The
updater's log: journalctl $([ "$(id -u)" = 0 ] || echo '--user ')-u trioditis-updater-$project
EOF
else
  cat <<EOF
Upgrade: back up (deploy/trioditis backup <directory>), update this checkout (git pull), then
run deploy/install/install.sh again. It keeps these settings; pass an option only to change
one. Or let admins update from the app: run this again with --updater.
EOF
fi
# The app's update channel is Stable (main) until an admin chooses; a checkout from dev is
# ahead of it, and the updater would leave it where it is.
if [ "$updater" = 1 ] && ! git -C "$root" merge-base --is-ancestor HEAD refs/remotes/origin/main 2>/dev/null &&
  git -C "$root" merge-base --is-ancestor HEAD refs/remotes/origin/dev 2>/dev/null; then
  cat <<EOF
This checkout is from dev, ahead of the Stable channel (main) the app starts on: choose
Nightly in Admin settings → Updates to keep it updated.
EOF
fi
