#!/usr/bin/env bash
# Builds the bundle's images from this checkout: the Node image, the bridge hosts', the sign-in
# browser's and the web app's (Caddy's), tagged <project>/<name>:<tag>.
#
#   deploy/install/build-images.sh --project <name> --tag <tag> --version <commit>
#                                  [--with-signal] [--debian-snapshot <day>]
#
# The installer runs it with --tag local, the tags compose.yml runs. The updater runs a new
# version's copy of it, from a checkout of that version beside the install, with another tag,
# while the server keeps running: the installer's build of the same images afterwards finds
# every step in Docker's build cache, so the server is stopped for far less time.
#
# compose.yml's `build:` sections say the same as this (Dockerfile, context, arguments); a
# service with an image of its own goes in both.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
here=$root/deploy

die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

unset -v project tag version
with_signal=0
debian_snapshot=''
while [ $# -gt 0 ]; do
  case "$1" in
    --project | --tag | --version | --debian-snapshot) [ $# -ge 2 ] || die "$1 needs a value." ;;
  esac
  case "$1" in
    --project) project=$2; shift ;;
    --tag) tag=$2; shift ;;
    --version) version=$2; shift ;;
    --with-signal) with_signal=1 ;;
    --debian-snapshot) debian_snapshot=$2; shift ;;
    *) die "Unknown option: $1" ;;
  esac
  shift
done
[ -n "${project:-}" ] && [ -n "${tag:-}" ] && [ -n "${version:-}" ] ||
  die "Usage: build-images.sh --project <name> --tag <tag> --version <commit> [--with-signal] [--debian-snapshot <day>]"

# Without the build attestations BuildKit adds by default (their timestamps give every build a
# new image ID), an unchanged image keeps its ID, so Compose leaves its containers running
# instead of recreating them, and everything that waits for them, on every run.
export BUILDX_NO_DEFAULT_ATTESTATIONS=1

# build NAME DOCKERFILE [--build-arg ...]: one image, from the whole checkout (.dockerignore
# keeps out everything but sources).
build() {
  local name=$1 dockerfile=$2
  shift 2
  docker build -q "$@" -f "$here/docker/$dockerfile" -t "$project/$name:$tag" "$root" >/dev/null ||
    die "Couldn't build the $name image ($dockerfile)."
}

# The Node image first: the installer generates the key pairs with it.
build node node.Dockerfile
# Every bridge host runs this one image. Signal's library (Rust) is only built when Signal is
# bridged: it adds a long first build. DEBIAN_SNAPSHOT, if the operator set one, pins the Debian
# packages to that day (docs/deploy.md, Building the same images again).
build bridge-host bridge-host.Dockerfile --build-arg "WITH_SIGNAL=$with_signal" --build-arg "DEBIAN_SNAPSHOT=$debian_snapshot"
build login-browser login-browser.Dockerfile --build-arg "DEBIAN_SNAPSHOT=$debian_snapshot"
# The commit the web app is built from, which it compares with the server's to see an update.
build web web.Dockerfile --build-arg "TRIODITIS_VERSION=$version"
