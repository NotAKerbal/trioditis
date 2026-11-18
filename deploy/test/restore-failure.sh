#!/bin/sh
# A restore that fails partway leaves every volume as it was. The archive's copy of the second
# volume doesn't fit it (a 1 MiB tmpfs), so replacing it fails after the first volume has
# been replaced; then the same with the second volume read-only, where putting its previous
# contents back fails too and the restore must keep a copy and say how to put it back.
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

# What's there before the restore, unlike the archive: changed data, and the second volume a
# tmpfs too small for the archive's copy of it.
replace_whatsapp() {
  docker volume rm "${project}_bridge-whatsapp" >/dev/null
  make_volume bridge-whatsapp --driver local --opt type=tmpfs --opt device=tmpfs --opt "o=$1"
}
replace_whatsapp size=1m
fill bridge-whatsapp 'echo before >/v/small'
fill bridge-fake 'echo changed >/v/a && rm -r /v/d && echo new >/v/c'
fill postgres 'echo 16 >/v/PG_VERSION'
before=$(sums bridge-fake bridge-whatsapp postgres)

if trioditis restore --yes "$archive" >"$root/out" 2>&1; then status=0; else status=$?; fi
[ "$status" != 0 ] && check ok "the restore failed (exit $status)" || check fail "the restore failed"
[ "$(sums bridge-fake bridge-whatsapp postgres)" = "$before" ] &&
  check ok "every volume is byte-identical to before" || check fail "every volume is byte-identical to before"
[ -z "$(docker volume ls -q | grep "^$project" | grep -e "-restore-")" ] &&
  check ok "nothing of the restore's is left" || check fail "nothing of the restore's is left"

# Read-only: replacing it fails, and so does putting it back.
replace_whatsapp size=1m,ro
before=$(sums bridge-fake bridge-whatsapp postgres)
if trioditis restore --yes "$archive" >"$root/out" 2>&1; then status=0; else status=$?; fi
[ "$status" != 0 ] && check ok "the read-only restore failed (exit $status)" || check fail "the read-only restore failed"
[ "$(sums bridge-fake bridge-whatsapp postgres)" = "$before" ] &&
  check ok "every volume is byte-identical to before (read-only)" ||
  check fail "every volume is byte-identical to before (read-only)"
kept=$(docker volume ls -q | grep "^${project}_.*-restore-.*-rollback$" || true)
[ -n "$kept" ] && grep -q "docker volume prune -af --filter label=" "$root/out" &&
  check ok "the previous contents are kept, with how to put them back" ||
  check fail "the previous contents are kept, with how to put them back"

finish
