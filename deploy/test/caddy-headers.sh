#!/bin/sh
# What client address the backend is told. The bundle's Caddyfile runs in front of a stand-in
# backend (a Caddy that answers with the X-Trioditis-Client-IP it was sent, on both Convex
# ports), so no backend is built:
# - a client's own X-Trioditis-Client-IP and X-Forwarded-For never reach the backend as sent,
#   on /api/auth/* or on /convex/http/*: it gets the address Caddy saw;
# - behind a trusted proxy (--public-url mode), the address from the proxy's X-Forwarded-For
#   is used, the rightmost one it didn't add, not the leftmost a client sent;
# - from a peer that isn't trusted, X-Forwarded-For is ignored.
# Then, published as each mode publishes it and asked from this machine (a copy of the
# Caddyfile with a route that answers "{client_ip} {remote_host}"):
# - --public-url on the loopback (as behind Tailscale Serve), trusting what the installer
#   trusts there (the loopback and the network's gateway): Caddy's peer is the gateway, and
#   the client is the proxy's X-Forwarded-For (rightmost first), or the gateway without one;
#   a client of the proxy can't pick its address, even with one in a private range (which
#   trusting all private addresses, as before, let it do);
# - direct, on every address: the client is the real address it came from, and an
#   X-Forwarded-For is ignored;
# - domain mode on a machine with IPv6 (an IPv6 network): an IPv6 client keeps its address.
# TRIODITIS_CADDYFILE=<path> tests another Caddyfile.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "Caddy tells the backend the client's address"
caddyfile=${TRIODITIS_CADDYFILE:-$repo/deploy/compose/Caddyfile}
caddy=caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
network="$project-net"
docker network create "$network" >/dev/null

cat >"$root/echo.caddy" <<'EOF'
{
	admin off
	auto_https off
}
:3210, :3211 {
	respond "{http.request.header.X-Trioditis-Client-IP}"
}
EOF
cp "$caddyfile" "$root/Caddyfile"
docker run -d --name "$project-backend" --network "$network" --network-alias backend --log-driver none \
  -v "$root/echo.caddy:/etc/caddy/Caddyfile:ro" "$caddy" >/dev/null
# A client, which also plays the proxy in front of Caddy.
docker run -d --name "$project-client" --network "$network" --log-driver none --entrypoint sleep "$tool" 3600 >/dev/null
client_ip=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$project-client")

# front <trusted proxies>: (re)starts the bundle's Caddy in local mode, trusting those.
front() {
  docker rm -f "$project-front" >/dev/null 2>&1 || true
  docker run -d --name "$project-front" --network "$network" --log-driver none \
    -e TRIODITIS_SITE_ADDRESS=:80 -e CADDY_GLOBAL_OPTIONS='auto_https off' -e CADDY_TRUSTED_PROXIES="$1" \
    -v "$root/Caddyfile:/etc/caddy/Caddyfile:ro" "$caddy" >/dev/null
  for _ in $(seq 50); do
    docker exec "$project-client" wget -qO- "http://$project-front/api/auth/ok" >/dev/null 2>&1 && return
    sleep 0.2
  done
}
# seen <path> [header...]: the client address the backend is told for a request from the client.
seen() {
  path=$1
  shift
  headers=''
  for header in "$@"; do headers="$headers --header '$header'"; done
  docker exec "$project-client" sh -c "wget -qO- $headers 'http://$project-front$path'" 2>/dev/null
}
expect() {
  [ "$1" = "$2" ] && check ok "$3" || check fail "$3 (the backend saw '$1', not '$2')"
}

# Caddy is the edge: no proxy is trusted.
front ''
spoof='X-Trioditis-Client-IP: 6.6.6.6'
forged='X-Forwarded-For: 7.7.7.7'
expect "$(seen /api/auth/sign-in/email "$spoof" "$forged")" "$client_ip" "a spoofed address doesn't reach Better Auth"
expect "$(seen /convex/http/api/auth/sign-in/email "$spoof" "$forged")" "$client_ip" "nor Convex's HTTP actions under /convex/http"
expect "$(seen /convex/api/query "$spoof")" "$client_ip" "nor the Convex API"

# Behind a proxy (the client), trusted.
front "$client_ip/32"
expect "$(seen /api/auth/sign-in/email 'X-Forwarded-For: 7.7.7.7')" 7.7.7.7 "a trusted proxy's address for its client is used"
expect "$(seen /api/auth/sign-in/email 'X-Forwarded-For: 6.6.6.6, 7.7.7.7')" 7.7.7.7 \
  "the rightmost address it didn't add, not the leftmost a client sent"
expect "$(seen /api/auth/sign-in/email "$spoof" 'X-Forwarded-For: 7.7.7.7')" 7.7.7.7 \
  "and a spoofed X-Trioditis-Client-IP is still replaced"

# A peer that isn't trusted.
front 192.0.2.0/24
expect "$(seen /api/auth/sign-in/email 'X-Forwarded-For: 7.7.7.7')" "$client_ip" "an untrusted peer's X-Forwarded-For is ignored"

# Published, with the echo route in a copy of the Caddyfile.
awk '{ print } /request_header X-Trioditis-Client-IP/ { print "\thandle /__test/client {\n\t\trespond \"{client_ip} {remote_host}\"\n\t}" }' \
  "$caddyfile" >"$root/Caddyfile.published"
free_port() {
  for candidate in $(seq 18700 18799); do
    ss -ltnH | awk '{ print $4 }' | grep -q ":$candidate$" || { echo "$candidate"; return; }
  done
}
# published <network> <-p value, PORT for the port> <trusted proxies>: starts it; prints the port.
published() {
  docker rm -f "$project-published" >/dev/null 2>&1 || true
  port=$(free_port)
  docker run -d --name "$project-published" --network "$1" --log-driver none -p "$(echo "$2" | sed "s/PORT/$port/")" \
    -e TRIODITIS_SITE_ADDRESS=:80 -e CADDY_GLOBAL_OPTIONS='auto_https off' -e CADDY_TRUSTED_PROXIES="$3" \
    -v "$root/Caddyfile.published:/etc/caddy/Caddyfile:ro" "$caddy" >/dev/null
  for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$port/__test/client" 2>/dev/null && break; sleep 0.2; done
  echo "$port"
}
asked() { url=$1; shift; curl -s -m 5 "$@" "$url/__test/client"; }
gateway=$(docker network inspect -f '{{(index .IPAM.Config 0).Gateway}}' "$network")

# --public-url on the loopback, trusting the loopback and the network's gateway (the default
# there, from the installer).
port=$(published "$network" "127.0.0.1:PORT:80" "127.0.0.1/32 ::1/128 $gateway/32")
expect "$(asked "http://127.0.0.1:$port" -H 'X-Forwarded-For: 100.64.1.2')" "100.64.1.2 $gateway" \
  "behind a proxy on the loopback, the client is its X-Forwarded-For (peer: the gateway)"
expect "$(asked "http://127.0.0.1:$port")" "$gateway $gateway" "without X-Forwarded-For, it's the gateway"
expect "$(asked "http://127.0.0.1:$port" -H 'X-Forwarded-For: 6.6.6.6, 100.64.1.2')" "100.64.1.2 $gateway" \
  "with a client's address put first, it's still the one the proxy added"
expect "$(asked "http://127.0.0.1:$port" -H 'X-Forwarded-For: 7.7.7.7, 192.168.23.45')" "192.168.23.45 $gateway" \
  "a client of the proxy with a private address can't pick its address"
echo "  observed: loopback with X-Forwarded-For 100.64.1.2 -> '$(asked "http://127.0.0.1:$port" -H 'X-Forwarded-For: 100.64.1.2')'"
echo "  observed: 'X-Forwarded-For: 7.7.7.7, 192.168.23.45' -> '$(asked "http://127.0.0.1:$port" -H 'X-Forwarded-For: 7.7.7.7, 192.168.23.45')' trusting the gateway"
port=$(published "$network" "127.0.0.1:PORT:80" private_ranges)
echo "  observed: the same -> '$(asked "http://127.0.0.1:$port" -H 'X-Forwarded-For: 7.7.7.7, 192.168.23.45')' trusting private_ranges (the default before)"

# Direct, on every address, trusting no one; asked at this machine's LAN address.
lan=$(ip -o -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')
port=$(published "$network" "0.0.0.0:PORT:80" '')
expect "$(asked "http://$lan:$port" -H 'X-Forwarded-For: 6.6.6.6')" "$lan $lan" \
  "direct, the client is the address it came from, and its X-Forwarded-For is ignored"
echo "  observed: direct from $lan -> '$(asked "http://$lan:$port")'; [::] published: $(ss -ltnH | awk '{ print $4 }' | grep -c "^\[::\]:$port$")"

# Domain mode publishes on every address, IPv6 included; with IPv6 on the network, an IPv6
# client keeps its address.
v6=$(ip -6 -o addr show scope global 2>/dev/null | awk '{ print $4 }' | cut -d/ -f1 | head -1)
if [ -n "$v6" ]; then
  docker network create --ipv6 "$project-v6" >/dev/null
  port=$(published "$project-v6" "PORT:80" '')
  expect "$(asked "http://[$v6]:$port")" "$v6 $v6" "on an IPv6 network, an IPv6 client keeps its address"
  docker rm -f "$project-published" >/dev/null
  port=$(published "$network" "PORT:80" '')
  echo "  observed: IPv6 client $v6 into an IPv4-only network -> '$(asked "http://[$v6]:$port")' (why compose.ipv6.yml)"
else
  echo "  skipped: this machine has no global IPv6 address"
fi

finish
