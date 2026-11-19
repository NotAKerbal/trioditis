#!/bin/sh
# What the updater (deploy/updater/updater.sh) does with a checkout, against a throwaway git
# remote whose commits carry a stub installer, and a stub docker that records the reports: it
# moves the checkout forward to a channel's newest commit and runs that commit's installer;
# after a failed install it goes back to the commit it was on and installs that again, and
# says so; it leaves a checkout that's up to date, ahead of the channel, diverged from it, or
# has local changes where it is; and each step reaches the admins as a report.
set -eu
repo=$(cd "$(dirname "$0")/../.." && pwd)
test_name="the updater moves a checkout forward, and back after a failed install"
failures=0
check() {
  if [ "$1" = ok ]; then echo "  ok: $2"; else echo "  FAILED: $2" >&2 && failures=$((failures + 1)); fi
}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
echo "$test_name"

git_() { git -c user.name=test -c user.email=test@example.com -c init.defaultBranch=main "$@"; }

# The remote: main at c1; dev at c2, then c3, whose installer fails, then c4 off main.
git_ init -q "$work/source"
mkdir -p "$work/source/deploy/install"
cat >"$work/source/deploy/install/install.sh" <<'EOF'
#!/bin/sh
root=$(cd "$(dirname "$0")/../.." && pwd)
echo "installed $(git -C "$root" rev-parse HEAD)" >>"$UPDATER_TEST_LOG"
# How it was run: its options, and whether it was handed the install's lock.
lock=no
if [ -e /dev/fd/9 ] && [ /dev/fd/9 -ef "$root/deploy/.operation.lock" ]; then lock=held; fi
echo "$* lock=$lock" >>"$UPDATER_TEST_LOG.how"
if [ -e "$root/deploy/install/FAIL" ]; then printf '\033[31merror:\033[0m The build broke.\n' >&2; exit 1; fi
EOF
chmod +x "$work/source/deploy/install/install.sh"
echo one >"$work/source/file"
git_ -C "$work/source" add -A
git_ -C "$work/source" commit -qm one
c1=$(git -C "$work/source" rev-parse HEAD)
git_ -C "$work/source" checkout -qb dev
echo two >"$work/source/file"
git_ -C "$work/source" commit -qam 'Make it two'
c2=$(git -C "$work/source" rev-parse HEAD)
git_ init -q --bare "$work/origin.git"
git_ -C "$work/source" push -q "$work/origin.git" main dev

git_ clone -q "$work/origin.git" "$work/checkout"
git_ -C "$work/checkout" checkout -q --detach "$c1"
mkdir -p "$work/checkout/deploy/updater" "$work/checkout/deploy/scripts"
cp "$repo/deploy/updater/updater.sh" "$work/checkout/deploy/updater/"
cp "$repo/deploy/scripts/env.sh" "$work/checkout/deploy/scripts/"
printf 'COMPOSE_PROJECT_NAME=trioditis-test\nUPDATER_SECRET=test-secret\n' >"$work/checkout/deploy/.env"
# The installer's files that aren't in git stay out of it, as in a real install.
printf 'deploy/.env\ndeploy/updater/\ndeploy/scripts/\ndeploy/.operation.lock\ndeploy/.updater-state\n' >>"$work/checkout/.git/info/exclude"

mkdir -p "$work/bin"
cat >"$work/bin/docker" <<'EOF'
#!/bin/sh
# The updater's only docker calls are the agent's: record each report.
case " $* " in
  *' -e UPDATER_SECRET '*' watch '*) echo "watch with ${UPDATER_SECRET:-no secret}" >>"$REPORT_LOG"; echo 'stable 0 - -' ;;
  *' report '*)
    # A request an admin cancelled can't be claimed.
    [ "${UPDATER_CLAIM:-}" != cancelled ] || exit 1
    # Admins chose stable after the updater began on nightly.
    [ "${UPDATER_CLAIM_CHANNEL:-}" != nightly ] || [ ! -e "$REPORT_LOG.stable" ] || exit 1
    # The backend out of reach, for one test.
    [ ! -e "$REPORT_LOG.down" ] || exit 1
    echo "$UPDATER_STATE|$UPDATER_MESSAGE|$UPDATER_DONE|$UPDATER_CURRENT|$UPDATER_LATEST|$UPDATER_BEHIND|$UPDATER_AHEAD|$UPDATER_SECRET" >>"$REPORT_LOG" ;;
  *) echo "stub: unexpected docker $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH" UPDATER_TEST_LOG="$work/installs" REPORT_LOG="$work/reports"

# run FUNCTION ARGS: one updater step in a fresh shell, as the service would take it, printing
# the outcome it's left with. Exits like the step (an update that succeeds exits 0 itself).
run() {
  : >"$work/installs"
  : >"$work/installs.how"
  : >"$work/reports"
  bash -c '. "$1/deploy/updater/updater.sh"; init || exit 9; BACKOFF_SECONDS=0; done_id=${TEST_REQUEST:-req1}; shift; "$@" 2>/dev/null; echo "$outcome_state|$outcome_message"' \
    updater "$work/checkout" "$@" >"$work/out" 2>&1 || true
}
head_is() { [ "$(git -C "$work/checkout" rev-parse HEAD)" = "$1" ]; }

run update stable
head_is "$c1" && grep -q '^idle|Already up to date' "$work/out" && [ ! -s "$work/installs" ] &&
  check ok "up to date with stable: nothing installs" || check fail "up to date with stable: nothing installs ($(cat "$work/out"))"

run update nightly
head_is "$c2" && [ "$(cat "$work/installs")" = "installed $c2" ] &&
  grep -q "^updating|Installing ${c2%"${c2#???????}"}.||" "$work/reports" &&
  grep -q "^idle|Updated to ${c2%"${c2#???????}"}.|req1|$c2|$c2|0|0|test-secret" "$work/reports" &&
  check ok "nightly moves it to dev's newest commit, installs it, and reports it done" ||
  check fail "nightly moves it to dev's newest commit, installs it, and reports it done ($(cat "$work/out" "$work/reports"))"
[ "$(cat "$work/installs.how")" = "--no-setup-link lock=held" ] &&
  check ok "the installer runs holding the updater's lock, and prints no setup link" ||
  check fail "the installer runs holding the updater's lock, and prints no setup link ($(cat "$work/installs.how"))"

# A commit whose installer fails.
git_ -C "$work/source" checkout -q dev
touch "$work/source/deploy/install/FAIL"
git_ -C "$work/source" add -A
git_ -C "$work/source" commit -qm 'Break the build'
c3=$(git -C "$work/source" rev-parse HEAD)
git_ -C "$work/source" push -q "$work/origin.git" dev
run update nightly
head_is "$c2" && [ "$(cat "$work/installs")" = "$(printf 'installed %s\ninstalled %s' "$c3" "$c2")" ] &&
  grep -q "^failed|The update to ${c3%"${c3#???????}"} failed: The build broke. The server is back on ${c2%"${c2#???????}"}." "$work/out" &&
  check ok "a failed install goes back to the commit it was on, installs that, and says why" ||
  check fail "a failed install goes back to the commit it was on, installs that, and says why ($(cat "$work/out" "$work/installs"))"
state=$work/checkout/deploy/.updater-state
grep -qx "failed_target=$c3" "$state" && grep -qx 'pending_target=' "$state" &&
  check ok "the failed commit outlasts a restart, and nothing is left pending" ||
  check fail "the failed commit outlasts a restart, and nothing is left pending ($(cat "$state"))"

# From c1, with dev at c3: a request cancelled before the update claimed it, and a lock held
# by someone else, both leave the checkout where it is.
git_ -C "$work/checkout" checkout -q --detach "$c1"
TEST_REQUEST=cancelled run update nightly
head_is "$c1" && grep -q "^idle|The update didn't start" "$work/out" && [ ! -s "$work/installs" ] &&
  check ok "a request cancelled before it starts installs nothing" ||
  check fail "a request cancelled before it starts installs nothing ($(cat "$work/out"))"
touch "$work/reports.stable"
run update nightly
rm -f "$work/reports.stable"
head_is "$c1" && grep -q "^idle|The update didn't start" "$work/out" && [ ! -s "$work/installs" ] &&
  check ok "an update for a channel admins have since left installs nothing" ||
  check fail "an update for a channel admins have since left installs nothing ($(cat "$work/out"))"
flock "$work/checkout/deploy/.operation.lock" sleep 5 &
holder=$!
sleep 0.5
run update nightly
kill "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
head_is "$c1" && grep -q '^failed|A backup or an install is running' "$work/out" && [ ! -s "$work/installs" ] &&
  check ok "a held lock stops it before the checkout moves" ||
  check fail "a held lock stops it before the checkout moves ($(cat "$work/out"))"

# An update cut off mid-install (here, as the checkout moved): its outcome isn't known, so the
# next start goes back to the commit it was on, counts the target failed, and reports it.
git_ -C "$work/checkout" checkout -q --detach "$c2"
printf 'pending_target=%s\npending_previous=%s\npending_request=req9\npending_phase=install\nauto_day=2026-01-01\n' "$c2" "$c1" >"$state"
run recover
head_is "$c1" && [ "$(cat "$work/installs")" = "installed $c1" ] &&
  grep -q "^failed|The update to ${c2%"${c2#???????}"} failed: It was cut off before it finished. The server is back on ${c1%"${c1#???????}"}.|req9|" "$work/reports" &&
  grep -qx 'pending_target=' "$state" && grep -qx "failed_target=$c2" "$state" && grep -qx 'auto_day=2026-01-01' "$state" &&
  check ok "an update cut off mid-install goes back on the next start, and its request is reported done" ||
  check fail "an update cut off mid-install goes back on the next start, and its request is reported done ($(cat "$work/out" "$work/reports" "$state"))"

# Cut off while going back: the next start goes on going back, and never tries c3 again.
git_ -C "$work/checkout" checkout -q --detach "$c3"
printf 'pending_target=%s\npending_previous=%s\npending_request=req7\npending_phase=rollback\nfailed_target=%s\n' "$c3" "$c2" "$c3" >"$state"
run recover
head_is "$c2" && [ "$(cat "$work/installs")" = "installed $c2" ] &&
  grep -q "^failed|The update to ${c3%"${c3#???????}"} failed: It was cut off before it finished. The server is back on ${c2%"${c2#???????}"}.|req7|" "$work/reports" &&
  grep -qx 'pending_target=' "$state" && grep -qx 'done_request=' "$state" &&
  check ok "cut off while going back, it goes on going back, and reports the request done" ||
  check fail "cut off while going back, it goes on going back, and reports the request done ($(cat "$work/out" "$work/installs" "$work/reports" "$state"))"

# The report that ends an update doesn't get through: it's kept, and sent once it can be.
printf 'done_request=req8\ndone_result=back\ndone_target=%s\ndone_previous=%s\nfailed_target=%s\n' "$c3" "$c2" "$c3" >"$state"
touch "$work/reports.down"
run report_done
rm -f "$work/reports.down"
grep -qx 'done_request=req8' "$state" && [ ! -s "$work/installs" ] &&
  check ok "an update's last report that didn't get through is kept" ||
  check fail "an update's last report that didn't get through is kept ($(cat "$state"))"
run report_done
grep -q '^failed|The update to .* failed. The server is back on .*|req8|' "$work/reports" && grep -qx 'done_request=' "$state" &&
  [ ! -s "$work/installs" ] && check ok "and is sent once it can be, installing nothing" ||
  check fail "and is sent once it can be, installing nothing ($(cat "$work/reports" "$state"))"

# While that report is waiting, a turn of the loop installs nothing, even for a new request.
git_ -C "$work/checkout" checkout -q --detach "$c1"
printf 'done_request=req8\ndone_result=back\ndone_target=%s\ndone_previous=%s\n' "$c3" "$c1" >"$state"
touch "$work/reports.down"
run handle 'nightly 1 req10 update'
rm -f "$work/reports.down"
head_is "$c1" && [ ! -s "$work/installs" ] && grep -qx 'done_request=req8' "$state" &&
  check ok "no update starts while the last one's report is waiting" ||
  check fail "no update starts while the last one's report is waiting ($(cat "$work/out" "$state"))"
git_ -C "$work/checkout" checkout -q --detach "$c2"
rm -f "$state"

# Ahead of stable (main is at c1): nothing to install.
run update stable
head_is "$c2" && grep -q "^idle|This server is newer than main" "$work/out" && [ ! -s "$work/installs" ] &&
  check ok "ahead of the channel: it stays" || check fail "ahead of the channel: it stays ($(cat "$work/out"))"

# Diverged: main gets a commit dev doesn't have.
git_ -C "$work/source" checkout -q main
echo hotfix >"$work/source/other"
git_ -C "$work/source" add -A
git_ -C "$work/source" commit -qm 'Hotfix'
git_ -C "$work/source" push -q "$work/origin.git" main
run update stable
head_is "$c2" && grep -q "^idle|This server runs commits main doesn't have" "$work/out" && [ ! -s "$work/installs" ] &&
  check ok "diverged from the channel: it stays" || check fail "diverged from the channel: it stays ($(cat "$work/out"))"

# Local changes to a tracked file.
git_ -C "$work/checkout" checkout -q --detach "$c1"
echo changed >"$work/checkout/file"
run update nightly
head_is "$c1" && grep -q "^failed|The server's checkout has local changes" "$work/out" && [ ! -s "$work/installs" ] &&
  [ "$(cat "$work/checkout/file")" = changed ] &&
  check ok "local changes: it stays, and they're kept" || check fail "local changes: it stays, and they're kept ($(cat "$work/out"))"
git_ -C "$work/checkout" checkout -q -- file

# The watch gets the secret too.
: >"$work/reports"
bash -c '. "$1/deploy/updater/updater.sh"; init; agent watch 0' updater "$work/checkout" >"$work/out" 2>&1 || true
[ "$(cat "$work/out")" = "stable 0 - -" ] && [ "$(cat "$work/reports")" = "watch with test-secret" ] &&
  check ok "the agent gets the updater's secret for a watch" ||
  check fail "the agent gets the updater's secret for a watch ($(cat "$work/out" "$work/reports"))"

# check_latest counts both ways.
bash -c '. "$1/deploy/updater/updater.sh"; init; check_latest nightly; echo "$latest $behind $ahead $latest_channel"' updater "$work/checkout" >"$work/out" 2>&1 || true
[ "$(cat "$work/out")" = "$c3 2 0 nightly" ] && check ok "it counts the commits the channel has that the server doesn't" ||
  check fail "it counts the commits the channel has that the server doesn't ($(cat "$work/out"))"

if [ "$failures" -gt 0 ]; then
  echo "$test_name: $failures failed" >&2
  exit 1
fi
echo "$test_name: all passed"
