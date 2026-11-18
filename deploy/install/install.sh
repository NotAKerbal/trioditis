#!/usr/bin/env bash
# Installs (or upgrades) a Trioditis server on this machine with Docker Compose.
#
#   deploy/install/install.sh                         # local mode: http://<this machine>:8080
#   deploy/install/install.sh --port 9000 --host 192.168.1.20
#   deploy/install/install.sh --public-url https://box.tailnet.ts.net:8443  # behind Tailscale Serve
#   deploy/install/install.sh --domain chat.example.com   # HTTPS with ACME
#   deploy/install/install.sh --networks whatsapp,fake    # also the fake network, for trying it out
#
# It's safe to run again: secrets are generated once and kept in deploy/.env, and a rerun
# rebuilds the images from this checkout, redeploys the functions and restarts what changed.
# See docs/deploy.md.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/.." && pwd)
env_file="$here/.env"

mode=local
port=8080
host=''
domain=''
networks=whatsapp
bind=''
proxy_url=unset
hairpin=0
e2e=0

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'
Options:
  --local              Serve plain HTTP on a port, with no domain (the default)
  --port <n>           Local mode's port (default 8080)
  --host <address>     The address people open, in local mode (default: this machine's
                       Tailscale IP if Tailscale is up, else its first LAN IP)
  --bind <address>     The interface local mode listens on (default 0.0.0.0, or 127.0.0.1
                       with --public-url)
  --public-url <url>   Local mode behind something that serves HTTPS and forwards to the
                       port, such as Tailscale Serve: the https:// address people open.
                       Kept for reruns; pass '' to go back to plain HTTP
  --domain <name>      Domain mode: HTTPS on 80/443 for <name>, with ACME certificates
  --networks <list>    Comma-separated: whatsapp, fake (default whatsapp)
  --e2e                Also expose the fake network's test endpoint on this machine's loopback
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --local) mode=local ;;
    --port) port=$2; shift ;;
    --host) host=$2; shift ;;
    --bind) bind=$2; shift ;;
    --public-url) proxy_url=$2; shift ;;
    --domain) mode=domain; domain=$2; shift ;;
    --networks) networks=$2; shift ;;
    --e2e) e2e=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- Prerequisites ------------------------------------------------------------------------

command -v docker >/dev/null || die "Docker isn't installed. Install Docker Engine and the Compose plugin, then run this again."
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin isn't installed (docker compose)."
docker info >/dev/null 2>&1 || die "Can't talk to Docker. Add yourself to the docker group (and log in again), or run this as a user who can."

case "$(uname -m)" in
  x86_64 | amd64 | aarch64 | arm64) ;;
  *) die "Unsupported CPU architecture $(uname -m): Trioditis runs on x86_64 and arm64." ;;
esac

docker_root=$(docker info --format '{{.DockerRootDir}}')
free_kib=$(df -Pk "$docker_root" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "${free_kib:-}" ] && [ "$free_kib" -lt $((8 * 1024 * 1024)) ]; then
  die "Less than 8 GiB free where Docker keeps its data ($docker_root). Building the images needs about 4 GiB, and the server needs room to grow."
fi

IFS=',' read -r -a network_list <<<"$networks"
for network in "${network_list[@]}"; do
  case "$network" in
    whatsapp | fake) ;;
    *) die "Unknown network '$network'. This version supports: whatsapp, fake." ;;
  esac
done
[ "${#network_list[@]}" -gt 0 ] || die "Pick at least one network."

# Encryption at rest is the disk's job in Phase 0: the connectors keep some state (names,
# phone numbers, history not yet imported) in plaintext in the bridge database.
encrypted_volume() {
  local source
  source=$(findmnt -no SOURCE -T "$1" 2>/dev/null | head -1) || return 1
  [ -n "$source" ] || return 1
  lsblk -s -no TYPE "$source" 2>/dev/null | grep -qx crypt
}
if ! encrypted_volume "$docker_root"; then
  warn "Docker's data ($docker_root) isn't on an encrypted volume. Trioditis seals stored messages, but the network connectors keep names, phone numbers and history not yet imported in plaintext, so put this server's disk (and its backups) on encrypted storage. See docs/deploy.md, Encryption at rest."
fi

# --- Settings and secrets -----------------------------------------------------------------

touch "$env_file"
chmod 600 "$env_file"

get() { grep -E "^$1=" "$env_file" | tail -1 | cut -d= -f2- || true; }
set_var() {
  local name=$1 value=$2 tmp
  tmp=$(mktemp "$env_file.XXXXXX")
  grep -vE "^$name=" "$env_file" >"$tmp" || true
  printf '%s=%s\n' "$name" "$value" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$env_file"
}
secret() { head -c "$1" /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
hex_secret() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
keep_or() { local current; current=$(get "$1"); [ -n "$current" ] || set_var "$1" "$2"; }

if [ "$mode" = local ]; then
  [ "$proxy_url" != unset ] || proxy_url=$(get PROXY_URL)
  proxy_url=${proxy_url%/}
  case "$proxy_url" in
    '' | https://*) ;;
    *) die "--public-url must be an https:// address: browsers keep keys only on secure pages." ;;
  esac
  set_var PROXY_URL "$proxy_url"
fi
if [ "$mode" = local ] && [ -n "$proxy_url" ]; then
  host=${proxy_url#https://}
  host=${host%%[:/]*}
  public_url=$proxy_url
  [ -n "$bind" ] || bind=127.0.0.1
  # The backend fetches sign-in keys from the public address. When that's a proxy on this
  # machine, such as Tailscale Serve, it listens only where people connect (the tailnet), not
  # where containers do, so a sidecar on the host network forwards from Docker's host address.
  proxy_port=${proxy_url#https://*:}
  proxy_port=${proxy_port%%/*}
  [ "$proxy_port" != "$proxy_url" ] || proxy_port=443
  proxy_ip=$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR == 1 {print $1}')
  if [ -n "$proxy_ip" ] && ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -qx "$proxy_ip"; then
    hairpin=1
    set_var HAIRPIN_BIND "$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')"
    set_var HAIRPIN_PORT "$proxy_port"
    set_var HAIRPIN_TARGET "$proxy_ip"
  fi
  set_var CADDY_SITE_ADDRESS ':80'
  set_var CADDY_GLOBAL_OPTIONS 'auto_https off'
  set_var HTTP_BIND "$bind"
  set_var HTTP_PORT "$port"
elif [ "$mode" = local ]; then
  [ -n "$bind" ] || bind=0.0.0.0
  if [ -z "$host" ]; then
    host=$(get PUBLIC_HOST)
    if [ -z "$host" ] || [ "$(get INSTALL_MODE)" != local ]; then
      host=$( (command -v tailscale >/dev/null && tailscale ip -4 2>/dev/null | head -1) || true)
      [ -n "$host" ] || host=$(hostname -I 2>/dev/null | awk '{print $1}')
      [ -n "$host" ] || die "Couldn't find this machine's address. Pass --host <address>."
    fi
  fi
  public_url="http://$host"
  [ "$port" = 80 ] || public_url="$public_url:$port"
  case "$host" in
    localhost | 127.* | '[::1]') ;;
    *) warn "Browsers treat $public_url as insecure, so the web app can't keep anyone's key there and sign-in stops at unlocking. Serve it over HTTPS: --public-url with Tailscale Serve, or --domain. See docs/deploy.md, HTTPS in local mode." ;;
  esac
  set_var CADDY_SITE_ADDRESS ':80'
  set_var CADDY_GLOBAL_OPTIONS 'auto_https off'
  set_var HTTP_BIND "$bind"
  set_var HTTP_PORT "$port"
else
  [ -n "$domain" ] || die "--domain needs a name."
  host=$domain
  public_url="https://$domain"
  set_var CADDY_SITE_ADDRESS "$domain"
  set_var CADDY_GLOBAL_OPTIONS ''
fi

compose_files=compose.yml
[ "$mode" = domain ] && compose_files="$compose_files:compose.domain.yml"
[ "$e2e" = 1 ] && compose_files="$compose_files:compose.e2e.yml"

bridge_hosts=()
for network in "${network_list[@]}"; do bridge_hosts+=("$network-1=http://bridge-$network:8611"); done

set_var INSTALL_MODE "$mode"
set_var PUBLIC_HOST "$host"
set_var PUBLIC_URL "$public_url"
set_var COMPOSE_FILE "$compose_files"
profiles=$networks
[ "$hairpin" = 0 ] || profiles="$profiles,hairpin"
set_var COMPOSE_PROFILES "$profiles"
set_var TRIODITIS_NETWORKS "$networks"
set_var BRIDGE_HOSTS "$(IFS=,; echo "${bridge_hosts[*]}")"

keep_or POSTGRES_PASSWORD "$(secret 24)"
keep_or CONVEX_INSTANCE_SECRET "$(hex_secret 32)"
keep_or BETTER_AUTH_SECRET "$(secret 32)"
keep_or GATEWAY_SECRET "$(secret 32)"
keep_or TRIODITIS_INTERNAL_TOKEN "$(secret 32)"
keep_or TRIODITIS_SETUP_TOKEN "$(secret 32)"

# Compose reads COMPOSE_FILE and COMPOSE_PROFILES from deploy/.env, relative to the compose
# directory, so it runs from there.
compose() { (cd "$here/compose" && docker compose --env-file "$env_file" "$@"); }

# --- Images -------------------------------------------------------------------------------

say "Building the images from this checkout (the first build takes a few minutes)"
# The Node image is built first, by itself: it generates the key pairs the rest needs.
docker build -q -f "$here/docker/node.Dockerfile" -t trioditis/node:local "$root" >/dev/null

if [ -z "$(get BRIDGE_PRIVATE_KEY)" ] || [ -z "$(get AGENT_ACCESS_PRIVATE_KEY)" ]; then
  say "Generating the server's key pairs"
  while IFS='=' read -r name value; do
    [ -n "$name" ] && set_var "$name" "$value"
  done < <(docker run --rm --entrypoint node trioditis/node:local deploy/scripts/gen-keys.ts)
fi

mkdir -p "$here/runtime"
cat >"$here/runtime/config.json" <<EOF
{ "convexUrl": "$public_url/convex", "convexSiteUrl": "$public_url", "environment": "selfhosted" }
EOF
chmod 644 "$here/runtime/config.json"

compose build --quiet

# --- Database and backend -----------------------------------------------------------------

wait_healthy() {
  local service=$1 tries=${2:-60} status
  for _ in $(seq "$tries"); do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$(compose ps -q "$service")" 2>/dev/null || true)
    [ "$status" = healthy ] && return 0
    sleep 2
  done
  compose logs --tail 40 "$service" >&2 || true
  die "$service didn't become healthy."
}

say "Starting the database"
compose up -d postgres
wait_healthy postgres
for database in convex_self_hosted $(printf 'bridge_%s ' "${network_list[@]}"); do
  if ! compose exec -T postgres psql -U trioditis -d trioditis -tAc "SELECT 1 FROM pg_database WHERE datname = '$database'" | grep -q 1; then
    compose exec -T postgres psql -U trioditis -d trioditis -qc "CREATE DATABASE $database" >/dev/null
  fi
done

say "Starting the Convex backend"
compose up -d backend
wait_healthy backend 90
if [ -z "$(get CONVEX_ADMIN_KEY)" ]; then
  admin_key=$(compose exec -T backend ./generate_admin_key.sh | tail -1 | tr -d '\r')
  [ -n "$admin_key" ] || die "Couldn't generate the Convex admin key."
  set_var CONVEX_ADMIN_KEY "$admin_key"
fi

# --- Everything else ----------------------------------------------------------------------

say "Deploying the functions and starting the server"
compose up -d --remove-orphans
for service in gateway caddy $(printf 'bridge-%s ' "${network_list[@]}"); do
  wait_healthy "$service" 90
done
[ "$e2e" = 1 ] && [[ " ${network_list[*]} " == *" fake "* ]] && compose up -d fake-control

# --- Done ---------------------------------------------------------------------------------

cat <<EOF

$(printf '\033[1m')Trioditis is running at $public_url$(printf '\033[0m')

Create the admin account with this link. It works once, until the first account exists:

  $public_url/setup#token=$(get TRIODITIS_SETUP_TOKEN)

Manage it with deploy/trioditis (docker compose for this install), e.g.:
  deploy/trioditis ps
  deploy/trioditis logs -f gateway
  deploy/trioditis down        # stop; data stays in Docker volumes

Upgrade: update this checkout (git pull), then run deploy/install/install.sh again.
EOF
