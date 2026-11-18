#!/bin/sh
# Runs every deploy/test script and says which failed. See docs/deploy.md, Testing the bundle.
# Each makes and removes its own throwaway project; none touches an install.
cd "$(dirname "$0")" || exit 1
failed=''
for test in restore-failure.sh restore-interrupt.sh restore-archive.sh backup-publish.sh keys.sh lock.sh env-source.sh caddy-headers.sh ports.sh install-settings.sh; do
  sh "./$test" || failed="$failed $test"
done
if [ -n "$failed" ]; then
  echo "Failed:$failed" >&2
  exit 1
fi
echo "All deploy tests passed."
