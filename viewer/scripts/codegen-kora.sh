#!/usr/bin/env bash
# Regenerate src/features/kora/koraContract.d.ts from the Kora week-0
# contract artifact (ADR 0019 rev.2 — «Неделя 0 — контракт-first»).
#
# Unlike codegen.sh / codegen-board.sh there is NO live server yet by
# contract: the source of truth is the committed frozen artifact
# docs/kora/openapi.yaml. Types are generated FROM the artifact (never
# hand-mapped), committed, and CI guards drift — the same byte-deterministic
# discipline as the other codegen flows.
#
# Usage (from viewer/):
#   npm run codegen:kora
set -euo pipefail

ARTIFACT="../docs/kora/openapi.yaml"
OUT="src/features/kora/koraContract.d.ts"

if [[ ! -f "$ARTIFACT" ]]; then
  echo "codegen-kora: $ARTIFACT not found — the contract artifact is committed, check the worktree." >&2
  exit 1
fi

npx openapi-typescript "$ARTIFACT" --output "$OUT" --immutable
# P4-3: normalize formatting — the artifact is frozen and the generated
# file is COMMITTED; openapi-typescript output is byte-stable across runs
# only when formatted deterministically (prettier = the repo formatter).
npx prettier --write "$OUT"
echo "codegen-kora: wrote $OUT ($(wc -l < "$OUT") lines). Review the diff — the file is committed and CI guards schema drift."
