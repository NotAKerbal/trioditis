#!/bin/sh
# What the updater (deploy/updater/updater.sh) does with a checkout, against a throwaway git
# remote whose commits carry a stub installer and image build, a stub deploy/trioditis that
# records backups and restores, and a stub docker that records the reports: it builds the new
# version's images while the server runs, and a version that doesn't build is called off with
# nothing stopped; it backs the server up next, and an update whose backup fails installs nothing; it moves the checkout's local branch for the
# channel forward to the channel's newest commit (so a later `git pull` works) and runs that
# commit's installer, the backup having left the server stopped; after a failed install it goes
# back to the commit it was on and restores the backup from before the update (which installs
# that commit again), and says so, and if that restore fails it stops the server rather than run
# the older code on the newer data, and says so; it keeps only its newest backups, in a
# directory of its own, never one the operator put beside them; it leaves a checkout that's up to
# date, ahead of the channel (saying which channel it's on, after a check, an update, or an hourly
# look), diverged from it, or has local changes where it is; each step
# reaches the admins as a report; and the release notes an update adds reach them too, before
# it installs and once it has.
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
echo install >>"$UPDATER_TEST_LOG.sequence"
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
# From c2 on, a stub image build: it records how it was run and from which commit, and leaves a
# `prebuild` image for the stub docker to list (failing while $UPDATER_TEST_LOG.build-fails exists).
cat >"$work/source/deploy/install/build-images.sh" <<'EOF'
#!/bin/sh
root=$(cd "$(dirname "$0")/../.." && pwd)
echo "build $* at $(git -C "$root" rev-parse HEAD)" >>"$UPDATER_TEST_LOG.builds"
echo build >>"$UPDATER_TEST_LOG.sequence"
if [ -e "$UPDATER_TEST_LOG.build-fails" ]; then printf '\033[31merror:\033[0m The web image broke.\n' >&2; exit 1; fi
touch "$REPORT_LOG.prebuilt"
EOF
chmod +x "$work/source/deploy/install/build-images.sh"
# Its note: a line that isn't one is left out, and a tab in a line's text is dropped.
mkdir -p "$work/source/release-notes"
printf 'New: Make it\ttwo.\nnot a note\nInternal: Count higher.' >"$work/source/release-notes/two.md"
git_ -C "$work/source" add -A
git_ -C "$work/source" commit -qm 'Make it two'
c2=$(git -C "$work/source" rev-parse HEAD)
git_ init -q --bare "$work/origin.git"
git_ -C "$work/source" push -q "$work/origin.git" main dev

git_ clone -q "$work/origin.git" "$work/checkout"
git_ -C "$work/checkout" checkout -q --detach "$c1"
# An operator's settings that change git grep's output don't change the notes read.
git -C "$work/checkout" config grep.lineNumber true
git -C "$work/checkout" config grep.column true
mkdir -p "$work/checkout/deploy/updater" "$work/checkout/deploy/scripts"
cp "$repo/deploy/updater/updater.sh" "$work/checkout/deploy/updater/"
cp "$repo/deploy/scripts/env.sh" "$work/checkout/deploy/scripts/"
printf 'COMPOSE_PROJECT_NAME=trioditis-test\nUPDATER_SECRET=test-secret\nUPDATE_BACKUP_DIR=%s\nINSTALL_NETWORKS=whatsapp,signal\nDEBIAN_SNAPSHOT=20260101T000000Z\n' "$work/backups" >"$work/checkout/deploy/.env"
# A stub deploy/trioditis: a backup makes a directory with a backup.info (failing while
# $UPDATER_TEST_LOG.backup-fails exists), and a restore records what it restored and, as the
# real one does, runs the installer (failing first while $UPDATER_TEST_LOG.restore-fails exists).
cat >"$work/checkout/deploy/trioditis" <<'EOF'
#!/bin/sh
root=$(cd "$(dirname "$0")/.." && pwd)
lock=no
if [ -e /dev/fd/9 ] && [ /dev/fd/9 -ef "$root/deploy/.operation.lock" ]; then lock=held; fi
case "$1" in
  stop | start)
    echo "$1 lock=$lock" >>"$UPDATER_TEST_LOG.server"
    [ "$1" != start ] || [ ! -e "$UPDATER_TEST_LOG.start-fails" ]
    ;;
  backup)
    kept=started
    [ "$2" != --keep-stopped ] || { kept=stopped; shift; }
    echo "backup $2 $kept lock=$lock" >>"$UPDATER_TEST_LOG.backups"
    echo backup >>"$UPDATER_TEST_LOG.sequence"
    [ ! -e "$UPDATER_TEST_LOG.backup-fails" ] || { echo "The disk is full." >&2; echo "The backup failed." >&2; exit 1; }
    n=$(cat "$UPDATER_TEST_LOG.n" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" >"$UPDATER_TEST_LOG.n"
    dir="$2/trioditis-test-2026010$n-000000"
    mkdir -p "$dir" && echo format=2 >"$dir/backup.info"
    echo "Backed up project trioditis-test to $dir (archive.enc, and the settings in secrets.env.enc), encrypted with BACKUP_KEY."
    ;;
  restore)
    shift
    echo "restore $* at $(git -C "$root" rev-parse HEAD) lock=$lock" >>"$UPDATER_TEST_LOG.restores"
    [ ! -e "$UPDATER_TEST_LOG.restore-fails" ] || { echo "The backup is from another version." >&2; exit 1; }
    "$root/deploy/install/install.sh" --no-setup-link
    ;;
esac
EOF
chmod +x "$work/checkout/deploy/trioditis"
# The installer's files that aren't in git stay out of it, as in a real install.
printf 'deploy/.env\ndeploy/updater/\ndeploy/scripts/\ndeploy/trioditis\ndeploy/.operation.lock\ndeploy/.updater-state\n' >>"$work/checkout/.git/info/exclude"

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
    # Admins turned automatic updates off after the updater began one.
    [ "${UPDATER_CLAIM_AUTO:-0}" != 1 ] || [ ! -e "$REPORT_LOG.manual" ] || exit 1
    # The backend out of reach, for one test; or only once the request is claimed, for another.
    [ ! -e "$REPORT_LOG.down" ] || exit 1
    [ ! -e "$REPORT_LOG.down-after-claim" ] || [ -n "${UPDATER_CLAIM:-}" ] || exit 1
    echo "$UPDATER_STATE|$UPDATER_MESSAGE|$UPDATER_DONE|$UPDATER_CURRENT|$UPDATER_LATEST|$UPDATER_BEHIND|$UPDATER_AHEAD|$UPDATER_SECRET" >>"$REPORT_LOG"
    if [ -n "${UPDATER_INSTALLED_TO:-}" ]; then
      printf '%s %s\n%s\n' "$UPDATER_INSTALLED_FROM" "$UPDATER_INSTALLED_TO" "$UPDATER_INSTALLED_NOTES" >>"$REPORT_LOG.installed"
    fi ;;
  # What's running, after the updater stopped the server: nothing, unless a test says a container
  # is still up.
  ' ps '*) [ ! -e "$REPORT_LOG.still-running" ] || echo abc123 ;;
  # The images the build beforehand tagged, and their removal.
  ' image ls '*) [ ! -e "$REPORT_LOG.prebuilt" ] || echo trioditis-test/node:prebuild ;;
  ' image rm '*) echo "drop $3" >>"$UPDATER_TEST_LOG.sequence" && rm -f "$REPORT_LOG.prebuilt" ;;
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
  : >"$work/reports.installed"
  : >"$work/installs.backups"
  : >"$work/installs.server"
  : >"$work/installs.restores"
  : >"$work/installs.builds"
  : >"$work/installs.sequence"
  mkdir -p "$work/tmp"
  TMPDIR=$work/tmp bash -c '. "$1/deploy/updater/updater.sh"; init || exit 9; BACKOFF_SECONDS=0; done_id=${TEST_REQUEST:-req1}; shift; "$@" 2>/dev/null; echo "$outcome_state|$outcome_message"' \
    updater "$work/checkout" "$@" >"$work/out" 2>&1 || true
}
head_is() { [ "$(git -C "$work/checkout" rev-parse HEAD)" = "$1" ]; }

run update stable
head_is "$c1" && grep -q '^idle|Already up to date' "$work/out" && [ ! -s "$work/installs" ] &&
  check ok "up to date with stable: nothing installs" || check fail "up to date with stable: nothing installs ($(cat "$work/out"))"

# A version whose images don't build: called off before the backup, with the server running.
touch "$work/installs.build-fails"
run update nightly
rm -f "$work/installs.build-fails"
head_is "$c1" && [ ! -s "$work/installs" ] && [ ! -s "$work/installs.backups" ] && [ ! -s "$work/installs.server" ] &&
  grep -q "^failed|${c2%"${c2#???????}"} didn't build, so the server kept running and nothing was installed: The web image broke.$" "$work/out" &&
  grep -q "^failed|${c2%"${c2#???????}"} didn't build.*|req1|" "$work/reports" &&
  grep -qx 'pending_target=' "$work/checkout/deploy/.updater-state" && grep -qx 'failed_target=' "$work/checkout/deploy/.updater-state" &&
  grep -qx 'done_request=' "$work/checkout/deploy/.updater-state" && [ -z "$(ls -A "$work/tmp")" ] &&
  check ok "a version that doesn't build is called off before the backup, the server left running, and says why" ||
  check fail "a version that doesn't build is called off before the backup, the server left running, and says why ($(cat "$work/out" "$work/installs.sequence"))"

# The same, with the backend out of reach for its report: the request stays over, kept until
# the report gets through, rather than claimed again.
touch "$work/installs.build-fails"
: >"$work/reports.down-after-claim"
run update nightly
rm -f "$work/installs.build-fails" "$work/reports.down-after-claim"
grep -qx 'done_request=req1' "$work/checkout/deploy/.updater-state" && grep -qx 'done_result=unbuilt' "$work/checkout/deploy/.updater-state" &&
  grep -qx 'pending_target=' "$work/checkout/deploy/.updater-state" &&
  check ok "a build that failed, its report not through, is kept as over until the backend has it" ||
  check fail "a build that failed, its report not through, is kept as over until the backend has it ($(cat "$work/checkout/deploy/.updater-state"))"
run report_done
grep -q "^failed|${c2%"${c2#???????}"} didn't build, so the server kept running and nothing was installed.|req1|" "$work/reports" &&
  grep -qx 'done_request=' "$work/checkout/deploy/.updater-state" && [ ! -s "$work/installs.builds" ] &&
  check ok "and is reported once it can be, building nothing again" ||
  check fail "and is reported once it can be, building nothing again ($(cat "$work/reports"))"

# A backup that fails: nothing installs.
touch "$work/installs.backup-fails"
run update nightly
rm -f "$work/installs.backup-fails"
head_is "$c1" && [ ! -s "$work/installs" ] && grep -q "^failed|Couldn't back up the server before updating, so nothing was installed: The disk is full." "$work/out" &&
  check ok "an update whose backup fails installs nothing, and says why" ||
  check fail "an update whose backup fails installs nothing, and says why ($(cat "$work/out"))"

run update nightly
head_is "$c2" && [ "$(cat "$work/installs")" = "installed $c2" ] &&
  grep -q "^updating|Installing ${c2%"${c2#???????}"}.||" "$work/reports" &&
  grep -q "^idle|Updated to ${c2%"${c2#???????}"}.|req1|$c2|$c2|0|0|test-secret" "$work/reports" &&
  check ok "nightly moves it to dev's newest commit, installs it, and reports it done" ||
  check fail "nightly moves it to dev's newest commit, installs it, and reports it done ($(cat "$work/out" "$work/reports"))"
[ "$(cat "$work/reports.installed")" = "$(printf '%s %s\nNew\tMake ittwo.\nInternal\tCount higher.' "$c1" "$c2")" ] &&
  check ok "the report that ends an update carries the notes it added" ||
  check fail "the report that ends an update carries the notes it added ($(cat "$work/reports.installed"))"
[ "$(cat "$work/installs.how")" = "--no-setup-link lock=held" ] &&
  check ok "the installer runs holding the updater's lock, and prints no setup link" ||
  check fail "the installer runs holding the updater's lock, and prints no setup link ($(cat "$work/installs.how"))"
[ "$(cat "$work/installs.builds")" = "build --project trioditis-test --tag prebuild --version $c2 --debian-snapshot 20260101T000000Z --with-signal at $c2" ] &&
  check ok "it builds the new version's images first, with that version's build and the install's settings" ||
  check fail "it builds the new version's images first, with that version's build and the install's settings ($(cat "$work/installs.builds"))"
[ "$(cat "$work/installs.sequence" | tr '\n' ' ')" = "build backup install drop trioditis-test/node:prebuild " ] &&
  [ -z "$(ls -A "$work/tmp")" ] &&
  check ok "then backs up and installs, and only then drops the images it built and its checkout" ||
  check fail "then backs up and installs, and only then drops the images it built and its checkout ($(cat "$work/installs.sequence"))"
[ "$(cat "$work/installs.backups")" = "backup $work/backups/updater-backups stopped lock=held" ] &&
  check ok "it backs the server up first, holding the lock, and leaves it stopped for the install" ||
  check fail "it backs the server up first, holding the lock ($(cat "$work/installs.backups"))"
[ "$(git -C "$work/checkout" symbolic-ref --short HEAD)" = dev ] &&
  [ "$(git -C "$work/checkout" rev-parse --abbrev-ref dev@{upstream})" = origin/dev ] &&
  check ok "the checkout is on its dev branch, following origin's, so git pull works" ||
  check fail "the checkout is on its dev branch, following origin's, so git pull works"

# A commit whose installer fails.
git_ -C "$work/source" checkout -q dev
touch "$work/source/deploy/install/FAIL"
echo 'Fixed: Break the build.' >"$work/source/release-notes/three.md"
# Renaming a note the server has (c2's) doesn't make it new.
git_ -C "$work/source" mv release-notes/two.md release-notes/two-renamed.md
git_ -C "$work/source" add -A
git_ -C "$work/source" commit -qm 'Break the build'
c3=$(git -C "$work/source" rev-parse HEAD)
git_ -C "$work/source" push -q "$work/origin.git" dev
run update nightly
backup=$(find "$work/backups/updater-backups" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)
head_is "$c2" && [ "$(cat "$work/installs")" = "$(printf 'installed %s\ninstalled %s' "$c3" "$c2")" ] &&
  grep -q "^failed|The update to ${c3%"${c3#???????}"} failed: The build broke. The server is back on ${c2%"${c2#???????}"}.$" "$work/out" &&
  [ "$(cat "$work/installs.restores")" = "restore --yes --recovery-dir $work/backups/updater-backups $backup at $c2 lock=held" ] &&
  check ok "a failed install goes back to the commit it was on, restores the backup from before, and says why" ||
  check fail "a failed install goes back to the commit it was on, restores the backup from before, and says why ($(cat "$work/out" "$work/installs" "$work/installs.restores"))"
state=$work/checkout/deploy/.updater-state
grep -qx "failed_target=$c3" "$state" && grep -qx 'pending_target=' "$state" &&
  check ok "the failed commit outlasts a restart, and nothing is left pending" ||
  check fail "the failed commit outlasts a restart, and nothing is left pending ($(cat "$state"))"

# A restore that can't be done: the older code never runs on the data the failed version may
# have changed; the server is stopped, and the report says so.
git_ -C "$work/checkout" checkout -q "$c2"
rm -f "$state"
# A backup of the operator's own beside the updater's, which it never removes.
mkdir -p "$work/backups/trioditis-test-20250101-000000" && echo format=2 >"$work/backups/trioditis-test-20250101-000000/backup.info"
touch "$work/installs.restore-fails"
run update nightly
rm -f "$work/installs.restore-fails"
head_is "$c2" && [ "$(cat "$work/installs")" = "installed $c3" ] && grep -qx 'stop lock=held' "$work/installs.server" &&
  grep -q "^failed|The update to .* failed: The build broke. Going back to ${c2%"${c2#???????}"} failed too: restoring its backup failed (The backup is from another version.), so the server is stopped" "$work/out" &&
  check ok "when the backup can't be restored, it stops the server rather than run the older code, and says so" ||
  check fail "when the backup can't be restored, it stops the server rather than run the older code, and says so ($(cat "$work/out" "$work/installs" "$work/installs.server"))"
[ "$(find "$work/backups/updater-backups" -mindepth 1 -maxdepth 1 -type d | wc -l)" = 3 ] &&
  [ -d "$work/backups/trioditis-test-20250101-000000" ] &&
  check ok "it keeps only its three newest backups, in its own directory" ||
  check fail "it keeps only its three newest backups, in its own directory ($(ls -R "$work/backups"))"

# Going back fails and the server can't be confirmed stopped (a container still running): the
# update stays in progress, as going back, for the next start to try again.
git_ -C "$work/checkout" checkout -q "$c2"
rm -f "$state"
touch "$work/installs.restore-fails" "$work/reports.still-running"
run update nightly
rm -f "$work/installs.restore-fails" "$work/reports.still-running"
grep -qx 'pending_phase=rollback' "$state" && grep -qx "pending_target=$c3" "$state" && grep -qx 'done_result=' "$state" &&
  grep -q "^updating|Going back to .*couldn't be confirmed stopped" "$work/reports" &&
  check ok "a server that can't be confirmed stopped keeps the update in progress, reported as updating, to try again" ||
  check fail "a server that can't be confirmed stopped keeps the update in progress, to try again ($(cat "$state" "$work/reports"))"
rm -f "$state"

# Cut off while backing up, and the server won't start again: the backup phase is kept, still
# reported as updating, for the next start to try again.
git_ -C "$work/checkout" checkout -q --detach "$c2"
printf 'pending_target=%s\npending_previous=%s\npending_request=req4\npending_phase=backup\n' "$c3" "$c2" >"$state"
touch "$work/installs.start-fails"
run recover
rm -f "$work/installs.start-fails"
grep -qx 'pending_phase=backup' "$state" && grep -qx "pending_target=$c3" "$state" && ! grep -q '^done_result=.' "$state" &&
  grep -q "^updating|Starting the server again" "$work/reports" && grep -qx 'start lock=held' "$work/installs.server" &&
  check ok "when the server won't start after a cut-off backup, the backup phase is kept, reported as updating" ||
  check fail "when the server won't start after a cut-off backup, the backup phase is kept, reported as updating ($(cat "$state" "$work/reports"))"

# Cut off while backing up (the server may be stopped, nothing installed): the next start starts
# it again, reports the request done, and doesn't count the target as failed.
git_ -C "$work/checkout" checkout -q --detach "$c2"
printf 'pending_target=%s\npending_previous=%s\npending_request=req5\npending_phase=backup\n' "$c3" "$c2" >"$state"
run recover
head_is "$c2" && [ ! -s "$work/installs" ] && grep -qx 'start lock=held' "$work/installs.server" &&
  grep -q "^failed|The update to ${c3%"${c3#???????}"} was cut off before anything was installed.*|req5|" "$work/reports" &&
  grep -qx 'pending_target=' "$state" && grep -qx 'failed_target=' "$state" &&
  check ok "an update cut off while backing up starts the server again, installing nothing" ||
  check fail "an update cut off while backing up starts the server again, installing nothing ($(cat "$work/reports" "$work/installs.server" "$state"))"
rm -f "$state"

# Cut off while building (nothing stopped or installed): the next start drops what it built,
# starts nothing, and reports the request done without counting the target as failed.
git_ -C "$work/checkout" checkout -q --detach "$c2"
printf 'pending_target=%s\npending_previous=%s\npending_request=req11\npending_phase=build\n' "$c3" "$c2" >"$state"
touch "$work/reports.prebuilt"
run recover
head_is "$c2" && [ ! -s "$work/installs" ] && [ ! -s "$work/installs.server" ] &&
  grep -qx 'drop trioditis-test/node:prebuild' "$work/installs.sequence" &&
  grep -q "^failed|The update to ${c3%"${c3#???????}"} was cut off before anything was installed.*|req11|" "$work/reports" &&
  grep -qx 'pending_target=' "$state" && grep -qx 'failed_target=' "$state" &&
  check ok "an update cut off while building starts nothing, drops what it built, and reports the request done" ||
  check fail "an update cut off while building starts nothing, drops what it built, and reports the request done ($(cat "$work/reports" "$work/installs.server" "$state"))"
rm -f "$state"

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
touch "$work/reports.manual"
run update nightly 1
rm -f "$work/reports.manual"
head_is "$c1" && grep -q "^idle|The update didn't start" "$work/out" && [ ! -s "$work/installs" ] &&
  check ok "an automatic update admins have since turned off installs nothing" ||
  check fail "an automatic update admins have since turned off installs nothing ($(cat "$work/out"))"
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

# Cut off with its backup taken: going back restores it, on the branch it was moving.
git_ -C "$work/checkout" checkout -q --detach "$c2"
saved="$work/backups/updater-backups/trioditis-test-20260109-000000"
mkdir -p "$saved" && echo format=2 >"$saved/backup.info"
printf 'pending_target=%s\npending_previous=%s\npending_request=req6\npending_phase=install\npending_branch=dev\npending_backup=%s\n' "$c2" "$c1" "$saved" >"$state"
run recover
head_is "$c1" && [ "$(git -C "$work/checkout" symbolic-ref --short HEAD)" = dev ] &&
  [ "$(cat "$work/installs.restores")" = "restore --yes --recovery-dir $work/backups/updater-backups $saved at $c1 lock=held" ] &&
  grep -qx 'pending_backup=' "$state" &&
  check ok "an update cut off after its backup goes back by restoring it" ||
  check fail "an update cut off after its backup goes back by restoring it ($(cat "$work/out" "$work/installs.restores" "$state"))"
git_ -C "$work/checkout" checkout -q --detach "$c1"

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

# Ahead of stable (main is at c1), from dev: nothing to install, and it says to choose Nightly.
run update stable
head_is "$c2" && grep -q "^idle|This server runs a newer version than Stable (main), from Nightly (dev). Choose Nightly" "$work/out" &&
  [ ! -s "$work/installs" ] && check ok "ahead of the channel, from the other one: it stays, and names the other" ||
  check fail "ahead of the channel, from the other one: it stays, and names the other ($(cat "$work/out"))"
run handle 'stable 0 - check'
grep -q "^idle|This server runs a newer version than Stable (main), from Nightly (dev)" "$work/reports" &&
  check ok "a check says so too" || check fail "a check says so too ($(cat "$work/reports"))"
run handle 'stable 0 - -'
grep -q "^idle|This server runs a newer version than Stable (main), from Nightly (dev)" "$work/reports" &&
  check ok "and so does the hourly look, with no one asking" || check fail "and so does the hourly look, with no one asking ($(cat "$work/reports"))"

# Diverged: main gets a commit dev doesn't have.
git_ -C "$work/source" checkout -q main
echo hotfix >"$work/source/other"
git_ -C "$work/source" add -A
git_ -C "$work/source" commit -qm 'Hotfix'
git_ -C "$work/source" push -q "$work/origin.git" main
run update stable
head_is "$c2" && grep -q "^idle|This server runs commits Stable (main) doesn't have, from Nightly (dev)" "$work/out" && [ ! -s "$work/installs" ] &&
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

# The notes on offer: those the channel's commit adds, the newest first; none once there.
bash -c '. "$1/deploy/updater/updater.sh"; init; check_latest nightly; printf "%s" "$latest_notes"' updater "$work/checkout" >"$work/out" 2>&1 || true
[ "$(cat "$work/out")" = "$(printf 'Fixed\tBreak the build.\nNew\tMake ittwo.\nInternal\tCount higher.')" ] &&
  check ok "an update on offer carries the notes it adds, the newest first" ||
  check fail "an update on offer carries the notes it adds, the newest first ($(cat "$work/out"))"
git_ -C "$work/checkout" checkout -q --detach "$c2"
bash -c '. "$1/deploy/updater/updater.sh"; init; check_latest nightly; printf "%s" "$latest_notes"' updater "$work/checkout" >"$work/out" 2>&1 || true
[ "$(cat "$work/out")" = "$(printf 'Fixed\tBreak the build.')" ] &&
  check ok "a note the server has, renamed since, isn't new" ||
  check fail "a note the server has, renamed since, isn't new ($(cat "$work/out"))"
git_ -C "$work/checkout" checkout -q --detach "$c3"
bash -c '. "$1/deploy/updater/updater.sh"; init; check_latest nightly; printf "%s|%s" "$behind" "$latest_notes"' updater "$work/checkout" >"$work/out" 2>&1 || true
[ "$(cat "$work/out")" = "0|" ] && check ok "and none once the server is there" ||
  check fail "and none once the server is there ($(cat "$work/out"))"

if [ "$failures" -gt 0 ]; then
  echo "$test_name: $failures failed" >&2
  exit 1
fi
echo "$test_name: all passed"
