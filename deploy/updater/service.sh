#!/bin/sh
# Installs or removes the updater's systemd service for this install (install.sh, which runs
# it unless --no-updater), or says whether this machine can run it. One service per install,
# named for its Compose project: trioditis-updater-<project>. As root it's a system service;
# otherwise a user service of the operator, which runs while they're logged out only with
# lingering on (loginctl enable-linger).
#
#   deploy/updater/service.sh check <project>      # exits 1, saying why, if it can't run here
#   deploy/updater/service.sh installed <project>  # exits 0 once its unit has been enabled
#   deploy/updater/service.sh install <project>
#   deploy/updater/service.sh remove <project>
#
# `install` writes the unit, enables it and starts it if it isn't running. It never restarts a
# running updater, which may be the one running the installer that called this: the updater
# exits after each update and systemd starts the new one.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
command=${1:-}
project=${2:-}
case "$project" in
  '' | *[!a-z0-9_-]*) echo "usage: service.sh check|installed|install|remove <project>" >&2; exit 2 ;;
esac
unit="trioditis-updater-$project.service"
root=$(cd "$here/.." && pwd)
# Checked before the wrapper below takes the name.
has_systemctl=0
command -v systemctl >/dev/null && has_systemctl=1

if [ "$(id -u)" = 0 ]; then
  dir=/etc/systemd/system
  systemctl() { command systemctl "$@"; }
  wanted_by=multi-user.target
  after='After=docker.service network-online.target
Wants=network-online.target'
else
  dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
  systemctl() { command systemctl --user "$@"; }
  wanted_by=default.target
  after=''
fi

# Why the updater can't run here, or nothing when it can: it needs systemd running (for a
# user service, the operator's own manager, which a shell from sudo or su often can't reach), a
# unit directory it can write, and a git checkout with an origin remote to fetch updates from.
# The checkout's path goes into the unit as is, where systemd would read quotes, spaces, \ or %
# (its specifiers) as more than characters. The checkout must be the top of its own repository:
# git looks upwards, so a copy unpacked inside another repository would otherwise update that one.
blocker() {
  case "$root" in
    *[!A-Za-z0-9._/-]*) echo "it needs the checkout at a path of only A-Z a-z 0-9 . _ / -, not $root"; return ;;
  esac
  # The unit's directory, or the nearest one above it that exists, which mkdir -p starts from.
  probe=$dir
  while [ ! -e "$probe" ] && [ ! -L "$probe" ]; do probe=$(dirname "$probe"); done
  if [ "$has_systemctl" = 0 ]; then
    echo "it runs as a systemd service, and this machine has no systemctl"
  elif [ "$(id -u)" = 0 ] && [ ! -d /run/systemd/system ]; then
    echo "it runs as a systemd service, and systemd isn't running here"
  elif [ "$(id -u)" != 0 ] && ! systemctl show-environment >/dev/null 2>&1; then
    echo "it runs as a user service, and this shell can't reach $(id -un)'s systemd user manager (log in as $(id -un) directly, not through sudo or su)"
  elif [ ! -d "$probe" ] || [ ! -w "$probe" ] || [ ! -x "$probe" ]; then
    echo "it writes its unit into $dir, and $probe isn't a directory this user can write to"
  elif ! top=$(git -C "$root" rev-parse --show-toplevel 2>/dev/null) || [ ! "$top" -ef "$root" ] ||
    ! git -C "$root" rev-parse --verify --quiet 'HEAD^{commit}' >/dev/null 2>&1; then
    echo "it updates a git checkout, and $root isn't one of its own"
  elif ! git -C "$root" remote get-url origin >/dev/null 2>&1; then
    echo "it fetches updates from the checkout's origin remote, and $root has none"
  fi
}

case "$command" in
  check)
    reason=$(blocker)
    [ -z "$reason" ] || { echo "$reason" >&2; exit 1; }
    ;;
  install)
    reason=$(blocker)
    [ -z "$reason" ] || { echo "The updater can't run here: $reason." >&2; exit 1; }
    mkdir -p "$dir"
    tmp=$(mktemp "$dir/.$unit.XXXXXX")
    cat >"$tmp" <<EOF
# Written by deploy/install/install.sh; removed by --no-updater. See docs/deploy.md, Updates.
[Unit]
Description=Trioditis updater ($project, $root)
$after

[Service]
Type=simple
ExecStart=/usr/bin/env bash $root/deploy/updater/updater.sh
Restart=always
RestartSec=10

[Install]
WantedBy=$wanted_by
EOF
    chmod 644 "$tmp"
    if cmp -s "$tmp" "$dir/$unit"; then rm -f "$tmp"; else mv -f "$tmp" "$dir/$unit"; fi
    systemctl daemon-reload
    systemctl enable --quiet "$unit"
    systemctl is-active --quiet "$unit" || systemctl start "$unit"
    if [ "$(id -u)" != 0 ] && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)" != yes ]; then
      echo "warning: the updater is a user service, so it stops when you log out. Keep it running with: loginctl enable-linger $(id -un)" >&2
    fi
    ;;
  remove)
    [ "$has_systemctl" = 1 ] || exit 0
    [ -f "$dir/$unit" ] || exit 0
    systemctl disable --now --quiet "$unit" || true
    rm -f "$dir/$unit"
    systemctl daemon-reload
    ;;
  # Enabled, not just written: a setup cut off before `enable` leaves the unit file but not the
  # link `enable` makes. Read from the files, since the manager may be what's out of reach.
  installed) [ -f "$dir/$unit" ] && [ -L "$dir/$wanted_by.wants/$unit" ] ;;
  *) echo "usage: service.sh check|installed|install|remove <project>" >&2; exit 2 ;;
esac
