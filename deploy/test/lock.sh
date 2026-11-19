#!/bin/sh
# deploy/trioditis passes on only Compose's own commands, with nothing before the command:
# any option there (a project, a compose file, an env file, a project directory, a dry run…)
# is refused, lock or not, and so is a command it doesn't know; a command's own options
# (logs -f) pass through. While a backup, install or other write command holds the lock, the
# commands that change things (start, up, stop…), create-admin and backup are refused, and the
# read-only ones (ps, config, logs) run. And restore, on a checkout with no install, still
# says it isn't available yet.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "only plain Compose commands, and write commands wait for the lock"

run() { if trioditis "$@" >"$root/out" 2>&1 </dev/null; then status=0; else status=$?; fi; }
refused_by() {
  message=$1
  shift
  run "$@"
  [ "$status" != 0 ] && grep -q -- "$message" "$root/out" &&
    check ok "'$*' is refused" || { check fail "'$*' is refused"; cat "$root/out" >&2; }
}
allowed() {
  run "$@"
  [ "$status" = 0 ] && check ok "'$*' runs" || { check fail "'$*' runs"; cat "$root/out" >&2; }
}
options="takes no options before the command"

# Anything before the command, lock free.
for form in "--compatibility=false --project-name other config" "-f other.yml ps" "--env-file x ps" \
  "--project-directory x ps" "--dry-run stop" "-pother stop postgres" "-p other stop postgres" \
  "--project-name=other stop postgres" "--project-name other stop postgres" "--profile ps stop postgres" \
  "--profile=ps stop postgres" "--frobnicate ps"; do
  # shellcheck disable=SC2086 # $form is the arguments
  refused_by "$options" $form
done
refused_by "doesn't know the command" frobnicate
refused_by "Usage" ''
allowed logs -f backend
allowed ps --services

# With the lock held.
sh -c 'exec 9>"$1" && flock 9 && exec sleep 120' sh "$root/deploy/.operation.lock" &
holder=$!
sleep 1
locked="Another backup, install or change to this install"
refused_by "$locked" start
refused_by "$locked" up -d postgres
refused_by "$locked" stop postgres
refused_by "$locked" create-admin someone@example.invalid
refused_by "$locked" backup "$backups"
allowed ps
allowed config --services
allowed logs backend
kill "$holder" 2>/dev/null || true
wait 2>/dev/null || true

# Restore on a checkout with no install yet.
mv "$root/deploy/.env" "$root/env.saved"
run restore --yes "$backups/x"
mv "$root/env.saved" "$root/deploy/.env"
[ "$status" != 0 ] && grep -q "Restore isn't available in this version yet" "$root/out" &&
  check ok "restore with no install says it isn't available yet" || { check fail "restore with no install says it isn't available yet"; cat "$root/out" >&2; }

finish
