#!/usr/bin/env bash
# vesmaro-eyes deploy wrapper (AGW-10, АРХКОМ-8 В3) — THE ONLY DOOR TO PROD.
#
# Every production change of the board goes through this script, in order:
#   1. preflight      — git fetch origin; HEAD must == origin/main and the
#                       working tree must be clean (deploy what main says,
#                       nothing else);
#   2. version gate   — scripts/sync-version.sh --check (no version drift
#                       between app.py, chart and image tag);
#   3. lock           — flock -n on a stable path: one deploy at a time,
#                       trap-cleaned (the protocol never deadlocks);
#   4. history gate   — helm history: the latest revision must be
#                       `deployed` (never stack an upgrade on a failed /
#                       pending-upgrade release). --skip-history-gate is
#                       REPAIR-ONLY;
#   5. values gate    — helm get values (live) vs deploy/chart/.../values.yaml
#                       (git) on NON-SECRET keys: a hand-edited live release
#                       (stale --set, a diagnostics window left on) refuses
#                       the deploy. Secret-class keys are compared by KEY
#                       PRESENCE only — values never printed;
#   6. build + push   — distrobox-host-exec podman (tag resolved from the
#                       chart values / appVersion);
#   7. helm upgrade   — -f values.yaml --set image.tag --set rootApp=app
#                       --atomic (RUNBOOK §11: rootApp=app is explicit in
#                       EVERY upgrade);
#   8. JOURNAL        — append-only line in deploy/JOURNAL.md, committed
#                       back to the repo (audit trail travels with main).
#
# Subcommands:
#   deploy                     build + upgrade (default)
#   verify                     dry run of gates 1-5, no deploy, no journal
#   rollback <rev>             same gates, helm rollback instead of upgrade
#   repair [--skip-history-gate]
#                              one-shot realignment: helm upgrade with the
#                              CURRENT app tag from the FRESH main chart
#                              (no image rebuild — the tag must already
#                              exist in the registry); the only subcommand
#                              allowed to skip the history gate (use it to
#                              recover a failed/pending release)
#
# Env knobs (ops/test overrides, VESMARO_DEPLOY_ prefix):
#   GIT / HELM / SYNC_VERSION / PODMAN_HOST / LOCK / JOURNAL / ACTOR / PYTHON
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE="${VESMARO_DEPLOY_RELEASE:-vesmaro-eyes}"
NAMESPACE="${VESMARO_DEPLOY_NAMESPACE:-kube-agents}"
CHART_DIR="$REPO_ROOT/deploy/chart/vesmaro-eyes"
VALUES_FILE="$CHART_DIR/values.yaml"
CHART_YAML="$CHART_DIR/Chart.yaml"
JOURNAL="${VESMARO_DEPLOY_JOURNAL:-$REPO_ROOT/deploy/JOURNAL.md}"
LOCK_PATH="${VESMARO_DEPLOY_LOCK:-/run/vesmaro-deploy.lock}"
GIT_BIN="${VESMARO_DEPLOY_GIT:-git}"
HELM_BIN="${VESMARO_DEPLOY_HELM:-helm}"
SYNC_VERSION="${VESMARO_DEPLOY_SYNC_VERSION:-$REPO_ROOT/scripts/sync-version.sh}"
PODMAN_HOST="${VESMARO_DEPLOY_PODMAN_HOST:-distrobox-host-exec podman}"

# python for yaml/json parsing: the repo venv when present, else python3
# (must import yaml for the values gate).
if [[ -z "${VESMARO_DEPLOY_PYTHON:-}" ]]; then
  if [[ -x "$REPO_ROOT/.venv/bin/python" ]]; then
    PY=("$REPO_ROOT/.venv/bin/python")
  else
    PY=(python3)
  fi
else
  # word-split on purpose: the knob may carry args
  read -r -a PY <<<"$VESMARO_DEPLOY_PYTHON"
fi

usage() {
  cat <<'USAGE'
Usage: scripts/deploy.sh [deploy|verify|rollback <rev>|repair] [--skip-history-gate]

  deploy    build + push the image, helm upgrade --atomic, JOURNAL entry
  verify    gates 1-5 only (preflight, version, lock, history, values)
  rollback  helm rollback <rev> through the same gates + JOURNAL entry
  repair    helm upgrade with the current app tag from the fresh main
            chart (no rebuild); --skip-history-gate allowed HERE only
USAGE
}

die() { echo "deploy: $1" >&2; exit "${2:-1}"; }
log() { echo "== $1"; }


# ------------------------------------------------------------------ gates
gate_preflight() {
  log "gate 1/5 preflight: HEAD == origin/main, clean tree"
  "$GIT_BIN" fetch origin >/dev/null 2>&1 \
    || die "git fetch origin failed — is the network/upstream sane?" 1
  local head origin_main
  head="$("$GIT_BIN" rev-parse HEAD)" \
    || die "cannot resolve HEAD" 1
  origin_main="$("$GIT_BIN" rev-parse origin/main)" \
    || die "cannot resolve origin/main" 1
  [[ "$head" == "$origin_main" ]] \
    || die "HEAD ($head) is not origin/main ($origin_main) — deploy ships exactly main: pull/rebase first" 1
  if [[ -n "$("$GIT_BIN" status --porcelain)" ]]; then
    die "working tree is dirty — commit or stash first (deploy reads config from git)" 1
  fi
}

gate_version_drift() {
  log "gate 2/5 version drift: sync-version --check"
  bash "$SYNC_VERSION" --check \
    || die "version drift detected — run scripts/sync-version.sh and commit" 1
}

acquire_lock() {
  log "gate 3/5 lock: $LOCK_PATH"
  exec 9>"$LOCK_PATH" || die "cannot open $LOCK_PATH for locking" 1
  if ! flock -n 9; then
    local holder
    holder="$(lock_holder)" || true
    die "another deploy holds $LOCK_PATH${holder:+ (holder: $holder)} — refusing to run concurrently" 1
  fi
  trap 'exec 9>&-' EXIT
}

# Best-effort holder identification: pid + process name only (never a
# full cmdline dump — a deploy command line may carry more than needed).
lock_holder() {
  if command -v fuser >/dev/null 2>&1; then
    fuser "$LOCK_PATH" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | head -1 \
      | while read -r pid; do
          printf 'pid %s (%s)' "$pid" "$(ps -o comm= -p "$pid" 2>/dev/null || echo unknown)"
        done
    return 0
  fi
  local real
  real="$(readlink -f "$LOCK_PATH" 2>/dev/null || echo "$LOCK_PATH")"
  local fd
  for fd in /proc/[0-9]*/fd/*; do
    if [[ "$(readlink "$fd" 2>/dev/null || true)" == "$real" ]]; then
      local pid
      pid="$(echo "$fd" | cut -d/ -f3)"
      printf 'pid %s (%s)' "$pid" "$(ps -o comm= -p "$pid" 2>/dev/null || echo unknown)"
      return 0
    fi
  done
  return 1
}

# The image tag the deploy pins: values.yaml image.tag (sync-version keeps
# it equal to Chart appVersion); empty falls back to appVersion per the
# chart contract. Never empty at the end.
resolve_image_tag() {
  local tag
  tag="$(sed -n 's/^  tag: *"\?\([^"#]*\)"\?.*/\1/p' "$VALUES_FILE" | head -1)"
  if [[ -z "$tag" ]]; then
    tag="$(sed -n 's/^appVersion: *"\?\([^"#]*\)"\?.*/\1/p' "$CHART_YAML" | head -1)"
  fi
  [[ -n "$tag" ]] || die "cannot resolve the image tag (values image.tag / Chart appVersion)" 1
  printf '%s' "$tag"
}

chart_version() {
  sed -n 's/^version: *\([0-9][^ #]*\).*/\1/p' "$CHART_YAML" | head -1
}

image_repository() {
  sed -n 's/^  repository: *\([^ #]*\).*/\1/p' "$VALUES_FILE" | head -1
}

# Latest revision row of the live release history: prints "rev status".
helm_last_revision() {
  "$HELM_BIN" history "$RELEASE" -n "$NAMESPACE" --output json 2>/dev/null \
    | "${PY[@]}" -c '
import json, sys
rows = json.load(sys.stdin)
if not rows:
    sys.exit(1)
last = max(rows, key=lambda r: int(r.get("revision", 0)))
print(last.get("revision", "?"), last.get("status", "?"))
'
}

gate_helm_history() {
  log "gate 4/5 helm history: latest revision must be deployed"
  local last
  if ! last="$(helm_last_revision)"; then
    die "cannot read helm history for $RELEASE/$NAMESPACE — is the release real?" 1
  fi
  local rev status
  read -r rev status <<<"$last"
  if [[ "$status" != "deployed" ]]; then
    die "latest helm revision $rev is '$status' (not deployed) — deploying on top of a broken release is refused. Recover via: scripts/deploy.sh repair --skip-history-gate (then investigate)" 1
  fi
  echo "   latest revision $rev: deployed"
}

# Non-secret keys the live release must agree on with git (values.yaml +
# the deploy intent: rootApp=app and image.tag=<resolved tag> per RUNBOOK
# §11 — the wrapper always passes both explicitly). Drift on ANY of them
# = refuse. Secret-class keys: KEY PRESENCE only, values never compared
# and never printed.
gate_values_drift() {
  log "gate 5/5 values drift: live release vs git (non-secret keys)"
  local live_yaml tag repo
  live_yaml="$(mktemp)"
  # NB: a plain RETURN trap SURVIVES the function and fires again on the
  # NEXT return with the local already gone (set -u → unbound variable)
  # — it removes itself after the one shot.
  trap 'rm -f "$live_yaml"; trap - RETURN' RETURN
  if ! "$HELM_BIN" get values "$RELEASE" -n "$NAMESPACE" --output yaml > "$live_yaml" 2>/dev/null; then
    die "helm get values failed — is the release $RELEASE/$NAMESPACE real?" 1
  fi
  tag="$(resolve_image_tag)"
  repo="$(image_repository)"
  "${PY[@]}" - "$live_yaml" "$VALUES_FILE" "$tag" "$repo" <<'PYDRIFT' \
    || die "values drift detected (details above) — realign the live release (scripts/deploy.sh repair) or commit the intended values" 1
import sys, yaml

live_path, file_path, image_tag, image_repo = sys.argv[1:5]
live = yaml.safe_load(open(live_path)) or {}
file = yaml.safe_load(open(file_path)) or {}

def dig(d, path):
    cur = d
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None, False
        cur = cur[part]
    return cur, True

# expected = file values, with the deploy intent folded in (RUNBOOK §11:
# EVERY upgrade passes --set rootApp=app --set image.tag=<tag>).
non_secret_expected = {
    "rootApp": "app",
    "image.tag": image_tag,
    "image.repository": image_repo,
    "image.pullPolicy": dig(file, "image.pullPolicy")[0],
    "replicaCount": dig(file, "replicaCount")[0],
    "strategy": dig(file, "strategy")[0],
    "pollerBootstrap.caFile.enabled": dig(file, "pollerBootstrap.caFile.enabled")[0],
    "uiToken.enabled": dig(file, "uiToken.enabled")[0],
    "ingress.enabled": dig(file, "ingress.enabled")[0],
    "ingress.className": dig(file, "ingress.className")[0],
    "ingress.host": dig(file, "ingress.host")[0],
    "ingress.tls.enabled": dig(file, "ingress.tls.enabled")[0],
    "networkPolicy.enabled": dig(file, "networkPolicy.enabled")[0],
    "networkPolicy.ingress.traefik.enabled": dig(file, "networkPolicy.ingress.traefik.enabled")[0],
    "networkPolicy.ingress.allowLan.enabled": dig(file, "networkPolicy.ingress.allowLan.enabled")[0],
    "networkPolicy.egress.dns.enabled": dig(file, "networkPolicy.egress.dns.enabled")[0],
    "networkPolicy.egress.mnemos.enabled": dig(file, "networkPolicy.egress.mnemos.enabled")[0],
    "networkPolicy.egress.lan.enabled": dig(file, "networkPolicy.egress.lan.enabled")[0],
    "memoryHostsAllowlist": dig(file, "memoryHostsAllowlist")[0],
    "securityContext.runAsNonRoot": dig(file, "securityContext.runAsNonRoot")[0],
}
# Secret-class: presence only, values never compared/printed (out-of-band
# rotation of existingSecret refs is the chart's own design).
secret_class = [
    "boardToken.existingSecret",
    "boardToken.existingSecretKey",
    "uiToken.existingSecret",
    "uiToken.existingSecretKey",
    "mnemos.cluster.existingSecret",
    "mnemos.cluster.existingSecretKey",
    "mnemos.laptop.existingSecret",
    "mnemos.laptop.existingSecretKey",
]

drift = []
for path, expected in non_secret_expected.items():
    got, present = dig(live, path)
    if not present:
        drift.append(f"{path}: absent in live release (expected {expected!r})")
    elif got != expected:
        drift.append(f"{path}: live={got!r} git={expected!r}")

for path in secret_class:
    _, in_live = dig(live, path)
    _, in_file = dig(file, path)
    if in_file and not in_live:
        drift.append(f"{path}: defined in git values, absent in live release (key name only — value not compared)")

if drift:
    print("values drift (NON-SECRET keys only):", file=sys.stderr)
    for line in drift:
        print(f"  - {line}", file=sys.stderr)
    sys.exit(1)
print("   live values match git + deploy intent (non-secret keys)")
PYDRIFT
}

run_gates() {
  gate_preflight
  gate_version_drift
  acquire_lock
  if [[ "$SKIP_HISTORY" -eq 1 ]]; then
    log "gate 4/5 helm history: SKIPPED (--skip-history-gate, repair only)"
  else
    gate_helm_history
  fi
  gate_values_drift
}

# ---------------------------------------------------------------- journal
journal_append() {  # $1 action, $2 rev_before, $3 rev_after, $4 image_tag
  local action="$1" rev_before="$2" rev_after="$3" image_tag="$4"
  local head chart_ver actor when
  head="$("$GIT_BIN" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  chart_ver="$(chart_version)"
  actor="${VESMARO_DEPLOY_ACTOR:-$(id -un 2>/dev/null || echo unknown)@$(hostname -s 2>/dev/null || echo unknown)}"
  when="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  if [[ ! -f "$JOURNAL" ]]; then
    printf '# vesmaro-eyes deploy JOURNAL — append-only audit trail (AGW-10)\n# date | actor | action | helm rev before>after | image tag | chart version | HEAD\n' > "$JOURNAL"
  fi
  printf '%s | %s | %s | rev %s>%s | image %s | chart %s | HEAD %s\n' \
    "$when" "$actor" "$action" "$rev_before" "$rev_after" \
    "${image_tag:-none}" "${chart_ver:-unknown}" "$head" >> "$JOURNAL"
  # The journal travels with the repo — but only when it lives inside it
  # (the test contour points the knob at a tmp file).
  case "$(readlink -f "$JOURNAL")" in
    "$REPO_ROOT"/*)
      "$GIT_BIN" add "$JOURNAL" \
        && "$GIT_BIN" commit -q -m "chore(deploy): journal — $action rev $rev_before>$rev_after image ${image_tag:-none}" \
        || echo "deploy: WARNING — could not commit $JOURNAL (deploy already done; commit it manually)" >&2
      "$GIT_BIN" push -q origin main 2>/dev/null \
        || echo "deploy: WARNING — could not push the journal commit (push it manually)" >&2
      ;;
    *) ;;
  esac
}

rev_now() {
  helm_last_revision | cut -d' ' -f1 || echo "?"
}

# ----------------------------------------------------------------- worker
do_verify() {
  run_gates
  log "verify: all gates green (no deploy was performed)"
}

build_and_push() {
  local tag repo
  tag="$(resolve_image_tag)"
  repo="$(image_repository)"
  log "image build + push: $repo:$tag"
  $PODMAN_HOST build -t "$repo:$tag" "$REPO_ROOT" \
    || die "podman build failed" 1
  $PODMAN_HOST push "$repo:$tag" \
    || die "podman push failed" 1
}

helm_upgrade_atomic() {
  local tag
  tag="$(resolve_image_tag)"
  log "helm upgrade: $RELEASE ($NAMESPACE) image $tag --atomic"
  "$HELM_BIN" upgrade "$RELEASE" "$CHART_DIR" -n "$NAMESPACE" \
    -f "$VALUES_FILE" \
    --set "image.tag=$tag" --set rootApp=app \
    --atomic --timeout 5m \
    || die "helm upgrade failed (--atomic rolls back on timeout/unready)" 1
}

do_deploy() {
  run_gates
  local rev_before tag
  rev_before="$(rev_now)"
  build_and_push
  helm_upgrade_atomic
  local rev_after
  rev_after="$(rev_now)"
  log "deployed: rev $rev_before>$rev_after"
  journal_append deploy "$rev_before" "$rev_after" "$(resolve_image_tag)"
}

do_rollback() {
  run_gates
  local rev_before
  rev_before="$(rev_now)"
  log "helm rollback: $RELEASE -> revision $ROLLBACK_REV"
  "$HELM_BIN" rollback "$RELEASE" "$ROLLBACK_REV" -n "$NAMESPACE" \
    --wait --timeout 5m \
    || die "helm rollback failed" 1
  local rev_after
  rev_after="$(rev_now)"
  log "rolled back: rev $rev_before>$rev_after (target revision $ROLLBACK_REV)"
  journal_append rollback "$rev_before" "$rev_after" "$(resolve_image_tag)"
}

do_repair() {
  run_gates
  local rev_before
  rev_before="$(rev_now)"
  # NO build/push: repair realigns chart/appVersion state; the tag must
  # already exist in the registry.
  helm_upgrade_atomic
  local rev_after
  rev_after="$(rev_now)"
  log "repaired: rev $rev_before>$rev_after (current app tag from fresh main chart)"
  journal_append repair "$rev_before" "$rev_after" "$(resolve_image_tag)"
}

# --------------------------------------------- main (source-guard for tests)
# Sourcing the script (unit tests) defines the gates WITHOUT running
# any of them; executing it directly parses argv and dispatches.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then

  CMD="deploy"
  ROLLBACK_REV=""
  SKIP_HISTORY=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      deploy|verify|rollback|repair) CMD="$1" ;;
      --skip-history-gate) SKIP_HISTORY=1 ;;
      -h|--help) usage; exit 0 ;;
      *) if [[ "$CMD" == "rollback" && "$1" =~ ^[0-9]+$ && -z "$ROLLBACK_REV" ]]; then
           ROLLBACK_REV="$1"
         else
           echo "unknown argument: $1" >&2; usage; exit 2
         fi ;;
    esac
    shift
  done
  if [[ "$SKIP_HISTORY" -eq 1 && "$CMD" != "repair" ]]; then
    die "--skip-history-gate is allowed for the repair subcommand ONLY" 2
  fi
  if [[ "$CMD" == "rollback" && -z "$ROLLBACK_REV" ]]; then
    die "rollback needs a revision number: scripts/deploy.sh rollback <rev>" 2
  fi

  case "$CMD" in
    deploy)   do_deploy ;;
    verify)   do_verify ;;
    rollback) do_rollback ;;
    repair)   do_repair ;;
    *)        usage; exit 2 ;;
  esac
fi  # source-guard
