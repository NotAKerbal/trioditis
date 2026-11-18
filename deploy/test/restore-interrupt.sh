#!/bin/sh
# Two interrupts during a restore (SIGINT to its process group, as Ctrl-C at a terminal
# sends): the first, while it replaces the volumes' contents, makes it put everything back;
# the second, during that, doesn't cut it short. Every volume ends byte-identical to before,
# and nothing of the restore's is left.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "a second interrupt doesn't cut a rollback short"

make_volume bridge-fake
make_volume postgres
# Large and incompressible, so replacing it takes long enough to interrupt.
fill bridge-fake 'head -c 800000000 /dev/urandom >/v/big'
fill postgres 'echo 17 >/v/PG_VERSION'
archive="$backups/archive.tgz"
make_archive "$archive" bridge-fake postgres
# What's there before is large too, so putting it back takes long enough to interrupt again.
fill bridge-fake 'head -c 500000000 /dev/urandom >/v/big && echo before >/v/small'
fill postgres 'echo 16 >/v/PG_VERSION'
before=$(sums bridge-fake postgres)

# A background job starts with SIGINT ignored, which a terminal's Ctrl-C doesn't: restored here.
setsid env --default-signal=INT "$root/deploy/trioditis" restore --yes "$archive" >"$root/out" 2>&1 &
for _ in $(seq 1800); do
  ! grep -q "Replacing the volumes" "$root/out" || break
  sleep 0.1
done
restorer=$(pgrep -f "deploy/trioditis restore --yes $archive" | head -1)
if grep -q "Replacing the volumes" "$root/out" && [ -n "$restorer" ]; then
  group=$(ps -o pgid= -p "$restorer" | tr -d ' ')
  /bin/kill -s INT -- "-$group"
  # The second, once it says it's putting things back, or three seconds on (it's putting back
  # 500 MB by then), whichever comes first.
  for _ in $(seq 30); do
    ! grep -q "Putting the previous contents back" "$root/out" || break
    sleep 0.1
  done
  /bin/kill -s INT -- "-$group" 2>/dev/null || true
  wait || true
  grep -q "Putting the previous contents back" "$root/out" && check ok "the first interrupt started putting things back" ||
    check fail "the first interrupt started putting things back"
  grep -q "previous contents were put back" "$root/out" && check ok "it put the previous contents back" ||
    { check fail "it put the previous contents back"; cat "$root/out" >&2; }
  [ "$(sums bridge-fake postgres)" = "$before" ] && check ok "every volume is byte-identical to before" ||
    check fail "every volume is byte-identical to before"
  [ -z "$(docker volume ls -q | grep "^$project" | grep -e "-restore-")" ] && [ -z "$(docker ps -aq --filter "name=^$project-restore")" ] &&
    check ok "nothing of the restore's is left" || check fail "nothing of the restore's is left"
else
  wait || true
  check fail "the restore was caught replacing the volumes"
  cat "$root/out" >&2
fi

finish
