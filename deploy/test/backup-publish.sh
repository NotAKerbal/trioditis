#!/bin/sh
# A backup is published whole or not at all, and without the server's private keys: a cold
# backup (nothing running) works and starts nothing, and its secrets.env and archive hold
# neither private key; one whose name is taken (here by a directory) goes to the next free
# name and leaves what was there alone; and one interrupted (SIGINT to its process group, as
# Ctrl-C sends) while the archive is streaming publishes nothing and leaves nothing behind.
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

# Every name it could take for the next two minutes is a directory already.
rm -rf "${backups:?}"/*
now=$(date +%s)
for second in $(seq 0 120); do
  taken_name="$backups/$project-$(date -d "@$((now + second))" +%Y%m%d-%H%M%S)"
  mkdir "$taken_name"
  echo keep >"$taken_name/mine"
done
trioditis backup "$backups" >"$root/out" 2>&1 && status=0 || status=$?
taken=$(find "$backups" -mindepth 1 -maxdepth 1 -type d -name '*-2' | head -1)
[ "$status" = 0 ] && [ -n "$taken" ] && [ -f "$taken/archive.tgz" ] && [ -f "$taken/secrets.env" ] &&
  check ok "a taken name moves the backup to the next one" || check fail "a taken name moves the backup to the next one"
[ "$(find "$backups" -name mine | wc -l)" = 121 ] && [ -z "$(find "$backups" -mindepth 2 -name archive.tgz ! -path "$taken/*")" ] &&
  check ok "what was at the taken names is untouched" || check fail "what was at the taken names is untouched"

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
