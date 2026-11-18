#!/bin/sh
# While a backup, restore or install holds the install's lock, deploy/trioditis runs only
# commands that change nothing: start, up, a passthrough with an option first, create-admin
# and backup are refused; ps and config run.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "write commands wait for the lock"

flock "$root/deploy/.operation.lock" sleep 120 &
holder=$!
sleep 1
refused() {
  if trioditis "$@" >"$root/out" 2>&1 </dev/null; then status=0; else status=$?; fi
  [ "$status" != 0 ] && grep -q "Another backup, restore or install" "$root/out" &&
    check ok "'$*' is refused" || { check fail "'$*' is refused"; cat "$root/out" >&2; }
}
allowed() {
  trioditis "$@" >"$root/out" 2>&1 </dev/null && check ok "'$*' runs" || { check fail "'$*' runs"; cat "$root/out" >&2; }
}
refused start
refused up -d postgres
refused --profile fake up -d
refused create-admin someone@example.invalid
refused backup "$backups"
allowed ps
allowed config --services
kill "$holder" 2>/dev/null || true
wait 2>/dev/null || true

finish
