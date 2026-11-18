#!/bin/sh
# A backup is published whole or not at all, and without the server's private keys: a cold
# backup (nothing running) works and starts nothing, and its secrets.env and archive hold
# neither private key; one whose name is taken (by a file, a directory or a symlink) goes to
# the next free name and leaves what was there alone; one whose rename silently does nothing
# (a stub mv that exits 0) fails instead of reporting success; and one interrupted (SIGINT
# to its process group, as Ctrl-C sends) while the archive is streaming publishes nothing and
# leaves nothing behind.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "backup publishes whole or not at all"

make_volume bridge-fake
make_volume postgres
fill bridge-fake 'echo one >/v/a'
fill postgres 'echo 17 >/v/PG_VERSION'

# Published entries in $backups, hidden ones (unpublished work) included.
entries() { ls -A "$backups"; }

if trioditis backup "$backups" >"$root/out" 2>&1; then status=0; else status=$?; fi
[ "$status" = 0 ] && check ok "a cold backup succeeds" || { check fail "a cold backup succeeds"; cat "$root/out" >&2; }
[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ] &&
  check ok "it starts nothing" || check fail "it starts nothing"
backup=$(find "$backups" -mindepth 1 -maxdepth 1 -type d ! -name '.*' | head -1)
[ -n "$backup" ] && [ "$(stat -c %a "$backup")" = 700 ] && [ "$(stat -c %a "$backup/archive.tgz")" = 600 ] &&
  [ "$(stat -c %a "$backup/secrets.env")" = 600 ] &&
  check ok "it's one 0700 directory holding archive.tgz and secrets.env, both 0600" ||
  check fail "it's one 0700 directory holding archive.tgz and secrets.env, both 0600"
[ "$(cat "$backup/secrets.env")" = "$(grep -vE '^(BRIDGE|AGENT_ACCESS)_PRIVATE_KEY=' "$root/deploy/.env")" ] &&
  grep -q '^BRIDGE_PUBLIC_KEY=test-BRIDGE_PUBLIC_KEY$' "$backup/secrets.env" &&
  check ok "secrets.env is deploy/.env without the private keys" || check fail "secrets.env is deploy/.env without the private keys"
docker run --rm --log-driver none -i --entrypoint sh "$tool" -c '
  mkdir /x && tar -xzf - -C /x && ! grep -rqF -e test-BRIDGE_PRIVATE_KEY -e test-AGENT_ACCESS_PRIVATE_KEY /x' <"$backup/archive.tgz" &&
  check ok "the archive holds neither private key" || check fail "the archive holds neither private key"
[ "$(entries | wc -l)" = 1 ] && check ok "nothing else is left in the directory" || check fail "nothing else is left in the directory"

# Every name it could take for the next two minutes is taken already: in turn by a file, a
# directory, and a symlink (to a file outside).
rm -rf "${backups:?}"/*
echo outside >"$root/outside"
now=$(date +%s)
for second in $(seq 0 120); do
  taken_name="$backups/$project-$(date -d "@$((now + second))" +%Y%m%d-%H%M%S)"
  case $((second % 3)) in
    0) echo keep >"$taken_name" ;;
    1) mkdir "$taken_name" && echo keep >"$taken_name/mine" ;;
    2) ln -s "$root/outside" "$taken_name" ;;
  esac
done
before_taken=$(find "$backups" -mindepth 1 | sort | while read -r entry; do stat -c '%n %F %s' "$entry"; done)
trioditis backup "$backups" >"$root/out" 2>&1 && status=0 || status=$?
taken=$(find "$backups" -mindepth 1 -maxdepth 1 -type d -name '*-2' | head -1)
[ "$status" = 0 ] && [ -n "$taken" ] && [ -f "$taken/archive.tgz" ] && [ -f "$taken/secrets.env" ] &&
  check ok "a taken name moves the backup to the next one" || check fail "a taken name moves the backup to the next one"
[ "$(find "$backups" -mindepth 1 ! -path "$taken" ! -path "$taken/*" | sort | while read -r entry; do stat -c '%n %F %s' "$entry"; done)" = "$before_taken" ] &&
  [ "$(cat "$root/outside")" = outside ] &&
  check ok "the file, directory and symlink at the taken names are untouched" ||
  check fail "the file, directory and symlink at the taken names are untouched"

# A rename that exits 0 and does nothing (as `mv --no-clobber` does on some versions when the
# name is taken) must not pass for a published backup.
rm -rf "${backups:?}"/*
mkdir -p "$root/stub"
printf '#!/bin/sh\nexit 0\n' >"$root/stub/mv"
chmod +x "$root/stub/mv"
PATH="$root/stub:$PATH" "$root/deploy/trioditis" backup "$backups" >"$root/out" 2>&1 && status=0 || status=$?
[ "$status" != 0 ] && ! grep -q "Backed up" "$root/out" && [ -z "$(entries)" ] &&
  check ok "a rename that does nothing fails the backup and leaves nothing" ||
  { check fail "a rename that does nothing fails the backup and leaves nothing"; cat "$root/out" >&2; entries >&2; }

# Interrupted while streaming: a large, incompressible volume keeps tar busy.
rm -rf "${backups:?}"/*
fill bridge-fake 'head -c 600000000 /dev/urandom >/v/big'
setsid "$root/deploy/trioditis" backup "$backups" >"$root/out" 2>&1 &
for _ in $(seq 600); do
  part=$(find "$backups" -path '*/.*/archive.tgz' -size +1M 2>/dev/null | head -1)
  [ -z "$part" ] || break
  sleep 0.1
done
streaming=$(pgrep -f "^docker run --rm --init --name $project-backup" | head -1)
if [ -n "$part" ] && [ -n "$streaming" ]; then
  /bin/kill -s INT -- "-$(ps -o pgid= -p "$streaming" | tr -d ' ')"
  wait || true
  [ -z "$(entries)" ] && check ok "an interrupted backup leaves nothing" || check fail "an interrupted backup leaves nothing ($(entries))"
  [ -z "$(docker ps -aq --filter "name=^$project-backup")" ] &&
    check ok "its archive container is gone" || check fail "its archive container is gone"
else
  wait || true
  check fail "the backup was caught while streaming"
fi

finish
