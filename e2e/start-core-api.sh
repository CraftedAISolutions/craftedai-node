#!/usr/bin/env bash
# Starts core-api (postgres, redis, api, worker) from a core-api checkout for the e2e.
# Usage: e2e/start-core-api.sh <path-to-core-api-checkout>
set -euo pipefail
CORE_API_DIR="$(cd "$1" && pwd)"
OVERLAY="$(cd "$(dirname "$0")" && pwd)/docker-compose.e2e.yml"
compose() { docker compose -f "$CORE_API_DIR/docker-compose.yml" -f "$OVERLAY" --project-directory "$CORE_API_DIR" "$@"; }

# A throwaway Ed25519 key ring for this run only (core-api Task 3 generator).
export EMBED_SIGNING_KEYS='[]' # placeholder so compose can parse the overlay while building
compose build api
ENTRY="$(compose run --rm --no-deps -T api npm run -s signing-key:generate 2>/dev/null)"
EMBED_SIGNING_KEYS="[$(echo "$ENTRY" | jq -c '.status = "current"')]"
export EMBED_SIGNING_KEYS
# Keep the private key out of any CI log line (no-op outside GitHub Actions).
echo "::add-mask::$(echo "$ENTRY" | jq -r '.privateJwk.d')"
echo "EMBED_SIGNING_KEYS=$EMBED_SIGNING_KEYS" >> "${GITHUB_ENV:-/dev/null}"

compose up -d --wait postgres redis
compose up -d api worker
for _ in $(seq 1 60); do
  curl -fsS http://localhost:3000/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://localhost:3000/health
compose exec -T api npm run migration:run
compose exec -T api npm run seed:catalog
curl -fsS http://localhost:3000/.well-known/jwks.json | jq -e '.keys | length == 1'
