#!/bin/sh
# What restore accepts. It opens the archive once: one that can only be read once (a pipe)
# restores, every volume byte-identical to when it was archived. One cut short, one with no
# manifest, and one that isn't an archive at all are refused, and change nothing.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "restore reads the archive once, and refuses bad ones"

make_volume bridge-fake
make_volume postgres
fill bridge-fake 'echo one >/v/a && mkdir /v/d && echo deep >/v/d/b'
fill postgres 'echo 17 >/v/PG_VERSION && chown 70:70 /v && chmod 700 /v'
archive="$backups/archive.tgz"
make_archive "$archive" bridge-fake postgres
archived=$(sums bridge-fake postgres)
fill bridge-fake 'echo changed >/v/a'
changed=$(sums bridge-fake postgres)

refused() {
  if trioditis restore --yes "$1" >"$root/out" 2>&1; then status=0; else status=$?; fi
  [ "$status" != 0 ] && grep -q "Nothing was changed" "$root/out" && [ "$(sums bridge-fake postgres)" = "$changed" ] &&
    check ok "$2 is refused and changes nothing" || { check fail "$2 is refused and changes nothing"; cat "$root/out" >&2; }
}
# Cut short: the first half.
head -c "$(($(stat -c %s "$archive") / 2))" "$archive" >"$backups/cut.tgz"
refused "$backups/cut.tgz" "an archive cut short"
# The same volumes without the manifest.
docker run --rm --log-driver none -v "${project}_bridge-fake:/volumes/${project}_bridge-fake:ro" \
  --entrypoint sh "$tool" -c "cd /volumes && tar -czf - ./${project}_bridge-fake" >"$backups/no-manifest.tgz"
refused "$backups/no-manifest.tgz" "an archive with no manifest"
head -c 4096 /dev/urandom >"$backups/noise.tgz"
refused "$backups/noise.tgz" "something that isn't an archive"

# Through a pipe, which gives its contents to the first open only: a restore that opened it
# again would wait forever, so it gets two minutes.
mkfifo "$backups/pipe"
cat "$archive" >"$backups/pipe" &
writer=$!
if timeout 120 "$root/deploy/trioditis" restore --yes "$backups/pipe" >"$root/out" 2>&1; then status=0; else status=$?; fi
kill "$writer" 2>/dev/null || true
wait || true
[ "$status" = 0 ] && [ "$(sums bridge-fake postgres)" = "$archived" ] &&
  check ok "an archive read once restores every volume as archived" ||
  { check fail "an archive read once restores every volume as archived"; cat "$root/out" >&2; }

finish
