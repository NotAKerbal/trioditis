#!/bin/sh
# `keys export` writes the server's keys to a new 0600 file, never over anything and never
# inside the checkout; `keys import` puts the private keys back into a deploy/.env that has
# only the public ones (as a backup's secrets.env does), and refuses a pair that isn't this
# server's. Neither prints a key.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "keys export and import"
env_file="$root/deploy/.env"
no_key_in() { ! grep -qE 'test-(BRIDGE|AGENT_ACCESS)_PRIVATE_KEY' "$1"; }

trioditis keys export "$backups/keys" >"$root/out" 2>&1 && status=0 || status=$?
[ "$status" = 0 ] && [ "$(stat -c %a "$backups/keys")" = 600 ] &&
  [ "$(grep -cE '^(BRIDGE|AGENT_ACCESS)_(PUBLIC|PRIVATE)_KEY=test-' "$backups/keys")" = 4 ] &&
  check ok "export writes the four keys to a new 0600 file" || check fail "export writes the four keys to a new 0600 file"
no_key_in "$root/out" && check ok "export prints no key" || check fail "export prints no key"

echo keep >"$backups/taken"
trioditis keys export "$backups/taken" >"$root/out" 2>&1 && status=0 || status=$?
[ "$status" != 0 ] && [ "$(cat "$backups/taken")" = keep ] && [ -z "$(find "$backups" -name '.trioditis-keys-*')" ] &&
  check ok "export never overwrites a file" || check fail "export never overwrites a file"
trioditis keys export "$root/deploy/keys" >"$root/out" 2>&1 && status=0 || status=$?
[ "$status" != 0 ] && [ ! -e "$root/deploy/keys" ] && check ok "export refuses the checkout" || check fail "export refuses the checkout"

# As after a lost server: deploy/.env is a backup's secrets.env, without the private keys.
grep -vE '^(BRIDGE|AGENT_ACCESS)_PRIVATE_KEY=' "$env_file" >"$root/secrets.env"
cp "$root/secrets.env" "$env_file"
# A pair from another server: the same file, another bridge public key.
sed 's/^BRIDGE_PUBLIC_KEY=.*/BRIDGE_PUBLIC_KEY=another-server/' "$backups/keys" >"$backups/foreign"
trioditis keys import "$backups/foreign" >"$root/out" 2>&1 && status=0 || status=$?
[ "$status" != 0 ] && cmp -s "$env_file" "$root/secrets.env" && check ok "import refuses a pair that isn't this server's" ||
  check fail "import refuses a pair that isn't this server's"

trioditis keys import "$backups/keys" >"$root/out" 2>&1 && status=0 || status=$?
[ "$status" = 0 ] && grep -qx 'BRIDGE_PRIVATE_KEY=test-BRIDGE_PRIVATE_KEY' "$env_file" &&
  grep -qx 'AGENT_ACCESS_PRIVATE_KEY=test-AGENT_ACCESS_PRIVATE_KEY' "$env_file" &&
  [ "$(grep -vE '^(BRIDGE|AGENT_ACCESS)_PRIVATE_KEY=' "$env_file")" = "$(cat "$root/secrets.env")" ] &&
  [ "$(stat -c %a "$env_file")" = 600 ] &&
  check ok "import adds the private keys and changes nothing else" || check fail "import adds the private keys and changes nothing else"
no_key_in "$root/out" && check ok "import prints no key" || check fail "import prints no key"

finish
