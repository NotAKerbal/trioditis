#!/bin/sh
# Installs or removes the updater's systemd service for this install (install.sh --updater
# and --no-updater). One service per install, named for its Compose project:
# trioditis-updater-<project>. As root it's a system service; otherwise a user service of the
# operator, which runs while they're logged out only with lingering on (loginctl enable-linger).
#
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
  '' | *[!a-z0-9_-]*) echo "usage: service.sh install|remove <project>" >&2; exit 2 ;;
esac
unit="trioditis-updater-$project.service"
root=$(cd "$here/.." && pwd)
# The checkout's path goes into the unit as is, where systemd would read quotes, spaces, \ or
# % (its specifiers) as more than characters.
case "$root" in
  *[!A-Za-z0-9._/-]*) echo "The updater needs the checkout at a path of only A-Z a-z 0-9 . _ / -, not $root." >&2; exit 1 ;;
esac
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

case "$command" in
  install)
    [ "$has_systemctl" = 1 ] || { echo "The updater runs as a systemd service, and this machine has no systemctl." >&2; exit 1; }
    mkdir -p "$dir"
    tmp=$(mktemp "$dir/.$unit.XXXXXX")
    cat >"$tmp" <<EOF
# Written by deploy/install/install.sh --updater; removed by --no-updater. See docs/deploy.md, Updates.
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
  *) echo "usage: service.sh install|remove <project>" >&2; exit 2 ;;
esac
