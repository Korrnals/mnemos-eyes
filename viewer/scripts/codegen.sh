#!/usr/bin/env bash
# Regenerate src/types/openapi.d.ts from the mnemos OpenAPI schema
# (architecture.md §8).
#
# Flow: GET ${MNEMOS_URL}/openapi.json -> openapi-snapshot.json (normalized
# and committed, so builds are reproducible without a live server) ->
# openapi-typescript generates src/types/openapi.d.ts FROM the snapshot.
# Generating from the snapshot (never straight from the URL) keeps the
# committed types byte-deterministic for a given schema.
#
# Usage:
#   npm run codegen            # fetch live schema, refresh snapshot, generate
#   MNEMOS_URL=http://host:port npm run codegen
#   npm run codegen:offline    # regenerate from the committed snapshot only
set -euo pipefail

MNEMOS_URL="${MNEMOS_URL:-http://127.0.0.1:8787}"
SNAPSHOT="openapi-snapshot.json"
OUT="src/types/openapi.d.ts"

from_snapshot=false
for arg in "$@"; do
  case "$arg" in
    --from-snapshot) from_snapshot=true ;;
    *)
      echo "codegen: unknown flag: $arg (supported: --from-snapshot)" >&2
      exit 2
      ;;
  esac
done

if [[ "$from_snapshot" == false ]]; then
  echo "codegen: fetching ${MNEMOS_URL}/openapi.json"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  curl --fail --silent --show-error "${MNEMOS_URL}/openapi.json" -o "$tmp"
  # Normalize whitespace so the committed snapshot is byte-deterministic.
  node -e '
    const fs = require("fs");
    const schema = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(process.argv[2], JSON.stringify(schema) + "\n");
  ' "$tmp" "$SNAPSHOT"
  echo "codegen: snapshot updated: ${SNAPSHOT} ($(wc -c < "$SNAPSHOT") bytes)"
else
  if [[ ! -f "$SNAPSHOT" ]]; then
    echo "codegen: ${SNAPSHOT} not found — run 'npm run codegen' against a live mnemos first." >&2
    exit 1
  fi
  echo "codegen: regenerating from existing snapshot ${SNAPSHOT}"
fi

npx openapi-typescript "$SNAPSHOT" --output "$OUT" --immutable
echo "codegen: wrote ${OUT} ($(wc -l < "$OUT") lines). Review the diff — the file is committed and CI guards schema drift."
