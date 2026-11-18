#!/bin/sh
# Deploys packages/backend's Convex functions to the bundle's backend and sets the
# deployment's environment. Run by the `functions` service on every `up`, so an upgrade
# that brings new functions applies them.
set -eu
cd /repo/packages/backend

for name in CONVEX_SELF_HOSTED_URL CONVEX_SELF_HOSTED_ADMIN_KEY; do
  if [ -z "$(printenv "$name" || true)" ]; then
    echo "deploy-functions: $name is not set (install.sh generates the admin key)" >&2
    exit 1
  fi
done

# What the functions read. Private keys and the admin key stay out: no function needs them.
for name in SITE_URL BETTER_AUTH_SECRET GATEWAY_SECRET TRIODITIS_SETUP_TOKEN TRIODITIS_NETWORKS \
  BRIDGE_PUBLIC_KEY AGENT_ACCESS_PUBLIC_KEY; do
  value=$(printenv "$name" || true)
  if [ -z "$value" ]; then
    echo "deploy-functions: $name is not set" >&2
    exit 1
  fi
  npx convex env set "$name" "$value" >/dev/null
done
echo "deploy-functions: environment set"

# Types and lint ran in CI; the bundle only ships what they checked.
npx convex deploy --typecheck disable --codegen disable
echo "deploy-functions: functions deployed"
