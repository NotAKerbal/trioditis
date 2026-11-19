#!/bin/sh
# deploy/trioditis hands Compose deploy/.env's values only: with a secret, the project, the
# compose file list and any other COMPOSE_* setting exported to something else, Compose still
# sees the install's own, including a saved list of several compose files.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "deploy/.env is the only source"

config=$(TRIODITIS_SETUP_TOKEN=exported COMPOSE_PROJECT_NAME=exported COMPOSE_FILE=exported.yml \
  POSTGRES_PASSWORD=exported trioditis config 2>&1) || true
echo "$config" | grep -q "^name: $project$" && check ok "the project is the saved one" || check fail "the project is the saved one"
echo "$config" | grep -q 'TRIODITIS_SETUP_TOKEN: test-setup-token' && check ok "the setup token is the saved one" ||
  check fail "the setup token is the saved one"
echo "$config" | grep -q 'POSTGRES_PASSWORD: test-POSTGRES_PASSWORD' && check ok "the database password is the saved one" ||
  check fail "the database password is the saved one"
echo "$config" | grep -q exported && check fail "no exported value reaches Compose" || check ok "no exported value reaches Compose"

# Several compose files saved, ':'-separated as the installer writes them; an exported
# separator (or profile list) mustn't change how they're read.
sed -i 's/^COMPOSE_FILE=.*/COMPOSE_FILE=compose.yml:compose.e2e.yml/' "$root/deploy/.env"
services=$(COMPOSE_PATH_SEPARATOR=, COMPOSE_PROFILES=whatsapp COMPOSE_ENV_FILES=exported.env trioditis config --services 2>&1) || true
echo "$services" | grep -qx fake-control && echo "$services" | grep -qx bridge-fake &&
  check ok "exported COMPOSE_* settings are ignored, and the saved compose files all load" ||
  { check fail "exported COMPOSE_* settings are ignored, and the saved compose files all load"; echo "$services" >&2; }

finish
