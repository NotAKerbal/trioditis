#!/usr/bin/env bash
# The updater: keeps this install up to date the way its admins choose in the app (Admin
# settings → Updates). `deploy/install/install.sh` runs it as a systemd service, as the
# operator, unless --no-updater; see docs/deploy.md, Updates.
#
# It learns the admins' choices (the release channel, whether updates install on their own)
# and requests from the backend, through deploy/scripts/updater-agent.mjs in a one-off
# container on the server's network, and reports back the same way. It fetches the channel's
# branch from this checkout's git remote, and to update, moves the checkout to that branch's
# newest commit and runs the installer, which restarts only what changed. It only ever moves
# forward: a commit the branch doesn't have, or local changes, and it stays where it is. If
# the installer fails, it goes back to the commit it was on and runs the installer again. It
# holds the install's lock from before it moves the checkout until the installer is done, and
# keeps what must outlast a restart in deploy/.updater-state: an update in progress (finished
# on the next start, if it was cut off, by going back), how the last one ended until the
# backend has the report, the day of the last automatic update, and the commit whose update
# last failed.
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
# How long it waits after the backend didn't answer, or didn't take a report.
BACKOFF_SECONDS=60

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
AGENT_VARIABLES='SECRET STATE MESSAGE DONE CLAIM CLAIM_CHANNEL CLAIM_AUTO CURRENT CURRENT_AT LATEST LATEST_CHANNEL LATEST_AT
  LATEST_SUBJECT LATEST_NOTES BEHIND AHEAD CHECKED_AT INSTALLED_FROM INSTALLED_TO INSTALLED_NOTES'
agent() {
  local passed=() name
  for name in $AGENT_VARIABLES; do passed+=(-e "UPDATER_$name"); done
  UPDATER_SECRET=$secret docker run --rm --init --log-driver none --label "trioditis.updater=$project" \
    --network "${project}_default" "${passed[@]}" \
    --entrypoint node "$project/node:local" deploy/scripts/updater-agent.mjs "$@"
}

# report STATE [MESSAGE]: what the admins see. Marks $done_id finished, if set; with
# UPDATER_CLAIM set to a request's ID, fails unless that request is still waiting. With
# UPDATER_INSTALLED_* set, it also says which update was just installed and its notes.
report() {
  UPDATER_STATE=$1 UPDATER_MESSAGE=${2:-} UPDATER_DONE=$done_id \
    UPDATER_CURRENT=$current UPDATER_CURRENT_AT=$current_at \
    UPDATER_LATEST=$latest UPDATER_LATEST_CHANNEL=$latest_channel UPDATER_LATEST_AT=$latest_at \
    UPDATER_LATEST_SUBJECT=$latest_subject UPDATER_LATEST_NOTES=$latest_notes UPDATER_BEHIND=$behind \
    UPDATER_AHEAD=$ahead UPDATER_CHECKED_AT=$checked_at \
    agent report || { log "Couldn't report to the backend."; return 1; }
}

# The state that outlasts a restart, in deploy/.updater-state: NAME=value lines, each checked
# as it's read, so a damaged file reads as no state rather than as a command.
#
# pending_*: the update in progress, from before the checkout moves until it's over, with its
# phase: `install` (the target) or `rollback` (back to the previous commit, the target having
# failed). done_*: how the last update ended, until the backend has the report, so a report
# that didn't get through is sent again rather than the request run again.
STATE_NAMES='pending_target pending_previous pending_request pending_phase
  done_request done_result done_target done_previous auto_day failed_target'
load_state() {
  local name value
  for name in $STATE_NAMES; do printf -v "$name" '%s' ''; done
  [ -f "$state_file" ] || return 0
  while IFS='=' read -r name value; do
    case "$name" in
      pending_target | pending_previous | done_target | done_previous | failed_target)
        [[ "$value" =~ ^[0-9a-f]{40}$ ]] || continue ;;
      pending_request | done_request) [[ "$value" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || continue ;;
      pending_phase) [[ "$value" =~ ^(install|rollback)$ ]] || continue ;;
      done_result) [[ "$value" =~ ^(updated|back|stuck)$ ]] || continue ;;
      auto_day) [[ "$value" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || continue ;;
      *) continue ;;
    esac
    printf -v "$name" '%s' "$value"
  done <"$state_file"
}
save_state() {
  local tmp name
  tmp=$(mktemp "$state_file.XXXXXX") || { log "Couldn't save $state_file."; return 1; }
  for name in $STATE_NAMES; do printf '%s=%s\n' "$name" "${!name}"; done >"$tmp" &&
    mv -f "$tmp" "$state_file" || { rm -f "$tmp"; log "Couldn't save $state_file."; return 1; }
}

# The install's lock (deploy/.operation.lock), on descriptor 9, which the installer it runs
# finds already held and uses as is. take_lock [SECONDS] waits that long for it (default: not
# at all).
take_lock() {
  command -v flock >/dev/null || return 0
  exec 9>"$here/.operation.lock" && flock -w "${1:-0}" 9
}
release_lock() { exec 9>&-; }

# outcome STATE MESSAGE: what the reports say from now until the next check or update.
outcome() {
  outcome_state=$1
  outcome_message=$2
}

describe_current() {
  current=$(git -C "$root" rev-parse --verify 'HEAD^{commit}') || return 1
  current_at=$(git -C "$root" show -s --format=%ct "$current")
}

# The most release-note lines a report carries, and the most bytes of each line's text: the
# notes reach the agent in one environment variable, which Linux caps at 128 KiB. The format
# allows 200 characters, at most 800 bytes of UTF-8; the backend cuts to its own limits.
MAX_NOTES=100
MAX_NOTE_BYTES=800

# release_notes FROM TO: the release notes TO has that FROM doesn't, as `<Label><tab><text>`
# lines: each line of every file in release-notes/ that TO adds, the newest file first. A note
# renamed (or moved with small edits) isn't new, as in scripts/release-notes.mjs, which checks
# the format (docs/CONTRIBUTING.md, Release notes); a line that doesn't fit it is left out here.
release_notes() {
  local from=$1 to=$2 path line count=0
  local -A added=() seen=()
  local ordered=()
  while IFS= read -r path; do added[$path]=1; done < <(
    git -C "$root" -c core.quotePath=true diff --name-only --find-renames --diff-filter=A "$from" "$to" -- release-notes/)
  # Newest first: the order the commits in between added them, then any left in name order.
  while IFS= read -r path; do
    [ -n "$path" ] && [ -n "${added[$path]:-}" ] && [ -z "${seen[$path]:-}" ] || continue
    seen[$path]=1
    ordered+=("$path")
  done < <(git -C "$root" -c core.quotePath=true log --format= --name-only --find-renames --diff-filter=A \
    "$from..$to" -- release-notes/; printf '%s\n' "${!added[@]}" | LC_ALL=C sort)
  for path in "${ordered[@]}"; do
    [[ "$path" =~ ^release-notes/[a-z0-9][a-z0-9-]*\.md$ ]] || continue
    while IFS= read -r line || [ -n "$line" ]; do
      [[ "$line" =~ ^(New|Improved|Fixed|Security|Internal):\ (.+)$ ]] || continue
      [ "$count" -lt "$MAX_NOTES" ] || return 0
      printf '%s\t%s\n' "${BASH_REMATCH[1]}" "$(printf '%s' "${BASH_REMATCH[2]}" | head -c "$MAX_NOTE_BYTES")"
      count=$((count + 1))
    done < <(git -C "$root" show "$to:$path" | LC_ALL=C tr -d '\000-\011\013-\037\177')
  done
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
  latest_notes=''
  [ "$behind" = 0 ] || latest_notes=$(release_notes "$current" "$commit")
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
  # Its output goes to the journal, which is no place for the admin setup link.
  "$root/deploy/install/install.sh" --no-setup-link 2>&1 | tee "$output" >&2
  status=${PIPESTATUS[0]}
  if [ "$status" != 0 ]; then
    install_error=$(sed 's/\x1b\[[0-9;]*m//g' "$output" | grep -a '^error: ' | tail -1 | cut -c8-308)
    [ -n "$install_error" ] || install_error="The installer stopped (exit $status)."
  fi
  rm -f "$output"
  [ "$status" = 0 ]
}

# update CHANNEL [AUTO]: installs the channel's newest commit, if that moves the server forward;
# AUTO 1 for an automatic update, which starts only while admins still have them on. Exits
# after a successful update, so the new version of this script takes over.
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
  # Held from here until the installer is done, so a backup or an install the operator starts
  # can't run between moving the checkout and installing it, nor be mistaken for a failure.
  if ! take_lock; then
    release_lock
    outcome failed "A backup or an install is running on the server. Try again once it's done."
    return
  fi
  target=$latest
  previous=$current
  # Claimed before anything moves, request and channel both: an admin who cancelled or chose
  # another channel meanwhile gets their way, and an update the backend can't hear about
  # doesn't start. The request stays until the update is over, so it isn't marked done yet.
  if ! UPDATER_CLAIM=$done_id UPDATER_CLAIM_CHANNEL=$channel UPDATER_CLAIM_AUTO=${2:-0} done_id='' \
    report updating "Installing ${target:0:7}."; then
    release_lock
    outcome idle "The update didn't start: it was cancelled, the channel or automatic updates changed, or the server couldn't be reached."
    return
  fi
  pending_target=$target pending_previous=$previous pending_request=$done_id pending_phase=install
  save_state || { release_lock; outcome failed "Couldn't save the updater's state on the server."; return; }
  log "Updating from $previous to $target ($name)."
  finish_update
}

# finish_update: installs $pending_target, or, in the rollback phase or once that fails, goes
# back to $pending_previous, holding the lock. Exits after a successful update.
finish_update() {
  local target=$pending_target previous=$pending_previous
  if [ "$pending_phase" != rollback ]; then
    failure_detail='' rollback_detail=''
    if run_install "$target"; then
      conclude updated
      describe_current
      behind=0 ahead=0 latest_notes=''
      report_done
      log "Updated to $target."
      exit 0
    fi
    failure_detail=$install_error
    log "The update to $target failed: $failure_detail Going back to $previous."
    failed_target=$target pending_phase=rollback
    save_state
  fi
  if run_install "$previous"; then conclude back; else
    rollback_detail=$install_error
    conclude stuck
  fi
  describe_current
  report_done
  release_lock
}

# conclude RESULT: the update in progress is over (updated, back on the previous commit, or
# stuck: going back failed too); kept as done_* until the backend has the report.
conclude() {
  done_request=$pending_request done_result=$1 done_target=$pending_target done_previous=$pending_previous
  pending_target='' pending_previous='' pending_request='' pending_phase=''
  save_state
}

# report_done: reports how the last update ended, marking its request done, and forgets it
# once the backend has it. Its outcome stays in the reports until the next check or update.
report_done() {
  [ -n "$done_result" ] || return 0
  local target=${done_target:0:7} previous=${done_previous:0:7}
  # Each error gets its own share of the 500 characters the backend keeps.
  local detail=${failure_detail:+: ${failure_detail:0:160}} back=${rollback_detail:+: ${rollback_detail:0:160}}
  # The notes of an update that went in: worked out here rather than kept, so a report sent
  # again after a restart has them too.
  local installed_from='' installed_to='' installed_notes=''
  case "$done_result" in
    updated)
      outcome idle "Updated to $target."
      installed_from=$done_previous installed_to=$done_target
      installed_notes=$(release_notes "$done_previous" "$done_target")
      ;;
    back) outcome failed "The update to $target failed${detail:-.} The server is back on $previous." ;;
    stuck) outcome failed "The update to $target failed${detail:-.} Going back to $previous failed too${back:-.} The updater's log on the server has the details." ;;
  esac
  if UPDATER_INSTALLED_FROM=$installed_from UPDATER_INSTALLED_TO=$installed_to \
    UPDATER_INSTALLED_NOTES=$installed_notes done_id=$done_request report "$outcome_state" "$outcome_message"; then
    done_request='' done_result='' done_target='' done_previous=''
    save_state
  fi
}

# An update cut off by a restart (the machine, or the service, stopped mid-install or
# mid-rollback, or its state couldn't be saved) goes back first: the checkout may be on either
# commit and the server half updated, and how the install would have ended isn't known, so the
# commit it was on is the one to be on. The target counts as failed, so nothing tries it again
# on its own.
recover() {
  [ -n "$pending_target" ] && [ -n "$pending_previous" ] || return 0
  log "The update to $pending_target was cut off; going back to $pending_previous."
  take_lock 3600 || { release_lock; log "The install's lock is held; trying again later."; return 1; }
  done_id='' report updating "Going back to ${pending_previous:0:7}: the update to ${pending_target:0:7} was cut off."
  failed_target=$pending_target pending_phase=rollback
  failure_detail="It was cut off before it finished." rollback_detail=''
  save_state
  finish_update
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
  state_file="$here/.updater-state"
  remote=origin
  # A fetch that needs credentials it doesn't have fails rather than waiting for a prompt.
  export GIT_TERMINAL_PROMPT=0

  load_settings || return 1
  # The checkout's own repository, not one it was unpacked inside (git looks upwards).
  { top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) && [ "$top" -ef "$root" ] && describe_current; } ||
    { log "$root isn't a git checkout of its own."; return 1; }
  latest='' latest_channel='' latest_at='' latest_subject='' latest_notes='' behind='' ahead='' checked_at=''
  last_fetch=0 done_id='' failure_detail='' rollback_detail=''
  load_state
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
  recover || exit 1
  log "Watching for updates to $root (project $project)."

  local wait=0 line
  while :; do
    # Its last line: the client library may print notes of its own before it.
    if ! line=$(agent watch "$wait" | tail -1); then
      log "Couldn't reach the backend; trying again in a minute."
      sleep "$BACKOFF_SECONDS"
      wait=0
      continue
    fi
    handle "$line"
    wait=$WATCH_SECONDS
  done
}

# handle LINE: one turn of the loop, for what a watch printed: `<channel> <auto> <request id or
# -> <request kind or ->`.
handle() {
  local channel auto request_id kind
  read -r channel auto request_id kind <<<"$1"
  if ! { [[ "$channel" =~ ^(stable|nightly)$ ]] && [[ "$auto" =~ ^[01]$ ]] &&
    [[ "$request_id" =~ ^([A-Za-z0-9_-]{1,64}|-)$ ]] && [[ "$kind" =~ ^(check|update|-)$ ]]; }; then
    log "Unexpected answer from the backend: $1"
    sleep "$BACKOFF_SECONDS"
    return
  fi
  # How the last update ended goes first. Until the backend has it, nothing new installs: the
  # report is what tells the backend that update's request is done, and a newer update would
  # take its place. The request it's for is reported, never run again.
  if [ -n "$done_request" ] && [ "$request_id" = "$done_request" ]; then request_id=- kind=-; fi
  report_done
  if [ -n "$done_result" ]; then
    log "The backend hasn't taken the last update's report; trying again shortly."
    sleep "$BACKOFF_SECONDS"
    return
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
    save_state
    if check_latest "$channel" && [ "$behind" != 0 ] && [ "$ahead" = 0 ] && [ "$latest" != "$failed_target" ]; then
      update "$channel" 1
    fi
  fi
  report "$outcome_state" "$outcome_message"
}

# Sourced by deploy/test/updater.sh for its functions; run, it's the service.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; exit; fi
