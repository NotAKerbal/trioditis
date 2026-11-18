# Shared by the deploy/test scripts (docs/deploy.md, Testing the bundle). Each test gets a
# throwaway install directory with its own Compose project (trioditis-test-<random>): the
# bundle's compose files, deploy/trioditis, and a .env of dummy values. Its volumes are made
# directly, labelled as Compose labels its own, so nothing is built or started. Everything a
# test makes is named after its project and removed when it ends, so it never touches another
# install. TRIODITIS_WRAPPER=<path> tests another deploy/trioditis, such as an older one.
# shellcheck shell=sh

set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
wrapper=${TRIODITIS_WRAPPER:-$repo/deploy/trioditis}
tool=alpine/socat:1.8.0.3@sha256:beb4a68d9e4fe6b0f21ea774a0fde6c31f580dde6368939ed70100c5385b015e
failures=0

check() {
  if [ "$1" = ok ]; then echo "  ok: $2"; else echo "  FAILED: $2" >&2 && failures=$((failures + 1)); fi
}
finish() {
  if [ "$failures" = 0 ]; then echo "PASS: $test_name"; else echo "FAIL: $test_name ($failures failed)" >&2; fi
  [ "$failures" = 0 ]
}

# Makes the throwaway install in $root (deploy/trioditis is $root/deploy/trioditis), and a
# directory for its backups outside it, $backups.
make_install() {
  test_name=$1
  project="trioditis-test-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  root=$(mktemp -d)
  backups=$(mktemp -d)
  trap cleanup EXIT
  mkdir -p "$root/deploy"
  cp "$wrapper" "$root/deploy/trioditis"
  cp -r "$repo/deploy/compose" "$root/deploy/compose"
  for name in POSTGRES_PASSWORD CONVEX_INSTANCE_SECRET BETTER_AUTH_SECRET GATEWAY_SECRET \
    TRIODITIS_INTERNAL_TOKEN BRIDGE_PUBLIC_KEY BRIDGE_PRIVATE_KEY AGENT_ACCESS_PUBLIC_KEY \
    AGENT_ACCESS_PRIVATE_KEY CONVEX_ADMIN_KEY; do
    echo "$name=test-$name"
  done >"$root/deploy/.env"
  cat >>"$root/deploy/.env" <<EOF
TRIODITIS_SETUP_TOKEN=test-setup-token
COMPOSE_PROJECT_NAME=$project
COMPOSE_FILE=compose.yml
COMPOSE_PROFILES=whatsapp,fake
TRIODITIS_NETWORKS=whatsapp,fake
BRIDGE_HOSTS=whatsapp-1=http://bridge-whatsapp:8611
PUBLIC_HOST=127.0.0.1
PUBLIC_URL=http://127.0.0.1:1
EOF
  chmod 600 "$root/deploy/.env"
  echo "$test_name (project $project)"
}

cleanup() {
  status=$?
  docker ps -aq --filter "name=^$project" | xargs -r docker rm -f >/dev/null 2>&1 || true
  docker volume ls -q | grep "^$project" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
  docker network ls -q --filter "name=^$project" | xargs -r docker network rm >/dev/null 2>&1 || true
  rm -rf "$root" "$backups"
  exit "$status"
}

trioditis() { "$root/deploy/trioditis" "$@"; }

# make_volume <key> [docker volume create options]: this project's volume for <key>.
make_volume() {
  key=$1
  shift
  docker volume create --label "com.docker.compose.project=$project" \
    --label "com.docker.compose.volume=$key" "$@" "${project}_$key" >/dev/null
}

# fill <key> <shell command>: runs the command with the volume at /v.
fill() {
  docker run --rm --log-driver none -v "${project}_$1:/v" --entrypoint sh "$tool" -c "$2"
}

# A checksum of a volume's whole tree: every entry's name, mode, owner, type and size, and
# every file's contents.
tree_sum() {
  docker run --rm --log-driver none -v "${project}_$1:/v:ro" --entrypoint sh "$tool" -c '
    cd /v && find . | sort | while read -r entry; do
      stat -c "%n %a %u:%g %F %s" "$entry"
      [ ! -f "$entry" ] || sha256sum "$entry"
    done | sha256sum'
}
sums() { for key in "$@"; do printf '%s %s\n' "$key" "$(tree_sum "$key")"; done; }

# The archive of the one backup in directory $1 (a backup directory's archive.tgz, or an
# older version's lone .tgz).
archive_in() { find "$1" -name '*.tgz' -type f ! -path '*/.*' | head -1; }

# make_archive <file> <key>...: an archive of those volumes as deploy/trioditis backup writes
# one (the volumes, then the manifest last), without going through backup, so a restore can
# be tested on its own.
make_archive() {
  out=$1
  shift
  mounts=''
  members=''
  for key in "$@"; do
    mounts="$mounts -v ${project}_$key:/volumes/${project}_$key:ro"
    members="$members ./${project}_$key"
  done
  # shellcheck disable=SC2086 # $mounts is a list of -v options
  docker run --rm --log-driver none $mounts -e MEMBERS="$members" --entrypoint sh "$tool" -c '
    cd /volumes
    {
      echo "trioditis-backup 1"
      for volume in $MEMBERS; do
        echo "volume ${volume#./} $(find "$volume" | wc -l) $(find "$volume" -type f -exec stat -c %s {} + | awk "{ s += \$1 } END { print s + 0 }")"
      done
    } >trioditis-backup.manifest
    tar -czf - $MEMBERS ./trioditis-backup.manifest' >"$out"
}
