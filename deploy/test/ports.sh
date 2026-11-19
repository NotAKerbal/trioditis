#!/bin/sh
# Only Caddy is published, in every mode and combination of compose files (and every
# profile): deploy/scripts/check-ports.sh, which the installer runs, passes for each. It
# catches a backend or other service published by mistake. And no sidecar (hairpin,
# loopback, fake-control) forwards to the Convex backend's ports.
# shellcheck disable=SC2015,SC2143 # `cond && check ok || check fail`: check ok always succeeds
# shellcheck source=deploy/test/lib.sh
. "$(dirname "$0")/lib.sh"
make_install "only Caddy is published"
cat >>"$root/deploy/.env" <<'EOF'
HTTP_PORT=18080
HTTP_BIND=127.0.0.1
LOOPBACK_PORT=18080
HAIRPIN_BIND=172.17.0.1
HAIRPIN_PORT=8443
HAIRPIN_TARGET=100.64.0.5
CADDY_SITE_ADDRESS=:80
EOF
check_ports="$repo/deploy/scripts/check-ports.sh"
# Every profile's services, as the installer checks them (deploy/trioditis passes on no
# global options, so this calls Compose as the installer does).
all_profiles_config() {
  (cd "$root/deploy/compose" && docker compose --env-file "$root/deploy/.env" -p "$project" --profile '*' config)
}

# The files install.sh can choose, each with and without --e2e.
for files in compose.yml compose.yml:compose.loopback.yml compose.yml:compose.hostmap.yml \
  compose.yml:compose.hostmap.yml:compose.hairpin.yml compose.yml:compose.domain.yml:compose.hostmap.yml \
  compose.yml:compose.domain.yml:compose.hostmap.yml:compose.ipv6.yml; do
  for e2e in '' :compose.e2e.yml; do
    sed -i "s/^COMPOSE_FILE=.*/COMPOSE_FILE=$files$e2e/" "$root/deploy/.env"
    config=$(all_profiles_config 2>&1) || { check fail "$files$e2e: compose config"; echo "$config" >&2; continue; }
    out=$(echo "$config" | sh "$check_ports") && check ok "$files$e2e publishes only Caddy" ||
      check fail "$files$e2e publishes only Caddy ($out)"
    # The sidecars' commands, and what they forward to.
    sidecars=$(echo "$config" | awk '/^  [^ ]/ { s = $1 } s ~ /^(hairpin|loopback|fake-control):$/' )
    echo "$sidecars" | grep -qE 'backend:321[01]|:321[01]\b' &&
      check fail "$files$e2e: a sidecar forwards to the backend's ports" ||
      check ok "$files$e2e: no sidecar forwards to the backend's ports"
  done
done

# The check itself catches a mistake: the backend, or another service, published.
sed -i "s/^COMPOSE_FILE=.*/COMPOSE_FILE=compose.yml:mistake.yml/" "$root/deploy/.env"
printf 'services:\n  backend:\n    ports:\n      - 127.0.0.1:13210:3210\n' >"$root/deploy/compose/mistake.yml"
out=$(all_profiles_config | sh "$check_ports") && check fail "a published backend is caught" ||
  { echo "$out" | grep -q "backend publishes the Convex port 3210" && check ok "a published backend is caught" || check fail "a published backend is caught ($out)"; }
printf 'services:\n  gateway:\n    ports:\n      - 8601:8601\n' >"$root/deploy/compose/mistake.yml"
out=$(all_profiles_config | sh "$check_ports") && check fail "another published service is caught" ||
  { echo "$out" | grep -q "gateway publishes port 8601" && check ok "another published service is caught" || check fail "another published service is caught ($out)"; }

finish
