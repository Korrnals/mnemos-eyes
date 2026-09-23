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
#                       REPAIR/ROLLBACK-ONLY;
#   5. values gate    — helm get values (live) vs deploy/chart/.../values.yaml
#                       (git) on NON-SECRET keys: a hand-edited live release
#                       (stale --set, a diagnostics window left on) refuses
#                       the deploy. RELEASE-BUMP FORGIVENESS (1.33.0 battle):
#                       on ANY release bump the live release by definition
#                       still runs the PREVIOUS tag, so an image.tag-only
#                       drift is waived automatically when the live tag
#                       equals the appVersion of the currently deployed
#                       helm revision (helm history) — "previous release,
#                       not manual drift"; a foreign tag (manual --set)
#                       refuses as before. Any other non-secret drift can
#                       be waived ONLY by an explicit audited escape:
#                       `deploy --allow-drift "<reason>"` (secret-class
#                       drift is NEVER waivable — see P2-A deadlock note
#                       below);
#   6. build + push   — distrobox-host-exec podman (tag resolved from the
#                       chart values / appVersion);
#   7. helm upgrade   — -f values.yaml --set image.tag --set rootApp=app
#                       --atomic (RUNBOOK §11: rootApp=app is explicit in
#                       EVERY upgrade);
#   8. JOURNAL        — append-only line in deploy/JOURNAL.md, committed
#                       back to the repo (audit trail travels with main).
#
# Subcommands:
#   deploy [--allow-drift "<reason>"]
#                              build + upgrade (default). A release-bump
#                              image.tag drift (live == previous release
#                              appVersion per helm history) is waived
#                              AUTOMATICALLY with an audit note — no flag
#                              needed. --allow-drift is the escape for
#                              every OTHER non-secret drift: the
#                              POST-ROLLBACK case (after `rollback <rev>`
#                              the live release legitimately carries the
#                              OLD revision's rootApp etc.), a manual tag
#                              pin, a diagnostics window. The flag waives
#                              ONLY the non-secret drift refusal; every
#                              other gate still runs; the reason is
#                              MANDATORY and lands in the JOURNAL line;
#   verify                     dry run of gates 1-5, no deploy, no journal
#   rollback <rev> [--skip-history-gate]
#                              same gates, helm rollback instead of
#                              upgrade. --skip-history-gate is explicitly
#                              allowed here: rolling back IS the sane
#                              recovery when the latest revision is
#                              failed/pending (rollback targets a KNOWN
#                              good revision; deploy/verify never skip);
#   repair [--skip-history-gate]
#                              one-shot realignment: helm upgrade with the
#                              CURRENT app tag from the FRESH main chart
#                              (no image rebuild — the tag must already
#                              exist in the registry); also allowed to
#                              skip the history gate (recover a failed/
#                              pending release)
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
GIT_BIN="${VESMARO_DEPLOY_GIT:-git}"
HELM_BIN="${VESMARO_DEPLOY_HELM:-helm}"
SYNC_VERSION="${VESMARO_DEPLOY_SYNC_VERSION:-$REPO_ROOT/scripts/sync-version.sh}"
PODMAN_HOST="${VESMARO_DEPLOY_PODMAN_HOST:-distrobox-host-exec podman}"
# NB (distrobox): the default LOCK below lives in /run, which is
# NAMESPACE-LOCAL per distrobox container — two different containers (or
# container vs host) each see their OWN /run and the flock does NOT
# serialize deploys between them. Run every deploy from the SAME
# container (or point LOCK at a shared path) — the gate only holds
# within one PID/mount namespace. /run is typically NOT user-writable:
# either pre-create the file once (see the runbook: sudo install -m 0666
# /dev/null /run/vesmaro-deploy.lock) or let acquire_lock fall back to
# $XDG_RUNTIME_DIR with a WARNING.
LOCK_PATH="${VESMARO_DEPLOY_LOCK:-/run/vesmaro-deploy.lock}"

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
Usage: scripts/deploy.sh [deploy|verify|rollback <rev>|repair] [flags]

  deploy    build + push the image, helm upgrade --atomic, JOURNAL entry
            (a release-bump image.tag drift — live equals the previous
            release appVersion — is waived automatically, no flag needed)
            --allow-drift "<reason>"  waive any OTHER NON-SECRET values
            drift (manual tag pin, post-rollback rootApp; reason is
            mandatory, lands in JOURNAL; secret-class drift and every
            other gate still refuse)
  verify    gates 1-5 only (preflight, version, lock, history, values)
  rollback  helm rollback <rev> through the same gates + JOURNAL entry
            --skip-history-gate allowed (recover from failed/pending)
  repair    helm upgrade with the current app tag from the fresh main
            chart (no rebuild); --skip-history-gate allowed HERE too
USAGE
}

die() { echo "deploy: $1" >&2; exit "${2:-1}"; }
log() { echo "== $1"; }

# ------------------------------------------------------- cleanup + traps
# ONE trap owns everything that must not outlive the process: gate tmp
# files (a RETURN trap never fires on the die/exit paths inside a
# function — the mktemp'd live-values file used to leak there) and the
# deploy-lock fd on signals too (not just EXIT).
declare -a TMP_CLEANUP=()
cleanup() {
  local f
  for f in ${TMP_CLEANUP[@]+"${TMP_CLEANUP[@]}"}; do
    if [[ -n "$f" ]]; then rm -f -- "$f"; fi
  done
  # release the deploy lock fd if we hold it (acquire_lock opened fd 9)
  if { true >&9; } 2>/dev/null; then exec 9>&-; fi
}
trap cleanup EXIT
# On a signal: clean up AND STOP — a handler that only closed the fd
# would let the deploy keep running with the lock already released.
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

# Subcommand state (mutated by argv parsing when executed; inert
# defaults when the script is sourced for unit tests).
CMD="deploy"
ROLLBACK_REV=""
SKIP_HISTORY=0
ALLOW_DRIFT=0
DRIFT_REASON=""
# set by gate_values_drift when the image.tag drift was auto-waived as
# the previous release — do_deploy folds it into the JOURNAL note so the
# waiver stays auditable even without --allow-drift
DRIFT_AUTO_WAIVED=0


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
  # The DEFAULT lock path lives in /run, which needs a one-time sudo
  # setup on hosts where /run is not user-writable. Refusing the deploy
  # over that is operationally hostile (the 1.33.0 first run hit it):
  # when the default path cannot be created/written we fall back to the
  # user runtime dir with a WARNING (serialization stays best-effort).
  # An EXPLICIT VESMARO_DEPLOY_LOCK knob is never second-guessed.
  if [[ -z "${VESMARO_DEPLOY_LOCK:-}" ]] && ! touch "$LOCK_PATH" 2>/dev/null; then
    LOCK_PATH="${XDG_RUNTIME_DIR:-/tmp}/vesmaro-deploy.lock"
    echo "deploy: WARNING — default lock path (/run/vesmaro-deploy.lock) not writable; falling back to $LOCK_PATH (best-effort serialization; pre-create the /run file or set VESMARO_DEPLOY_LOCK for strict locking)" >&2
  fi
  log "gate 3/5 lock: $LOCK_PATH"
  exec 9>"$LOCK_PATH" || die "cannot open $LOCK_PATH for locking" 1
  if ! flock -n 9; then
    local holder
    holder="$(lock_holder)" || true
    die "another deploy holds $LOCK_PATH${holder:+ (holder: $holder)} — refusing to run concurrently" 1
  fi
  # fd 9 is released by the global cleanup() trap (EXIT/INT/TERM).
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
#
# NB: the first sed anchors on EXACTLY two leading spaces + `tag:` —
# it matches values.yaml's `image.tag` and nothing else ONLY while that
# key stays at that indent. A re-indented/renamed block silently stops
# matching and we fall through to appVersion (which sync-version keeps
# equal, so the damage is bounded — but if you ever nest image.* deeper,
# revisit this parser instead of trusting the fallback).
resolve_image_tag() {
  local tag
  tag="$(sed -n 's/^  tag: *"\?\([^"#]*\)"\?.*/\1/p' "$VALUES_FILE" | head -1)"
  if [[ -z "$tag" ]]; then
    tag="$(sed -n 's/^appVersion: *"\?\([^"#]*\)"\?.*/\1/p' "$CHART_YAML" | head -1)"
  fi
  [[ -n "$tag" ]] || die "cannot resolve the image tag (values image.tag / Chart appVersion)" 1
  printf '%s' "$tag"
}

# The image tag a SPECIFIC live revision runs — for the rollback JOURNAL
# line: after `helm rollback` the live release carries the TARGET
# revision's tag, and resolve_image_tag() (git values) would lie in the
# audit trail. Same 2-space-indent sed caveat as resolve_image_tag
# (`helm get values` emits image.tag at exactly that indent).
live_tag_at_revision() {  # $1 = revision number
  local tag
  tag="$("$HELM_BIN" get values "$RELEASE" -n "$NAMESPACE" \
      --revision "$1" --output yaml 2>/dev/null \
      | sed -n 's/^  tag: *"\?\([^"#]*\)"\?.*/\1/p' | head -1)"
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

# appVersion of the CURRENTLY DEPLOYED revision (helm history) — i.e.
# the tag the previous release legitimately runs. Empty when no
# deployed revision exists or the history is unreadable; callers treat
# empty as "cannot confirm" and do NOT auto-waive.
deployed_app_version() {
  "$HELM_BIN" history "$RELEASE" -n "$NAMESPACE" --output json 2>/dev/null \
    | "${PY[@]}" -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    sys.exit(1)
deployed = [r for r in rows if r.get("status") == "deployed"]
if not deployed:
    sys.exit(1)
last = max(deployed, key=lambda r: int(r.get("revision", 0)))
print(last.get("app_version") or "")
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
    die "latest helm revision $rev is '$status' (not deployed) — deploying on top of a broken release is refused. Recover via: scripts/deploy.sh rollback <last-good-rev> --skip-history-gate, or scripts/deploy.sh repair --skip-history-gate (then investigate)" 1
  fi
  echo "   latest revision $rev: deployed"
}

# Non-secret keys the live release must agree on with git (values.yaml +
# the deploy intent: rootApp=app and image.tag=<resolved tag> per RUNBOOK
# §11 — the wrapper always passes both explicitly). Drift on ANY of them
# = refuse — EXCEPT the release-bump shape: an image.tag-ONLY drift where
# the live tag equals the appVersion of the currently deployed helm
# revision is auto-waived (the 1.33.0 battle: on every release bump live
# by definition still runs the previous tag — that is not manual drift).
# Any other non-secret drift is waivable ONLY by `deploy --allow-drift
# "<reason>"` (the post-rollback escape: the live release then
# legitimately carries the old revision's values). Secret-class keys:
# KEY PRESENCE only, values never compared and never printed — NEVER
# waivable (exit 3).
# Exit codes of the python half: 0 = match, 1 = non-secret drift
# (multi-key or non-tag — waivable only via --allow-drift), 2 = image.tag
# ONLY drift (bash then decides: previous release → auto-waive, else
# refuse/--allow-drift), 3 = secret-class drift (never), 4 = unexpected
# error (never — a parse crash must not be mistakable for waivable drift).
gate_values_drift() {
  log "gate 5/5 values drift: live release vs git (non-secret keys)"
  local live_yaml tag repo rc out
  live_yaml="$(mktemp)"
  # removed on EVERY exit path (die included) by the global cleanup()
  # trap — a RETURN trap does not fire on the die/exit paths.
  TMP_CLEANUP+=("$live_yaml")
  if ! "$HELM_BIN" get values "$RELEASE" -n "$NAMESPACE" --output yaml > "$live_yaml" 2>/dev/null; then
    die "helm get values failed — is the release $RELEASE/$NAMESPACE real?" 1
  fi
  tag="$(resolve_image_tag)"
  repo="$(image_repository)"
  rc=0
  out="$("${PY[@]}" - "$live_yaml" "$VALUES_FILE" "$tag" "$repo" <<'PYDRIFT'
import sys, yaml

live_path, file_path, image_tag, image_repo = sys.argv[1:5]

def load(path):
    try:
        return yaml.safe_load(open(path)) or {}
    except Exception:
        return None  # unparseable = NOT waivable drift (exit 4 below)

live = load(live_path)
file = load(file_path)
if live is None or file is None:
    print("values drift check: cannot parse the live or git values yaml", file=sys.stderr)
    sys.exit(4)

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
drifted_paths = []
for path, expected in non_secret_expected.items():
    got, present = dig(live, path)
    if not present:
        drift.append(f"{path}: absent in live release (expected {expected!r})")
        drifted_paths.append(path)
    elif got != expected:
        drift.append(f"{path}: live={got!r} git={expected!r}")
        drifted_paths.append(path)

secret_drift = []
for path in secret_class:
    _, in_live = dig(live, path)
    _, in_file = dig(file, path)
    if in_file and not in_live:
        secret_drift.append(f"{path}: defined in git values, absent in live release (key name only — value not compared)")

if drift:
    print("values drift (NON-SECRET keys):", file=sys.stderr)
    for line in drift:
        print(f"  - {line}", file=sys.stderr)
if secret_drift:
    print("values drift (SECRET-CLASS keys, presence only — NEVER waivable):", file=sys.stderr)
    for line in secret_drift:
        print(f"  - {line}", file=sys.stderr)
if secret_drift:
    sys.exit(3)
if drifted_paths == ["image.tag"]:
    # the release-bump shape: the ONLY drift is image.tag — bash decides
    # via helm history whether live runs the previous release (auto-waive)
    # or a foreign manually-pinned tag (refuse / --allow-drift)
    live_tag = dig(live, "image.tag")[0]
    print(f"TAG-ONLY-DRIFT {live_tag}")
    sys.exit(2)
if drift:
    sys.exit(1)
print("   live values match git + deploy intent (non-secret keys)")
PYDRIFT
)" || rc=$?
  if [[ "$rc" -eq 0 && -n "$out" ]]; then
    printf '%s\n' "$out"
  fi
  case "$rc" in
    0) ;;
    2)
      # image.tag-only drift: if the live tag IS the appVersion of the
      # currently deployed revision, live is simply the previous release
      # (every release bump looks like this) — waived, no flag needed.
      local live_tag prev_app
      live_tag="$(printf '%s\n' "$out" | sed -n 's/^TAG-ONLY-DRIFT //p' | head -1)"
      prev_app="$(deployed_app_version)" || prev_app=""
      if [[ -n "$live_tag" && -n "$prev_app" && "$live_tag" == "$prev_app" ]]; then
        DRIFT_AUTO_WAIVED=1
        log "gate 5/5 values drift: WAIVED — image.tag $live_tag is the appVersion of the deployed revision (previous release, not manual drift)"
      elif [[ "$ALLOW_DRIFT" -eq 1 ]]; then
        log "gate 5/5 values drift: image.tag '$live_tag' is NOT the deployed revision's appVersion ('${prev_app:-unknown}') — previous-release auto-waive does not apply"
        log "gate 5/5 values drift: WAIVED (--allow-drift) — non-secret keys only, reason recorded in JOURNAL"
      else
        die "image.tag drift is NOT the previous release (live=$live_tag, deployed-revision appVersion=${prev_app:-unknown}) — realign the live release (scripts/deploy.sh repair), commit the intended values, or waive explicitly: scripts/deploy.sh deploy --allow-drift \"<reason>\"" 1
      fi ;;
    1)
      if [[ "$ALLOW_DRIFT" -eq 1 ]]; then
        log "gate 5/5 values drift: WAIVED (--allow-drift) — non-secret keys only, reason recorded in JOURNAL"
      else
        die "values drift detected (details above) — realign the live release (scripts/deploy.sh repair), commit the intended values, or waive explicitly: scripts/deploy.sh deploy --allow-drift \"<reason>\"" 1
      fi ;;
    3) die "values drift on SECRET-CLASS keys (details above) — --allow-drift does NOT cover this; realign the release first" 1 ;;
    *) die "values drift check failed unexpectedly (rc=$rc) — refusing" 1 ;;
  esac
}

run_gates() {
  gate_preflight
  gate_version_drift
  acquire_lock
  if [[ "$SKIP_HISTORY" -eq 1 ]]; then
    log "gate 4/5 helm history: SKIPPED (--skip-history-gate, repair/rollback only)"
  else
    gate_helm_history
  fi
  gate_values_drift
}

# ---------------------------------------------------------------- journal
journal_append() {  # $1 action, $2 rev_before, $3 rev_after, $4 image_tag, [$5 note]
  local action="$1" rev_before="$2" rev_after="$3" image_tag="$4" note="${5:-}"
  local head chart_ver actor when line
  head="$("$GIT_BIN" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  chart_ver="$(chart_version)"
  actor="${VESMARO_DEPLOY_ACTOR:-$(id -un 2>/dev/null || echo unknown)@$(hostname -s 2>/dev/null || echo unknown)}"
  when="$(date '+%Y-%m-%dT%H:%M:%S%z')"
  if [[ ! -f "$JOURNAL" ]]; then
    printf '# vesmaro-eyes deploy JOURNAL — append-only audit trail (AGW-10)\n# date | actor | action | helm rev before>after | image tag | chart version | HEAD\n' > "$JOURNAL"
  fi
  # the note is single-line by construction (newlines squashed at argv
  # parse) — the journal stays one-entry-per-line parseable
  line="$(printf '%s | %s | %s | rev %s>%s | image %s | chart %s | HEAD %s' \
    "$when" "$actor" "$action" "$rev_before" "$rev_after" \
    "${image_tag:-none}" "${chart_ver:-unknown}" "$head")"
  if [[ -n "$note" ]]; then
    line="$line | $note"
  fi
  printf '%s\n' "$line" >> "$JOURNAL"
  # The journal travels with the repo — but only when it lives inside it
  # (the test contour points the knob at a tmp file).
  case "$(readlink -f "$JOURNAL")" in
    "$REPO_ROOT"/*)
      "$GIT_BIN" add "$JOURNAL" \
        && "$GIT_BIN" commit -q -m "chore(deploy): journal — $action rev $rev_before>$rev_after image ${image_tag:-none}" \
        || echo "deploy: WARNING — could not commit $JOURNAL (deploy already done; commit it manually)" >&2
      # push HEAD, not the local main branch: deploys often run from a
      # worktree / detached HEAD that does NOT own main (gate 1 only
      # needs HEAD == origin/main) — `push origin main` would then push
      # the STALE local main and silently strand the journal commit.
      "$GIT_BIN" push -q origin HEAD:main 2>/dev/null \
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
  local rev_before
  rev_before="$(rev_now)"
  build_and_push
  helm_upgrade_atomic
  local rev_after
  rev_after="$(rev_now)"
  log "deployed: rev $rev_before>$rev_after"
  # drift waiver note: the audit trail must show WHY the values gate
  # was skipped, in the JOURNAL line itself — for BOTH waiver kinds
  # (explicit --allow-drift and the automatic previous-release one)
  local note=""
  if [[ "$ALLOW_DRIFT" -eq 1 ]]; then
    note="allow-drift: $DRIFT_REASON"
  elif [[ "$DRIFT_AUTO_WAIVED" -eq 1 ]]; then
    note="auto-waived: image.tag drift = previous release (deployed-revision appVersion)"
  fi
  journal_append deploy "$rev_before" "$rev_after" "$(resolve_image_tag)" "$note"
}

do_rollback() {
  run_gates
  local rev_before
  rev_before="$(rev_now)"
  log "helm rollback: $RELEASE -> revision $ROLLBACK_REV"
  "$HELM_BIN" rollback "$RELEASE" "$ROLLBACK_REV" -n "$NAMESPACE" \
    --wait --timeout 5m \
    || die "helm rollback failed" 1
  local rev_after tag_after
  rev_after="$(rev_now)"
  log "rolled back: rev $rev_before>$rev_after (target revision $ROLLBACK_REV)"
  # the journal tag must reflect WHAT THE RELEASE NOW RUNS: the target
  # revision's live tag, NOT git's resolve_image_tag() (they diverge
  # exactly when a rollback is worth journaling)
  tag_after="$(live_tag_at_revision "$rev_after")"
  if [[ -z "$tag_after" ]]; then
    log "WARNING: could not read the live tag of rev $rev_after — journaling the git tag as a fallback"
    tag_after="$(resolve_image_tag)"
  fi
  journal_append rollback "$rev_before" "$rev_after" "$tag_after"
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

  while [[ $# -gt 0 ]]; do
    case "$1" in
      deploy|verify|rollback|repair) CMD="$1" ;;
      --skip-history-gate) SKIP_HISTORY=1 ;;
      --allow-drift)
        # the waiver reason is MANDATORY and must be non-empty — an
        # anonymous drift waiver is unauditable
        if [[ $# -lt 2 || -z "$2" ]]; then
          die "--allow-drift needs a non-empty reason: scripts/deploy.sh deploy --allow-drift \"<reason>\"" 2
        fi
        ALLOW_DRIFT=1
        DRIFT_REASON="$2"
        shift ;;
      -h|--help) usage; exit 0 ;;
      *) if [[ "$CMD" == "rollback" && "$1" =~ ^[0-9]+$ && -z "$ROLLBACK_REV" ]]; then
           ROLLBACK_REV="$1"
         else
           echo "unknown argument: $1" >&2; usage; exit 2
         fi ;;
    esac
    shift
  done
  # keep the journal one-entry-per-line even if the reason tries not to be
  DRIFT_REASON="${DRIFT_REASON//$'\n'/ }"
  DRIFT_REASON="${DRIFT_REASON//$'\r'/ }"
  if [[ "$ALLOW_DRIFT" -eq 1 && "$CMD" != "deploy" ]]; then
    die "--allow-drift is allowed for the deploy subcommand ONLY" 2
  fi
  if [[ "$SKIP_HISTORY" -eq 1 && "$CMD" != "repair" && "$CMD" != "rollback" ]]; then
    die "--skip-history-gate is allowed for the repair and rollback subcommands ONLY" 2
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
