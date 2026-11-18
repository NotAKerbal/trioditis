#!/bin/sh
# Deploys packages/backend's Convex functions to the bundle's backend and sets the
# deployment's environment. Run by the `functions` service on every `up`, so an upgrade
# that brings new functions applies them.
set -eu
cd /repo/packages/backend

# Every Convex CLI command here (env set, deploy, each migration) must reach only the bundle's
# backend. The CLI also reads deployment selectors from the environment and from dotenv files
# each time it starts, so any other CONVEX_* setting is dropped, and a dotenv file (which the
# image never has: see .dockerignore) stops the job rather than being read.
for name in $(env | sed -n 's/^\(CONVEX_[A-Za-z0-9_]*\)=.*/\1/p'); do
  case "$name" in
    CONVEX_SELF_HOSTED_URL | CONVEX_SELF_HOSTED_ADMIN_KEY) ;;
    *) unset "$name" ;;
  esac
done
for file in .env .env.local; do
  if [ -e "$file" ]; then
    echo "deploy-functions: packages/backend/$file is in the image; it could point the Convex CLI elsewhere, so nothing was deployed" >&2
    exit 1
  fi
done

for name in CONVEX_SELF_HOSTED_URL CONVEX_SELF_HOSTED_ADMIN_KEY; do
  if [ -z "$(printenv "$name" || true)" ]; then
    echo "deploy-functions: $name is not set (install.sh generates the admin key)" >&2
    exit 1
  fi
done

# What the functions read. Private keys and the admin key stay out: no function needs them.
names='SITE_URL BETTER_AUTH_SECRET GATEWAY_SECRET TRIODITIS_SETUP_TOKEN TRIODITIS_NETWORKS
  BRIDGE_PUBLIC_KEY AGENT_ACCESS_PUBLIC_KEY'
for name in $names; do
  if [ -z "$(printenv "$name" || true)" ]; then
    echo "deploy-functions: $name is not set" >&2
    exit 1
  fi
done
# Set in one call, as NAME=value lines on stdin, so no value is ever a process argument that
# the process list would show. printf is the shell's own, not a separate process.
for name in $names; do
  printf '%s=%s\n' "$name" "$(printenv "$name")"
done | npx convex env set --force >/dev/null
echo "deploy-functions: environment set"

# Types and lint ran in CI; the bundle only ships what they checked.
npx convex deploy --typecheck disable --codegen disable
echo "deploy-functions: functions deployed"

# Then the migrations, which fix rows an older version wrote, so an upgrade needs nothing run
# by hand. Their one entry point runs them all, every deploy; run-migrations.mjs calls it on
# this backend only, and a failure stops the job and the install.
node /repo/deploy/scripts/run-migrations.mjs
