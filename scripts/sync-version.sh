#!/usr/bin/env bash
# Single source of truth for the version (archcom C5): FastAPI(version=...)
# in server/app.py. This script PROPAGATES it to every consumer:
#
#   1. web/index.html            — cache-bust query strings (?v=X.Y.Z)
#   2. deploy/chart/vesmaro-eyes/Chart.yaml   — version + appVersion
#   3. deploy/chart/vesmaro-eyes/values.yaml  — image.tag
#
# Usage:
#   scripts/sync-version.sh            # apply: read app.py, patch consumers
#   scripts/sync-version.sh --check    # CI mode: exit 1 on drift, no writes
#   scripts/sync-version.sh 1.2.0      # convenience: bump app.py first, then sync
#
# Run this after bumping the version in server/app.py and BEFORE building
# the image / cutting the release. CI (verify step) should run --check.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_PY="$REPO_ROOT/server/app.py"
INDEX_HTML="$REPO_ROOT/web/index.html"
CHART_YAML="$REPO_ROOT/deploy/chart/vesmaro-eyes/Chart.yaml"
VALUES_YAML="$REPO_ROOT/deploy/chart/vesmaro-eyes/values.yaml"

SEMVER_RE='[0-9]+\.[0-9]+\.[0-9]+'

MODE="apply"
CHECK=0
VERSION_ARG=""
for arg in "$@"; do
  case "$arg" in
    --check) MODE="check"; CHECK=1 ;;
    *) VERSION_ARG="$arg" ;;
  esac
done

# --- resolve the source version -------------------------------------------
if [[ -n "$VERSION_ARG" ]]; then
  VERSION="$VERSION_ARG"
  [[ "$VERSION" =~ ^$SEMVER_RE$ ]] || { echo "not semver: $VERSION" >&2; exit 2; }
  if [[ $CHECK -eq 1 ]]; then
    echo "--check ignores a version argument" >&2
    exit 2
  fi
  sed -i -E "s/(FastAPI\(title=\"vesmaro-eyes\", version=\")$SEMVER_RE(\")/\1$VERSION\2/" "$APP_PY"
else
  VERSION="$(grep -oP 'FastAPI\(title="vesmaro-eyes", version="\K'"$SEMVER_RE" "$APP_PY" | head -1)"
  [[ -n "$VERSION" ]] || { echo "cannot parse version from $APP_PY" >&2; exit 2; }
fi

echo "source version: $VERSION ($APP_PY)"

fail=0
apply() { # apply <file> <description> <sed-expr>
  local file="$1" desc="$2" expr="$3"
  if [[ $CHECK -eq 1 ]]; then
    if sed -E "$expr" "$file" | cmp -s - "$file"; then
      echo "  OK    $desc already at $VERSION"
    else
      echo "  DRIFT $desc (expected $VERSION)"
      fail=1
    fi
  else
    sed -i -E "$expr" "$file"
    echo "  patch $desc -> $VERSION"
  fi
}

apply "$INDEX_HTML"  "web/index.html cache-bust"    "s/\?v=$SEMVER_RE/?v=$VERSION/g"
apply "$CHART_YAML"  "Chart.yaml version/appVersion" "s/^(version: )$SEMVER_RE$/\1$VERSION/; s/^(appVersion: \")$SEMVER_RE(\"$)/\1$VERSION\2/"
apply "$VALUES_YAML" "values.yaml image.tag"        "s/^(  tag: \")$SEMVER_RE(\"$)/\1$VERSION\2/"

if [[ $CHECK -eq 1 && $fail -eq 1 ]]; then
  echo "version drift detected; run scripts/sync-version.sh to fix" >&2
  exit 1
fi

if [[ $CHECK -eq 1 ]]; then
  echo "all consumers in sync at $VERSION"
else
  echo "sync complete: $VERSION"
fi
