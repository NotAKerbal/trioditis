#!/bin/sh
# A restore that fails partway leaves every volume as it was:
# - the archive's copy of the second volume doesn't fit it (a 1 MiB tmpfs), so replacing it
#   fails after the first volume has been replaced, and everything is put back;
# - the second volume is read-only, so putting it back fails too: the checked copies are kept,
#   and the printed command that puts one back works (and refuses an incomplete copy);
# - the worker can't start (the second volume's bind source is missing): nothing is touched,
#   and no command that would replace a volume is printed.
# A tmpfs volume loses its contents when nothing has it mounted, so a holder container keeps
# the second volume mounted from when it's written until it's checked.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "restore fails partway"

make_volume bridge-fake
make_volume bridge-whatsapp
make_volume postgres
fill bridge-fake 'echo one >/v/a && mkdir /v/d && echo deep >/v/d/b'
fill bridge-whatsapp 'head -c 3000000 /dev/urandom >/v/big'
fill postgres 'echo 17 >/v/PG_VERSION && chown 70:70 /v && chmod 700 /v'
archive="$backups/archive.tgz"
make_archive "$archive" bridge-fake bridge-whatsapp postgres

# Replaces the second volume with one made with the given options, held mounted.
replace_whatsapp() {
  docker rm -f "$project-holder" >/dev/null 2>&1 || true
  docker volume rm "${project}_bridge-whatsapp" >/dev/null
  make_volume bridge-whatsapp "$@"
  docker run -d --name "$project-holder" --log-driver none -v "${project}_bridge-whatsapp:/v" \
    --entrypoint sleep "$tool" 3600 >/dev/null
}
restore() {
  if trioditis restore --yes "$archive" >"$root/out" 2>&1; then status=0; else status=$?; fi
}
leftovers() { docker volume ls -q | grep "^$project" | grep -e "-restore-" || true; }

# What's there before the restore, unlike the archive: changed data, and the second volume a
# tmpfs too small for the archive's copy of it.
replace_whatsapp --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=1m
fill bridge-whatsapp 'echo before >/v/small'
fill bridge-fake 'echo changed >/v/a && rm -r /v/d && echo new >/v/c'
fill postgres 'echo 16 >/v/PG_VERSION'
fill bridge-whatsapp 'grep -qx before /v/small' && check ok "the second volume holds its sentinel" ||
  check fail "the second volume holds its sentinel"
before=$(sums bridge-fake bridge-whatsapp postgres)
restore
[ "$status" != 0 ] && check ok "the restore failed (exit $status)" || check fail "the restore failed"
[ "$(sums bridge-fake bridge-whatsapp postgres)" = "$before" ] &&
  check ok "every volume is byte-identical to before" || check fail "every volume is byte-identical to before"
fill bridge-whatsapp 'grep -qx before /v/small' && check ok "the sentinel is still there" ||
  check fail "the sentinel is still there"
[ -z "$(leftovers)" ] && check ok "nothing of the restore's is left" || check fail "nothing of the restore's is left"

# Read-only: replacing it fails, and so does putting it back.
replace_whatsapp --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=1m,ro
before=$(sums bridge-fake bridge-whatsapp postgres)
restore
[ "$status" != 0 ] && check ok "the read-only restore failed (exit $status)" || check fail "the read-only restore failed"
[ "$(sums bridge-fake bridge-whatsapp postgres)" = "$before" ] &&
  check ok "every volume is byte-identical to before (read-only)" ||
  check fail "every volume is byte-identical to before (read-only)"
fake_command=$(grep -F -- "-v ${project}_bridge-fake:/to " "$root/out" || true)
[ -n "$(leftovers | grep -e '-rollback$')" ] && [ -n "$fake_command" ] && echo "$fake_command" | grep -qF '[ -f /from/' &&
  check ok "the checked copies are kept, with commands that check them first" ||
  check fail "the checked copies are kept, with commands that check them first"
# Change the first volume, then put it back with the printed command.
fill bridge-fake 'echo after-the-restore >/v/a'
sh -c "$fake_command" 2>/dev/null && [ "$(sums bridge-fake bridge-whatsapp postgres)" = "$before" ] &&
  check ok "the printed command puts the volume back as it was" || check fail "the printed command puts the volume back as it was"
# A copy without the mark (here, emptied) is refused, and the volume is left alone.
copy=$(leftovers | grep -e "_bridge-fake-restore-.*-rollback$")
docker run --rm --log-driver none -v "$copy:/c" --entrypoint sh "$tool" -c 'find /c -mindepth 1 -delete'
fill bridge-fake 'echo kept >/v/kept'
kept=$(sums bridge-fake)
if sh -c "$fake_command" 2>/dev/null; then refused=no; else refused=yes; fi
[ "$refused" = yes ] && [ "$(sums bridge-fake)" = "$kept" ] &&
  check ok "the command refuses an incomplete copy" || check fail "the command refuses an incomplete copy"
leftovers | xargs -r docker volume rm >/dev/null

# The worker can't start: the second volume binds a directory that doesn't exist.
docker rm -f "$project-holder" >/dev/null 2>&1 || true
docker volume rm "${project}_bridge-whatsapp" >/dev/null
make_volume bridge-whatsapp --driver local --opt type=none --opt o=bind --opt device="$root/missing"
before=$(sums bridge-fake postgres)
restore
[ "$status" != 0 ] && check ok "the restore with a worker that can't start failed" || check fail "the restore with a worker that can't start failed"
[ "$(sums bridge-fake postgres)" = "$before" ] && check ok "the other volumes are byte-identical to before" ||
  check fail "the other volumes are byte-identical to before"
! grep -q -e "-v ${project}_.*:/to" "$root/out" && grep -q "never touched" "$root/out" &&
  check ok "no command that would replace a volume is printed, and it says nothing was touched" ||
  { check fail "no command that would replace a volume is printed, and it says nothing was touched"; cat "$root/out" >&2; }
[ -z "$(leftovers)" ] && check ok "nothing of the restore's is left" || check fail "nothing of the restore's is left"

finish
