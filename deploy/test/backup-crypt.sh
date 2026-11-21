#!/bin/sh
# deploy/scripts/backup-crypt.mjs, which encrypts backups with the install's BACKUP_KEY: what it
# encrypts decrypts to the same bytes, at every size around its chunk boundary (empty included);
# a file cut short (by a byte, or just after a whole chunk), one with a byte changed, and one
# decrypted with another key all fail; a BACKUP_KEY that isn't exactly a key is refused; and the
# encrypted file holds none of the data in the clear. Needs node (24 or later) on PATH; no Docker.
# shellcheck disable=SC2015 # `cond && check ok || check fail`: check ok always succeeds
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
crypt=$repo/deploy/scripts/backup-crypt.mjs
test_name="backups are encrypted, and only decrypt whole and unchanged"
failures=0
check() {
  if [ "$1" = ok ]; then echo "  ok: $2"; else echo "  FAILED: $2" >&2 && failures=$((failures + 1)); fi
}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
echo "$test_name"
new_key() { head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'; }
BACKUP_KEY=$(new_key)
export BACKUP_KEY

for size in 0 1 65535 65536 65537 131072 300000; do
  head -c "$size" /dev/urandom >"$work/plain"
  node "$crypt" encrypt <"$work/plain" >"$work/sealed" && node "$crypt" decrypt <"$work/sealed" >"$work/opened" &&
    cmp -s "$work/plain" "$work/opened" && check ok "$size bytes decrypt to what was encrypted" ||
    check fail "$size bytes decrypt to what was encrypted"
done

# A recognisable plaintext, which mustn't show in the encrypted file.
for _ in $(seq 20000); do echo 'Chat name: Alice and Bob'; done >"$work/plain"
node "$crypt" encrypt <"$work/plain" >"$work/sealed"
! grep -q 'Alice and Bob' "$work/sealed" && check ok "the encrypted file holds none of it in the clear" ||
  check fail "the encrypted file holds none of it in the clear"

fails() { # $1: what; reads the file to decrypt on stdin
  if node "$crypt" decrypt >"$work/out" 2>"$work/err"; then check fail "$1 fails"; else check ok "$1 fails"; fi
}
size=$(wc -c <"$work/sealed")
head -c "$((size - 1))" "$work/sealed" | fails "a file cut short by a byte"
head -c "$((20 + 32 + 65536 + 16))" "$work/sealed" | fails "a file cut just after a whole chunk"
{ head -c 100 "$work/sealed"; printf 'X'; tail -c +102 "$work/sealed"; } | fails "a file with a byte changed"
BACKUP_KEY=$(new_key) fails "decrypting with another key" <"$work/sealed"
# A file encrypted as one backup's archive opens only as that.
BACKUP_CONTEXT=one/archive node "$crypt" encrypt <"$work/plain" >"$work/bound"
BACKUP_CONTEXT=one/archive node "$crypt" decrypt <"$work/bound" | cmp -s - "$work/plain" &&
  check ok "a file bound to its backup and role decrypts as itself" || check fail "a file bound to its backup and role decrypts as itself"
BACKUP_CONTEXT=two/archive fails "the same file as another backup's archive" <"$work/bound"
BACKUP_CONTEXT=one/settings fails "the same file as its backup's settings" <"$work/bound"
fails "the same file with no backup named" <"$work/bound"
printf 'not a backup' | fails "a file that isn't one"
for bad in '' short "$(new_key)=" "$(new_key | cut -c1-42)B"; do
  if BACKUP_KEY=$bad node "$crypt" encrypt </dev/null >/dev/null 2>&1; then
    check fail "a BACKUP_KEY like '$(printf '%s' "$bad" | cut -c1-6)…' ($(printf '%s' "$bad" | wc -c) chars) is refused"
  else
    check ok "a BACKUP_KEY like '$(printf '%s' "$bad" | cut -c1-6)…' ($(printf '%s' "$bad" | wc -c) chars) is refused"
  fi
done

if [ "$failures" -gt 0 ]; then
  echo "FAIL: $test_name ($failures failed)" >&2
  exit 1
fi
echo "PASS: $test_name"
