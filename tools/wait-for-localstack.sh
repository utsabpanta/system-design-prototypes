#!/usr/bin/env bash
# Block until LocalStack's edge port answers healthy, so `pnpm run up` is
# safe to chain straight into deploy/seed.
set -euo pipefail

ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"
DEADLINE=$((SECONDS + 120))

printf 'waiting for LocalStack at %s ' "$ENDPOINT"
until curl -sf "$ENDPOINT/_localstack/health" >/dev/null 2>&1; do
  if [ "$SECONDS" -ge "$DEADLINE" ]; then
    echo
    echo "timed out after 120s. Check: docker compose logs localstack"
    exit 1
  fi
  printf '.'
  sleep 2
done
echo ' ready'
