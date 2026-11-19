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
printf 'deploy/.env\ndeploy/updater/\ndeploy/scripts/\ndeploy/.operation.lock\n' >>"$work/checkout/.git/info/exclude"

mkdir -p "$work/bin"
cat >"$work/bin/docker" <<'EOF'
#!/bin/sh
# The updater's only docker calls are the agent's: record each report.
case " $* " in
  *' -e UPDATER_SECRET '*' watch '*) echo "watch with ${UPDATER_SECRET:-no secret}" >>"$REPORT_LOG"; echo 'stable 0 - -' ;;
  *' report '*) echo "$UPDATER_STATE|$UPDATER_MESSAGE|$UPDATER_DONE|$UPDATER_CURRENT|$UPDATER_LATEST|$UPDATER_BEHIND|$UPDATER_AHEAD|$UPDATER_SECRET" >>"$REPORT_LOG" ;;
  *) echo "stub: unexpected docker $*" >&2; exit 1 ;;
esac
EOF
chmod +x "$work/bin/docker"
export PATH="$work/bin:$PATH" UPDATER_TEST_LOG="$work/installs" REPORT_LOG="$work/reports"

# run FUNCTION ARGS: one updater step in a fresh shell, as the service would take it, printing
# the outcome it's left with. Exits like the step (an update that succeeds exits 0 itself).
run() {
  : >"$work/installs"
  : >"$work/reports"
  bash -c '. "$1/deploy/updater/updater.sh"; init || exit 9; done_id=req1; shift; "$@" 2>/dev/null; echo "$outcome_state|$outcome_message"' \
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
