#!/bin/sh
# While a backup, install or other write command holds the lock, deploy/trioditis runs only
# commands that change nothing: start, up, a passthrough with an option first, create-admin
# and backup are refused, and so is a command hidden behind an option's value (--profile ps
# stop) or an option it doesn't know; ps and config run, after global options too.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "write commands wait for the lock"

flock "$root/deploy/.operation.lock" sleep 120 &
holder=$!
sleep 1
refused() {
  if trioditis "$@" >"$root/out" 2>&1 </dev/null; then status=0; else status=$?; fi
  [ "$status" != 0 ] && grep -q "Another backup, install or change to this install" "$root/out" &&
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
refused --profile ps stop postgres
refused --profile=ps stop postgres
refused -f compose.yml --profile ps stop postgres
refused --frobnicate ps
refused --profile fake
allowed ps
allowed config --services
allowed --profile fake ps
allowed --profile=fake --ansi never ps
kill "$holder" 2>/dev/null || true
wait 2>/dev/null || true

finish
