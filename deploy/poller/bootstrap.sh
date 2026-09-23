#!/usr/bin/env bash
# vesmaro-eyes poller bootstrap — the ONE-COMMAND onboarding (wave 3D).
#
#   curl -fsSL https://<board>/api/poller/bootstrap.sh | sudo bash -s -- \
#     --url https://<board> --token mne_… [--name vps-1] [--harness zcode]
#
# What it does, in order: parse/sanity args → preflight (python ≥ 3.10,
# systemd, curl, openssl) → fetch the lab CA (ONE -k retry for the CA ONLY,
# fingerprint printed for the out-of-band check; a pre-placed
# /etc/vesmaro/lab-ca.crt short-circuits the -k path) → venv + deps →
# artifacts over PINNED TLS → register with the enrollment token → write
# 0600 env + yaml (allowlist is an honest fail-closed SEED — edit it) →
# systemd system unit → verdict.
#
# Honesty rules (ADR 0009 §9, A3):
# - outbound-only: the script never opens ports, the board never pings in;
# - the enrollment token travels as a CLI ARGUMENT, never in a URL
#   (ADR 0012 §9); it is single-use, TTL 15 min — shell-history exposure
#   is bounded by design;
# - the generated allowlist CANNOT launch anything until the owner edits
#   the command: nomination ≠ execution (the board gate is the dictionary,
#   the launch gate stays the local allowlist).
# - re-run with a SPENT token and an existing install = UPDATE path:
#   re-download artifacts, PRESERVE the user's allowlist and executor_id,
#   restart — the upgrade story. Registration is never re-run (a used
#   token cannot mint a second executor; rotation = revoke + delete on the
#   board, then a fresh run with a new token and the same --name).
#
# Exit codes: 0 registered/updated · 2 bad arguments · 3 environment
# failed (preflight/TLS) · 4 registration refused (4xx, no idempotent
# path) · 5 install/systemd failure.

set -euo pipefail

# ----------------------------------------------------------------- config
BOARD_URL="" TOKEN="" EXEC_NAME="" HARNESS="zcode" HOST_NAME=""
BASE_DIR="/opt/mnemos-eyes"
VENV_DIR="$BASE_DIR/venv"
POLLER_PY="$BASE_DIR/assignment_poller.py"
ENV_FILE="/etc/vesmaro/poller.env"
YAML_FILE="/etc/vesmaro/poller.yaml"
MARKER_FILE="/etc/vesmaro/poller-bootstrap.json"
CA_FILE="/etc/vesmaro/lab-ca.crt"
UNIT_FILE="/etc/systemd/system/vesmaro-assignment-poller.service"
STATE_DIR="/var/lib/vesmaro-eyes"

usage() {
  cat <<'USAGE'
Usage: bootstrap.sh --url <board-url> --token mne_… [--name NAME] [--harness NAME] [--host HOST]

  --url      board base URL as seen FROM THIS MACHINE (VPN overlay address
             if that is what resolves here — may differ from the LAN one)
  --token    one-time enrollment token (mne_…, TTL 15 min, single use);
             mint it on the board: Реестр → Добавить исполнителя
  --name     executor name (default: this hostname)
  --harness  harness id from the board's harness dictionary (default: zcode)
  --host     declared host string (default: this hostname)

Re-run behaviour: with an already-spent token and an existing install the
script takes the UPDATE path (fresh artifacts, your allowlist preserved).
Exit codes: 0 ok · 2 args · 3 environment · 4 registration refused ·
5 install/systemd.
USAGE
}

die() { echo "bootstrap: $1" >&2; exit "${2:-1}"; }
step() { echo "== $1"; }

# ------------------------------------------------------------ parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) BOARD_URL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --name) EXEC_NAME="${2:-}"; shift 2 ;;
    --harness) HARNESS="${2:-}"; shift 2 ;;
    --host) HOST_NAME="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$BOARD_URL" ]] || { echo "--url is required" >&2; usage; exit 2; }
[[ -n "$TOKEN" ]] || { echo "--token is required (mne_…, minted on the board)" >&2; usage; exit 2; }
[[ "$TOKEN" =~ ^mne_[A-Za-z0-9_-]+$ ]] || die "--token must look like mne_… (got a different shape) — mint a one-time enrollment token on the board" 2
[[ "$BOARD_URL" =~ ^https:// ]] || die "--url must be https:// (the board is never plain HTTP)" 2
HOST_NAME="${HOST_NAME:-$(hostname 2>/dev/null || echo unknown-host)}"
EXEC_NAME="${EXEC_NAME:-$HOST_NAME}"

step "preflight"
command -v curl >/dev/null 2>&1 || die "curl not found — install curl first" 3
command -v openssl >/dev/null 2>&1 || die "openssl not found — install openssl first" 3
command -v systemctl >/dev/null 2>&1 || die "systemd not found — this installer targets a systemd host (the laptop/distrobox path is manual: deploy/poller/README.md)" 3
[[ "$(id -u)" -eq 0 ]] || die "run as root (the curl | sudo bash form, or a root shell)" 3
command -v python3 >/dev/null 2>&1 || die "python3 not found — install python ≥ 3.10 first" 3
PY_MINOR=$(python3 -c 'import sys; print(f"{sys.version_info[0]}{sys.version_info[1]:02d}")')
[[ "$PY_MINOR" -ge 310 ]] || die "python3 $(python3 -V 2>&1) is too old — need ≥ 3.10" 3
echo "   url=$BOARD_URL name=$EXEC_NAME harness=$HARNESS host=$HOST_NAME"

# ------------------------------------------------------------- lab CA pin
# A pre-placed CA short-circuits the network fetch entirely (the strictest
# path: the owner copied it out-of-band per REMOTE-EXECUTOR.md §3).
if [[ -s "$CA_FILE" ]]; then
  step "TLS: using the pre-placed CA at $CA_FILE (no -k window at all)"
else
  step "TLS: fetching the lab CA from the board"
  if ! curl -fsSL --cacert "$CA_FILE" "$BOARD_URL/api/poller/artifacts/ca.crt" \
        -o "$CA_FILE" 2>/dev/null; then
    # Expected on first contact: the lab cert is self-signed, this shell
    # does not trust it yet. ONE retry with -k, STRICTLY for the CA fetch —
    # a certificate is public material, and everything AFTER this point
    # (artifacts, registration, the poller itself) rides the PINNED CA.
    echo "   no system trust for the lab cert — one -k retry for the CA ONLY"
    curl -fsSL -k "$BOARD_URL/api/poller/artifacts/ca.crt" -o "$CA_FILE" \
      || die "could not download the CA even with -k — is --url reachable from this machine?" 3
    openssl x509 -in "$CA_FILE" -noout -text 2>/dev/null | grep -q "CA:TRUE" \
      || { rm -f "$CA_FILE"; die "downloaded cert is not a CA (basicConstraints) — refusing to pin it" 3; }
    FPR=$(openssl x509 -in "$CA_FILE" -noout -fingerprint -sha256 | cut -d= -f2)
    echo "   CA fingerprint (SHA256): $FPR"
    echo "   >>> VERIFY this fingerprint with the board owner over a personal"
    echo " >>> channel before continuing — everything below pins THIS CA."
  fi
  chmod 0644 "$CA_FILE"
fi
CURL_CA=(--cacert "$CA_FILE")

# ------------------------------------------------------- deps (venv, PEP 668)
step "python venv + dependencies"
python3 -m venv "$VENV_DIR" || die "could not create the venv at $VENV_DIR (install python3-venv)" 3
"$VENV_DIR/bin/pip" install --quiet --no-cache-dir httpx pyyaml \
  || die "pip install failed (httpx, pyyaml)" 3

# ---------------------------------------------------------------- register
# Idempotency: a SPENT token (410) with an existing install means UPDATE —
# registration is skipped, artifacts are refreshed, the user's allowlist
# and executor_id are preserved below.
step "registering the executor on the board"
UPDATE_MODE=0
EXEC_ID="" SECRET=""
HTTP_BODY=$(mktemp)
HTTP_CODE=$(curl "${CURL_CA[@]}" -fsS -o "$HTTP_BODY" -w '%{http_code}' \
  -X POST "$BOARD_URL/api/executors" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$EXEC_NAME\",\"harness\":\"$HARNESS\",\"host\":\"$HOST_NAME\",\"transport\":\"local-poll\"}" \
  || true)
if [[ "$HTTP_CODE" == "201" ]]; then
  EXEC_ID=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["executor"]["id"])' < "$HTTP_BODY")
  SECRET=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["executor_secret"])' < "$HTTP_BODY")
  echo "   registered: $EXEC_ID ($EXEC_NAME) — state pending, awaits owner approval"
elif [[ "$HTTP_CODE" == "409" ]]; then
  die "name '$EXEC_NAME' is already registered on the board — re-run with --name <other>" 4
elif [[ "$HTTP_CODE" == "422" ]]; then
  die "harness '$HARNESS' is not in the board dictionary — add it in the UI (Реестр → harness combobox) and re-run" 4
elif [[ "$HTTP_CODE" == "410" || "$HTTP_CODE" == "401" ]]; then
  if [[ -f "$MARKER_FILE" && -f "$ENV_FILE" && -f "$YAML_FILE" ]]; then
    step "token already spent + existing install found → UPDATE path"
    UPDATE_MODE=1
  else
    die "token expired/used and no existing install found — mint a NEW enrollment token on the board and re-run" 4
  fi
elif [[ "$HTTP_CODE" == "429" ]]; then
  die "rate limited (10/60 s) or pending-executor cap reached — wait and re-run" 4
else
  die "registration failed (HTTP ${HTTP_CODE:-transport-error}): $(head -c 200 "$HTTP_BODY")" 4
fi
rm -f "$HTTP_BODY"

if [[ "$UPDATE_MODE" -eq 1 ]]; then
  EXEC_ID=$(python3 -c 'import json; print(json.load(open("'"$MARKER_FILE"'"))["executor_id"])')
  PRESERVE_AWL=$(awk '/^allowlist:/{p=1} p' "$YAML_FILE" || true)
fi

# ------------------------------------------------------------ artifacts
step "fetching runtime artifacts (pinned TLS)"
curl "${CURL_CA[@]}" -fsSL "$BOARD_URL/api/poller/artifacts/poller.py" -o "$POLLER_PY" \
  || die "could not download poller.py" 3
chmod 0755 "$POLLER_PY"
UNIT_DL=$(mktemp)
curl "${CURL_CA[@]}" -fsSL "$BOARD_URL/api/poller/artifacts/vesmaro-assignment-poller.service" -o "$UNIT_DL" \
  || die "could not download the systemd unit" 3
# Adapt the repo unit to THIS machine: run as the invoking sudo user (not a
# hardcoded laptop user), config at /etc/vesmaro, state under $STATE_DIR.
RUN_USER="${SUDO_USER:-root}"
sed -e "s|^User=.*|User=$RUN_USER|" \
    -e "s|--config [^ ]*|--config $YAML_FILE|" \
    -e "s|^ReadWritePaths=.*|ReadWritePaths=$STATE_DIR|" \
    "$UNIT_DL" > "$UNIT_FILE"
rm -f "$UNIT_DL"
chmod 0644 "$UNIT_FILE"
mkdir -p "$STATE_DIR"
chown "$RUN_USER:" "$STATE_DIR" 2>/dev/null || true

# ------------------------------------------------------------ secrets+config
step "writing $ENV_FILE and $YAML_FILE (0600)"
if [[ "$UPDATE_MODE" -ne 1 ]]; then
  install -m 0600 -o root -g root /dev/null "$ENV_FILE"
  # The secret NEVER echoes to stdout and NEVER lands in the yaml.
  printf 'VESMARO_BOARD_TOKEN=%s\n' "$SECRET" > "$ENV_FILE"
fi

if [[ "$UPDATE_MODE" -eq 1 && -n "${PRESERVE_AWL:-}" ]]; then
  # Managed keys are rewritten; the user-owned allowlist block survives.
  { cat <<YAML
# vesmaro-eyes poller config — MANAGED KEYS rewritten by bootstrap.sh;
# everything from 'allowlist:' down is USER-OWNED and survives re-runs.
board_url: $BOARD_URL
executor_id: $EXEC_ID
executor_name: $EXEC_NAME
poll_interval: 10
poll_jitter: 2
heartbeat_interval: 60
max_concurrent: 2
ca_bundle: $CA_FILE
YAML
    printf '%s\n' "$PRESERVE_AWL"
  } > "$YAML_FILE.new"
else
  cat > "$YAML_FILE.new" <<YAML
# vesmaro-eyes poller config — MANAGED KEYS rewritten by bootstrap.sh;
# everything from 'allowlist:' down is USER-OWNED and survives re-runs.
board_url: $BOARD_URL
executor_id: $EXEC_ID
executor_name: $EXEC_NAME
poll_interval: 10
poll_jitter: 2
heartbeat_interval: 60
max_concurrent: 2
ca_bundle: $CA_FILE
# A3 allowlist — THE launch gate. The seed below is an HONEST STUB: the
# command is a placeholder, every assignment is refused (fail-closed,
# one refusal-report per task) until you edit it to a REAL command and
# restart the unit. Nomination on the board does NOT execute here.
allowlist:
  - harness: $HARNESS
    command:
      - $HARNESS
    specialists:
      - "*"
YAML
fi
[[ "$UPDATE_MODE" -eq 1 ]] && cp "$YAML_FILE" "$YAML_FILE.bak"
mv "$YAML_FILE.new" "$YAML_FILE"
chmod 0600 "$YAML_FILE"

python3 -c 'import json,sys; json.dump({"executor_id": sys.argv[1], "board_url": sys.argv[2], "harness": sys.argv[3], "name": sys.argv[4]}, open(sys.argv[5], "w"))' \
  "$EXEC_ID" "$BOARD_URL" "$HARNESS" "$EXEC_NAME" "$MARKER_FILE"

# ---------------------------------------------------------------- systemd
step "systemd unit"
systemctl daemon-reload || die "daemon-reload failed" 5
if [[ "$UPDATE_MODE" -eq 1 ]]; then
  systemctl restart vesmaro-assignment-poller || die "restart failed — journalctl -u vesmaro-assignment-poller" 5
else
  systemctl enable --now vesmaro-assignment-poller || die "enable --now failed — journalctl -u vesmaro-assignment-poller" 5
fi

# ---------------------------------------------------------------- verdict
# The board cannot ping the executor (outbound-only, ADR 0009 §9) — the
# verdict is the executor's registry state + presence clock, honestly read
# back a couple of poll cycles later.
step "verdict (waiting ~16 s for the first poll cycles)"
sleep 16
# Quoted heredoc: the python snippet keeps both quote styles untouched.
VERDICT_PY=$(cat <<'PY'
import json, sys
rows = json.load(sys.stdin)["items"]
row = next((r for r in rows if r["id"] == sys.argv[1]), None)
print(f'{row["state"]}|{row["enabled"]}|{row["presence"]}' if row else "unknown|false|offline")
PY
)
STATE=$(curl "${CURL_CA[@]}" -fsSL "$BOARD_URL/api/executors" 2>/dev/null \
  | python3 -c "$VERDICT_PY" "$EXEC_ID" 2>/dev/null) || STATE="unknown|false|offline"
[[ -n "$STATE" ]] || STATE="unknown|false|offline"
IFS='|' read -r R_STATE R_ENABLED R_PRESENCE <<<"$STATE"
if [[ "$R_STATE" == "pending" ]]; then
  echo "READY-ISH: registered and polling — NOW APPROVE IT ON THE BOARD:"
  echo "  Реестр → $EXEC_NAME → Подтвердить (approve) → Включить (enable)."
elif [[ "$R_STATE" == "approved" && "$R_ENABLED" != "True" ]]; then
  echo "ALMOST: approved but DISABLED — flip the Включить toggle in the registry."
elif [[ "$R_STATE" == "approved" && "$R_ENABLED" == "True" && "$R_PRESENCE" == "online" ]]; then
  echo "DONE: $EXEC_NAME is approved, enabled and ONLINE — ready for assignments."
elif [[ "$R_STATE" == "revoked" ]]; then
  echo "WARNING: the executor is REVOKED on the board — it will not poll."
else
  echo "REGISTERED BUT NOT SEEN YET (presence: $R_PRESENCE)."
  echo "  Check: --url resolves from THIS machine (VPN overlay?);"
  echo "  journalctl -u vesmaro-assignment-poller -f;"
  echo "  the empty executor_id is the classic cause — it is set in $YAML_FILE."
fi
echo
echo "NEXT (mandatory): edit $YAML_FILE → allowlist → put the REAL harness"
echo "command there (the seed is a stub) → systemctl restart vesmaro-assignment-poller."
echo "Registry row: $BOARD_URL (Реестр) · re-run this script to UPDATE artifacts."
exit 0
