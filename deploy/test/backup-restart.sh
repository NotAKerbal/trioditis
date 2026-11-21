#!/bin/sh
# A backup starts again exactly the containers that were running, and nothing else: not a
# finished one-shot job that a running service depends on (as the gateway depends on the
# functions job), and not a service that was stopped. The stack here is small and its own:
# job (a one-shot that counts its runs), svc (depends on job finishing; running) and idle
# (stopped before the backup), plus caddy and gateway, for the order: a step that's
# unhealthy for a while and then healthy is waited for, and the next starts; when one
# doesn't become healthy in time, the restart stops there: it names it, the backup fails,
# and the next step (the gateway) isn't started.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "a backup starts again only what was running"

cat >"$root/deploy/compose/restart-test.yml" <<EOF
services:
  job:
    image: $tool
    entrypoint: [sh, -c, 'echo ran >>/runs/count']
    volumes: [runs:/runs]
  svc:
    image: $tool
    entrypoint: [sleep, '3600']
    depends_on:
      job: { condition: service_completed_successfully }
    healthcheck: { test: [CMD, 'true'], interval: 1s }
  idle:
    image: $tool
    entrypoint: [sleep, '3600']
  caddy:
    image: $tool
    entrypoint: [sleep, '3600']
    healthcheck: { test: [CMD, 'true'], interval: 1s }
  gateway:
    image: $tool
    entrypoint: [sleep, '3600']
volumes:
  runs:
EOF
sed -i 's/^COMPOSE_FILE=.*/COMPOSE_FILE=restart-test.yml/; s/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=/' "$root/deploy/.env"
trioditis up -d >/dev/null 2>&1 || { check fail "the test stack starts"; finish; }
trioditis stop idle >/dev/null 2>&1
container() { docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$1"; }
state() { docker inspect -f '{{.State.Status}}' "$(container "$1")"; }
runs() { docker run --rm --log-driver none -v "${project}_runs:/runs:ro" --entrypoint sh "$tool" -c 'wc -l </runs/count'; }
[ "$(state svc)" = running ] && [ "$(state idle)" = exited ] && [ "$(runs)" = 1 ] ||
  { check fail "the test stack is up as expected (svc $(state svc), idle $(state idle), job ran $(runs))"; finish; }

trioditis backup "$backups" >"$root/out" 2>&1 && status=0 || status=$?
[ "$status" = 0 ] && check ok "the backup succeeds" || { check fail "the backup succeeds"; cat "$root/out" >&2; }
[ "$(state svc)" = running ] && check ok "the running service runs again" || check fail "the running service runs again ($(state svc))"
[ "$(state idle)" = exited ] && check ok "the stopped one stays stopped" || check fail "the stopped one stays stopped ($(state idle))"
[ "$(runs)" = 1 ] && check ok "the finished one-shot job isn't run again" || check fail "the finished one-shot job isn't run again (ran $(runs) times)"


# A step whose healthcheck fails for a while and then passes (a stub docker that reports
# the first three healthy answers as unhealthy): the restart waits it out, and the next
# step starts.
real_docker=$(command -v docker)
mkdir -p "$root/stub"
cat >"$root/stub/docker" <<EOF
#!/bin/sh
case "\$*" in *State.Health*)
  out=\$($real_docker "\$@") || exit
  n=\$(cat "$root/unhealthy" 2>/dev/null || echo 0)
  case "\$out" in *healthy) [ "\$n" -ge 3 ] || { echo \$((n + 1)) >"$root/unhealthy" && echo "\$out" | sed 's/healthy\$/unhealthy/' && exit 0; } ;; esac
  echo "\$out"
  exit 0 ;;
esac
exec $real_docker "\$@"
EOF
chmod +x "$root/stub/docker"
PATH="$root/stub:$PATH" "$root/deploy/trioditis" backup "$backups" >"$root/out" 2>&1 && status=0 || status=$?
[ "$status" = 0 ] && [ "$(cat "$root/unhealthy")" = 3 ] && check ok "a step unhealthy for a while, then healthy, is waited for" ||
  { check fail "a step unhealthy for a while, then healthy, is waited for"; cat "$root/out" >&2; }
[ "$(state gateway)" = running ] && check ok "and the next step starts" || check fail "and the next step starts ($(state gateway))"

# A step that never becomes healthy in time: a stub docker that always says "starting", a
# sleep that doesn't wait, and a clock that moves 30 seconds each time it's read.
printf '#!/bin/sh\ncase "$*" in *State.Health*) echo starting; exit 0 ;; esac\nexec %s "$@"\n' "$real_docker" >"$root/stub/docker"
printf '#!/bin/sh\nexit 0\n' >"$root/stub/sleep"
cat >"$root/stub/date" <<EOF
#!/bin/sh
[ "\$*" = +%s ] || exec $(command -v date) "\$@"
now=\$(cat "$root/clock" 2>/dev/null || echo 1000)
echo \$((now + 30)) >"$root/clock"
echo "\$now"
EOF
chmod +x "$root/stub/docker" "$root/stub/sleep" "$root/stub/date"
PATH="$root/stub:$PATH" "$root/deploy/trioditis" backup "$backups" >"$root/out" 2>&1 && status=0 || status=$?
[ "$status" != 0 ] && grep -q "caddy didn't become healthy" "$root/out" && grep -q "deploy/trioditis up -d" "$root/out" &&
  check ok "a step not healthy in time stops the restart, naming it, and the backup fails" ||
  { check fail "a step not healthy in time stops the restart, naming it, and the backup fails"; cat "$root/out" >&2; }
[ "$(state gateway)" = exited ] && check ok "the next step isn't started" || check fail "the next step isn't started ($(state gateway))"

# --keep-stopped (the updater's): once the backup is made, the server is left stopped.
trioditis up -d svc >/dev/null 2>&1
trioditis backup --keep-stopped "$backups" >"$root/out" 2>&1 && status=0 || status=$?
[ "$status" = 0 ] && [ "$(state svc)" = exited ] && grep -q "left stopped" "$root/out" &&
  check ok "with --keep-stopped, the server is left stopped" ||
  { check fail "with --keep-stopped, the server is left stopped ($(state svc))"; cat "$root/out" >&2; }

finish
