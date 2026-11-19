#!/usr/bin/env bash
# The updater: keeps this install up to date the way its admins choose in the app (Admin
# settings → Updates). `deploy/install/install.sh --updater` runs it as a systemd service, as
# the operator; see docs/deploy.md, Updates.
#
# It learns the admins' choices (the release channel, whether updates install on their own)
# and requests from the backend, through deploy/scripts/updater-agent.mjs in a one-off
# container on the server's network, and reports back the same way. It fetches the channel's
# branch from this checkout's git remote, and to update, moves the checkout to that branch's
# newest commit and runs the installer, which restarts only what changed. It only ever moves
# forward: a commit the branch doesn't have, or local changes, and it stays where it is. If
# the installer fails, it goes back to the commit it was on and runs the installer again.
#
# Everything is in functions and the last line calls main, so bash has read the whole file
# before an update replaces it. After an update it exits, and systemd starts the new one.

# The branch each release channel follows.
channel_branch() {
  case "$1" in
    stable) echo main ;;
    nightly) echo dev ;;
    *) return 1 ;;
  esac
}
# Automatic updates install during this hour, the host's local time, at most once a day.
AUTO_HOUR=04
# How long a watch waits for a request: also how often the updater reports in.
WATCH_SECONDS=600
# How often it looks for a new version without being asked.
FETCH_SECONDS=3600

log() { printf 'updater: %s\n' "$*" >&2; }

# Reads the project and the updater's secret from deploy/.env, with the installer's parser.
load_settings() {
  local text
  env_raw_clean "$env_file" || { log "deploy/.env holds a NUL or a carriage return."; return 1; }
  text=$(cat "$env_file") || return 1
  project=$(printf '%s\n' "$text" | env_value COMPOSE_PROJECT_NAME)
  project=${project:-trioditis}
  secret=$(printf '%s\n' "$text" | env_value UPDATER_SECRET)
  [ -n "$secret" ] || { log "deploy/.env has no UPDATER_SECRET. Run deploy/install/install.sh --updater."; return 1; }
}

# agent ARGS: runs updater-agent.mjs on the server's network, from the bundle's Node image.
# The secret and a report's values reach it as UPDATER_* variables, never as arguments (an
# unset one isn't passed); --init so it stops on a signal.
AGENT_VARIABLES='SECRET STATE MESSAGE DONE CURRENT CURRENT_AT LATEST LATEST_CHANNEL LATEST_AT
  LATEST_SUBJECT BEHIND AHEAD CHECKED_AT'
agent() {
  local passed=() name
  for name in $AGENT_VARIABLES; do passed+=(-e "UPDATER_$name"); done
  UPDATER_SECRET=$secret docker run --rm --init --log-driver none --label "trioditis.updater=$project" \
    --network "${project}_default" "${passed[@]}" \
    --entrypoint node "$project/node:local" deploy/scripts/updater-agent.mjs "$@"
}

# report STATE [MESSAGE]: what the admins see. Marks $done_id finished, if set.
report() {
  UPDATER_STATE=$1 UPDATER_MESSAGE=${2:-} UPDATER_DONE=$done_id \
    UPDATER_CURRENT=$current UPDATER_CURRENT_AT=$current_at \
    UPDATER_LATEST=$latest UPDATER_LATEST_CHANNEL=$latest_channel UPDATER_LATEST_AT=$latest_at \
    UPDATER_LATEST_SUBJECT=$latest_subject UPDATER_BEHIND=$behind UPDATER_AHEAD=$ahead \
    UPDATER_CHECKED_AT=$checked_at \
    agent report || log "Couldn't report to the backend."
}

# outcome STATE MESSAGE: what the reports say from now until the next check or update.
outcome() {
  outcome_state=$1
  outcome_message=$2
}

describe_current() {
  current=$(git -C "$root" rev-parse --verify 'HEAD^{commit}') || return 1
  current_at=$(git -C "$root" show -s --format=%ct "$current")
}

# check_latest CHANNEL: fetches the channel's branch and compares its newest commit with this
# one: `behind` counts the commits it has that this doesn't, `ahead` the other way round.
check_latest() {
  local channel=$1 branch ref commit
  branch=$(channel_branch "$channel") || return 1
  ref="refs/remotes/$remote/$branch"
  last_fetch=$(date +%s)
  if ! timeout 300 git -C "$root" fetch --quiet --no-tags "$remote" "+refs/heads/$branch:$ref"; then
    log "Couldn't fetch $branch from $remote."
    return 1
  fi
  describe_current || return 1
  commit=$(git -C "$root" rev-parse --verify "$ref^{commit}") || return 1
  latest=$commit
  latest_channel=$channel
  latest_at=$(git -C "$root" show -s --format=%ct "$commit")
  latest_subject=$(git -C "$root" show -s --format=%s "$commit")
  behind=$(git -C "$root" rev-list --count "$current..$commit")
  ahead=$(git -C "$root" rev-list --count "$commit..$current")
  checked_at=$(date +%s)
}

# run_install COMMIT: checks the commit out and runs its installer, which keeps every setting.
# On failure, `install_error` is the installer's last error line.
run_install() {
  local output status
  install_error=''
  if ! git -C "$root" checkout --quiet --detach "$1"; then
    install_error="Couldn't check out ${1:0:7}."
    return 1
  fi
  output=$(mktemp)
  "$root/deploy/install/install.sh" 2>&1 | tee "$output" >&2
  status=${PIPESTATUS[0]}
  if [ "$status" != 0 ]; then
    install_error=$(sed 's/\x1b\[[0-9;]*m//g' "$output" | grep -a '^error: ' | tail -1 | cut -c8-308)
    [ -n "$install_error" ] || install_error="The installer stopped (exit $status)."
  fi
  rm -f "$output"
  [ "$status" = 0 ]
}

# update CHANNEL: installs the channel's newest commit, if that moves the server forward.
# Exits after a successful update, so the new version of this script takes over.
update() {
  local channel=$1 name target previous
  name=$(channel_branch "$channel")
  if ! check_latest "$channel"; then
    outcome failed "Couldn't reach the repository to look for updates."
    return
  fi
  if [ "$behind" = 0 ] && [ "$ahead" = 0 ]; then
    outcome idle "Already up to date."
    return
  fi
  if [ "$behind" = 0 ]; then
    outcome idle "This server is newer than $name, so there's nothing to install."
    return
  fi
  if [ "$ahead" != 0 ]; then
    outcome idle "This server runs commits $name doesn't have, so it stays where it is."
    return
  fi
  if [ -n "$(git -C "$root" status --porcelain --untracked-files=no)" ]; then
    outcome failed "The server's checkout has local changes, so the updater won't move it."
    return
  fi
  # The installer takes this lock too; checked first so a backup or an install the operator
  # is running isn't mistaken for a failed update.
  if command -v flock >/dev/null && ! flock -n "$here/.operation.lock" true; then
    outcome failed "A backup or an install is running on the server. Try again once it's done."
    return
  fi
  target=$latest
  previous=$current
  log "Updating from $previous to $target ($name)."
  # The request stays until the update is over, so it isn't marked done yet.
  done_id='' report updating "Installing ${target:0:7}."
  if run_install "$target"; then
    describe_current
    behind=0 ahead=0
    outcome idle "Updated to ${target:0:7}."
    report idle "$outcome_message"
    log "Updated to $target."
    exit 0
  fi
  local error=$install_error
  log "The update to $target failed: $error Going back to $previous."
  failed_target=$target
  if run_install "$previous"; then
    describe_current
    outcome failed "The update to ${target:0:7} failed: $error The server is back on ${previous:0:7}."
  else
    describe_current
    outcome failed "The update to ${target:0:7} failed, and so did going back to ${previous:0:7}: $install_error The updater's log on the server has the details."
  fi
}

# Whether an automatic update is due: the admins turned them on, it's the hour for them, and
# none has been tried today. A commit whose update failed isn't tried again automatically.
auto_due() {
  [ "$auto" = 1 ] && [ "$(date +%H)" = "$AUTO_HOUR" ] && [ "$auto_day" != "$(date +%F)" ]
}

# Everything the loop needs, before it starts.
init() {
  set -uo pipefail
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  root=$(cd "$here/.." && pwd)
  env_file="$here/.env"
  # shellcheck source=deploy/scripts/env.sh
  . "$here/scripts/env.sh"
  remote=origin
  # A fetch that needs credentials it doesn't have fails rather than waiting for a prompt.
  export GIT_TERMINAL_PROMPT=0

  load_settings || return 1
  describe_current || { log "$root isn't a git checkout."; return 1; }
  latest='' latest_channel='' latest_at='' latest_subject='' behind='' ahead='' checked_at=''
  last_fetch=0 auto_day='' failed_target='' done_id=''
  outcome idle ''
}

main() {
  # A user service runs with the groups the user's systemd manager started with, which lack
  # docker if the operator was added to it since. sg starts this again in the group then.
  if ! docker info >/dev/null 2>&1 && [ -z "${UPDATER_IN_DOCKER_GROUP:-}" ] && command -v sg >/dev/null &&
    getent group docker | cut -d: -f4 | tr ',' '\n' | grep -qx "$(id -un)"; then
    log "Not in the docker group in this session; starting again with sg."
    exec env UPDATER_IN_DOCKER_GROUP=1 sg docker -c "exec bash $(printf '%q' "${BASH_SOURCE[0]}")"
  fi
  init || exit 1
  # Containers left by an updater that was killed mid-watch.
  for container in $(docker ps -aq --filter "label=trioditis.updater=$project"); do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
  log "Watching for updates to $root (project $project)."

  local wait=0 line channel auto request_id kind
  while :; do
    # Its last line: the client library may print notes of its own before it.
    if ! line=$(agent watch "$wait" | tail -1); then
      log "Couldn't reach the backend; trying again in a minute."
      sleep 60
      wait=0
      continue
    fi
    read -r channel auto request_id kind <<<"$line"
    if ! { [[ "$channel" =~ ^(stable|nightly)$ ]] && [[ "$auto" =~ ^[01]$ ]] &&
      [[ "$request_id" =~ ^([A-Za-z0-9_-]{1,64}|-)$ ]] && [[ "$kind" =~ ^(check|update|-)$ ]]; }; then
      log "Unexpected answer from the backend: $line"
      sleep 60
      continue
    fi
    done_id=''
    [ "$request_id" = - ] || done_id=$request_id

    if [ "$kind" = update ]; then
      update "$channel"
    elif [ "$kind" = check ]; then
      report checking
      if check_latest "$channel"; then outcome idle ''; else outcome failed "Couldn't reach the repository to look for updates."; fi
    elif [ "$channel" != "$latest_channel" ] || [ $(($(date +%s) - last_fetch)) -ge "$FETCH_SECONDS" ]; then
      check_latest "$channel" || true
    fi
    if [ "$kind" != update ] && auto_due; then
      auto_day=$(date +%F)
      if check_latest "$channel" && [ "$behind" != 0 ] && [ "$ahead" = 0 ] && [ "$latest" != "$failed_target" ]; then
        update "$channel"
      fi
    fi
    report "$outcome_state" "$outcome_message"
    wait=$WATCH_SECONDS
  done
}

# Sourced by deploy/test/updater.sh for its functions; run, it's the service.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit; fi
