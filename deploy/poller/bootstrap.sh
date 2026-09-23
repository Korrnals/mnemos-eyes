#!/usr/bin/env bash
# vesmaro-eyes poller bootstrap — the ONE-COMMAND onboarding (wave 3D).
#
#   curl -kfsSL https://<board>/api/poller/bootstrap.sh | sudo bash -s -- \
#     --url https://<board> --token mne_… [--name vps-1] [--harness zcode]
#
# The OUTER -k is honest and bounded: the installer TEXT is public and
# secret-free, and the lab TLS is self-signed — the shell does not trust
# it yet (that is the chicken-and-egg this script exists to break). The
# content rides TLS to the board it names; EVERYTHING the script does
# afterwards (artifacts, registration, the poller itself) uses the
# PINNED lab CA fetched through it, with the sha256 fingerprint printed
# for the out-of-band owner check. Paranoid two-step (fetch, READ, then
# bash) — see REMOTE-EXECUTOR.md, Путь 1.
#
# What it does, in order: parse/sanity args → preflight (python ≥ 3.10,
# systemd, curl, openssl) → fetch the lab CA (ONE -k retry for the CA ONLY)
# → TRUST ANCHOR (AGW-9, АРХКОМ-8 В1): the CA fingerprint is verified
# against --expect-fp / VESMARO_EXPECT_FP silently (mismatch = abort,
# downloaded CA discarded), or printed for an out-of-band owner check with
# a STRICT /dev/tty prompt (stdin is the curl pipe); no anchor and no tty
# = abort. A pre-placed /etc/vesmaro/lab-ca.crt short-circuits the -k
# path (placement IS the out-of-band act) but still must match --expect-fp
# when one is given → venv + deps → artifacts over PINNED TLS → register
# with the enrollment token → write 0600 env + yaml (allowlist is an
# honest fail-closed SEED — edit it) → systemd system unit → verdict.
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
EXPECT_FP="${VESMARO_EXPECT_FP:-}"   # --expect-fp wins over the env synonym
BASE_DIR="/opt/mnemos-eyes"
VENV_DIR="$BASE_DIR/venv"
POLLER_PY="$BASE_DIR/assignment_poller.py"
ENV_FILE="/etc/vesmaro/poller.env"
YAML_FILE="/etc/vesmaro/poller.yaml"
MARKER_FILE="/etc/vesmaro/poller-bootstrap.json"
# VESMARO_CA_FILE: non-standard CA location knob (also keeps the test
# contour off /etc) — the pre-placed path reads the same variable.
CA_FILE="${VESMARO_CA_FILE:-/etc/vesmaro/lab-ca.crt}"
UNIT_FILE="/etc/systemd/system/vesmaro-assignment-poller.service"
STATE_DIR="/var/lib/vesmaro-eyes"

usage() {
  cat <<'USAGE'
Usage: bootstrap.sh --url <board-url> --token mne_… [--name NAME] [--harness NAME] [--host HOST]
                    [--expect-fp SHA256:<fingerprint>]

  --url      board base URL as seen FROM THIS MACHINE (VPN overlay address
             if that is what resolves here — may differ from the LAN one)
  --token    one-time enrollment token (mne_…, TTL 15 min, single use);
             mint it on the board: Реестр → Добавить исполнителя
  --name     executor name (default: this hostname)
  --harness  harness id from the board's harness dictionary (default: zcode)
  --host     declared host string (default: this hostname)
  --expect-fp  TRUST ANCHOR (AGW-9): the expected lab-CA fingerprint in the
             board canon (SHA256:base64, what the enrollment screen shows
             as ca_fingerprint; a bare hex64 or sha256:-prefixed form is
             accepted too). Given → the fetched/pre-placed CA is verified
             SILENTLY; mismatch = abort, downloaded CA discarded.
             Env synonym: VESMARO_EXPECT_FP. Without an anchor the script
             prints the fingerprint and asks you to type the owner-confirmed
             value on /dev/tty (no tty + no anchor = abort).

Re-run behaviour: with an already-spent token and an existing install the
script takes the UPDATE path (fresh artifacts, your allowlist preserved).
Exit codes: 0 ok · 2 args · 3 environment · 4 registration refused ·
5 install/systemd.
USAGE
}

die() { echo "bootstrap: $1" >&2; exit "${2:-1}"; }
step() { echo "== $1"; }

# --------------------------------------------------- fingerprint helpers
# The board canon (server/provisioner.py fingerprint_of_bytes — the
# ssh-keygen standard): 'SHA256:' + UNPADDED base64 of sha256(DER).
# Computed over the DER form, never over the PEM text.
ca_fingerprint() {
  local b64
  b64=$(openssl x509 -in "$1" -outform DER 2>/dev/null \
    | openssl dgst -sha256 -binary \
    | openssl base64 -A) || return 1
  # '=' appears in base64 ONLY as trailing padding — strip at the first.
  printf 'SHA256:%s' "${b64%%=*}"
}

# Canonical form of an owner-supplied fingerprint (provisioner
# normalize_fingerprint parity): SHA256:base64(43), sha256:/SHA256: hex64
# or bare hex64 — the hex digest is re-ENCODED, never re-hashed. Prints
# the canon form; exits non-zero on garbage. python3 is guaranteed here
# by the preflight (the anchor runs after it).
normalize_fp() {
  python3 - "$1" <<'PY'
import base64, re, sys
fp = re.sub(r"\s+", "", (sys.argv[1] if len(sys.argv) > 1 else ""))
body = fp[7:] if fp[:7].lower() == "sha256:" else fp
if re.fullmatch(r"[A-Za-z0-9+/]{43}", body):
    print("SHA256:" + body)
elif re.fullmatch(r"[a-fA-F0-9]{64}", body):
    print("SHA256:" + base64.b64encode(
        bytes.fromhex(body.lower())).decode().rstrip("="))
else:
    sys.exit(2)
PY
}

# ------------------------------------------------------------ parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) BOARD_URL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --name) EXEC_NAME="${2:-}"; shift 2 ;;
    --harness) HARNESS="${2:-}"; shift 2 ;;
    --host) HOST_NAME="${2:-}"; shift 2 ;;
    --expect-fp) EXPECT_FP="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[[ -n "$BOARD_URL" ]] || { echo "--url is required" >&2; usage; exit 2; }
[[ -n "$TOKEN" ]] || { echo "--token is required (mne_…, minted on the board)" >&2; usage; exit 2; }
[[ "$TOKEN" =~ ^mne_[A-Za-z0-9_-]+$ ]] || die "--token must look like mne_… (got a different shape) — mint a one-time enrollment token on the board" 2
[[ "$BOARD_URL" =~ ^https:// ]] || die "--url must be https:// (the board is never plain HTTP)" 2
# Shape-check the anchor NOW (before any network): SHA256:base64(43) or a
# hex64, with an optional case-insensitive sha256: prefix. Full
# normalization happens in the TLS section (python3 is preflight-gated).
if [[ -n "$EXPECT_FP" && ! "$EXPECT_FP" =~ ^([Ss][Hh][Aa]256:)?([A-Za-z0-9+/]{43}|[a-fA-F0-9]{64})[[:space:]]*$ ]]; then
  die "--expect-fp must be SHA256:<base64> or a <hex64> digest (the board's enrollment screen prints the canon form) — got a different shape" 2
fi
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
CA_SRC="pre-placed"
if [[ -s "$CA_FILE" ]]; then
  step "TLS: using the pre-placed CA at $CA_FILE (no -k window at all)"
else
  step "TLS: fetching the lab CA from the board"
  CA_SRC=""
  # First attempt is the honest system-trust one (machines that already
  # trust the lab CA take a zero-(-k) path); --cacert on a not-yet-existing
  # file would fail LOCALLY (exit 77) before any connection, so it is used
  # only from the second attempt on. ONE retry with -k, STRICTLY for the
  # CA fetch — a certificate is public material, and everything AFTER this
  # point (artifacts, registration, the poller itself) rides the PINNED CA.
  if curl -fsSL "$BOARD_URL/api/poller/artifacts/ca.crt" \
        -o "$CA_FILE" 2>/dev/null; then
    CA_SRC="system-trust"
  else
    echo "   no system trust for the lab cert — one -k retry for the CA ONLY"
    curl -fsSL -k "$BOARD_URL/api/poller/artifacts/ca.crt" -o "$CA_FILE" \
      || die "could not download the CA even with -k — is --url reachable from this machine?" 3
    CA_SRC="-k"
  fi
  # Whatever TLS carried it, this file becomes THE pin — only a real CA
  # gets pinned (a served leaf/EE cert would break every later handshake).
  openssl x509 -in "$CA_FILE" -noout -text 2>/dev/null | grep -q "CA:TRUE" \
    || { rm -f "$CA_FILE"; die "downloaded cert is not a CA (basicConstraints) — refusing to pin it" 3; }
  chmod 0644 "$CA_FILE"
fi

# ------------------------------------------- trust anchor (AGW-9, АРХКОМ-8 В1)
# The pinned CA must BE the board's CA. Fingerprint canon = the board's
# (SHA256:base64 over DER, provisioner parity). Hierarchy, fail-closed:
#   (1) --expect-fp / VESMARO_EXPECT_FP given → SILENT verify; mismatch =
#       abort, a DOWNLOADED CA is discarded (a pre-placed one stays on
#       disk — it is the owner's file — but the install still aborts);
#   (2) no anchor → the fingerprint is printed for the out-of-band owner
#       check and confirmed by TYPING it on /dev/tty (stdin is the curl
#       pipe); empty answer / EOF / mismatch = abort (CA discarded);
#   (3) no anchor and no /dev/tty = abort — an unattended install must
#       carry the anchor explicitly, never skip the check.
# The pre-placed path skips the interactive prompt (placement IS the
# out-of-band act) but never skips an explicit --expect-fp.
if ! CA_FP="$(ca_fingerprint "$CA_FILE")" || [[ -z "$CA_FP" ]]; then
  die "could not compute the fingerprint of $CA_FILE — not a readable certificate (aborting before anything is pinned)" 3
fi
if [[ -n "$EXPECT_FP" ]]; then
  if ! EXPECTED_FP="$(normalize_fp "$EXPECT_FP")"; then
    die "--expect-fp could not be normalized (internal shape check passed, normalization failed) — aborting" 2
  fi
  if [[ "$CA_FP" != "$EXPECTED_FP" ]]; then
    [[ "$CA_SRC" == "pre-placed" ]] || rm -f "$CA_FILE"
    die "CA fingerprint MISMATCH: expected $EXPECTED_FP, got $CA_FP — refusing to pin a CA the anchor does not name ($CA_SRC CA discarded; check --expect-fp or the board's certificate)" 3
  fi
  echo "   CA fingerprint verified against the anchor: $CA_FP"
else
  echo "   CA fingerprint (canon):   $CA_FP"
  echo "   CA fingerprint (openssl): SHA256:$(openssl x509 -in "$CA_FILE" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2)"
  if [[ "$CA_SRC" == "pre-placed" ]]; then
    echo "   (pre-placed CA — placement was the out-of-band act, no prompt)"
  else
    echo "   >>> VERIFY this fingerprint with the board owner over a personal"
    echo "   >>> channel, then TYPE it below to continue — everything below pins THIS CA."
    # NB: a permission test ([[ -r /dev/tty ]]) LIES in a session without a
    # controlling terminal (the check passes, open() then fails ENXIO) —
    # the honest probe is the open itself. The { } block keeps the error
    # suppression TEMPORARY: a bare `exec 3</dev/tty 2>/dev/null` would
    # silence the shell's stderr FOREVER on success (found by the pty
    # harness — every later die() line would have vanished).
    if ! { exec 3</dev/tty; } 2>/dev/null; then
      rm -f "$CA_FILE"
      die "no --expect-fp and no usable /dev/tty — the CA fingerprint cannot be confirmed out-of-band. Re-run with --expect-fp SHA256:<fp> (env VESMARO_EXPECT_FP; the board's enrollment screen prints it as ca_fingerprint), or pre-place the CA at $CA_FILE (REMOTE-EXECUTOR.md §3)" 3
    fi
    CONFIRM=""
    if ! read -r CONFIRM <&3; then
      exec 3<&-
      rm -f "$CA_FILE"
      die "could not read the fingerprint confirmation from /dev/tty — aborting (downloaded CA discarded)" 3
    fi
    exec 3<&-
    if ! CONFIRM_FP="$(normalize_fp "$CONFIRM")" || [[ "$CONFIRM_FP" != "$CA_FP" ]]; then
      rm -f "$CA_FILE"
      die "fingerprint confirmation does not match — aborting (downloaded CA discarded). Type the fingerprint exactly as the board owner gives it; empty Enter is a refusal" 3
    fi
    echo "   fingerprint confirmed by the operator — pinning THIS CA"
  fi
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
# The body is built by python3 (already validated by the preflight): raw
# shell interpolation would mangle any quote into a misleading 422.
REG_BODY=$(python3 -c 'import json, sys
print(json.dumps({"name": sys.argv[1], "harness": sys.argv[2],
                  "host": sys.argv[3], "transport": "local-poll"}))' \
  "$EXEC_NAME" "$HARNESS" "$HOST_NAME")
HTTP_CODE=$(curl "${CURL_CA[@]}" -fsS -o "$HTTP_BODY" -w '%{http_code}' \
  -X POST "$BOARD_URL/api/executors" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$REG_BODY" \
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
  MARKER_URL=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("board_url", ""))' "$MARKER_FILE")
  if [[ -n "$MARKER_URL" && "$MARKER_URL" != "$BOARD_URL" ]]; then
    die "this install was bootstrapped against $MARKER_URL, but --url is $BOARD_URL — keeping the old executor_secret would mean an eternal 401. Rotate instead: revoke + delete the executor on the board, then re-run with a NEW token" 4
  fi
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
# hardcoded laptop user), config at /etc/vesmaro, state under $STATE_DIR —
# and the ExecStart poller path to where THIS script put the artifact
# ($POLLER_PY): the repo unit names the laptop layout
# (/opt/mnemos-eyes/scripts/...), nobody creates that scripts/ dir here —
# an unpatched ExecStart is a guaranteed 203/EXEC at first start.
RUN_USER="${SUDO_USER:-root}"
sed -e "s|^User=.*|User=$RUN_USER|" \
    -e "s|--config [^ ]*|--config $YAML_FILE|" \
    -e "s|^ReadWritePaths=.*|ReadWritePaths=$STATE_DIR|" \
    -e "s|/opt/mnemos-eyes/scripts/assignment_poller.py|$POLLER_PY|" \
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
