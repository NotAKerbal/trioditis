#!/bin/sh
# A backup is published whole or not at all, and without the server's private keys: a cold
# backup (nothing running) works and starts nothing, and its secrets.env and archive hold
# neither private key; one whose name is taken (by a file, a directory or a symlink) goes to
# the next free name and leaves what was there alone; one whose rename silently does nothing
# (a stub mv that exits 0) fails instead of reporting success; one interrupted (SIGINT to
# its process group, as Ctrl-C sends) while the archive is streaming, or after it reserved
# its name, publishes nothing and leaves nothing behind (an interrupt while it makes its
# name's directory is held off, and one already there is never removed); one that can't run
# its last check on the private keys, or finds the lock held (taken before .env is read),
# publishes nothing; one with a deploy/.env not in the form the installer writes (export,
# spaces around =, quoted values, a name twice, a carriage return) is refused before it
# makes anything; and secrets.env holds only the settings listed in deploy/install/env-names:
# no comment (even one quoting a private key), no unlisted setting (named, not shown), and,
# as a last check, no private key's value inside a listed one.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "backup publishes whole or not at all"
bk=$(private_value BRIDGE_PRIVATE_KEY)
ak=$(private_value AGENT_ACCESS_PRIVATE_KEY)

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
# The .env's lines for the listed names, which is everything but the two private keys here.
expected=$(while IFS= read -r line; do
  grep -qxF "${line%%=*}" "$repo/deploy/install/env-names" && echo "$line"
done <"$root/deploy/.env" | sort)
[ "$(sort "$backup/secrets.env")" = "$expected" ] &&
  grep -q '^BRIDGE_PUBLIC_KEY=test-BRIDGE_PUBLIC_KEY$' "$backup/secrets.env" &&
  check ok "secrets.env is deploy/.env without the private keys" || check fail "secrets.env is deploy/.env without the private keys"
docker run --rm --log-driver none -i --entrypoint sh "$tool" -c '
  mkdir /x && tar -xzf - -C /x && ! grep -rqF -e "$1" -e "$2" /x' sh "$bk" "$ak" <"$backup/archive.tgz" &&
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

# Interrupted after reserving its name: a stub mv that ignores the interrupt and does nothing
# holds it there; the interrupt is acted on once mv returns.
rm -rf "${backups:?}"/*
printf '#!/bin/sh\ntrap "" INT\nsleep 3\nexit 0\n' >"$root/stub/mv"
# A background job starts with SIGINT ignored, which a terminal's Ctrl-C doesn't: reset here.
PATH="$root/stub:$PATH" setsid env --default-signal=INT "$root/deploy/trioditis" backup "$backups" >"$root/out" 2>&1 &
for _ in $(seq 600); do
  pgrep -f "^/bin/sh $root/stub/mv" >/dev/null && break
  sleep 0.1
done
stub=$(pgrep -f "^/bin/sh $root/stub/mv" | head -1)
if [ -n "$stub" ]; then
  /bin/kill -s INT -- "-$(ps -o pgid= -p "$stub" | tr -d ' ')"
  wait || true
  [ -z "$(entries)" ] && check ok "interrupted after reserving its name, it leaves nothing" ||
    check fail "interrupted after reserving its name, it leaves nothing ($(entries))"
else
  wait || true
  check fail "the backup was caught after reserving its name"
fi

# Interrupted while it makes its name's directory (a stub mkdir that takes a moment): the
# interrupt is held off there, so the directory is either made and recorded, or not made
# at all. Either way, no empty directory is left: a finished backup, or nothing.
rm -rf "${backups:?}"/*
rm -f "$root/stub/mv"
real_mkdir=$(command -v mkdir)
printf '#!/bin/sh\ntrap "" INT\n%s "$@" || exit\ncase "$*" in *%s-20*) sleep 3 ;; esac\n' "$real_mkdir" "$project" >"$root/stub/mkdir"
chmod +x "$root/stub/mkdir"
interrupt_at() { # $1: what the stub's command line has when it's to be interrupted
  PATH="$root/stub:$PATH" setsid env --default-signal=INT "$root/deploy/trioditis" backup "$backups" >"$root/out" 2>&1 &
  for _ in $(seq 600); do
    pgrep -f "^/bin/sh $root/stub/mkdir .*$1" >/dev/null && break
    sleep 0.1
  done
  stub=$(pgrep -f "^/bin/sh $root/stub/mkdir .*$1" | head -1)
  [ -z "$stub" ] || /bin/kill -s INT -- "-$(ps -o pgid= -p "$stub" | tr -d ' ')"
  wait || true
  [ -n "$stub" ]
}
if interrupt_at "$project-20"; then
  empty=$(find "$backups" -mindepth 1 -maxdepth 1 -type d -empty | wc -l)
  hidden=$(find "$backups" -mindepth 1 -maxdepth 1 -name '.*' | wc -l)
  [ "$empty" = 0 ] && [ "$hidden" = 0 ] && check ok "interrupted while making its directory, it leaves no empty one" ||
    check fail "interrupted while making its directory, it leaves no empty one ($(entries))"
else
  check fail "the backup was caught making its directory"
fi

# A directory already there at its name, empty, and an interrupt while it tries to make it
# (and fails): the directory isn't its to remove, and stays.
rm -rf "${backups:?}"/*
now=$(date +%s)
for second in $(seq 0 60); do mkdir "$backups/$project-$(date -d "@$((now + second))" +%Y%m%d-%H%M%S)"; done
printf '#!/bin/sh\ntrap "" INT\ncase "$*" in *%s-20[0-9]*[0-9]) sleep 3 ;; esac\nexec %s "$@"\n' "$project" "$real_mkdir" >"$root/stub/mkdir"
if interrupt_at "$project-20[0-9-]*[0-9]$"; then
  [ "$(find "$backups" -mindepth 1 -maxdepth 1 -type d -empty -name "$project-20*" ! -name '*-2' | wc -l)" = 61 ] &&
    check ok "an empty directory already at its name survives an interrupt" ||
    check fail "an empty directory already at its name survives an interrupt ($(find "$backups" -mindepth 1 -maxdepth 1 -type d -empty | wc -l) left)"
else
  check fail "the backup was caught trying its name"
fi
rm -f "$root/stub/mkdir"

# The lock is taken before deploy/.env is read: with it held, even a .env it would refuse
# gets the lock's answer.
rm -rf "${backups:?}"/*
cp "$root/deploy/.env" "$root/env.before-lock"
echo 'export BAD=1' >>"$root/deploy/.env"
sh -c 'exec 9>"$1" && flock 9 && exec sleep 30' sh "$root/deploy/.operation.lock" &
holder=$!
sleep 1
trioditis backup "$backups" >"$root/out" 2>&1 && status=0 || status=$?
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
cp "$root/env.before-lock" "$root/deploy/.env"
[ "$status" != 0 ] && grep -q "Another backup, install or change" "$root/out" && ! grep -q "isn't all in the form" "$root/out" &&
  check ok "it takes the lock before it reads deploy/.env" || { check fail "it takes the lock before it reads deploy/.env"; cat "$root/out" >&2; }

# The last check, on the private keys' values: if it can't run (grep fails, here a stub that
# exits 2), nothing is published.
rm -rf "${backups:?}"/*
real_grep=$(command -v grep)
printf '#!/bin/sh\ncase "$*" in *-qFf*) exit 2 ;; esac\nexec %s "$@"\n' "$real_grep" >"$root/stub/grep"
chmod +x "$root/stub/grep"
PATH="$root/stub:$PATH" "$root/deploy/trioditis" backup "$backups" >"$root/out" 2>&1 && status=0 || status=$?
rm -f "$root/stub/grep"
[ "$status" != 0 ] && grep -q "Couldn't check secrets.env for the private keys" "$root/out" && [ -z "$(entries)" ] &&
  check ok "a private-key check that can't run stops the backup" || { check fail "a private-key check that can't run stops the backup"; cat "$root/out" >&2; }

# A deploy/.env in forms Compose reads but the parser doesn't: each is refused before
# anything is made (not even the backup directory), and the server is left as it was.
cp "$root/deploy/.env" "$root/env.good"
# shellcheck disable=SC2016 # the ${…} is literal: it's what the parser must refuse
for form in "export BRIDGE_PRIVATE_KEY=$bk" "BRIDGE_PRIVATE_KEY = $bk" "BRIDGE_PRIVATE_KEY=\"$bk\"" \
  "BRIDGE_PRIVATE_KEY= \"$bk\"" "BRIDGE_PRIVATE_KEY=$bk" "$(printf 'BRIDGE_PRIVATE_KEY=%s\r' "$bk")" \
  'PUBLIC_HOST=a b' 'PUBLIC_HOST=${GATEWAY_SECRET}' 'PUBLIC_HOST=a#b'; do
  rm -rf "${backups:?}"
  # Each replaces its setting's line (a second BRIDGE_PRIVATE_KEY line, unchanged, is the
  # duplicate case).
  case "$form" in
    "BRIDGE_PRIVATE_KEY=$bk") cp "$root/env.good" "$root/deploy/.env" && echo "$form" >>"$root/deploy/.env" ;;
    *) { grep -v "^$(echo "$form" | sed 's/^export //; s/[ =].*//')=" "$root/env.good"; echo "$form"; } >"$root/deploy/.env" ;;
  esac
  trioditis backup "$backups" >"$root/out" 2>&1 && status=0 || status=$?
  shown=$(printf '%s' "$form" | tr '\r' '^' | sed "s/$bk/<key>/")
  [ "$status" != 0 ] && grep -q "isn't all in the form the installer writes" "$root/out" && [ ! -e "$backups" ] &&
    check ok "a .env with '$shown' is refused before anything is made" ||
    { check fail "a .env with '$shown' is refused before anything is made"; cat "$root/out" >&2; }
done
mkdir -p "$backups"

# What secrets.env holds: listed settings only.
backup_with() {
  rm -rf "${backups:?}"/*
  { cat "$root/env.good"; printf '%s\n' "$@"; } >"$root/deploy/.env"
  trioditis backup "$backups" >"$root/out" 2>&1 && status=0 || status=$?
  secrets=$(find "$backups" -mindepth 2 -name secrets.env | head -1)
}
no_private_in() { [ -n "$1" ] && ! grep -qF -e "$bk" -e "$ak" "$1"; }
backup_with "# BRIDGE_PRIVATE_KEY=$bk" '' 'OPERATOR_NOTE=keep-me'
[ "$status" = 0 ] && no_private_in "$secrets" && ! grep -q '^#\|^$\|OPERATOR_NOTE' "$secrets" &&
  check ok "secrets.env leaves out comments, blank lines and an unlisted setting" ||
  check fail "secrets.env leaves out comments, blank lines and an unlisted setting"
grep -q "Left out of secrets.env.*OPERATOR_NOTE" "$root/out" && ! grep -q "keep-me" "$root/out" &&
  check ok "the unlisted setting is named, not shown" || check fail "the unlisted setting is named, not shown"
[ "$(sort "$secrets")" = "$expected" ] &&
  check ok "secrets.env holds exactly the listed settings the .env has" || check fail "secrets.env holds exactly the listed settings the .env has"
backup_with "INSTALL_DOMAIN=example-$bk-example"
[ "$status" != 0 ] && grep -q "A private key's value is in another setting" "$root/out" && [ -z "$(entries)" ] &&
  check ok "a private key's value inside a listed setting stops the backup" ||
  { check fail "a private key's value inside a listed setting stops the backup"; cat "$root/out" >&2; }
cp "$root/env.good" "$root/deploy/.env"

# Interrupted while streaming: a large, incompressible volume keeps tar busy.
rm -rf "${backups:?}"/*
fill bridge-fake 'head -c 600000000 /dev/urandom >/v/big'
# A background job starts with SIGINT ignored, which a terminal's Ctrl-C doesn't: reset here.
setsid env --default-signal=INT "$root/deploy/trioditis" backup "$backups" >"$root/out" 2>&1 &
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
