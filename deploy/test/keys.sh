#!/bin/sh
# `keys export` writes the server's keys to a new 0600 file, never over anything and never
# inside the checkout; `keys import` puts the private keys back into a deploy/.env that has
# only the public ones (as a backup's secrets.env does), and refuses a pair that isn't this
# server's: one whose public key differs, or whose private key isn't the private half of the
# saved public key (mixed pairs). Neither prints a key. The keys are real X25519 pairs, made
# with the bundle's Node image, since import derives each public key to check it.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "keys export and import"
env_file="$root/deploy/.env"
node_image=node:24.21-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
docker image inspect "$node_image" >/dev/null 2>&1 || docker pull -q "$node_image" >/dev/null
# Three real pairs: the server's two, and one from elsewhere.
docker run --rm --network none --log-driver none "$node_image" node -e "
  const { generateKeyPairSync } = require('node:crypto')
  for (const name of ['BRIDGE', 'AGENT_ACCESS', 'OTHER']) {
    const { publicKey, privateKey } = generateKeyPairSync('x25519')
    console.log(name + '_PUBLIC_KEY=' + publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'))
    console.log(name + '_PRIVATE_KEY=' + privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64url'))
  }" >"$root/pairs"
grep -vE '^(BRIDGE|AGENT_ACCESS)_(PUBLIC|PRIVATE)_KEY=' "$env_file" >"$root/env"
grep -E '^(BRIDGE|AGENT_ACCESS)_' "$root/pairs" >>"$root/env"
cp "$root/env" "$env_file"
key() { sed -n "s/^$1=//p" "$root/pairs"; }
no_key_in() { ! grep -qF -e "$(key BRIDGE_PRIVATE_KEY)" -e "$(key AGENT_ACCESS_PRIVATE_KEY)" -e "$(key OTHER_PRIVATE_KEY)" "$1"; }

trioditis keys export "$backups/keys" >"$root/out" 2>&1 && status=0 || status=$?
[ "$status" = 0 ] && [ "$(stat -c %a "$backups/keys")" = 600 ] &&
  [ "$(grep -cE '^(BRIDGE|AGENT_ACCESS)_(PUBLIC|PRIVATE)_KEY=.' "$backups/keys")" = 4 ] &&
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

# Mixed pairs: this server's public keys with private keys that aren't their halves (the
# other's, and the two swapped).
sed "s/^BRIDGE_PRIVATE_KEY=.*/BRIDGE_PRIVATE_KEY=$(key OTHER_PRIVATE_KEY)/" "$backups/keys" >"$backups/mixed"
sed "s/^BRIDGE_PRIVATE_KEY=.*/BRIDGE_PRIVATE_KEY=$(key AGENT_ACCESS_PRIVATE_KEY)/; s/^AGENT_ACCESS_PRIVATE_KEY=.*/AGENT_ACCESS_PRIVATE_KEY=$(key BRIDGE_PRIVATE_KEY)/" \
  "$backups/keys" >"$backups/swapped"
for file in mixed swapped; do
  trioditis keys import "$backups/$file" >"$root/out" 2>&1 && status=0 || status=$?
  [ "$status" != 0 ] && grep -q "isn't the private half" "$root/out" && cmp -s "$env_file" "$root/secrets.env" && no_key_in "$root/out" &&
    check ok "import refuses a $file pair, printing no key" || { check fail "import refuses a $file pair, printing no key"; cat "$root/out" >&2; }
done

trioditis keys import "$backups/keys" >"$root/out" 2>&1 && status=0 || status=$?
[ "$status" = 0 ] && grep -qx "BRIDGE_PRIVATE_KEY=$(key BRIDGE_PRIVATE_KEY)" "$env_file" &&
  grep -qx "AGENT_ACCESS_PRIVATE_KEY=$(key AGENT_ACCESS_PRIVATE_KEY)" "$env_file" &&
  [ "$(grep -vE '^(BRIDGE|AGENT_ACCESS)_PRIVATE_KEY=' "$env_file")" = "$(cat "$root/secrets.env")" ] &&
  [ "$(stat -c %a "$env_file")" = 600 ] &&
  check ok "import adds the private keys and changes nothing else" || check fail "import adds the private keys and changes nothing else"
no_key_in "$root/out" && check ok "import prints no key" || check fail "import prints no key"

finish
