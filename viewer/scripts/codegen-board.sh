#!/usr/bin/env bash
# Regenerate src/types/board-openapi.d.ts from the BOARD server OpenAPI schema
# (ADR 0011 §6: BoardAdapter types come from the board's OpenAPI, never from
# hand-mapping the mnemos vocabulary).
#
# Flow: GET ${BOARD_URL}/openapi.json -> board-openapi-snapshot.json
# (normalized and committed, so builds are reproducible without a live
# server) -> openapi-typescript generates src/types/board-openapi.d.ts FROM
# the snapshot. Generating from the snapshot (never straight from the URL)
# keeps the committed types byte-deterministic for a given schema.
#
# Usage (from viewer/):
#   npm run codegen:board            # fetch live schema, refresh snapshot, generate
#   BOARD_URL=http://127.0.0.1:8140 npm run codegen:board
#   npm run codegen:board:offline    # regenerate from the committed snapshot only
#
# Bring up a local board server for the fetch step with:
#   VESMARO_DATA=/tmp/fe0-gen VESMARO_BOARD_TOKEN=dev \
#     python3 -m uvicorn server.app:app --port 8140   # from the repo root
set -euo pipefail

BOARD_URL="${BOARD_URL:-http://127.0.0.1:8140}"
SNAPSHOT="board-openapi-snapshot.json"
OUT="src/types/board-openapi.d.ts"

from_snapshot=false
for arg in "$@"; do
  case "$arg" in
    --from-snapshot) from_snapshot=true ;;
    *)
      echo "codegen-board: unknown flag: $arg (supported: --from-snapshot)" >&2
      exit 2
      ;;
  esac
done

if [[ "$from_snapshot" == false ]]; then
  echo "codegen-board: fetching ${BOARD_URL}/openapi.json"
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  curl --fail --silent --show-error "${BOARD_URL}/openapi.json" -o "$tmp"
  # Normalize whitespace so the committed snapshot is byte-deterministic.
  node -e '
    const fs = require("fs");
    const schema = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    fs.writeFileSync(process.argv[2], JSON.stringify(schema) + "\n");
  ' "$tmp" "$SNAPSHOT"
  echo "codegen-board: snapshot updated: ${SNAPSHOT} ($(wc -c < "$SNAPSHOT") bytes)"
else
  if [[ ! -f "$SNAPSHOT" ]]; then
    echo "codegen-board: ${SNAPSHOT} not found — run 'npm run codegen:board' against a live board server first." >&2
    exit 1
  fi
  echo "codegen-board: regenerating from existing snapshot ${SNAPSHOT}"
fi

npx openapi-typescript "$SNAPSHOT" --output "$OUT" --immutable
echo "codegen-board: wrote ${OUT} ($(wc -l < "$OUT") lines). Review the diff — the file is committed and CI guards schema drift."
