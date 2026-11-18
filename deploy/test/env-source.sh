#!/bin/sh
# deploy/trioditis hands Compose deploy/.env's values only: with a secret, the project and the
# compose file list exported to something else, Compose still sees the install's own.
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

finish
