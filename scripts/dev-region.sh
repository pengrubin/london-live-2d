#!/usr/bin/env bash
# Run the stack locally as a given region, then open http://localhost:5173
#
#   scripts/dev-region.sh          # London (the default deployment)
#   scripts/dev-region.sh dubai
#
# Why this exists rather than a line of env vars: config.ts reads process.env
# first but falls back to backend/.env, and an EMPTY process value counts as
# unset — so `TFL_APP_KEY= ` does not hide a key that .env holds. A non-London
# region therefore needs .env moved aside, which is easy to forget and worse to
# forget to undo. The trap below restores it however this script exits.
#
# A region's deployment settings live in scripts/regions/<region>.env, which is
# the same set of variables its Railway service would carry.

set -euo pipefail

REGION="${1:-london}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/backend/.env"
ENV_STASH="$ROOT/backend/.env.dev-region-stash"

cleanup() {
  [ -f "$ENV_STASH" ] && mv -f "$ENV_STASH" "$ENV_FILE"
  kill 0 2>/dev/null || true # stop both servers together
}
trap cleanup EXIT INT TERM

start_frontend() {
  ( cd "$ROOT/frontend" && npm run dev ) &
}

if [ "$REGION" = "london" ]; then
  echo "→ London — backend/.env as-is · http://localhost:5173"
  ( cd "$ROOT/backend" && npm run dev ) &
  start_frontend
  wait
  exit 0
fi

REGION_ENV="$ROOT/scripts/regions/$REGION.env"
[ -f "$REGION_ENV" ] || { echo "No settings at scripts/regions/$REGION.env" >&2; exit 1; }
[ -f "$ROOT/data/$REGION/manifest.json" ] || {
  echo "No baked data at data/$REGION/ — run: node scripts/bake-osm-rail.mjs $REGION" >&2
  exit 1
}

# Carry over only credentials that are global rather than London-specific.
AIS_KEY="$(grep -E '^AIS_API_KEY=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"'\''' || true)"
[ -f "$ENV_FILE" ] && mv "$ENV_FILE" "$ENV_STASH"

echo "→ $REGION — backend/.env stashed, restored on exit · http://localhost:5173"
(
  cd "$ROOT/backend"
  set -a
  # shellcheck disable=SC1090
  . "$REGION_ENV"
  set +a
  env AIS_API_KEY="$AIS_KEY" \
      REGION_DATA_DIR="data/$REGION" \
      REGION_PMTILES_URL="/$REGION.pmtiles" \
      `# deliberately overrides the region file: locally the basemap is served` \
      `# from data/<region>/ so dev does not hammer R2 on every reload` \
      npm run dev
) &
( cd "$ROOT/frontend" && env REGION_DATA_DIR="data/$REGION" npm run dev ) &
wait
