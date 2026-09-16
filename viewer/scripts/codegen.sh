#!/usr/bin/env bash
# Regenerate src/types/openapi.d.ts from the live mnemos OpenAPI schema
# (architecture.md §8). Filled in / wired by task T3 — today the command
# below is the intended invocation; the committed openapi.d.ts is a placeholder.
#
# Usage: npm run codegen   (or MNEMOS_URL=http://host:port bash scripts/codegen.sh)
set -euo pipefail

MNEMOS_URL="${MNEMOS_URL:-http://127.0.0.1:8787}"
OUT="src/types/openapi.d.ts"

echo "codegen: fetching ${MNEMOS_URL}/openapi.json -> ${OUT}"
npx openapi-typescript "${MNEMOS_URL}/openapi.json" \
  --output "$OUT" \
  --immutable-types

echo "codegen: done. Review the diff — the file is committed and CI guards schema drift."
