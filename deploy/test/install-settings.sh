#!/bin/sh
# How install.sh writes its files, against a stub docker that stops it at `compose build`
# (just after the runtime config is written), so nothing is built or started: an existing
# deploy/.env it can't read stops the install and stays as it was; a symlink at
# deploy/runtime/config.json is replaced, not followed; the values Compose gets come from
# deploy/.env only, not from exported variables; and half a key pair (a public key without
# its private one, as a backup's secrets.env leaves) stops the install, unless
# --new-server-keys asks for a new pair; and --public-url with the port reachable from other
# machines needs --trusted-proxies, since any of them could send its own X-Forwarded-For; a
# .env not in the one form (export, spaces around =, quotes, even after a space, a name
# twice, a carriage return) stops it, unchanged; set_var refuses a name that isn't
# classified (listed in deploy/install/env-names, or a private key), so a new setting can't be
# added without deciding whether backups keep it, and nothing else writes deploy/.env; and a
# value that isn't literal (a space from --bind, say), or an option's value spanning lines (a
# second setting slipped in), or a NUL in deploy/.env, stops it before anything is saved. Every
# value a fresh install writes or generates is literal, since the stub runs get through. TRIODITIS_INSTALLER=<path> tests another
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
  cp -r "$repo/deploy/scripts" "$work/checkout/deploy/scripts"
  cp -r "$repo/deploy/updater" "$work/checkout/deploy/updater"
  cp "$repo/deploy/install/env-names" "$work/checkout/deploy/install/env-names"
}
# A systemd whose user manager answers, or doesn't with STUB_SYSTEMCTL=fail.
cat >"$work/bin/systemctl" <<'EOF'
#!/bin/sh
[ "${STUB_SYSTEMCTL:-ok}" = ok ]
EOF
chmod +x "$work/bin/systemctl"
cat >"$work/bin/docker" <<'EOF'
#!/bin/sh
case "$1" in
  info) [ "${2:-}" != --format ] || echo /var/lib/docker ;;
  build) ;;
  run)
    for name in BRIDGE AGENT_ACCESS; do echo "${name}_PUBLIC_KEY=stub-public" "${name}_PRIVATE_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" | tr ' ' '\n'; done
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
install() {
  runs=$((${runs:-0} + 1))
  if PATH="$work/bin:$PATH" STUB_LOG="$work/compose.log" bash "$work/checkout/deploy/install/install.sh" --host 127.0.0.1 --bind 127.0.0.1 --port 18999 "$@" >"$work/out" 2>&1; then status=0; else status=$?; fi
  cp "$work/checkout/deploy/.env" "$work/env.$runs" 2>/dev/null || true
  return "$status"
}
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
  AGENT_ACCESS_PUBLIC_KEY=agent-public AGENT_ACCESS_PRIVATE_KEY=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA >"$work/checkout/deploy/.env"
chmod 600 "$work/checkout/deploy/.env"
if install; then status=0; else status=$?; fi
[ "$status" != 0 ] && grep -q "keys import" "$work/out" && [ "$(value BRIDGE_PUBLIC_KEY)" = old-public ] &&
  [ -z "$(value BRIDGE_PRIVATE_KEY)" ] && check ok "half a key pair stops the install, pointing to keys import" ||
  check fail "half a key pair stops the install, pointing to keys import"
install --new-server-keys || true
[ "$(value BRIDGE_PUBLIC_KEY)" = stub-public ] && [ "$(value BRIDGE_PRIVATE_KEY)" = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ] &&
  [ "$(value AGENT_ACCESS_PUBLIC_KEY)" = agent-public ] && [ "$(value AGENT_ACCESS_PRIVATE_KEY)" = BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA ] &&
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
for line in 'export POSTGRES_PASSWORD=keep-me' 'POSTGRES_PASSWORD = keep-me' 'POSTGRES_PASSWORD="keep-me"' \
  'POSTGRES_PASSWORD= "keep-me"' "$(printf 'POSTGRES_PASSWORD=keep-me\r')" 'POSTGRES_PASSWORD=keep-me
POSTGRES_PASSWORD=again'; do
  checkout
  printf '%s\nCOMPOSE_PROJECT_NAME=trioditis-test\n' "$line" >"$work/checkout/deploy/.env"
  before=$(cat "$work/checkout/deploy/.env")
  if install; then status=0; else status=$?; fi
  [ "$status" != 0 ] && grep -qE "not in the form this writes|holds a NUL or a carriage return" "$work/out" && [ "$(cat "$work/checkout/deploy/.env")" = "$before" ] &&
    check ok "a .env with '$(echo "$line" | head -1 | tr '\r' '^')…' stops the install, unchanged" ||
    check fail "a .env with '$(echo "$line" | head -1 | tr '\r' '^')…' stops the install, unchanged"
done

# Every name the installer saves goes through set_var, which refuses one that's neither listed
# in deploy/install/env-names nor a private key: a copy of the installer that saves another
# stops, without saving it. And nothing else writes deploy/.env, in the installer or in
# deploy/trioditis (env_write, in deploy/scripts/env.sh, is the one writer).
checkout
awk '{ print } /^set_var \\$/ && !done { print "  NEW_SETTING \"x\" \\"; done = 1 }' "$installer" >"$work/checkout/deploy/install/install.sh"
grep -q 'NEW_SETTING' "$work/checkout/deploy/install/install.sh" || check fail "the test could add a setting to the installer"
if PATH="$work/bin:$PATH" STUB_LOG="$work/compose.log" bash "$work/checkout/deploy/install/install.sh" --host 127.0.0.1 >"$work/out" 2>&1; then status=0; else status=$?; fi
[ "$status" != 0 ] && grep -q "Not saving NEW_SETTING" "$work/out" && ! grep -qs NEW_SETTING "$work/checkout/deploy/.env" &&
  check ok "set_var refuses a setting that isn't classified, saving nothing" ||
  { check fail "set_var refuses a setting that isn't classified, saving nothing"; tail -3 "$work/out" >&2; }
# shellcheck disable=SC2016 # a grep pattern: the $ names are literal
direct=$(grep -nE '>\s*"?\$(env_file|here/\.env)|(mv|cp|ln)[^|;]* "\$env_file"\s*$|tee [^|;]*"\$env_file"' "$installer" "$repo/deploy/trioditis" || true)
[ -z "$direct" ] && check ok "nothing but env_write writes deploy/.env" || check fail "nothing but env_write writes deploy/.env ($direct)"

# A value that isn't literal (a space, here, from --bind) stops the install before it saves it.
checkout
if install --public-url https://proxy.invalid:8443 --bind '127.0.0.1 x'; then status=0; else status=$?; fi
[ "$status" != 0 ] && grep -qE "isn't literal|--bind must be one line" "$work/out" && [ ! -e "$work/checkout/deploy/.env" ] &&
  check ok "a value that isn't literal stops the install before anything is saved" ||
  { check fail "a value that isn't literal stops the install before anything is saved"; tail -3 "$work/out" >&2; }

# An option's value that spans lines, which would read as a second setting in deploy/.env.
nl='
'
for option in --host --domain --public-url --trusted-proxies; do
  checkout
  case "$option" in
    --public-url) value="https://box.example.com${nl}REVIEW_MARKER=literal" ;;
    --trusted-proxies) value="192.168.0.10/32${nl}REVIEW_MARKER=literal" ;;
    *) value="box.example.com${nl}REVIEW_MARKER=literal" ;;
  esac
  case "$option" in --trusted-proxies) extra="--public-url https://proxy.invalid:8443 --bind 192.168.0.96" ;; *) extra='' ;; esac
  # shellcheck disable=SC2086 # $extra is options
  if install $extra "$option" "$value"; then status=0; else status=$?; fi
  [ "$status" != 0 ] && grep -q -- "$option must be one line" "$work/out" && ! grep -qs REVIEW_MARKER "$work/checkout/deploy/.env" &&
    check ok "a $option value spanning lines stops the install, saving nothing" ||
    { check fail "a $option value spanning lines stops the install, saving nothing"; tail -2 "$work/out" >&2; }
done

# A NUL in a value of deploy/.env (which the shell's read would drop, with a warning).
checkout
printf 'POSTGRES_PASSWORD=keep\000me\nCOMPOSE_PROJECT_NAME=trioditis-test\n' >"$work/checkout/deploy/.env"
cp "$work/checkout/deploy/.env" "$work/env.nul"
if install; then status=0; else status=$?; fi
[ "$status" != 0 ] && grep -q "holds a NUL or a carriage return" "$work/out" && cmp -s "$work/checkout/deploy/.env" "$work/env.nul" &&
  check ok "a NUL in deploy/.env stops the install, unchanged" || { check fail "a NUL in deploy/.env stops the install, unchanged"; tail -2 "$work/out" >&2; }

# Telegram needs the operator's own app credentials: without them, or with ones that can't be
# right, the install stops before saving anything; with them they're saved, and a rerun that
# doesn't pass them keeps them.
checkout
if install --networks whatsapp,telegram; then status=0; else status=$?; fi
[ "$status" != 0 ] && grep -q "my.telegram.org/apps" "$work/out" && [ ! -e "$work/checkout/deploy/.env" ] &&
  check ok "telegram without an API ID and hash stops the install, saving nothing" ||
  { check fail "telegram without an API ID and hash stops the install, saving nothing"; tail -2 "$work/out" >&2; }
if install --networks telegram --telegram-api-id 1234567 --telegram-api-hash 0123456789abcdef; then status=0; else status=$?; fi
[ "$status" != 0 ] && grep -q -- "--telegram-api-hash must be" "$work/out" && [ ! -e "$work/checkout/deploy/.env" ] &&
  check ok "a short API hash stops the install, saving nothing" ||
  { check fail "a short API hash stops the install, saving nothing"; tail -2 "$work/out" >&2; }
install --networks telegram --telegram-api-id 1234567 --telegram-api-hash 0123456789abcdef0123456789abcdef || true
[ "$(value TELEGRAM_API_ID)" = 1234567 ] && [ "$(value TELEGRAM_API_HASH)" = 0123456789abcdef0123456789abcdef ] &&
  check ok "the API ID and hash are saved" || { check fail "the API ID and hash are saved"; tail -2 "$work/out" >&2; }
install || true
[ "$(value TELEGRAM_API_ID)" = 1234567 ] && [ "$(value TELEGRAM_API_HASH)" = 0123456789abcdef0123456789abcdef ] &&
  [ "$(value TRIODITIS_NETWORKS)" = telegram ] && check ok "and a rerun keeps them" || check fail "and a rerun keeps them"

# The updater is on by default where it can run: a new install in a git checkout with an origin
# remote turns it on, and one in a directory that isn't a git checkout gets it off and says why.
# A saved choice stays, and --updater where it can't run stops the install, changing nothing.
checkout
install || true
[ "$(value INSTALL_UPDATER)" = 0 ] && grep -q "The updater is off.*isn't one" "$work/out" &&
  check ok "outside a git checkout, the updater is off, saying why" ||
  { check fail "outside a git checkout, the updater is off, saying why"; tail -2 "$work/out" >&2; }
checkout
git -C "$work/checkout" init -q
git -C "$work/checkout" -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false commit -q --allow-empty -m test
git -C "$work/checkout" remote add origin https://example.invalid/trioditis.git
install || true
[ "$(value INSTALL_UPDATER)" = 1 ] && ! grep -q "The updater is off" "$work/out" &&
  check ok "in a git checkout with an origin remote, the updater is on" ||
  { check fail "in a git checkout with an origin remote, the updater is on"; tail -2 "$work/out" >&2; }
sed -i 's/^INSTALL_UPDATER=.*/INSTALL_UPDATER=0/' "$work/checkout/deploy/.env"
install || true
[ "$(value INSTALL_UPDATER)" = 0 ] && ! grep -q "The updater is off" "$work/out" &&
  check ok "an install that turned it off keeps it off" || check fail "an install that turned it off keeps it off"
cp "$work/checkout/deploy/.env" "$work/env.updater"
if STUB_SYSTEMCTL=fail install --updater; then status=0; else status=$?; fi
[ "$status" != 0 ] && grep -q "The updater can't run here: .*user manager" "$work/out" && cmp -s "$work/checkout/deploy/.env" "$work/env.updater" &&
  check ok "--updater where it can't run stops the install, unchanged" ||
  { check fail "--updater where it can't run stops the install, unchanged"; tail -2 "$work/out" >&2; }

# A unit directory it can't write, and a copy unpacked inside another repository (git would
# find that one, and the updater would update it), get the updater off by default too.
mkdir -p "$work/xdg/systemd"
: >"$work/xdg/systemd/user"
rm -f "$work/checkout/deploy/.env"
XDG_CONFIG_HOME="$work/xdg" install || true
[ "$(value INSTALL_UPDATER)" = 0 ] && grep -q "The updater is off.*isn't a directory this user can write to" "$work/out" &&
  check ok "with a unit directory it can't write, the updater is off, saying why" ||
  { check fail "with a unit directory it can't write, the updater is off, saying why"; tail -2 "$work/out" >&2; }
checkout
git -C "$work" init -q
git -C "$work" -c user.name=test -c user.email=test@example.invalid -c commit.gpgsign=false commit -q --allow-empty -m parent
git -C "$work" remote add origin https://example.invalid/other.git
install || true
rm -rf "$work/.git"
[ "$(value INSTALL_UPDATER)" = 0 ] && grep -q "The updater is off.*isn't one of its own" "$work/out" &&
  check ok "inside another repository, the updater is off, saying why" ||
  { check fail "inside another repository, the updater is off, saying why"; tail -2 "$work/out" >&2; }

if [ "$failures" = 0 ]; then echo "PASS: $test_name"; else echo "FAIL: $test_name ($failures failed)" >&2; fi
[ "$failures" = 0 ]
