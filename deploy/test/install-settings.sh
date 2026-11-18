#!/bin/sh
# How install.sh writes its files, against a stub docker that stops it at `compose build`
# (just after the runtime config is written), so nothing is built or started: an existing
# deploy/.env it can't read stops the install and stays as it was; a symlink at
# deploy/runtime/config.json is replaced, not followed; the values Compose gets come from
# deploy/.env only, not from exported variables; and half a key pair (a public key without
# its private one, as a backup's secrets.env leaves) stops the install, unless
# --new-server-keys asks for a new pair; and --public-url with the port reachable from other
# machines needs --trusted-proxies, since any of them could send its own X-Forwarded-For. TRIODITIS_INSTALLER=<path> tests another
# install.sh.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
installer=${TRIODITIS_INSTALLER:-$repo/deploy/install/install.sh}
test_name="install.sh writes its files safely"
failures=0
check() {
  if [ "$1" = ok ]; then echo "  ok: $2"; else echo "  FAILED: $2" >&2 && failures=$((failures + 1)); fi
}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"
echo "$test_name"

# A checkout with the installer and compose files, and the stub docker on PATH.
checkout() {
  rm -rf "$work/checkout"
  mkdir -p "$work/checkout/deploy/install"
  cp "$installer" "$work/checkout/deploy/install/install.sh"
  cp -r "$repo/deploy/compose" "$work/checkout/deploy/compose"
}
cat >"$work/bin/docker" <<'EOF'
#!/bin/sh
case "$1" in
  info) [ "${2:-}" != --format ] || echo /var/lib/docker ;;
  build) ;;
  run)
    for name in BRIDGE AGENT_ACCESS; do echo "${name}_PUBLIC_KEY=stub-public" "${name}_PRIVATE_KEY=stub-private" | tr ' ' '\n'; done
    ;;
  compose)
    [ "${2:-}" != version ] || exit 0
    # What Compose would have been handed from the environment, then stop the install.
    echo "TRIODITIS_SETUP_TOKEN=${TRIODITIS_SETUP_TOKEN-unset} COMPOSE_FILE=${COMPOSE_FILE-unset} COMPOSE_PATH_SEPARATOR=${COMPOSE_PATH_SEPARATOR-unset}" >>"$STUB_LOG"
    echo "stub: stopping at docker compose $*" >&2
    exit 1
    ;;
  *) echo "stub: unexpected docker $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$work/bin/docker"
install() { PATH="$work/bin:$PATH" STUB_LOG="$work/compose.log" bash "$work/checkout/deploy/install/install.sh" --host 127.0.0.1 --bind 127.0.0.1 --port 18999 "$@" >"$work/out" 2>&1; }
value() { sed -n "s/^$1=//p" "$work/checkout/deploy/.env" | tail -1; }

# An existing .env it can't read.
checkout
printf 'POSTGRES_PASSWORD=keep-me\nCOMPOSE_PROJECT_NAME=trioditis-test\n' >"$work/checkout/deploy/.env"
chmod 000 "$work/checkout/deploy/.env"
if install; then status=0; else status=$?; fi
chmod 600 "$work/checkout/deploy/.env"
[ "$status" != 0 ] && grep -q "Couldn't read deploy/.env" "$work/out" &&
  check ok "an unreadable .env stops the install" || check fail "an unreadable .env stops the install"
[ "$(cat "$work/checkout/deploy/.env")" = "$(printf 'POSTGRES_PASSWORD=keep-me\nCOMPOSE_PROJECT_NAME=trioditis-test')" ] &&
  check ok "and stays as it was" || check fail "and stays as it was"

# A symlink at the runtime config, and exported values that deploy/.env should override.
checkout
mkdir -p "$work/checkout/deploy/runtime"
printf 'not yours\n' >"$work/victim"
chmod 600 "$work/victim"
ln -s "$work/victim" "$work/checkout/deploy/runtime/config.json"
rm -f "$work/compose.log"
TRIODITIS_SETUP_TOKEN=exported COMPOSE_FILE=exported.yml COMPOSE_PATH_SEPARATOR=, install || true
[ "$(cat "$work/victim")" = "not yours" ] && [ "$(stat -c %a "$work/victim")" = 600 ] &&
  check ok "the symlink's target is untouched" || check fail "the symlink's target is untouched"
config="$work/checkout/deploy/runtime/config.json"
[ -f "$config" ] && [ ! -L "$config" ] && [ "$(stat -c %a "$config")" = 644 ] && grep -q '"convexUrl": "http://127.0.0.1:18999/convex"' "$config" &&
  check ok "config.json is a new 0644 file in its place" || check fail "config.json is a new 0644 file in its place"
[ "$(stat -c %a "$work/checkout/deploy/.env")" = 600 ] && check ok ".env is 0600" || check fail ".env is 0600"
[ -s "$work/compose.log" ] && ! grep -qv 'TRIODITIS_SETUP_TOKEN=unset COMPOSE_FILE=unset COMPOSE_PATH_SEPARATOR=unset' "$work/compose.log" &&
  check ok "Compose gets no exported value" || check fail "Compose gets no exported value ($(cat "$work/compose.log" 2>/dev/null))"

# Half the bridge key pair, as after restoring a backup's secrets.env.
checkout
printf '%s\n' POSTGRES_PASSWORD=keep-me COMPOSE_PROJECT_NAME=trioditis-test BRIDGE_PUBLIC_KEY=old-public \
  AGENT_ACCESS_PUBLIC_KEY=agent-public AGENT_ACCESS_PRIVATE_KEY=agent-private >"$work/checkout/deploy/.env"
chmod 600 "$work/checkout/deploy/.env"
if install; then status=0; else status=$?; fi
[ "$status" != 0 ] && grep -q "keys import" "$work/out" && [ "$(value BRIDGE_PUBLIC_KEY)" = old-public ] &&
  [ -z "$(value BRIDGE_PRIVATE_KEY)" ] && check ok "half a key pair stops the install, pointing to keys import" ||
  check fail "half a key pair stops the install, pointing to keys import"
install --new-server-keys || true
[ "$(value BRIDGE_PUBLIC_KEY)" = stub-public ] && [ "$(value BRIDGE_PRIVATE_KEY)" = stub-private ] &&
  [ "$(value AGENT_ACCESS_PUBLIC_KEY)" = agent-public ] && [ "$(value AGENT_ACCESS_PRIVATE_KEY)" = agent-private ] &&
  check ok "--new-server-keys makes a new pair for that half only" || check fail "--new-server-keys makes a new pair for that half only"

# --public-url on a LAN bind: refused without --trusted-proxies, kept with it. (The proxy's
# name doesn't resolve, so no hairpin is looked for.)
checkout
if install --public-url https://proxy.invalid:8443 --bind 192.168.0.96; then status=0; else status=$?; fi
[ "$status" != 0 ] && grep -q -- "--trusted-proxies" "$work/out" && [ ! -e "$work/checkout/deploy/.env" ] &&
  check ok "--public-url on a LAN bind needs --trusted-proxies" || check fail "--public-url on a LAN bind needs --trusted-proxies"
install --public-url https://proxy.invalid:8443 --bind 192.168.0.96 --trusted-proxies 192.168.0.10/32 || true
[ "$(value CADDY_TRUSTED_PROXIES)" = 192.168.0.10/32 ] && check ok "and trusts only the proxy given" ||
  check fail "and trusts only the proxy given ($(value CADDY_TRUSTED_PROXIES))"
checkout
install --public-url https://proxy.invalid:8443 || true
[ "$(value CADDY_TRUSTED_PROXIES)" = "127.0.0.1/32 ::1/128" ] && [ "$(value HTTP_BIND)" = 127.0.0.1 ] &&
  check ok "on the loopback, only the loopback is trusted until the network's gateway is known" ||
  check fail "on the loopback, only the loopback is trusted until the network's gateway is known ($(value CADDY_TRUSTED_PROXIES))"

# A .env not in the form the installer writes stops it, unchanged.
for line in 'export POSTGRES_PASSWORD=keep-me' 'POSTGRES_PASSWORD = keep-me' 'POSTGRES_PASSWORD="keep-me"' 'POSTGRES_PASSWORD=keep-me
POSTGRES_PASSWORD=again'; do
  checkout
  printf '%s\nCOMPOSE_PROJECT_NAME=trioditis-test\n' "$line" >"$work/checkout/deploy/.env"
  before=$(cat "$work/checkout/deploy/.env")
  if install; then status=0; else status=$?; fi
  [ "$status" != 0 ] && grep -q "not in the form this writes" "$work/out" && [ "$(cat "$work/checkout/deploy/.env")" = "$before" ] &&
    check ok "a .env with '$(echo "$line" | head -1)…' stops the install, unchanged" ||
    check fail "a .env with '$(echo "$line" | head -1)…' stops the install, unchanged"
done

if [ "$failures" = 0 ]; then echo "PASS: $test_name"; else echo "FAIL: $test_name ($failures failed)" >&2; fi
[ "$failures" = 0 ]
