#!/bin/sh
# deploy/trioditis restore puts a backup back safely: it checks the backup through before it
# stops anything, keeps a backup of the server as it was, replaces every volume and the
# settings with the backup's (keeping this server's keys and settings added by hand), and starts
# the server through the installer with deploy/.restore-settle written, so the restored sends are
# settled before the gateway starts (here a stub installer records how it was run); until then
# deploy/trioditis starts nothing and Compose hands the gateway RESTORE_PENDING, which it
# refuses to start with. Ownership and
# modes survive. It refuses, changing nothing, a backup from another version (unless it's an
# older one this version descends from, with --from-older-version), one it can't open with this
# BACKUP_KEY, one whose archive is damaged, one whose keys aren't this server's, one from another
# Postgres major version, and, without --yes, one it can't ask about. Onto a checkout with no
# install it restores with --keys <key file>. An older unencrypted backup still restores. A
# failing installer leaves the restore failed, the data restored and the settle marker in place.
# The server keys are real X25519 pairs, since --keys derives each public key to check it.
# shellcheck disable=SC2015 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "restore checks the backup, keeps the server as it was, and settles before starting"
env_file="$root/deploy/.env"
git_() { git -c user.name=test -c user.email=test@example.com -c init.defaultBranch=main -C "$root" "$@"; }

# Real key pairs, as keys.sh makes them.
docker image inspect "$node_image" >/dev/null 2>&1 || docker pull -q "$node_image" >/dev/null
docker run --rm --network none --log-driver none "$node_image" node -e "
  const { generateKeyPairSync } = require('node:crypto')
  for (const name of ['BRIDGE', 'AGENT_ACCESS']) {
    const { publicKey, privateKey } = generateKeyPairSync('x25519')
    console.log(name + '_PUBLIC_KEY=' + publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'))
    console.log(name + '_PRIVATE_KEY=' + privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('base64url'))
  }" >"$root/pairs"
grep -vE '^(BRIDGE|AGENT_ACCESS)_(PUBLIC|PRIVATE)_KEY=' "$env_file" >"$root/env"
cat "$root/pairs" >>"$root/env"
# A setting the operator added by hand, which backups leave out and a restore keeps.
echo 'OPERATOR_NOTE=keep-me' >>"$root/env"

# A stub installer: records its options, whether it was handed the lock, and the settle marker.
cat >"$root/deploy/install/install.sh" <<'EOF'
#!/bin/sh
root=$(cd "$(dirname "$0")/../.." && pwd)
lock=no
if [ -e /dev/fd/9 ] && [ /dev/fd/9 -ef "$root/deploy/.operation.lock" ]; then lock=held; fi
echo "$* lock=$lock $(cat "$root/deploy/.restore-settle" 2>/dev/null)" >>"$root/installs"
[ ! -e "$root/install-fails" ] || exit 1
# As the real one does once it has settled the restored sends: the gate comes off.
sed -i '/^RESTORE_PENDING=/d' "$root/deploy/.env"
rm -f "$root/deploy/.restore-settle"
EOF
chmod +x "$root/deploy/install/install.sh"

# The checkout is a git checkout, at the version deploy/.env says it runs.
printf 'deploy/.env*\ndeploy/.operation.lock\ndeploy/.last-backup\ndeploy/.restore-settle*\ninstalls\ninstall-fails\nbefore-*\npairs\nenv*\nout\n' >"$root/.gitignore"
git_ init -q
git_ add -A
git_ commit -qm one
v1=$(git_ rev-parse HEAD)
echo "TRIODITIS_VERSION=$v1" >>"$root/env"
cp "$root/env" "$env_file"
chmod 600 "$env_file"

make_volume postgres
make_volume bridge-whatsapp
fill postgres 'echo 17 >/v/PG_VERSION && mkdir -m 700 /v/base && echo rows >/v/base/1 && chown -R 70:70 /v/base'
fill bridge-whatsapp 'echo one >/v/a'
# What the volumes hold, with each entry's owner and mode.
contents() {
  docker run --rm --log-driver none -v "${project}_postgres:/p:ro" -v "${project}_bridge-whatsapp:/w:ro" --entrypoint sh "$tool" -c \
    'cd / && find p w | sort | while read -r f; do printf "%s %s " "$f" "$(stat -c "%u:%g %a" "$f")"; [ -f "$f" ] && cat "$f" || echo; done'
}
run() { if trioditis "$@" >"$root/out" 2>&1 </dev/null; then status=0; else status=$?; fi; }
newest() { find "$backups" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -newer "$1" | head -1; }

touch "$root/before-b1"
sleep 1
run backup "$backups"
b1=$(newest "$root/before-b1")
[ "$status" = 0 ] && [ -n "$b1" ] && check ok "a backup to restore" || { check fail "a backup to restore"; cat "$root/out" >&2; }
as_backed_up=$(contents)

# The server moves on.
fill bridge-whatsapp 'echo two >/v/a && echo later >/v/new'
fill postgres 'echo more >/v/base/2'
moved_on=$(contents)
unchanged() { [ "$(contents)" = "$moved_on" ] && cmp -s "$env_file" "$root/env.now"; }
cp "$env_file" "$root/env.now"

# Refused, changing nothing: without --yes, and no terminal to ask in.
run restore "$b1"
[ "$status" = 2 ] && grep -q "pass --yes" "$root/out" && unchanged && [ ! -e "$root/installs" ] &&
  check ok "without --yes and no terminal, it asks for one, changing nothing" ||
  { check fail "without --yes and no terminal, it asks for one, changing nothing"; cat "$root/out" >&2; }

# Refused: another BACKUP_KEY.
sed "s/^BACKUP_KEY=.*/BACKUP_KEY=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')/" "$root/env.now" >"$env_file"
run restore --yes "$b1"
cp "$root/env.now" "$env_file"
[ "$status" != 0 ] && grep -q "Couldn't open the backup's secrets.env.enc" "$root/out" && unchanged &&
  check ok "a backup this BACKUP_KEY doesn't open is refused, changing nothing" ||
  { check fail "a backup this BACKUP_KEY doesn't open is refused, changing nothing"; cat "$root/out" >&2; }

# Refused: another server's keys.
sed 's/^BRIDGE_PUBLIC_KEY=.*/BRIDGE_PUBLIC_KEY=another-server/' "$root/env.now" >"$env_file"
run restore --yes "$b1"
cp "$root/env.now" "$env_file"
[ "$status" != 0 ] && grep -q "isn't the one the backup's data is sealed to" "$root/out" && unchanged &&
  check ok "a backup sealed to another server's keys is refused, changing nothing" ||
  { check fail "a backup sealed to another server's keys is refused, changing nothing"; cat "$root/out" >&2; }

# Refused: a damaged archive (a byte changed well inside it).
cp -a "$b1" "$backups/damaged"
size=$(wc -c <"$b1/archive.enc")
{ head -c "$((size / 2))" "$b1/archive.enc"; printf 'X'; tail -c "+$((size / 2 + 2))" "$b1/archive.enc"; } >"$backups/damaged/archive.enc"
run restore --yes "$backups/damaged"
rm -rf "$backups/damaged"
[ "$status" != 0 ] && grep -q "Couldn't read the backup's archive" "$root/out" && unchanged && [ ! -e "$root/installs" ] &&
  check ok "a damaged archive is refused before anything stops, changing nothing" ||
  { check fail "a damaged archive is refused before anything stops, changing nothing"; cat "$root/out" >&2; }

# Refused: another version; one this version descends from with --from-older-version only.
echo two >"$root/second"
git_ add -A
git_ commit -qm two
run restore --yes "$b1"
[ "$status" != 0 ] && grep -q "The backup is from version $v1" "$root/out" && unchanged &&
  check ok "a backup from another version is refused, changing nothing" ||
  { check fail "a backup from another version is refused, changing nothing"; cat "$root/out" >&2; }
git_ checkout -q "$v1"

# Refused: data from another Postgres major version.
fill postgres 'echo 16 >/v/PG_VERSION'
touch "$root/before-pg"
sleep 1
run backup "$backups"
pg16=$(newest "$root/before-pg")
fill postgres 'echo 17 >/v/PG_VERSION'
run restore --yes "$pg16"
[ "$status" != 0 ] && grep -q "from Postgres 16, and this version runs Postgres 17" "$root/out" && unchanged &&
  check ok "a backup from another Postgres major version is refused, changing nothing" ||
  { check fail "a backup from another Postgres major version is refused, changing nothing"; cat "$root/out" >&2; }
# Refused: one backup's archive beside another's settings (each file is bound to its backup).
mkdir -m 700 "$backups/mixed"
cp "$b1/archive.enc" "$backups/mixed/"
cp "$pg16/secrets.env.enc" "$pg16/backup.info" "$backups/mixed/"
run restore --yes "$backups/mixed"
rm -rf "$pg16" "$backups/mixed"
[ "$status" != 0 ] && grep -q "Couldn't read the backup's archive" "$root/out" && unchanged &&
  check ok "one backup's archive beside another's settings is refused, changing nothing" ||
  { check fail "one backup's archive beside another's settings is refused, changing nothing"; cat "$root/out" >&2; }

# Refused: a private key in deploy/.env that isn't the half of the public key there.
other_key=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')
sed "s/^BRIDGE_PRIVATE_KEY=.*/BRIDGE_PRIVATE_KEY=$other_key/" "$root/env.now" >"$env_file"
run restore --yes "$b1"
cp "$root/env.now" "$env_file"
[ "$status" != 0 ] && grep -q "isn't the private half" "$root/out" && unchanged &&
  check ok "a private key that isn't its public key's half is refused, changing nothing" ||
  { check fail "a private key that isn't its public key's half is refused, changing nothing"; cat "$root/out" >&2; }

# It restores: the volumes and settings are the backup's, the server's keys and hand-added
# settings stay, the server as it was is backed up, and the installer starts it holding the
# lock, with the settle marker saying when the backup was taken.
touch "$root/before-restore"
sleep 1
run restore --yes "$b1"
recovery=$(newest "$root/before-restore")
created=$(sed -n 's/^created=//p' "$b1/backup.info")
[ "$status" = 0 ] && [ "$(contents)" = "$as_backed_up" ] &&
  check ok "it restores every volume as it was backed up, owners and modes included" ||
  { check fail "it restores every volume as it was backed up, owners and modes included"; cat "$root/out" >&2; contents >&2; }
[ "$(cat "$root/installs" 2>/dev/null)" = "--no-setup-link lock=held backup_at=${created}000" ] &&
  check ok "the installer starts it, holding the lock, with the sends to settle from the backup's time" ||
  check fail "the installer starts it, holding the lock, with the sends to settle from the backup's time ($(cat "$root/installs" 2>/dev/null))"
for name in BRIDGE_PRIVATE_KEY AGENT_ACCESS_PRIVATE_KEY BACKUP_KEY OPERATOR_NOTE TRIODITIS_VERSION POSTGRES_PASSWORD; do
  [ "$(sed -n "s/^$name=//p" "$env_file")" = "$(sed -n "s/^$name=//p" "$root/env.now")" ] || echo "$name" >>"$root/differs"
done
[ ! -e "$root/differs" ] && [ "$(stat -c %a "$env_file")" = 600 ] &&
  check ok "deploy/.env keeps the server's keys and hand-added settings, and the backup's others" ||
  check fail "deploy/.env keeps the server's keys and hand-added settings, and the backup's others ($(cat "$root/differs" 2>/dev/null))"
rm -f "$root/differs"
[ -n "$recovery" ] && [ "$recovery" != "$b1" ] && decrypt "$recovery/archive.enc" |
  docker run --rm -i --log-driver none --entrypoint sh "$tool" -c "tar -xzOf - ./${project}_bridge-whatsapp/new" | grep -qx later &&
  check ok "the server as it was is backed up first" || check fail "the server as it was is backed up first"
rm -f "$root/installs" "$root/deploy/.restore-settle"

# Putting the recovery copy back is a restore like any other.
run restore --yes --recovery-dir "$backups/recoveries" "$recovery"
[ "$status" = 0 ] && [ -n "$(ls -A "$backups/recoveries")" ] && [ "$(contents)" = "$moved_on" ] &&
  check ok "the copy of the server as it was restores it" || { check fail "the copy of the server as it was restores it"; cat "$root/out" >&2; }
rm -f "$root/installs" "$root/deploy/.restore-settle"

# An installer that fails: the restore fails, the data is the backup's, and the marker stays for
# the next installer run.
touch "$root/install-fails"
run restore --yes "$b1"
rm -f "$root/install-fails"
[ "$status" != 0 ] && [ "$(contents)" = "$as_backed_up" ] && [ -e "$root/deploy/.restore-settle" ] &&
  grep -q "settles the restored sends before it starts" "$root/out" &&
  check ok "a failing installer fails the restore, leaving the marker for the next run" ||
  { check fail "a failing installer fails the restore, leaving the marker for the next run"; cat "$root/out" >&2; }
# Until it's settled, nothing that could start the gateway runs, and Compose would hand the
# gateway the setting it refuses to start with.
for command in "up -d" "start" "restart gateway" "run --rm gateway true"; do
  # shellcheck disable=SC2086 # the command and its arguments
  run $command
  [ "$status" != 0 ] && grep -q "A restore's sends aren't settled yet" "$root/out" &&
    check ok "while the restore isn't settled, '$command' is refused" ||
    { check fail "while the restore isn't settled, '$command' is refused"; cat "$root/out" >&2; }
done
run config
grep -qE "TRIODITIS_RESTORE_PENDING: \"?${created}000\"?" "$root/out" &&
  check ok "and the gateway's container would be made with RESTORE_PENDING" ||
  { check fail "and the gateway's container would be made with RESTORE_PENDING"; grep -n RESTORE "$root/out" >&2; }
sed -i '/^RESTORE_PENDING=/d' "$env_file"
rm -f "$root/installs" "$root/deploy/.restore-settle"

# An older, unencrypted backup (archive.tgz and secrets.env in the clear) still restores.
# Its manifest as the first format wrote it: no ID, time, version or Postgres line, so the
# Postgres version is read from the archived data.
mkdir -m 700 "$backups/older"
decrypt "$b1/secrets.env.enc" >"$backups/older/secrets.env"
# shellcheck disable=SC2016 # expanded in the container
decrypt "$b1/archive.enc" | docker run --rm -i --log-driver none --entrypoint sh "$tool" -c '
  mkdir /x && cd /x && tar -xzf - &&
  sed -i -e "1s/.*/trioditis-backup 1/" -e "/^\(id\|created\|version\|postgres\) /d" trioditis-backup.manifest &&
  tar -czf - $(ls -A | grep -vx trioditis-backup.manifest | sed "s|^|./|") ./trioditis-backup.manifest' >"$backups/older/archive.tgz"
fill bridge-whatsapp 'echo three >/v/a'
run restore --yes "$backups/older"
[ "$status" = 0 ] && [ "$(contents)" = "$as_backed_up" ] && grep -q "older, unencrypted backup" "$root/out" &&
  check ok "an older unencrypted backup restores, with a warning" ||
  { check fail "an older unencrypted backup restores, with a warning"; cat "$root/out" >&2; }
rm -rf "$backups/older" "$root/installs" "$root/deploy/.restore-settle"

# Volumes that don't come out as the manifest says (an older backup whose manifest is wrong):
# the server as it was is put back, and the restore fails.
mkdir -m 700 "$backups/wrong"
decrypt "$b1/secrets.env.enc" >"$backups/wrong/secrets.env"
# shellcheck disable=SC2016 # expanded in the container
decrypt "$b1/archive.enc" | docker run --rm -i --log-driver none --entrypoint sh "$tool" -c '
  mkdir /x && cd /x && tar -xzf - &&
  sed -i -e "s/^\(volume [^ ]*_bridge-whatsapp [0-9]*\) [0-9]*$/\1 999999/" -e "/^id /d" trioditis-backup.manifest &&
  tar -czf - $(ls -A | grep -vx trioditis-backup.manifest | sed "s|^|./|") ./trioditis-backup.manifest' >"$backups/wrong/archive.tgz"
fill bridge-whatsapp 'echo five >/v/a'
before_wrong=$(contents)
run restore --yes "$backups/wrong"
[ "$status" != 0 ] && [ "$(contents)" = "$before_wrong" ] && grep -q "Nothing was restored: the server is as it was" "$root/out" &&
  [ ! -e "$root/deploy/.restore-settle" ] &&
  check ok "volumes that don't match the manifest put the server back as it was" ||
  { check fail "volumes that don't match the manifest put the server back as it was"; cat "$root/out" >&2; }
rm -rf "$backups/wrong" "$root/installs"

# From a version this checkout descends from, when asked.
git_ checkout -q main
fill bridge-whatsapp 'echo four >/v/a'
run restore --yes --from-older-version "$b1"
git_ checkout -q "$v1"
[ "$status" = 0 ] && [ "$(contents)" = "$as_backed_up" ] && grep -q "older than this checkout" "$root/out" &&
  check ok "with --from-older-version, a backup from an older version restores, with a warning" ||
  { check fail "with --from-older-version, a backup from an older version restores, with a warning"; cat "$root/out" >&2; }
rm -f "$root/installs" "$root/deploy/.restore-settle"

# After losing the server: a checkout with no install, the backup and the key file.
run keys export "$backups/keys"
cp "$env_file" "$root/env.lost"
rm -f "$env_file"
fill bridge-whatsapp 'echo gone >/v/a'
run restore --yes "$b1"
[ "$status" = 2 ] && grep -q -- "--keys <file>" "$root/out" && [ ! -e "$env_file" ] &&
  check ok "with no install, it needs the key file" || { check fail "with no install, it needs the key file"; cat "$root/out" >&2; }
run restore --yes --keys "$backups/keys" "$b1"
[ "$status" != 0 ] && grep -q "already has volumes or containers on this Docker" "$root/out" && [ ! -e "$env_file" ] &&
  [ "$(docker run --rm --log-driver none -v "${project}_bridge-whatsapp:/w:ro" --entrypoint cat "$tool" /w/a)" = gone ] &&
  check ok "with no install, it won't overwrite the project's volumes another checkout has on this Docker" ||
  { check fail "with no install, it won't overwrite the project's volumes another checkout has on this Docker"; cat "$root/out" >&2; }
# A new machine: none of the project's volumes are here.
docker volume ls -q --filter "label=com.docker.compose.project=$project" | xargs -r docker volume rm -f >/dev/null
run restore --yes --keys "$backups/keys" "$b1"
[ "$status" = 0 ] && [ "$(contents)" = "$as_backed_up" ] && [ "$(sort "$env_file")" = "$(grep -v '^OPERATOR_NOTE=' "$root/env.lost" | sort)" ] &&
  [ -e "$root/installs" ] && check ok "with --keys it restores onto a checkout with no install" ||
  { check fail "with --keys it restores onto a checkout with no install"; cat "$root/out" >&2; }

finish
