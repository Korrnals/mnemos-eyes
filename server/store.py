"""vesmaro-eyes task board — persistent SQLite layer.

The board is deliberately a thin projection over two sources of truth:

1. Its own SQLite store (on a mounted volume) holding board tasks.
2. The live mnemos memory engine, which the server reaches over HTTP
   (in-cluster service DNS in the ai-agent cluster, loopback in dev).

Task state mirrors the mnemos workflow state machine
(``open → in-progress → blocked / resolved / done / withdrawn``) so a task
and a memory speak the same lifecycle language.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .security import mask_secrets

# WF-1: board columns in display order — two pre-validation lanes
# (backlog, validating) join the kanban left of `open`
# (workflow-lifecycle-proposal §3). They are BOARD stages, not workflow
# statuses: both map onto the mnemos status `open` (see COLUMN_STATUS_MAP).
TASK_COLUMNS: tuple[str, ...] = (
    "backlog", "validating", "open", "in-progress", "blocked", "resolved", "done",
)
# Values valid for the ``col`` field (the kanban projection).
VALID_STATUSES = frozenset(TASK_COLUMNS)
# BE-10: per-task status dictionary = the mnemos workflow state machine.
# `withdrawn` is a terminal mnemos status with no board column (cancelled
# tasks are archived instead — WF-1 proposal §7). Validated on create and
# PATCH; `col` remains the kanban projection (see move_task).
TASK_STATUSES = frozenset({"open", "in-progress", "blocked", "resolved",
                           "done", "withdrawn"})
# WF-1 (proposal §5): board column → workflow status. The pre-validation
# lanes read as `open` (work has not started); the stage distinction lives
# in the column itself and the task:stage:* mnemos tags, never in the
# status dictionary.
COLUMN_STATUS_MAP: dict[str, str] = {
    "backlog": "open", "validating": "open", "open": "open",
    "in-progress": "in-progress", "blocked": "blocked",
    "resolved": "resolved", "done": "done",
}
# WF-1 validation lane (proposal §4/§6): entering `validating` starts a
# 24h wall clock (``validating_since`` — restart-safe, wall-clock based).
# On timeout the background sweep flags the task for the architectural
# committee; it NEVER moves the task (the decision is human).
VALIDATING_WINDOW_S = 24 * 3600.0
ARCHCOM_REVIEW_TAG = "task:stage:archcom-review"
# WF-1 v1 transition mirror (proposal §4.3, minimal): a blocked task may
# not jump straight to a resolution column — the block must lift first
# (blocked → in-progress → resolved → done). Everything else stays free:
# the owner is free to move tasks; a full state machine is a later phase.
BLOCKED_DIRECT_TARGETS = frozenset({"done", "resolved"})


class InvalidTransitionError(Exception):
    """WF-1: a column move the transition mirror forbids (HTTP 422
    upstream). v1 guards only blocked → done / blocked → resolved."""
# BE-11a: agent report kinds for a task.
REPORT_KINDS = ("intermediate", "final")
VALID_ENVS = frozenset({"cluster", "laptop", "local", "cloud", "unknown"})
# BE-12: task priority dictionary. `normal` is both the API default and the
# column DEFAULT, so pre-migration rows read `normal` with no backfill.
TASK_PRIORITIES = frozenset({"critical", "high", "normal", "low"})
# BE-12: content fields guarded by the 24h edit window. `status` is
# deliberately NOT here: status changes are workflow transitions (column
# moves, UI-8 «Вернуть в работу» → PATCH status), free at any task age —
# only CONTENT edits lock after 24h. `col`/`position` were never patchable
# (they change via POST /move); `archived`/`id`/`created_at` are managed
# exclusively by the archive/create machinery.
EDITABLE_FIELDS = frozenset({
    "title", "summary", "spec", "project", "env", "priority",
    "agents", "specialists", "memory_ids", "mnemos_tags",
})
# Age (seconds) after which EDITABLE_FIELDS edits require force=True.
EDIT_WINDOW_SECONDS = 24 * 3600


class TaskLockedError(Exception):
    """BE-12: a content edit hit the 24h edit window (HTTP 423 upstream).
    Retry the same PATCH with force=True to override; the override is
    recorded in the task.updated audit event (payload forced=true)."""


# --------------------------------------------------------- assignments
# ADR 0009 (variant A′): an assignment is ONE EXECUTION ATTEMPT on a task
# (task : assignment = 1 : N, CI-run semantics). ``active`` = non-terminal
# state; the ≤1-active-per-task invariant is enforced in create_assignment
# and surfaces as HTTP 409 upstream.
ASSIGNMENT_STATES = frozenset({
    "queued", "claimed", "running", "done", "failed", "cancelled", "expired",
})
ACTIVE_ASSIGNMENT_STATES = ("queued", "claimed", "running")
# Task workflow statuses an assignment can NOT be created for. ``blocked``
# is deliberately NOT terminal — a blocked task can be re-taken into work.
TERMINAL_TASK_STATUSES = frozenset({"resolved", "done", "withdrawn"})
# ADR 0009 §9: snapshot cap 16K with plain truncation. spec_hash covers the
# FULL spec (not the truncated copy), so the audit trail identifies the
# exact content version the owner nominated.
SPEC_SNAPSHOT_CAP = 16384
# ADR 0009 §10 (phase 3 reaper): wall-clock deadlines. claimed without a
# start for > 10 min, or running without a heartbeat for > 30 min → expired.
# Stagnation (queued, nobody claims) is notification-only after 30 min.
REAP_CLAIM_AFTER_S = 600.0
REAP_HEARTBEAT_AFTER_S = 1800.0
REAP_QUEUED_AFTER_S = 1800.0


class AssignmentError(Exception):
    """Base class for assignment lifecycle violations (ADR 0009)."""


class AssignmentNotFoundError(AssignmentError):
    """Unknown assignment id (HTTP 404 upstream)."""


class AssignmentConflictError(AssignmentError):
    """State/invariant violation: CAS lost, wrong source state, or the task
    already has an active assignment (HTTP 409 upstream)."""


class AssignmentTokenError(AssignmentError):
    """claim_token / claimed_by mismatch (HTTP 403 upstream). The token is a
    correctness boundary — a stale poller must not finish a re-claimed
    assignment — not a security boundary (ADR 0009 §3)."""


class TaskNotAssignableError(AssignmentError):
    """Target task is archived or workflow-terminal (HTTP 422 upstream)."""


class UnknownHarnessError(AssignmentError):
    """Nomination references a harness absent from the dictionary (wave 3C;
    HTTP 422 upstream). Raised from the IN-TRANSACTION assignment core so
    every minting window is gated — the UI route, the manual run-now and
    any future S2 engine mint through the same private code path."""


# ----------------------------------------------------------- executors
# ARCH-9 (ADR 0009 Amendment 2 §3-§4): the executor registry — the third
# entity (specialist ≠ harness ≠ executor). Registry state model is
# pending → approved → revoked (owner-approval identity gate; routing
# considers approved+enabled only). Presence is COMPUTED on read from the
# last_seen TTL — there is no presence column and the background sweeper
# NEVER mutates executor rows.
EXECUTOR_STATES = frozenset({"pending", "approved", "revoked"})
EXECUTOR_TRANSPORTS = frozenset({"local-poll", "mesh-r4"})
# Two-clock discipline (Amd 2 §6): these thresholds read ONLY executor
# clocks (executors.last_seen); the ARCH-7 reaper reads only assignment
# clocks. Initial values per the АРХКОМ-4 verdict: online ≤ 2 min,
# stale 2–10 min, offline > 10 min. Server-documented constants — the API
# exposes them in GET /api/executors meta so clients never hardcode.
PRESENCE_ONLINE_S = 120.0
PRESENCE_STALE_S = 600.0


class ExecutorError(Exception):
    """Base class for executor-registry violations (ARCH-9)."""


class ExecutorNotFoundError(ExecutorError):
    """Unknown executor id (HTTP 404 upstream)."""


class ExecutorConflictError(ExecutorError):
    """Registry invariant violation — duplicate name (HTTP 409 upstream)."""


class ExecutorStateError(ExecutorError):
    """Illegal registry-state transition (HTTP 409 upstream). ``revoked``
    is terminal: a revoked secret must not be resurrected by re-approval —
    re-registration is the path (kill-switch semantics, Amd 2 §5)."""


class ExecutorQuotaError(ExecutorError):
    """Open-pending registry quota exhausted (HTTP 429 upstream — a
    resource guard, same class as rate limits, not a conflict)."""


# F5 (security review PR #18): a machine-token holder can mint pending
# registrations without a total cap (the 10/60s/IP limiter bounds pace,
# not volume). Cap the OPEN pending backlog; approving/revoking/deleting
# frees quota. Constant, not config — it is an abuse ceiling, not a
# deployment knob.
EXECUTOR_PENDING_CAP = 20


# Harness dictionary (wave 3C): nomination-hygiene constants. The name
# pattern keeps the value safe everywhere it lands (rules/conditions,
# audit payloads, URLs, UI) — lowercase [a-z0-9] head, then [a-z0-9._-].
HARNESS_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,59}$")
# Dictionary ceiling: a sane select list and a junk-abuse bound. A cap hit
# is a 422 (entry validation), not a 429 — the dictionary is not a rate
# resource, it is a form the owner controls.
HARNESS_MAX_COUNT = 64


class HarnessError(Exception):
    """Base class for harness-dictionary violations (wave 3C)."""


class HarnessNotFoundError(HarnessError):
    """Unknown harness name (HTTP 404 upstream)."""


class HarnessConflictError(HarnessError):
    """Duplicate harness name (HTTP 409 upstream)."""


class HarnessInUseError(HarnessError):
    """Harness still referenced by an executor, an active assignment or an
    automation rule — deletion refused (HTTP 409 upstream). History
    (terminal assignments, journal rows) deliberately does NOT block:
    it is archival and stays verbatim."""


class HarnessQuotaError(HarnessError):
    """Dictionary ceiling reached (HTTP 422 upstream — entry validation,
    same class as a bad name, not a rate guard)."""


def presence_from_last_seen(last_seen: str) -> str:
    """Computed presence (Amd 2 §6): ``online`` when last_seen is younger
    than PRESENCE_ONLINE_S, ``stale`` up to PRESENCE_STALE_S, ``offline``
    beyond — never-heartbeated (``''``) included. Reads only the executor
    clock; never persisted."""
    if not last_seen:
        return "offline"
    age = _age_seconds(last_seen)
    if age <= PRESENCE_ONLINE_S:
        return "online"
    if age <= PRESENCE_STALE_S:
        return "stale"
    return "offline"


# ------------------------------------------------------------- pairing (CV-7)
# ADR 0012: QR pairing + device tokens (mnd_). The pairing code is a
# 128-bit urlsafe single-use secret with a 3-minute TTL; the DB keeps ONLY
# its sha256 (hash-only, ADR §5/§10.1). Device tokens share the
# hash-only discipline (sha256, no salt — the token is 192-bit random,
# unsalted sha256 is the ADR-ratified choice and matches executors).
PAIRING_TTL_S = 180.0                 # one TTL for code/QR/verify (§6)
PAIRING_VERIFY_DIGITS = 4             # anti-mistake screen check (§3.5)
DEVICE_MAX_ACTIVE = 5                 # ≤5 active device sessions (§5)
DEVICE_SLIDING_TTL_S = 30 * 86400.0   # sliding expiry while active (§5)
DEVICE_HARD_TTL_S = 90 * 86400.0      # absolute cap regardless of activity
DEVICE_TOKEN_PREFIX = "mnd_"
PAIRING_STATES = frozenset({
    "created", "scanned", "confirmed", "issued", "expired", "revoked",
})
# Pairing states that can still move (TTL-sweep candidates).
PAIRING_LIVE_STATES = ("created", "scanned", "confirmed")


class PairingError(Exception):
    """Base class for pairing-lifecycle violations (ADR 0012)."""


class PairingNotFoundError(PairingError):
    """Unknown pairing id or code (HTTP 404 upstream — never distinguishes
    the two on the unauthenticated exchange leg)."""


class PairingStateError(PairingError):
    """Illegal pairing-state transition (HTTP 409 upstream; on the exchange
    leg the handler re-reads the row and answers by its CURRENT state)."""


class PairingExpiredError(PairingError):
    """Pairing past its TTL or already consumed (HTTP 410 upstream)."""


class DeviceError(Exception):
    """Base class for device-session violations (ADR 0012 §5)."""


class DeviceNotFoundError(DeviceError):
    """Unknown device id (HTTP 404 upstream)."""


class DeviceQuotaError(DeviceError):
    """≤5-active-device quota exhausted (HTTP 409 upstream — the owner must
    choose explicitly; auto-eviction is FORBIDDEN by ADR §5)."""


# ---------------------------------------------------- enrollment (ADR 0009 Amd 2 §4 supplement)
# One-time registration tokens for REMOTE executors (rented VPS): the owner
# mints an ``mne_``-prefixed secret from the UI; the executor presents it on
# POST /api/executors and receives its own executor_secret. Scope is
# REGISTRATION ONLY — a leaked token yields at most one PENDING executor the
# owner must still approve (never the machine loop). Mirror of the pairing
# pattern (ADR 0012): hash-only storage, single TTL, single-use CAS, audit
# without material. The plaintext exists exactly once, in the POST response.
ENROLLMENT_TTL_S = 900.0              # 15 min: ssh/copy-paste slack (design §11-2)
ENROLLMENT_TOKEN_PREFIX = "mne_"
ENROLLMENT_MAX_LIVE = 3               # live (created) tokens; 4th → 409, NO auto-revoke
ENROLLMENT_STATES = frozenset({"created", "used", "expired", "revoked"})
ENROLLMENT_LIVE_STATES = ("created",)  # TTL-sweep candidates


class EnrollmentError(Exception):
    """Base class for enrollment-token lifecycle violations."""


class EnrollmentNotFoundError(EnrollmentError):
    """Unknown enrollment id (HTTP 404 upstream — the ui leg only; the
    registration leg answers 401 for an unknown bearer, never 404)."""


class EnrollmentStateError(EnrollmentError):
    """Illegal enrollment-state transition (HTTP 409 on the ui revoke leg;
    HTTP 410 on the registration leg — the token is spent/dead)."""


class EnrollmentQuotaError(EnrollmentError):
    """Live (created) enrollment tokens at ENROLLMENT_MAX_LIVE (HTTP 409 —
    the owner revokes or waits for TTL; auto-revoke is FORBIDDEN)."""


def _iso_in(seconds: float, now: datetime | None = None) -> str:
    """UTC ISO stamp ``seconds`` into the future (TTL arithmetic helper)."""
    base = now or datetime.now(timezone.utc)
    return (base + timedelta(seconds=seconds)).isoformat(timespec="seconds")


def _iso_past(ts: str, now: datetime | None = None) -> bool:
    """Has an ISO stamp already passed? Corrupt/empty values fail CLOSED
    (an unparsable expiry must not resurrect a dead session)."""
    try:
        t = datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return True
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return t <= (now or datetime.now(timezone.utc))


# --------------------------------------------------- automation (SCHED-1 S1)
# ADR 0013 §2: scheduler & hooks — S1 is CONTRACTS ONLY (no engine, no
# loops, no ECA — those are S2 behind the T2 gate). Automation is a
# separate domain answering "when / in response to what", composed with
# (never merged into) the executor routing chain.
SCHEDULE_TRIGGER_KINDS = frozenset({"interval", "time-of-day"})
HOOK_ACTIONS = frozenset({"create_assignment", "notify"})
# Server constant (ADR 0013 §2/C-3): the closed set of hook source events.
# Structurally excludes `automation.*` (anti-loop layer 2) and heartbeat
# events (per-tick noise ban, Amd 2 §7).
HOOK_EVENT_WHITELIST = frozenset({
    "task.moved",
    "assignment.failed",
    "assignment.expired",
    "task.validation-timeout",   # WF-1 (future emitter)
    "executor.offline",          # notify-only per SCHED-1 §5 (enforced below)
})
RULE_CONDITION_OPS = frozenset({"eq", "ne", "in"})
# Condition sources (ADR 0013 §3): origin classes a rule may listen to.
# ``automation`` is NOT a member and can never be allowlisted — structural
# anti-loop layer 1. ``machine`` for create_assignment is an explicit
# per-rule owner opt-in, audited old→new.
HOOK_SOURCE_ORIGINS = frozenset({"ui", "server", "machine"})
# Action-dependent defaults (SE А-1, АРХКОМ-5): notify hears every origin
# except automation; create_assignment only ui/server.
HOOK_SOURCE_DEFAULTS: dict[str, tuple[str, ...]] = {
    "notify": ("machine", "server", "ui"),
    "create_assignment": ("server", "ui"),
}
# ADR 0013 §2: interval triggers must be >= 60 s (422 below that).
SCHEDULE_MIN_INTERVAL_S = 60.0
SCHEDULE_MAX_INTERVAL_S = 366 * 24 * 3600   # 1 year cap: bigger values overflow datetime arithmetic
SCHEDULE_DEFAULT_MAX_RUNS_PER_DAY = 4
SCHEDULE_DEFAULT_COOLDOWN_S = 300
# ADR 0013 §6 starting values: per-rule default 4/day lives in-row; the
# global daily cap lives in board_meta (the S2 engine executes it).
AUTOMATION_ENABLED_META_KEY = "automation.enabled"
AUTOMATION_CAP_META_KEY = "automation.cap.global_per_day"
AUTOMATION_DEFAULT_GLOBAL_CAP = 10  # ADR 0013 §6 starting value

# Condition field allowlist (SCHED-1 H3 / ADR 0013 §3): STRUCTURED fields
# only — never free text (spec, report bodies, notes). A None enum means
# "closed set impossible" (free string value, length-capped); every other
# field carries its dictionary so the UI form is a triple of selects over
# server data (Frontend blocker, АРХКОМ-5).
RULE_CONDITION_FIELD_ENUMS: dict[str, tuple[str, ...] | None] = {
    "col": tuple(TASK_COLUMNS),
    "status": tuple(sorted(TASK_STATUSES)),
    "state": tuple(sorted(ASSIGNMENT_STATES)),
    "env": tuple(sorted(VALID_ENVS)),
    "priority": tuple(sorted(TASK_PRIORITIES)),
    "transport": tuple(sorted(EXECUTOR_TRANSPORTS)),
    "project": None,
    "specialist": None,
    "executor_id": None,
    # "harness" joins via _condition_field_enums() — its enum is the LIVE
    # harnesses TABLE (wave 3C; callers pass harness_names()).
}


def _condition_field_enums(
        harness_enum: tuple[str, ...] | frozenset[str],
) -> dict[str, tuple[str, ...] | None]:
    """The FULL condition-field dictionary — the static table plus the
    harness enum (the live ``harnesses`` table, passed by the caller).
    Single source for BOTH the CRUD validation and the /status
    meta-dictionary, so the UI form can never offer a field the validator
    would reject."""
    enums = dict(RULE_CONDITION_FIELD_ENUMS)
    enums["harness"] = tuple(sorted(harness_enum))
    return enums
_RULE_MAX_NAME = 120
_RULE_MAX_CONDITION_CLAUSES = 8
_RULE_MAX_IN_VALUES = 16
_RULE_MAX_PAYLOAD_JSON = 4096


class AutomationError(Exception):
    """Base class for automation-domain violations (ADR 0013)."""


class RuleNotFoundError(AutomationError):
    """Unknown rule id (HTTP 404 upstream)."""


class AutomationValidationError(AutomationError):
    """Rule payload violates a contract (HTTP 422 upstream) — includes
    duplicate names (S1 AC: name-duplicate answers 422, not 409)."""


_HHMM_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
# ISO-8601 duration subset: P[nW][nD][T[nH][nM][n[.]S]] — weeks/days/hours/
# minutes/seconds only (no Y/M: calendar-ambiguous). At least one component
# required; T requires at least one time component after it.
_ISO_DURATION_RE = re.compile(
    r"^P(?!$)(?:(\d+)W)?(?:(\d+)D)?"
    r"(?:T(?!$)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$")


def parse_iso8601_duration(value: str) -> float:
    """ISO-8601 duration (P…T… subset, see _ISO_DURATION_RE) → seconds.

    Raises AutomationValidationError on anything else — garbage must 422 at
    the CRUD boundary (ADR 0013 §2), never reach the S2 tick loop."""
    m = _ISO_DURATION_RE.fullmatch((value or "").strip())
    if not m or not any(m.groups()):
        raise AutomationValidationError(
            f"invalid ISO-8601 duration: {value!r} "
            "(expected e.g. 'PT15M', 'PT1H30M', 'P1D', 'P2W')")
    w, d, h, mi, s = (float(g) if g else 0.0 for g in m.groups())
    seconds = w * 7 * 86400 + d * 86400 + h * 3600 + mi * 60 + s
    if seconds <= 0:
        raise AutomationValidationError(
            f"duration must be positive: {value!r}")
    return seconds


def _validate_hhmm(value: str, what: str) -> str:
    v = (value or "").strip()
    if not _HHMM_RE.fullmatch(v):
        raise AutomationValidationError(
            f"invalid {what}: {value!r} (expected 'HH:MM' UTC, 00:00–23:59)")
    return v


def _validate_window(window_from: Any, window_to: Any) -> tuple[str | None, str | None]:
    """NULL/'' = always (the S1 default); otherwise both ends must be valid
    'HH:MM' UTC — a half-open pair is ambiguous and therefore 422."""
    def norm(v: Any) -> str | None:
        if v is None or v == "":
            return None
        if not isinstance(v, str):
            raise AutomationValidationError(
                f"window value must be a 'HH:MM' string, got {type(v).__name__}")
        return _validate_hhmm(v, "window value")
    wf, wt = norm(window_from), norm(window_to)
    if (wf is None) != (wt is None):
        raise AutomationValidationError(
            "window_from/window_to must be set together "
            "(both empty = run window always)")
    return wf, wt


def validate_condition(
        raw: Any, harness_enum: tuple[str, ...] | frozenset[str],
) -> list[dict[str, Any]]:
    """Normalize + validate a hook condition [{field, op, value}] against
    the closed allowlist (422 at CRUD time, not at fire time — ADR 0013
    §2). Structured fields only; values checked against the field's enum
    when one exists (the UI form has no free-text condition input).
    ``harness_enum`` is the LIVE harness-dictionary snapshot from the
    caller (wave 3C — hooks validate against the table, not the seed)."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise AutomationValidationError("condition must be a list of clauses")
    if len(raw) > _RULE_MAX_CONDITION_CLAUSES:
        raise AutomationValidationError(
            f"condition: max {_RULE_MAX_CONDITION_CLAUSES} clauses")
    enums = _condition_field_enums(harness_enum)
    out: list[dict[str, Any]] = []
    for item in raw:
        if (not isinstance(item, dict)
                or set(item) != {"field", "op", "value"}):
            raise AutomationValidationError(
                f"condition clause must be exactly {{field, op, value}}: "
                f"{item!r}")
        field, op, value = item["field"], item["op"], item["value"]
        if field not in enums:
            raise AutomationValidationError(
                f"unknown condition field: {field!r}; allowed: "
                f"{sorted(enums)}")
        if op not in RULE_CONDITION_OPS:
            raise AutomationValidationError(
                f"unknown condition op: {op!r}; allowed: "
                f"{sorted(RULE_CONDITION_OPS)}")
        enum = enums[field]
        values: list[str]
        if op == "in":
            if (not isinstance(value, list) or not value
                    or len(value) > _RULE_MAX_IN_VALUES):
                raise AutomationValidationError(
                    f"op 'in' needs a non-empty list (max "
                    f"{_RULE_MAX_IN_VALUES}) as value")
            values = value
        else:
            values = [value]
        checked: list[str] = []
        for v in values:
            if not isinstance(v, str) or not v.strip():
                raise AutomationValidationError(
                    f"condition values must be non-empty strings: {v!r}")
            v = v.strip()[:_RULE_MAX_NAME]
            if enum is not None and v not in enum:
                raise AutomationValidationError(
                    f"condition value {v!r} is not in the '{field}' "
                    f"dictionary: {list(enum)}")
            if v not in checked:
                checked.append(v)
        out.append({"field": field, "op": op,
                    "value": sorted(checked) if op == "in" else checked[0]})
    return out


def validate_source_allowlist(raw: Any, action: str) -> list[str]:
    """Origin allowlist for a hook. ``None`` → the action-dependent default
    (SE А-1). ``automation`` can never be allowlisted (anti-loop); machine
    for create_assignment is the owner's explicit, audited opt-in."""
    if action not in HOOK_ACTIONS:
        raise AutomationValidationError(
            f"unknown action: {action!r}; allowed: {sorted(HOOK_ACTIONS)}")
    if raw is None:
        return list(HOOK_SOURCE_DEFAULTS[action])
    if not isinstance(raw, list) or not raw:
        raise AutomationValidationError(
            "source_allowlist must be a non-empty list of origins "
            f"{sorted(HOOK_SOURCE_ORIGINS)}")
    out: list[str] = []
    for o in raw:
        if not isinstance(o, str) or o not in HOOK_SOURCE_ORIGINS:
            raise AutomationValidationError(
                f"unknown source origin: {o!r}; allowed: "
                f"{sorted(HOOK_SOURCE_ORIGINS)} ('automation' can never be "
                "allowlisted)")
        if o not in out:
            out.append(o)
    return sorted(out)


def _compute_next_run(trigger_kind: str, trigger_value: str,
                      now: datetime | None = None) -> str:
    """Server-side schedule-clock write (ADR 0013 §2): the next due moment
    from ``now``. interval → now + duration; time-of-day → the next UTC
    occurrence (strictly after now). Inputs are pre-validated upstream —
    this function is the single recompute point for POST/PATCH/enable."""
    now = now or datetime.now(timezone.utc)
    if trigger_kind == "interval":
        seconds = parse_iso8601_duration(trigger_value)
        if seconds < SCHEDULE_MIN_INTERVAL_S:
            raise AutomationValidationError(
                f"interval must be >= {int(SCHEDULE_MIN_INTERVAL_S)}s, "
                f"got {trigger_value!r}")
        return (now + timedelta(seconds=seconds)).isoformat(timespec="seconds")
    hh, mm = _validate_hhmm(trigger_value, "trigger_value").split(":")
    candidate = now.replace(hour=int(hh), minute=int(mm),
                            second=0, microsecond=0)
    if candidate <= now:
        candidate += timedelta(days=1)
    return candidate.isoformat(timespec="seconds")


def _bump_iso_second(ts: str) -> str:
    """+1 s on an ISO timestamp — the manual-run collision walk (see
    run_schedule_now)."""
    return (datetime.fromisoformat(ts)
            + timedelta(seconds=1)).isoformat(timespec="seconds")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS board_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    col          TEXT NOT NULL CHECK (col IN ('backlog','validating','open','in-progress','blocked','resolved','done')),
    position     INTEGER NOT NULL DEFAULT 0,
    title        TEXT NOT NULL,
    summary      TEXT NOT NULL DEFAULT '',
    spec         TEXT NOT NULL DEFAULT '',
    agents       TEXT NOT NULL DEFAULT '[]',
    specialists  TEXT NOT NULL DEFAULT '[]',
    env          TEXT NOT NULL DEFAULT 'unknown' CHECK (env IN ('cluster','laptop','local','cloud','unknown')),
    project      TEXT NOT NULL DEFAULT '',
    memory_ids   TEXT NOT NULL DEFAULT '[]',
    mnemos_tags  TEXT NOT NULL DEFAULT '[]',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    kind     TEXT NOT NULL,
    task_id  TEXT,
    payload  TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS memory_groups (
    name        TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_servers (
    name         TEXT PRIMARY KEY,
    url          TEXT NOT NULL,
    group_name   TEXT NOT NULL DEFAULT 'default',
    description  TEXT NOT NULL DEFAULT '',
    enabled      INTEGER NOT NULL DEFAULT 1,
    state        TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','paused','syncing','error')),
    token_ref    TEXT NOT NULL DEFAULT '',
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_cache (
    specialist TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    json       TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'system' CHECK (category IN ('system','work')),
    title    TEXT NOT NULL,
    message  TEXT NOT NULL DEFAULT '',
    task_id  TEXT,
    read     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS group_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    group_name TEXT NOT NULL,
    action   TEXT NOT NULL,
    detail   TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS server_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    server     TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT ''
);
-- W5 (ROADMAP-v2 §5, mesh federation): mesh nodes as observable board
-- entities. base_url is the node's metrics/healthz address (host:port);
-- GET {base_url}/healthz needs NO token, so there is deliberately no
-- token column here — a mesh node must not hold board-class secrets
-- (ADR 0009 Amd 2). Additive table riding the _SCHEMA executescript —
-- NO SEED_VERSION bump (the seed check wipes tasks, not registries).
CREATE TABLE IF NOT EXISTS mesh_nodes (
    name         TEXT PRIMARY KEY,
    base_url     TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    enabled      INTEGER NOT NULL DEFAULT 1,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_col ON tasks (col, position);
CREATE INDEX IF NOT EXISTS idx_notifications_task ON notifications (task_id);
CREATE INDEX IF NOT EXISTS idx_events_id ON events (id);
CREATE INDEX IF NOT EXISTS idx_server_log ON server_log (server, id);
CREATE TABLE IF NOT EXISTS task_reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('intermediate','final')),
    agent      TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL,
    superseded INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_reports_task ON task_reports (task_id, id);
CREATE TABLE IF NOT EXISTS task_inbox (
    memory_id         TEXT PRIMARY KEY,
    server            TEXT NOT NULL,
    project           TEXT NOT NULL DEFAULT '',
    title             TEXT NOT NULL,
    excerpt           TEXT NOT NULL DEFAULT '',
    tags              TEXT NOT NULL DEFAULT '[]',
    priority          TEXT NOT NULL DEFAULT 'normal',
    specialist        TEXT NOT NULL DEFAULT '',
    source_created_at TEXT NOT NULL DEFAULT '',
    last_seen         TEXT NOT NULL,
    adopted_task_id   TEXT
);
CREATE TABLE IF NOT EXISTS task_assignments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id             TEXT NOT NULL,
    specialist          TEXT NOT NULL DEFAULT '',
    harness             TEXT NOT NULL DEFAULT 'zcode',
    state               TEXT NOT NULL DEFAULT 'queued'
                        CHECK (state IN ('queued','claimed','running','done',
                                         'failed','cancelled','expired')),
    created_by          TEXT NOT NULL DEFAULT 'owner',
    claimed_by          TEXT,
    claim_token         TEXT,
    note                TEXT NOT NULL DEFAULT '',
    spec_snapshot       TEXT NOT NULL DEFAULT '',
    spec_hash           TEXT NOT NULL DEFAULT '',
    executor_id         TEXT NOT NULL DEFAULT '',
    claimed_by_executor TEXT NOT NULL DEFAULT '',
    topics              TEXT NOT NULL DEFAULT '[]',
    created_at          TEXT NOT NULL,
    claimed_at          TEXT,
    started_at          TEXT,
    heartbeat_at        TEXT,
    finished_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_assignments_state ON task_assignments (state, id);
CREATE INDEX IF NOT EXISTS idx_task_assignments_task ON task_assignments (task_id, id);
-- PR #13 review P3a: the ≤1-active-assignment-per-task invariant becomes
-- STRUCTURAL. A partial unique index rejects a second queued/claimed/
-- running row for the same task even if the create-side check is ever
-- bypassed; create_assignment maps the IntegrityError to 409.
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_assignments_active_task
ON task_assignments (task_id) WHERE state IN ('queued','claimed','running');
-- ARCH-9: executor registry (pending → approved → revoked). secret_hash is
-- sha256(executor_secret) — the plaintext secret exists exactly once, in
-- the register response. last_seen is the presence clock; NOTHING writes
-- it except authenticated presence ticks (the sweeper only reads).
CREATE TABLE IF NOT EXISTS executors (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL UNIQUE,
    harness        TEXT NOT NULL,
    host           TEXT NOT NULL DEFAULT '',
    transport      TEXT NOT NULL DEFAULT 'local-poll'
                   CHECK (transport IN ('local-poll','mesh-r4')),
    capabilities   TEXT NOT NULL DEFAULT '[]',
    version        TEXT NOT NULL DEFAULT '',
    enabled        INTEGER NOT NULL DEFAULT 0,
    state          TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending','approved','revoked')),
    secret_hash    TEXT NOT NULL DEFAULT '',
    last_seen      TEXT NOT NULL DEFAULT '',
    registered_via TEXT NOT NULL DEFAULT '',
    registered_at  TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
-- Harness dictionary (wave 3C, design 2026-09-22 §C): the OWNER-MANAGED
-- registry that replaced the closed KNOWN_HARNESSES nomination gate. The
-- constant survives as the SEED (inserted once, when the table is empty —
-- seeding on empty preserves owner deletions across restarts). Additive
-- IF NOT EXISTS, no SEED_VERSION bump (task_assignments precedent). The
-- gates (registration, enrollment hint, assignment create, automation
-- payloads, rule condition enum) all read THIS table; launching is still
-- gated by the poller's local allowlist (A3) — the dictionary only rules
-- nomination hygiene on the board.
CREATE TABLE IF NOT EXISTS harnesses (
    name      TEXT PRIMARY KEY,
    added_at  TEXT NOT NULL,
    added_via TEXT NOT NULL DEFAULT 'seed',
    note      TEXT NOT NULL DEFAULT ''
);
-- SCHED-1 S1 (ADR 0013 §2): automation contracts — additive only, no
-- SEED_VERSION bump (task_assignments precedent). Three tables:
-- schedules/hooks (the rules) + launches (the append-only journal).
-- ``enabled DEFAULT 0``: creation is disabled; enablement is a separate
-- audited action (rule.toggled) — there is NO second pause column.
-- ``next_run_at`` is written by the server only (POST/PATCH/enable
-- recompute from now); the S1 manual run-now deliberately does NOT touch
-- it (schedule-clock family belongs to the tick, ADR 0013 §7).
CREATE TABLE IF NOT EXISTS schedules (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL UNIQUE,
    enabled          INTEGER NOT NULL DEFAULT 0,
    target_kind      TEXT NOT NULL DEFAULT 'task'
                     CHECK (target_kind IN ('task')),
    task_id          TEXT NOT NULL,
    specialist       TEXT NOT NULL,
    harness          TEXT NOT NULL DEFAULT 'zcode',
    executor_id      TEXT NOT NULL DEFAULT '',
    trigger_kind     TEXT NOT NULL
                     CHECK (trigger_kind IN ('interval','time-of-day')),
    trigger_value    TEXT NOT NULL,
    window_from      TEXT,
    window_to        TEXT,
    max_runs_per_day INTEGER NOT NULL DEFAULT 4,
    cooldown_s       INTEGER NOT NULL DEFAULT 300,
    next_run_at      TEXT,
    last_run_at      TEXT,
    created_by       TEXT NOT NULL DEFAULT 'owner',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
-- "on" and "trigger" are SQLite keywords — quoted everywhere they appear.
-- condition/source_allowlist/action_payload are JSON TEXT validated at the
-- CRUD boundary (422, never at fire time). budget = per-rule launches/day.
CREATE TABLE IF NOT EXISTS hooks (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL UNIQUE,
    enabled          INTEGER NOT NULL DEFAULT 0,
    "on"             TEXT NOT NULL,
    condition        TEXT NOT NULL DEFAULT '[]',
    source_allowlist TEXT NOT NULL DEFAULT '[]',
    action           TEXT NOT NULL
                     CHECK (action IN ('create_assignment','notify')),
    action_payload   TEXT NOT NULL DEFAULT '{}',
    cooldown_s       INTEGER NOT NULL DEFAULT 300,
    budget           INTEGER NOT NULL DEFAULT 4,
    created_by       TEXT NOT NULL DEFAULT 'owner',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
-- Append-only launch journal. rule_name is a SNAPSHOT: the journal stays
-- readable after rule surgery. Idempotency via TWO partial unique indexes
-- (SE deltas, АРХКОМ-5): a schedule occurrence is (rule_id, run_at); a
-- hook firing is (rule_id, event_id) — the monotonic audit-row id, not a
-- second timestamp. Manual run-now shares the schedule key: run_at is the
-- click time, bumped +1 s on a same-second collision (bounded walk).
CREATE TABLE IF NOT EXISTS launches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id       INTEGER NOT NULL,
    rule_kind     TEXT NOT NULL CHECK (rule_kind IN ('schedule','hook')),
    rule_name     TEXT NOT NULL,
    run_at        TEXT NOT NULL,
    event_id      INTEGER,
    "trigger"     TEXT NOT NULL CHECK ("trigger" IN ('tick','manual','event')),
    origin        TEXT NOT NULL DEFAULT '',
    decision      TEXT NOT NULL
                  CHECK (decision IN ('launched','skipped','missed')),
    reason        TEXT NOT NULL DEFAULT '',
    assignment_id INTEGER,
    attempted_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launches_rule ON launches (rule_kind, rule_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_launches_schedule_run
ON launches (rule_id, run_at) WHERE rule_kind='schedule';
CREATE UNIQUE INDEX IF NOT EXISTS idx_launches_hook_event
ON launches (rule_id, event_id) WHERE rule_kind='hook';
-- CV-7 (ADR 0012): QR pairing requests. code_hash is sha256(code) — the
-- code itself is NEVER stored (hash-only, §5/§10.1); it exists exactly
-- once, in the POST /api/pairing 201 response. verify is 4 digits for the
-- trusted-side screen check — it is NOT a secret (§3.5) but never rides
-- SSE/notifications. source_ip is bound by the FIRST exchange (§3.1).
-- Additive tables riding the _SCHEMA executescript — NO SEED_VERSION bump
-- (mesh_nodes/task_assignments precedent).
CREATE TABLE IF NOT EXISTS pairing_requests (
    id           TEXT PRIMARY KEY,
    code_hash    TEXT NOT NULL,
    verify       TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'created'
                 CHECK (state IN ('created','scanned','confirmed','issued','expired','revoked')),
    scope        TEXT NOT NULL DEFAULT 'read',
    created_by   TEXT NOT NULL DEFAULT 'owner',
    device_name  TEXT NOT NULL DEFAULT '',
    source_ip    TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    scanned_at   TEXT NOT NULL DEFAULT '',
    confirmed_at TEXT NOT NULL DEFAULT '',
    expires_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pairing_code_hash ON pairing_requests (code_hash);
-- Enrollment (ADR 0009 Amd 2 §4 supplement, 2026-09-22): one-time
-- registration tokens for REMOTE executors. token_hash is sha256 of the
-- mne_-prefixed secret — the plaintext exists exactly once, in the
-- POST /api/executors/enrollment 201 response. Single-use: the CAS
-- created→used rides the SAME transaction as the executor INSERT (the
-- design contract — a rolled-back registration never burns a token).
-- used_ip/executor_id are written by that CAS for the owner's approve-time
-- review. Additive table riding the _SCHEMA executescript — NO SEED_VERSION
-- bump (pairing_requests/task_assignments precedent).
CREATE TABLE IF NOT EXISTS enrollment_tokens (
    id           TEXT PRIMARY KEY,
    token_hash   TEXT NOT NULL,
    label        TEXT NOT NULL DEFAULT '',
    harness_hint TEXT NOT NULL DEFAULT '',
    name_hint    TEXT NOT NULL DEFAULT '',
    state        TEXT NOT NULL DEFAULT 'created'
                 CHECK (state IN ('created','used','expired','revoked')),
    created_by   TEXT NOT NULL DEFAULT 'owner',
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    used_at      TEXT NOT NULL DEFAULT '',
    used_ip      TEXT NOT NULL DEFAULT '',
    executor_id  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_enrollment_token_hash ON enrollment_tokens (token_hash);
-- CV-7 (ADR 0012 §5): paired device sessions. token_hash is sha256 of the
-- mnd_-prefixed token — plaintext exists exactly once, in the exchange 200
-- response. expires_at is the SLIDING 30-day clock (refreshed on every
-- validated request); hard_expires_at is the absolute 90-day cap that
-- activity can never push out. last_seen mirrors last_seen_at (the raw
-- request stamp; naming parity with the executors registry).
CREATE TABLE IF NOT EXISTS device_sessions (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    scope           TEXT NOT NULL DEFAULT 'read',
    token_hash      TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    last_seen_at    TEXT NOT NULL DEFAULT '',
    expires_at      TEXT NOT NULL DEFAULT '',
    hard_expires_at TEXT NOT NULL,
    state           TEXT NOT NULL DEFAULT 'active'
                     CHECK (state IN ('active','expired','revoked')),
    ua              TEXT NOT NULL DEFAULT '',
    ip              TEXT NOT NULL DEFAULT '',
    last_seen       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_device_sessions_token ON device_sessions (token_hash);
"""

# WF-1 table-rebuild target (Store._rebuild_tasks_for_wf1): the full
# CURRENT tasks shape with the 7-column CHECK. SQLite cannot ALTER a CHECK
# constraint, so widening tasks.col goes create-new → copy → swap-names.
_TASKS_WF1_DDL = """
CREATE TABLE tasks_new (
    id               TEXT PRIMARY KEY,
    col              TEXT NOT NULL CHECK (col IN ('backlog','validating','open','in-progress','blocked','resolved','done')),
    position         INTEGER NOT NULL DEFAULT 0,
    title            TEXT NOT NULL,
    summary          TEXT NOT NULL DEFAULT '',
    spec             TEXT NOT NULL DEFAULT '',
    agents           TEXT NOT NULL DEFAULT '[]',
    specialists      TEXT NOT NULL DEFAULT '[]',
    env              TEXT NOT NULL DEFAULT 'unknown' CHECK (env IN ('cluster','laptop','local','cloud','unknown')),
    project          TEXT NOT NULL DEFAULT '',
    memory_ids       TEXT NOT NULL DEFAULT '[]',
    mnemos_tags      TEXT NOT NULL DEFAULT '[]',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL,
    archived         INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'open',
    archived_from    TEXT NOT NULL DEFAULT '',
    priority         TEXT NOT NULL DEFAULT 'normal',
    validating_since TEXT NOT NULL DEFAULT ''
)
"""
# Column order shared by the rebuild's INSERT … SELECT (source table has
# every column except validating_since — the ALTER below has not run yet).
_TASK_COLUMNS_FULL = (
    "id", "col", "position", "title", "summary", "spec", "agents",
    "specialists", "env", "project", "memory_ids", "mnemos_tags",
    "created_at", "updated_at", "archived", "status", "archived_from",
    "priority",
)
_TASKS_BACKUP_WF1 = "tasks_backup_wf1"

# Bumped on incompatible seed layout changes; reseed wipes user edits.
# Single source of truth: server/seed.py (imported lazily to avoid a cycle).
def _seed_version() -> str:
    from .seed import SEED_VERSION
    return SEED_VERSION


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _loads(raw: str) -> list[Any]:
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return []


def _age_seconds(created_at: str) -> float:
    """Seconds elapsed since ``created_at`` (BE-12 edit window).

    All store-written timestamps are timezone-aware ISO strings; a naive or
    unparsable value (legacy/manual row) is treated as UTC / age 0 — the
    window fails OPEN (a corrupt timestamp must not permanently lock a
    task's content)."""
    try:
        created = datetime.fromisoformat(created_at)
    except (TypeError, ValueError, AttributeError):
        return 0.0
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - created).total_seconds()


class Store:
    """Thread-safe SQLite wrapper. One connection per call — cheap and safe
    for the single-digit request rates this board sees."""

    def __init__(self, path: str | Path) -> None:
        self._path = str(path)
        self._lock = threading.Lock()
        Path(self._path).parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as db:
            db.executescript(_SCHEMA)
            self._migrate(db)
            self._seed_if_empty(db)
            self._seed_harnesses(db)

    def _conn(self) -> sqlite3.Connection:
        db = sqlite3.connect(self._path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA foreign_keys=ON")
        return db

    # ------------------------------------------------------------------ meta
    # Harnesses are EXECUTION ENVIRONMENTS (zcode, hermes, pi, copilot,
    # claude-code, ...). GCW roles like "gcw-tech-lead" are SPECIALISTS,
    # never agents. Since wave 3C this set is the SEED of the harnesses
    # TABLE (owner-managed via /api/harnesses); every nomination gate reads
    # the table (harness_names / _harness_names_db), never this constant.
    KNOWN_HARNESSES = frozenset({
        "zcode", "hermes", "pi", "copilot", "claude-code", "cursor",
        "aider", "continue", "cline", "windsurf",
    })

    def _seed_harnesses(self, db: sqlite3.Connection) -> None:
        """Seed the harness dictionary exactly once — when the table is
        still empty. INSERT OR IGNORE keeps the boot idempotent; seeding
        ONLY on empty preserves owner deletions across restarts (the
        dictionary is owner-managed since wave 3C, deleted seeds must not
        resurrect)."""
        count = db.execute("SELECT COUNT(*) AS n FROM harnesses").fetchone()["n"]
        if count:
            return
        now = _now()
        db.executemany(
            "INSERT OR IGNORE INTO harnesses (name, added_at, added_via, note) "
            "VALUES (?,?,?,?)",
            [(name, now, "seed", "") for name in sorted(self.KNOWN_HARNESSES)],
        )

    def _migrate(self, db: sqlite3.Connection) -> None:
        # schema evolution for pre-0.7 databases.
        # IMPORTANT: additive ALTER TABLE only — never bump SEED_VERSION for
        # a column addition. The seed-version check below WIPES all tasks
        # when the stored version differs (workflow-lifecycle-proposal §7),
        # so schema extensions must not ride on it.
        cols = {r["name"] for r in db.execute(
            "PRAGMA table_info(tasks)").fetchall()}
        if "archived" not in cols:
            db.execute("ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
        if "status" not in cols:
            # BE-10: per-task workflow status. Existing rows are backfilled
            # from their column (identity map: every board column is also a
            # valid status). Backfill runs exactly once, right after the
            # ALTER — later boots must never overwrite an explicitly PATCHed
            # status with the column value.
            db.execute("ALTER TABLE tasks ADD COLUMN status TEXT NOT NULL DEFAULT 'open'")
            db.execute("UPDATE tasks SET status = col")
        if "archived_from" not in cols:
            # BE-11b: column a task lived in when it was archived, so
            # unarchive can restore it. No backfill: rows archived before
            # this column existed get archived_from='' and fall back to
            # 'open' on unarchive (documented fallback).
            db.execute("ALTER TABLE tasks ADD COLUMN archived_from TEXT NOT NULL DEFAULT ''")
        if "priority" not in cols:
            # BE-12: task priority. Additive ALTER only — the column DEFAULT
            # 'normal' covers every pre-migration row, so no backfill and NO
            # SEED_VERSION bump (the seed-version check wipes all tasks).
            db.execute(
                "ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'")
        # WF-1 (proposal §7 risks 2-3): widen the tasks.col CHECK to the
        # 7-column dictionary via table rebuild — rows and ids are
        # preserved verbatim, a safety snapshot is kept, and SEED_VERSION
        # is NOT bumped (the seed-version check below wipes all tasks).
        self._rebuild_tasks_for_wf1(db)
        cols = {r["name"] for r in db.execute(
            "PRAGMA table_info(tasks)").fetchall()}
        if "validating_since" not in cols:
            # WF-1: 24h validation clock. Only the rebuild path on an old
            # DB skips this (the rebuilt table already carries the column);
            # fresh schemas created after the rebuild no-op land here.
            db.execute(
                "ALTER TABLE tasks "
                "ADD COLUMN validating_since TEXT NOT NULL DEFAULT ''")
        # ARCH-9: denormalized topics on assignments (Amd 2 §9). Additive
        # ALTER for pre-ARCH-9 databases — the '[]' DEFAULT covers existing
        # rows; new rows are filled at creation. executors and the partial
        # unique index ride on the _SCHEMA executescript (IF NOT EXISTS).
        acols = {r["name"] for r in db.execute(
            "PRAGMA table_info(task_assignments)").fetchall()}
        if "topics" not in acols:
            db.execute(
                "ALTER TABLE task_assignments "
                "ADD COLUMN topics TEXT NOT NULL DEFAULT '[]'")
        # Enrollment (Amd 2 §4 supplement): origin fact on the executor row
        # ('' = machine-token bootstrap; 'enrollment:<id>' = one-time token).
        # Additive ALTER for pre-enrollment databases — the '' DEFAULT covers
        # existing rows; new rows are filled at registration. The enrollments
        # table itself rides the _SCHEMA executescript (IF NOT EXISTS).
        ecols = {r["name"] for r in db.execute(
            "PRAGMA table_info(executors)").fetchall()}
        if "registered_via" not in ecols:
            db.execute(
                "ALTER TABLE executors "
                "ADD COLUMN registered_via TEXT NOT NULL DEFAULT ''")
        row = db.execute(
            "SELECT value FROM board_meta WHERE key='seed_version'"
        ).fetchone()
        stored = row["value"] if row else None
        if stored != _seed_version():
            # Wipe board tables and reseed from the shipped fixtures.
            db.execute("DELETE FROM tasks")
            db.execute("DELETE FROM events")
            db.execute(
                "INSERT OR REPLACE INTO board_meta (key, value) VALUES ('seed_version', ?)",
                (_seed_version(),),
            )

    def _rebuild_tasks_for_wf1(self, db: sqlite3.Connection) -> None:
        """WF-1: rebuild ``tasks`` with the 7-column CHECK (idempotent).

        SQLite cannot ALTER a CHECK constraint, so the widen goes: safety
        snapshot → create tasks_new → INSERT SELECT (ids verbatim — the
        task_reports/events/task_inbox references survive) → drop old →
        rename → recreate idx_tasks_col. Runs inside the caller's boot
        transaction, so a crash mid-rebuild rolls back to the intact old
        table. The snapshot table (_TASKS_BACKUP_WF1) is deliberately LEFT
        IN PLACE — operational cleanup happens outside the boot path.

        No-op when the stored CHECK already knows the 7-column dictionary
        (fresh schemas and already-migrated databases), so repeated boots
        never rebuild twice and never overwrite the snapshot.
        """
        row = db.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'"
        ).fetchone()
        if row is None:  # pragma: no cover — _SCHEMA just created the table
            return
        # The 5-column predecessor schema contains no 'validating' token;
        # the rebuilt/new schema always does (CHECK + validating_since).
        if "'validating'" in (row["sql"] or ""):
            return
        db.execute(f"DROP TABLE IF EXISTS {_TASKS_BACKUP_WF1}")
        db.execute(
            f"CREATE TABLE {_TASKS_BACKUP_WF1} AS SELECT * FROM tasks")
        n_rows = db.execute("SELECT COUNT(*) AS n FROM tasks").fetchone()["n"]
        db.execute(_TASKS_WF1_DDL)
        cols_sel = ", ".join(_TASK_COLUMNS_FULL)
        db.execute(
            f"INSERT INTO tasks_new ({cols_sel}, validating_since) "
            f"SELECT {cols_sel}, '' FROM tasks")
        db.execute("DROP TABLE tasks")
        db.execute("ALTER TABLE tasks_new RENAME TO tasks")
        db.execute("CREATE INDEX IF NOT EXISTS idx_tasks_col "
                   "ON tasks (col, position)")
        self._log(db, "schema.wf1_tasks_rebuilt", None, {
            "rows": n_rows, "backup": _TASKS_BACKUP_WF1,
            "col_check": "7-column",
        })

    def _seed_if_empty(self, db: sqlite3.Connection) -> None:
        count = db.execute("SELECT COUNT(*) AS n FROM tasks").fetchone()["n"]
        if count:
            return
        from .seed import SEED_TASKS

        for pos, task in enumerate(SEED_TASKS):
            db.execute(
                """INSERT INTO tasks
                       (id, col, status, position, title, summary, spec,
                        agents, specialists, env, project, memory_ids,
                        mnemos_tags, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    task["id"],
                    task["col"],
                    task["col"],  # status derives from col (BE-10)
                    pos,
                    task["title"],
                    task["summary"],
                    task.get("spec", ""),
                    json.dumps(task.get("agents", [])),
                    json.dumps(task.get("specialists", [])),
                    task.get("env", "unknown"),
                    task.get("project", "mnemos-eyes"),
                    json.dumps(task.get("memory_ids", [])),
                    json.dumps(task.get("mnemos_tags", [])),
                    task.get("created_at", _now()),
                    task.get("updated_at", _now()),
                ),
            )

    # ----------------------------------------------------------------- meta
    # Key/value rows in board_meta (seed_version lives there too). Used for
    # one-shot operational flags such as the reports backfill marker.
    def get_meta(self, key: str) -> str | None:
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT value FROM board_meta WHERE key=?", (key,)
            ).fetchone()
        return row["value"] if row else None

    def set_meta(self, key: str, value: str) -> None:
        with self._lock, self._conn() as db:
            db.execute(
                "INSERT OR REPLACE INTO board_meta (key, value) VALUES (?,?)",
                (key, value),
            )

    # ----------------------------------------------------------------- read
    def board(self, status: str | None = None) -> dict[str, Any]:
        """Board projection. Optional ``status`` filter (BE-10) narrows the
        task list; ``counts`` always describe the whole board, not the
        filtered view."""
        with self._lock, self._conn() as db:
            q = "SELECT * FROM tasks WHERE archived=0"
            params: tuple[Any, ...] = ()
            if status is not None:
                q += " AND status=?"
                params = (status,)
            q += " ORDER BY col, position"
            tasks = [dict(r) for r in db.execute(q, params).fetchall()]
            stats = db.execute(
                """SELECT col, COUNT(*) AS n FROM tasks GROUP BY col"""
            ).fetchall()
        for t in tasks:
            t["agents"] = _loads(t["agents"])
            t["specialists"] = _loads(t["specialists"])
            t["memory_ids"] = _loads(t["memory_ids"])
            t["mnemos_tags"] = _loads(t["mnemos_tags"])
        counts = {c: 0 for c in TASK_COLUMNS}
        for r in stats:
            counts[r["col"]] = r["n"]
        return {"columns": list(TASK_COLUMNS), "tasks": tasks, "counts": counts}

    def task(self, task_id: str) -> dict[str, Any] | None:
        with self._lock, self._conn() as db:
            row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            return None
        t = dict(row)
        for k in ("agents", "specialists", "memory_ids", "mnemos_tags"):
            t[k] = _loads(t[k])
        return t

    # ---------------------------------------------------------------- write
    def create_task(self, payload: dict[str, Any]) -> dict[str, Any]:
        col = payload.get("col", "open")
        if col not in VALID_STATUSES:
            raise ValueError(f"invalid col: {col}")
        # BE-10: status defaults to the column map; an explicit status is
        # honored when provided (validated against the workflow dictionary).
        # Only None means "not provided" — an explicit empty string is
        # garbage and must 422, not silently fall back to the column.
        status = payload.get("status")
        if status is None:
            # WF-1: pre-validation lanes carry the workflow status `open`
            # (COLUMN_STATUS_MAP), not their column name.
            status = COLUMN_STATUS_MAP[col]
        if status not in TASK_STATUSES:
            raise ValueError(f"invalid status: {status}")
        env = payload.get("env", "unknown")
        if env not in VALID_ENVS:
            raise ValueError(f"invalid env: {env}")
        # BE-12: priority, same boundary pattern as env/status — None means
        # "not provided" and falls back to the dictionary default; garbage
        # must raise (surfaces as 422 upstream), never silently normalize.
        priority = payload.get("priority")
        if priority is None:
            priority = "normal"
        if priority not in TASK_PRIORITIES:
            raise ValueError(f"invalid priority: {priority}")
        # random suffix: two creates in the same millisecond must not
        # collide on the tasks.id UNIQUE constraint (QA-1 regression)
        task_id = payload.get("id") or f"t-{int(time.time()*1000)}-{secrets.token_hex(2)}"
        now = _now()
        # WF-1: a task born directly in the validation lane starts its 24h
        # clock immediately (the sweep must not skip it for an empty stamp).
        validating_since = now if col == "validating" else ""
        with self._lock, self._conn() as db:
            pos = db.execute(
                "SELECT COALESCE(MAX(position)+1, 0) AS p FROM tasks WHERE col=?",
                (col,),
            ).fetchone()["p"]
            db.execute(
                """INSERT INTO tasks
                       (id, col, status, position, title, summary, spec,
                        agents, specialists, env, project, memory_ids,
                        mnemos_tags, priority, validating_since,
                        created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    task_id, col, status, pos, payload["title"],
                    payload.get("summary", ""), payload.get("spec", ""),
                    json.dumps(payload.get("agents", [])),
                    json.dumps(payload.get("specialists", [])),
                    env, payload.get("project", ""),
                    json.dumps(payload.get("memory_ids", [])),
                    json.dumps(payload.get("mnemos_tags", [])),
                    priority, validating_since,
                    now, now,
                ),
            )
            self._log(db, "task.created", task_id, {"col": col, "status": status})
        return self.task(task_id)  # type: ignore[return-value]

    def move_task(self, task_id: str, col: str, position: int | None = None) -> dict[str, Any] | None:
        """Kanban move (BE-10 semantics + the WF-1 v1 transition mirror).

        - ``status`` re-derives from COLUMN_STATUS_MAP: pre-validation
          lanes (backlog/validating) read as workflow `open`; a status set
          by a manual PATCH lives only until the next move (the ``?status=``
          filter stays honest with the kanban state).
        - WF-1 v1 guard (proposal §4.3, minimal): blocked → done and
          blocked → resolved raise InvalidTransitionError — the block must
          lift first. Every other move stays free (owner's discretion);
          the full state machine is a later phase.
        - WF-1 clock: ENTERING validating stamps ``validating_since``
          (starts the 24h sweep window); LEAVING the lane clears it; a
          same-column reorder keeps the clock (position-only moves must
          not reset the deadline).
        """
        if col not in VALID_STATUSES:
            raise ValueError(f"invalid col: {col}")
        with self._lock, self._conn() as db:
            row = db.execute("SELECT col FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                return None
            src = row["col"]
            if src == "blocked" and col in BLOCKED_DIRECT_TARGETS:
                raise InvalidTransitionError(
                    f"недопустимый переход: {src} → {col} — сначала "
                    "in-progress (приёмка идёт через resolved)")
            if position is None:
                position = db.execute(
                    "SELECT COALESCE(MAX(position)+1, 0) AS p FROM tasks WHERE col=?",
                    (col,),
                ).fetchone()["p"]
            status = COLUMN_STATUS_MAP[col]
            if col == "validating" and src != "validating":
                db.execute(
                    "UPDATE tasks SET col=?, status=?, position=?, "
                    "validating_since=?, updated_at=? WHERE id=?",
                    (col, status, position, _now(), _now(), task_id),
                )
            elif col != "validating":
                db.execute(
                    "UPDATE tasks SET col=?, status=?, position=?, "
                    "validating_since='', updated_at=? WHERE id=?",
                    (col, status, position, _now(), task_id),
                )
            else:
                # reorder inside validating — clock untouched
                db.execute(
                    "UPDATE tasks SET col=?, status=?, position=?, updated_at=? WHERE id=?",
                    (col, status, position, _now(), task_id),
                )
            self._log(db, "task.moved", task_id, {"from": src, "to": col})
        return self.task(task_id)

    def update_task(self, task_id: str, patch: dict[str, Any],
                    force: bool = False) -> dict[str, Any] | None:
        """Content/status PATCH (BE-12 semantics).

        Allow-listed keys only — anything else (notably ``col``) is silently
        ignored, per the established v1 contract: column changes go through
        POST /move, so a PATCH carrying ``col`` is not an error, it is a
        no-op for that key (documented; not 422).

        ``status`` is a workflow transition and stays editable at any task
        age (UI-8 «Вернуть в работу» relies on this). The keys in
        EDITABLE_FIELDS are content: past EDIT_WINDOW_SECONDS they raise
        TaskLockedError unless ``force=True``; a forced write is recorded in
        the task.updated event payload as ``forced: true``.
        """
        allowed = {"title", "summary", "spec", "agents", "specialists",
                   "env", "project", "memory_ids", "mnemos_tags", "status",
                   "priority"}
        fields: dict[str, Any] = {}
        for key, value in patch.items():
            if key not in allowed:
                continue
            if key in ("agents", "specialists", "memory_ids", "mnemos_tags"):
                fields[key] = json.dumps(value)
            elif key == "env":
                if value not in VALID_ENVS:
                    raise ValueError(f"invalid env: {value}")
                fields[key] = value
            elif key == "status":
                # BE-10: full workflow dictionary, incl. `withdrawn` which
                # has no board column. Lives until the next move (see
                # move_task).
                if value not in TASK_STATUSES:
                    raise ValueError(f"invalid status: {value}")
                fields[key] = value
            elif key == "priority":
                # BE-12: priority dictionary; validated like env/status so
                # garbage surfaces as 422 upstream, never as a silent write.
                if value not in TASK_PRIORITIES:
                    raise ValueError(f"invalid priority: {value}")
                fields[key] = value
            else:
                fields[key] = value
        if not fields:
            return self.task(task_id)
        fields["updated_at"] = _now()
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT created_at FROM tasks WHERE id=?", (task_id,)
            ).fetchone()
            if row is None:
                return None
            # BE-12: 24h content-edit window. Only content fields age out;
            # a status-only patch (or any patch without EDITABLE_FIELDS
            # members) is never locked.
            if (not force
                    and any(k in EDITABLE_FIELDS for k in fields)
                    and _age_seconds(row["created_at"]) > EDIT_WINDOW_SECONDS):
                raise TaskLockedError(
                    f"task {task_id} is older than {EDIT_WINDOW_SECONDS}s")
            sets = ", ".join(f"{k}=?" for k in fields)
            db.execute(
                f"UPDATE tasks SET {sets} WHERE id=?",  # noqa: S608 — keys from a fixed allow-list
                (*fields.values(), task_id),
            )
            payload: dict[str, Any] = {"fields": sorted(fields)}
            if force:
                # forced edits must stay auditable: the override lands in
                # the same task.updated event as the field list
                payload["forced"] = True
            self._log(db, "task.updated", task_id, payload)
        return self.task(task_id)

    def delete_task(self, task_id: str) -> bool:
        with self._lock, self._conn() as db:
            cur = db.execute("DELETE FROM tasks WHERE id=?", (task_id,))
            deleted = cur.rowcount > 0
            if deleted:
                # reports and assignments are payload data attached to the
                # task (unlike the events audit log) — they do not outlive it
                db.execute("DELETE FROM task_reports WHERE task_id=?", (task_id,))
                db.execute("DELETE FROM task_assignments WHERE task_id=?", (task_id,))
                self._log(db, "task.deleted", task_id, {})
        return deleted

    # --------------------------------------------------------------- events
    def _log(self, db: sqlite3.Connection, kind: str, task_id: str | None,
             payload: dict[str, Any]) -> None:
        db.execute(
            "INSERT INTO events (ts, kind, task_id, payload) VALUES (?,?,?,?)",
            (_now(), kind, task_id, json.dumps(payload)),
        )

    def events(self, after_id: int = 0, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock, self._conn() as db:
            rows = db.execute(
                "SELECT id, ts, kind, task_id, payload FROM events "
                "WHERE id > ? ORDER BY id ASC LIMIT ?",
                (after_id, limit),
            ).fetchall()
        out = []
        for r in rows:
            e = dict(r)
            e["payload"] = _loads(e["payload"])
            out.append(e)
        return out

    def task_events(self, task_id: str, limit: int = 50) -> list[dict[str, Any]]:
        """Audit events for one task, newest first."""
        with self._lock, self._conn() as db:
            rows = db.execute(
                "SELECT ts, kind, task_id, payload FROM events "
                "WHERE task_id=? ORDER BY id DESC LIMIT ?",
                (task_id, limit),
            ).fetchall()
        out = []
        for r in rows:
            e = dict(r)
            e["payload"] = _loads(e["payload"])
            out.append(e)
        return out

    def last_event_id(self) -> int:
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT COALESCE(MAX(id), 0) AS m FROM events"
            ).fetchone()
        return int(row["m"])

    # ------------------------------------------------------ memory servers
    def list_servers(self, include_disabled: bool = True) -> list[dict[str, Any]]:
        q = "SELECT * FROM memory_servers" + ("" if include_disabled else " WHERE enabled=1")
        with self._lock, self._conn() as db:
            rows = [dict(r) for r in db.execute(
                f"{q} ORDER BY sort_order, name").fetchall()]
        return rows

    def get_server(self, name: str) -> dict[str, Any] | None:
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM memory_servers WHERE name=?", (name,)
            ).fetchone()
        return dict(row) if row else None

    def upsert_server(self, spec: dict[str, Any]) -> dict[str, Any]:
        name = spec["name"]
        now = _now()
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT name FROM memory_servers WHERE name=?", (name,)
            ).fetchone()
            if row is None:
                pos = db.execute(
                    "SELECT COALESCE(MAX(sort_order)+1, 0) AS p FROM memory_servers"
                ).fetchone()["p"]
                db.execute(
                    """INSERT INTO memory_servers
                           (name, url, group_name, description, enabled, state,
                            token_ref, sort_order, created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (name, spec["url"], spec.get("group_name", "default"),
                     spec.get("description", ""), 1 if spec.get("enabled", True) else 0,
                     spec.get("state", "idle"), spec.get("token_ref", ""), pos, now, now),
                )
                self._log(db, "server.created", None, {"server": name})
            else:
                db.execute(
                    """UPDATE memory_servers SET url=?, group_name=?, description=?,
                           token_ref=COALESCE(NULLIF(?, ''), token_ref), updated_at=?
                       WHERE name=?""",
                    (spec["url"], spec.get("group_name", "default"),
                     spec.get("description", ""), spec.get("token_ref", ""), now, name),
                )
                self._log(db, "server.updated", None, {"server": name})
        return self.get_server(name)  # type: ignore[return-value]

    def set_server_enabled(self, name: str, enabled: bool) -> dict[str, Any] | None:
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT name FROM memory_servers WHERE name=?", (name,)
            ).fetchone()
            if row is None:
                return None
            db.execute(
                "UPDATE memory_servers SET enabled=?, state=?, updated_at=? WHERE name=?",
                (1 if enabled else 0, "idle" if enabled else "paused", _now(), name),
            )
            self._log(db, "server." + ("enabled" if enabled else "disabled"),
                      None, {"server": name})
        return self.get_server(name)

    def set_server_state(self, name: str, state: str) -> dict[str, Any] | None:
        if state not in ("idle", "paused", "syncing", "error"):
            raise ValueError(f"invalid state: {state}")
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT name FROM memory_servers WHERE name=?", (name,)
            ).fetchone()
            if row is None:
                return None
            db.execute(
                "UPDATE memory_servers SET state=?, updated_at=? WHERE name=?",
                (state, _now(), name),
            )
        return self.get_server(name)

    def delete_server(self, name: str) -> bool:
        """Remove a server from the board registry (NOT the store itself)."""
        with self._lock, self._conn() as db:
            cur = db.execute("DELETE FROM memory_servers WHERE name=?", (name,))
            deleted = cur.rowcount > 0
            if deleted:
                self._log(db, "server.deleted", None, {"server": name})
        return deleted

    def log_server_action(self, server: str, action: str, detail: str = "") -> None:
        with self._lock, self._conn() as db:
            self._log(db, "server." + action, None, {"server": server})
            db.execute(
                "INSERT INTO server_log (ts, server, action, detail) VALUES (?,?,?,?)",
                (_now(), server, action, mask_secrets(detail)[:500]),
            )

    def server_history(self, server: str, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock, self._conn() as db:
            rows = db.execute(
                "SELECT ts, action, detail FROM server_log WHERE server=? "
                "ORDER BY id DESC LIMIT ?",
                (server, limit),
            ).fetchall()
        return [dict(r) for r in rows]

    # ------------------------------------------- mesh nodes (W5, ROADMAP-v2 §5)
    # Observable mesh-node registry — the memory_servers pattern minus the
    # secret machinery: healthz carries no token, so there is no token_ref,
    # no state column (health is probed live, never persisted) and no
    # per-node action log beyond the shared events audit.
    def list_mesh_nodes(self, include_disabled: bool = True) -> list[dict[str, Any]]:
        q = "SELECT * FROM mesh_nodes" + ("" if include_disabled else " WHERE enabled=1")
        with self._lock, self._conn() as db:
            rows = [dict(r) for r in db.execute(
                f"{q} ORDER BY sort_order, name").fetchall()]
        return rows

    def get_mesh_node(self, name: str) -> dict[str, Any] | None:
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM mesh_nodes WHERE name=?", (name,)
            ).fetchone()
        return dict(row) if row else None

    def upsert_mesh_node(self, spec: dict[str, Any]) -> dict[str, Any] | None:
        """Insert or fully update one mesh node. The UPDATE branch also
        flips ``enabled`` (nodes have no separate action endpoint — the
        owner manages them via the API, not the UI)."""
        name = spec["name"]
        now = _now()
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT name FROM mesh_nodes WHERE name=?", (name,)
            ).fetchone()
            if row is None:
                pos = db.execute(
                    "SELECT COALESCE(MAX(sort_order)+1, 0) AS p FROM mesh_nodes"
                ).fetchone()["p"]
                db.execute(
                    """INSERT INTO mesh_nodes
                           (name, base_url, description, enabled, sort_order,
                            created_at, updated_at)
                       VALUES (?,?,?,?,?,?,?)""",
                    (name, spec["base_url"], spec.get("description", ""),
                     1 if spec.get("enabled", True) else 0, pos, now, now),
                )
                self._log(db, "mesh_node.created", None, {"node": name})
            else:
                db.execute(
                    """UPDATE mesh_nodes SET base_url=?, description=?,
                           enabled=?, updated_at=? WHERE name=?""",
                    (spec["base_url"], spec.get("description", ""),
                     1 if spec.get("enabled", True) else 0, now, name),
                )
                self._log(db, "mesh_node.updated", None, {"node": name})
        return self.get_mesh_node(name)

    def delete_mesh_node(self, name: str) -> bool:
        """Remove a node from the board registry (the node itself is
        untouched — mirrors delete_server semantics)."""
        with self._lock, self._conn() as db:
            cur = db.execute("DELETE FROM mesh_nodes WHERE name=?", (name,))
            deleted = cur.rowcount > 0
            if deleted:
                self._log(db, "mesh_node.deleted", None, {"node": name})
        return deleted

    # ------------------------------------------------------- memory groups
    def list_groups(self) -> list[dict[str, Any]]:
        with self._lock, self._conn() as db:
            rows = [dict(r) for r in db.execute(
                "SELECT * FROM memory_groups ORDER BY name").fetchall()]
            for r in rows:
                r["servers"] = [
                    x["name"] for x in db.execute(
                        "SELECT name FROM memory_servers WHERE group_name=? "
                        "ORDER BY sort_order, name", (r["name"],)
                    ).fetchall()
                ]
        return rows

    def upsert_group(self, name: str, title: str = "", description: str = "") -> dict[str, Any]:
        now = _now()
        with self._lock, self._conn() as db:
            db.execute(
                """INSERT INTO memory_groups (name, title, description, created_at)
                       VALUES (?,?,?,?)
                   ON CONFLICT(name) DO UPDATE SET
                       title=excluded.title, description=excluded.description""",
                (name, title or name, description, now),
            )
            self._log(db, "group.saved", None, {"group": name})
        return next((g for g in self.list_groups() if g["name"] == name), None)  # type: ignore[return-value]

    def delete_group(self, name: str) -> bool:
        """Delete a group; its servers fall back to group 'default'."""
        with self._lock, self._conn() as db:
            cur = db.execute("DELETE FROM memory_groups WHERE name=?", (name,))
            deleted = cur.rowcount > 0
            if deleted:
                db.execute(
                    "UPDATE memory_servers SET group_name='default' WHERE group_name=?",
                    (name,),
                )
                self._log(db, "group.deleted", None, {"group": name})
        return deleted

    def set_server_group(self, name: str, group: str) -> dict[str, Any] | None:
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT name FROM memory_servers WHERE name=?", (name,)
            ).fetchone()
            if row is None:
                return None
            db.execute(
                "UPDATE memory_servers SET group_name=?, updated_at=? WHERE name=?",
                (group, _now(), name),
            )
            self._log(db, "server.moved", None, {"server": name, "group": group})
        return self.get_server(name)

    # -------------------------------------------------------- notifications
    def notify(self, category: str, title: str, message: str = "",
               task_id: str | None = None) -> dict[str, Any]:
        if category not in ("system", "work"):
            category = "system"
        with self._lock, self._conn() as db:
            cur = db.execute(
                "INSERT INTO notifications (ts, category, title, message, task_id) "
                "VALUES (?,?,?,?,?)",
                (_now(), category, title[:200], message[:500], task_id),
            )
            nid = cur.lastrowid
        return {"id": nid, "category": category, "title": title, "message": message,
                "task_id": task_id, "ts": _now(), "read": 0}

    def notifications(self, after_id: int = 0, limit: int = 50,
                      unread_only: bool = False) -> list[dict[str, Any]]:
        q = "SELECT * FROM notifications WHERE id > ?"
        params: list[Any] = [after_id]
        if unread_only:
            q += " AND read=0"
        q += " ORDER BY id DESC LIMIT ?"
        params.append(limit)
        with self._lock, self._conn() as db:
            rows = [dict(r) for r in db.execute(q, params).fetchall()]
        for r in rows:
            r["read"] = bool(r["read"])
        return rows

    def unread_count(self) -> int:
        with self._lock, self._conn() as db:
            return int(db.execute(
                "SELECT COUNT(*) AS n FROM notifications WHERE read=0"
            ).fetchone()["n"])

    def mark_read(self, nid: int | None = None) -> bool:
        with self._lock, self._conn() as db:
            if nid is None:
                db.execute("UPDATE notifications SET read=1 WHERE read=0")
            else:
                db.execute("UPDATE notifications SET read=1 WHERE id=?", (nid,))
        return True

    # ------------------------------------------------------------- archive
    def archive_task(self, task_id: str) -> bool:
        """Archive a task, remembering its current column in ``archived_from``
        (BE-11b) so unarchive can put it back."""
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT col FROM tasks WHERE id=? AND archived=0",
                (task_id,),
            ).fetchone()
            if row is None:
                return False
            db.execute(
                "UPDATE tasks SET archived=1, archived_from=col, updated_at=? WHERE id=?",
                (_now(), task_id),
            )
            self._log(db, "task.archived", task_id, {"from": row["col"]})
        return True

    def unarchive_task(self, task_id: str) -> dict[str, Any] | None:
        """Restore an archived task (BE-11b). It returns to its pre-archive
        column (``archived_from``); rows archived before that column existed
        (``archived_from=''``) — or carrying a value outside the column
        dictionary — fall back to ``open``. Status re-syncs via
        COLUMN_STATUS_MAP (same semantics as move). ``validating_since`` is
        deliberately untouched: archiving is a board flag orthogonal to the
        column, and a task returning to the validation lane with an old
        stamp is honestly overdue — it still needs the decision."""
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT archived, archived_from FROM tasks WHERE id=?",
                (task_id,),
            ).fetchone()
            if row is None or not row["archived"]:
                return None
            col = row["archived_from"] or "open"
            if col not in VALID_STATUSES:
                # Legacy garbage must not hit the 7-column CHECK
                # (IntegrityError → 500) — documented fallback instead.
                col = "open"
            db.execute(
                "UPDATE tasks SET archived=0, col=?, status=?, updated_at=? WHERE id=?",
                (col, COLUMN_STATUS_MAP[col], _now(), task_id),
            )
            self._log(db, "task.unarchived", task_id, {"to": col})
        return self.task(task_id)

    def archived_tasks(self, q: str = "", status: str = "", col: str = "",
                       agent: str = "", project: str = "") -> list[dict[str, Any]]:
        """Archive v2 (BE-11b): full filtered listing, newest first.
        ``q`` is a LIKE match on title/summary; ``agent`` matches a member
        of the agents JSON array. Pagination (limit/offset) is applied by
        the API layer — the archive is small and the API also needs the
        unpaginated set for the per-project grouping."""
        where = ["archived=1"]
        params: list[Any] = []
        if q:
            like = f"%{q}%"
            where.append("(title LIKE ? OR summary LIKE ?)")
            params += [like, like]
        if status:
            where.append("status=?")
            params.append(status)
        if col:
            where.append("col=?")
            params.append(col)
        if agent:
            # exact member match inside the JSON array: "agent-name"
            where.append(r"agents LIKE ?")
            params.append(f'%"{agent}"%')
        if project:
            where.append("project=?")
            params.append(project)
        cond = " AND ".join(where)
        with self._lock, self._conn() as db:
            rows = [dict(r) for r in db.execute(
                f"SELECT * FROM tasks WHERE {cond} ORDER BY updated_at DESC",  # noqa: S608 — fragments from a fixed allow-list, values bound
                params,
            ).fetchall()]
        for t in rows:
            for k in ("agents", "specialists", "memory_ids", "mnemos_tags"):
                t[k] = _loads(t[k])
        return rows

    # ------------------------------------------------------- agent reports
    def add_report(self, task_id: str, body: str, kind: str,
                   agent: str = "", *, identity_mismatch: bool = False,
                   ) -> tuple[dict[str, Any], list[int]] | None:
        """Append an agent report to a task (BE-11a). A new ``final`` report
        supersedes all previous live finals (they stay in history flagged
        ``superseded``); intermediates are never touched. Returns
        (report, superseded_ids) or None when the task does not exist.

        ARCH-9: ``identity_mismatch`` flags a report whose declared agent
        string disagrees with the token-backed executor (spoofing signal,
        Amd 2 §7) — it lands in the task.report audit payload."""
        if kind not in REPORT_KINDS:
            raise ValueError(f"invalid report kind: {kind}")
        text = body.strip()
        if not text:
            raise ValueError("report body is empty")
        agent = agent[:120]
        now = _now()
        with self._lock, self._conn() as db:
            if db.execute("SELECT id FROM tasks WHERE id=?",
                          (task_id,)).fetchone() is None:
                return None
            superseded_ids: list[int] = []
            if kind == "final":
                rows = db.execute(
                    "SELECT id FROM task_reports "
                    "WHERE task_id=? AND kind='final' AND superseded=0",
                    (task_id,),
                ).fetchall()
                superseded_ids = [r["id"] for r in rows]
                if superseded_ids:
                    marks = ", ".join("?" for _ in superseded_ids)
                    db.execute(
                        f"UPDATE task_reports SET superseded=1 WHERE id IN ({marks})",
                        superseded_ids,
                    )
            cur = db.execute(
                "INSERT INTO task_reports (task_id, kind, agent, body, superseded, created_at) "
                "VALUES (?,?,?,?,0,?)",
                (task_id, kind, agent, text, now),
            )
            rid = int(cur.lastrowid)
            payload: dict[str, Any] = {
                "report_id": rid, "kind": kind, "agent": agent,
                "superseded": superseded_ids}
            if identity_mismatch:
                payload["identity_mismatch"] = True
            self._log(db, "task.report", task_id, payload)
        report = {"id": rid, "task_id": task_id, "kind": kind, "agent": agent,
                  "body": text, "superseded": False, "created_at": now}
        return report, superseded_ids

    def list_reports(self, task_id: str) -> list[dict[str, Any]] | None:
        """Chronological report history for a task; None when the task does
        not exist (distinguishing an empty history from a missing task)."""
        with self._lock, self._conn() as db:
            if db.execute("SELECT id FROM tasks WHERE id=?",
                          (task_id,)).fetchone() is None:
                return None
            rows = [dict(r) for r in db.execute(
                "SELECT id, task_id, kind, agent, body, superseded, created_at "
                "FROM task_reports WHERE task_id=? ORDER BY id ASC",
                (task_id,),
            ).fetchall()]
        for r in rows:
            r["superseded"] = bool(r["superseded"])
        return rows

    def list_recent_reports(self, *, task_id: str | None = None,
                            kind: str | None = None, limit: int = 50,
                            before_id: int | None = None,
                            include_superseded: bool = False,
                            ) -> list[dict[str, Any]]:
        """Cross-task report feed, freshest first (CV-6: the Agents-domain
        activity stream). Rows in the same house shape as ``list_reports``.

        Filters: ``task_id`` exact, ``kind`` exact (REPORT_KINDS only —
        ValueError on garbage; the endpoint maps it to 422). Cursor
        pagination: ``before_id`` keeps rows with id strictly below it, so
        pages stay stable while new reports land (no offset drift); the
        caller owns the limit clamp. A ``task_id`` that matches nothing —
        including an unknown task — yields an EMPTY page, not an error:
        unlike per-task ``list_reports`` the feed addresses no single
        entity, so there is nothing to 404 on (endpoint-level contract).

        Superseded finals are excluded by default — the live feed shows one
        final per task; ``include_superseded`` restores them flagged."""
        if kind is not None and kind not in REPORT_KINDS:
            raise ValueError(f"invalid report kind: {kind}")
        where: list[str] = []
        params: list[Any] = []
        if task_id is not None:
            where.append("task_id=?")
            params.append(task_id)
        if kind is not None:
            where.append("kind=?")
            params.append(kind)
        if not include_superseded:
            where.append("superseded=0")
        if before_id is not None:
            where.append("id<?")
            params.append(before_id)
        cond = f" WHERE {' AND '.join(where)}" if where else ""
        with self._lock, self._conn() as db:
            rows = [dict(r) for r in db.execute(
                "SELECT id, task_id, kind, agent, body, superseded, created_at "
                f"FROM task_reports{cond} ORDER BY id DESC LIMIT ?",  # noqa: S608 — fragments from a fixed allow-list, values bound
                (*params, limit),
            ).fetchall()]
        for r in rows:
            r["superseded"] = bool(r["superseded"])
        return rows

    # ------------------------------------------------------- assignments
    # ADR 0009 phase 1: assignment queue (variant A′). One connection per
    # call under the write lock; every multi-step transition (claim+move,
    # finish+move) is a single transaction, so correctness is structural
    # (SQLite single-writer) rather than conventional.

    def _assignment(self, db: sqlite3.Connection,
                    assignment_id: int) -> dict[str, Any] | None:
        row = db.execute(
            "SELECT * FROM task_assignments WHERE id=?", (assignment_id,)
        ).fetchone()
        if row is None:
            return None
        a = dict(row)
        a["topics"] = _loads(a.get("topics") or "[]")
        return a

    @staticmethod
    def _executor_transport(db: sqlite3.Connection, executor_id: str) -> str:
        """Transport tag for assignment audit events (Amd 2 §7: executor_id
        + transport ride together). Empty for an empty id or an executor
        deleted from the registry (attribution strings outlive rows —
        DELETE deliberately keeps assignments untouched)."""
        if not executor_id:
            return ""
        row = db.execute(
            "SELECT transport FROM executors WHERE id=?",
            (executor_id,)).fetchone()
        return row["transport"] if row else ""

    @staticmethod
    def _claim_token_matches(stored: str | None, token: str | None) -> bool:
        """Constant-time claim-token comparison (correctness boundary)."""
        if not stored or not token:
            return False
        return hmac.compare_digest(stored, token)

    @staticmethod
    def _task_in_txn(db: sqlite3.Connection, task_id: str) -> dict[str, Any] | None:
        row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            return None
        t = dict(row)
        for k in ("agents", "specialists", "memory_ids", "mnemos_tags"):
            t[k] = _loads(t[k])
        return t

    def _create_assignment(self, db: sqlite3.Connection, task_id: str,
                           specialist: str, harness: str = "zcode",
                           created_by: str = "owner",
                           executor_id: str = "") -> dict[str, Any]:
        """In-transaction core of create_assignment (ADR 0013 §4: the S2
        engine and the S1 manual run-now insert the assignment "by the same
        private code path as create_assignment"). Caller owns the lock and
        the transaction; same gates, same errors as the public wrapper."""
        task = db.execute(
            """SELECT spec, archived, status, mnemos_tags, project
               FROM tasks WHERE id=?""", (task_id,)
        ).fetchone()
        if task is None:
            raise AssignmentNotFoundError(f"task {task_id} not found")
        if task["archived"]:
            raise TaskNotAssignableError(
                f"task {task_id} is archived — assignment refused")
        if task["status"] in TERMINAL_TASK_STATUSES:
            raise TaskNotAssignableError(
                f"task {task_id} is terminal ({task['status']}) — "
                "assignment refused")
        # Wave 3C: the nomination gate lives HERE, in-transaction, not on
        # the UI route alone — the manual run-now (and the future S2
        # engine) mint through this same private path, and a gate on the
        # route only would let them nominate a DELETED harness (a zombie
        # queued row holding the ≤1-active slot, launchable by nobody).
        known = self._harness_names_db(db)
        if harness not in known:
            raise UnknownHarnessError(
                f"unknown harness: {harness}; known: {sorted(known)}")
        active = db.execute(
            "SELECT COUNT(*) AS n FROM task_assignments "
            "WHERE task_id=? AND state IN ('queued','claimed','running')",
            (task_id,),
        ).fetchone()["n"]
        if active:
            raise AssignmentConflictError(
                f"task {task_id} already has an active assignment")
        spec = task["spec"] or ""
        spec_hash = hashlib.sha256(spec.encode("utf-8")).hexdigest()
        # ARCH-9 (Amd 2 §9): denormalized topics — the project/domain
        # tags mesh subscription filters need without joining through
        # mnemos. project:<slug> from the task's project column is
        # included when mnemos_tags does not already carry it (the
        # column is the canonical project; metadata tier only).
        topics = [t for t in _loads(task["mnemos_tags"])
                  if isinstance(t, str)
                  and t.startswith(("project:", "domain:"))]
        if task["project"] and f"project:{task['project']}" not in topics:
            topics.insert(0, f"project:{task['project']}")
        try:
            cur = db.execute(
                """INSERT INTO task_assignments
                       (task_id, specialist, harness, state, created_by, note,
                        spec_snapshot, spec_hash, executor_id, topics, created_at)
                       VALUES (?,?,?,'queued',?,?,?,?,?,?,?)""",
                (task_id, specialist.strip()[:120], harness,
                 created_by[:120], "", spec[:SPEC_SNAPSHOT_CAP], spec_hash,
                 executor_id.strip()[:120], json.dumps(topics), _now()),
            )
        except sqlite3.IntegrityError as exc:
            # P3a: the partial unique index is the structural backstop
            # for the ≤1-active invariant (create-side check raced).
            raise AssignmentConflictError(
                f"task {task_id} already has an active assignment") from exc
        aid = int(cur.lastrowid)
        self._log(db, "assignment.created", task_id, {
            "assignment_id": aid, "specialist": specialist.strip()[:120],
            "harness": harness, "created_by": created_by[:120],
            "executor_id": executor_id.strip()[:120], "spec_hash": spec_hash,
            "topics": topics,
        })
        return self._assignment(db, aid)  # type: ignore[return-value]

    def create_assignment(self, task_id: str, specialist: str,
                          harness: str = "zcode", created_by: str = "owner",
                          executor_id: str = "") -> dict[str, Any]:
        """Queue an execution attempt on a task (ADR 0009 §3).

        Copies the task spec into an immutable ``spec_snapshot`` (capped at
        SPEC_SNAPSHOT_CAP, plain truncation) plus ``spec_hash`` = sha256 hex
        over the FULL spec. The poller executes the snapshot, never the live
        spec (A2: closes the edit-after-review-before-claim TOCTOU window).
        ``executor_id`` is a plain stored designation (ARCH-9 contract); no
        registry exists in phase 1, so nothing validates it.

        Raises:
            AssignmentNotFoundError — task id unknown (404 upstream);
            TaskNotAssignableError — task archived or workflow-terminal (422);
            UnknownHarnessError — harness absent from the dictionary (422;
                          wave 3C — the gate lives in the in-transaction
                          core, so run-now and the S2 engine are gated too);
            AssignmentConflictError — the task already has an active
                                      assignment: the ≤1 invariant (409).
        """
        with self._lock, self._conn() as db:
            return self._create_assignment(
                db, task_id, specialist, harness, created_by, executor_id)

    def assignments(self, state: str | None = None,
                    task_id: str | None = None,
                    by: str | None = None) -> list[dict[str, Any]]:
        """Assignment listing (poller inbox + UI badge source). ``state`` /
        ``task_id`` are optional exact filters; ``by='automation'`` keeps
        only engine-minted rows (``created_by LIKE 'automation:%'`` —
        ADR 0013 §2); oldest first (queue order)."""
        q = "SELECT * FROM task_assignments"
        where: list[str] = []
        params: list[Any] = []
        if by == "automation":
            where.append("created_by LIKE 'automation:%'")
        if state is not None:
            where.append("state=?")
            params.append(state)
        if task_id is not None:
            where.append("task_id=?")
            params.append(task_id)
        if where:
            q += " WHERE " + " AND ".join(where)
        q += " ORDER BY id ASC"
        with self._lock, self._conn() as db:
            rows = [dict(r) for r in db.execute(q, params).fetchall()]
        for r in rows:
            r["topics"] = _loads(r.get("topics") or "[]")
        return rows

    def claim_assignment(self, assignment_id: int, claimed_by: str,
                         executor_id: str = "", *, token_executor_id: str | None = None,
                         ) -> tuple[dict[str, Any], str, dict[str, Any] | None, bool]:
        """Atomic claim (ADR 0009 A4): CAS ``UPDATE ... WHERE state='queued'``
        + rowcount check, with the task column move open → in-progress in
        the SAME transaction. Two pollers racing → one 200, one 409.

        Executor identity (ARCH-9): ``token_executor_id`` is the
        token-BACKED executor id (executor-secret auth at the route);
        ``executor_id`` is the declared body field. Only explicit pins are
        enforced (Amd 2 §5), inside this same transaction:
        - pinned assignment + no token executor → AssignmentConflictError
          (409: the pin conflicts with a generic machine claim);
        - pinned assignment + token executor of ANOTHER executor →
          AssignmentTokenError (403: identity mismatch, spoofing gate);
        - declared executor_id contradicting the token identity → 403.
        The token-backed identity is authoritative for attribution.

        PR #13 review P3c: a task archived AFTER the assignment was created
        refuses the claim (422) — a poller must not execute work whose task
        left the board between nomination and claim.

        Returns (assignment, claim_token, task_after, moved). The token is
        generated here (secrets.token_hex(16)) and handed to the caller —
        it is never re-derivable afterwards.
        """
        token = secrets.token_hex(16)
        now = _now()
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM task_assignments WHERE id=?",
                (assignment_id,),
            ).fetchone()
            if row is None:
                raise AssignmentNotFoundError(
                    f"assignment {assignment_id} not found")
            task_id = row["task_id"]
            pin = (row["executor_id"] or "").strip()
            if pin:
                if token_executor_id is None:
                    raise AssignmentConflictError(
                        f"assignment {assignment_id} is explicitly pinned to "
                        f"executor '{pin}' — that executor's token is required "
                        "to claim it")
                if token_executor_id != pin:
                    raise AssignmentTokenError(
                        f"assignment {assignment_id} is pinned to executor "
                        f"'{pin}'; the token belongs to '{token_executor_id}'")
            if (executor_id.strip() and token_executor_id is not None
                    and executor_id.strip() != token_executor_id):
                raise AssignmentTokenError(
                    f"declared executor_id '{executor_id.strip()}' does not "
                    f"match the token-backed executor '{token_executor_id}'")
            effective_executor = (token_executor_id if token_executor_id
                                  else executor_id.strip())
            # P3c: archived-after-creation guard
            trow = db.execute(
                "SELECT archived FROM tasks WHERE id=?", (task_id,)).fetchone()
            if trow is None or trow["archived"]:
                raise TaskNotAssignableError(
                    f"task {task_id} is archived (or gone) — claim refused")
            try:
                cur = db.execute(
                    "UPDATE task_assignments SET state='claimed', claimed_by=?, "
                    "claim_token=?, claimed_at=?, claimed_by_executor=? "
                    "WHERE id=? AND state='queued'",
                    (claimed_by.strip()[:120], token, now,
                     effective_executor[:120], assignment_id),
                )
            except sqlite3.IntegrityError as exc:
                raise AssignmentConflictError(
                    f"assignment {assignment_id} is not queued "
                    "(already claimed or terminal)") from exc
            if cur.rowcount != 1:
                raise AssignmentConflictError(
                    f"assignment {assignment_id} is not queued "
                    "(already claimed or terminal)")
            self._log(db, "assignment.claimed", task_id, {
                "assignment_id": assignment_id,
                "claimed_by": claimed_by.strip()[:120],
                "executor_id": effective_executor[:120],
                # Amd 2 §7 (PR #18 F6b): executor identity rides with its
                # transport on assignment events
                "transport": self._executor_transport(
                    db, effective_executor[:120]),
            })
            # Task column move, same transaction, only from 'open': the ADR
            # mapping is claim → open→in-progress (WF-1 §4.2 — an agent may
            # move its own task). Any other column stays untouched.
            moved = False
            trow = db.execute(
                "SELECT col FROM tasks WHERE id=?", (task_id,)).fetchone()
            if trow is not None and trow["col"] == "open":
                pos = db.execute(
                    "SELECT COALESCE(MAX(position)+1, 0) AS p FROM tasks "
                    "WHERE col='in-progress'",
                ).fetchone()["p"]
                db.execute(
                    "UPDATE tasks SET col='in-progress', status='in-progress', "
                    "position=?, updated_at=? WHERE id=?",
                    (pos, now, task_id),
                )
                self._log(db, "task.moved", task_id,
                          {"from": "open", "to": "in-progress"})
                moved = True
            task = self._task_in_txn(db, task_id)
            assignment = self._assignment(db, assignment_id)
        return assignment, token, task, moved

    def start_assignment(self, assignment_id: int, token: str) -> dict[str, Any]:
        """claimed → running. ``heartbeat_at`` starts at start (executor
        liveness baseline for the phase-3 reaper)."""
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM task_assignments WHERE id=?", (assignment_id,)
            ).fetchone()
            if row is None:
                raise AssignmentNotFoundError(
                    f"assignment {assignment_id} not found")
            if not self._claim_token_matches(row["claim_token"], token):
                raise AssignmentTokenError("claim_token mismatch")
            if row["state"] != "claimed":
                raise AssignmentConflictError(
                    f"assignment {assignment_id} is {row['state']}, "
                    "expected claimed")
            now = _now()
            db.execute(
                "UPDATE task_assignments SET state='running', started_at=?, "
                "heartbeat_at=? WHERE id=?", (now, now, assignment_id))
            self._log(db, "assignment.started", row["task_id"],
                      {"assignment_id": assignment_id})
            return self._assignment(db, assignment_id)  # type: ignore[return-value]

    def heartbeat_assignment(self, assignment_id: int, token: str,
                             note: str = "") -> dict[str, Any]:
        """Executor liveness tick (poller-driven, ~60 s). 409 unless running
        — a 409 on an expired assignment doubles as the kill signal to the
        poller (ADR 0009 §10). No audit event: heartbeats are noise.

        ARCH-9 presence piggyback: when the assignment carries a
        claimed_by_executor attribution, the same tick refreshes that
        executor's last_seen (presence clock) in this transaction — the
        poller's assignment heartbeat doubles as its presence heartbeat.
        Revoked executors do not tick (touch_executor_last_seen gate)."""
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM task_assignments WHERE id=?", (assignment_id,)
            ).fetchone()
            if row is None:
                raise AssignmentNotFoundError(
                    f"assignment {assignment_id} not found")
            if not self._claim_token_matches(row["claim_token"], token):
                raise AssignmentTokenError("claim_token mismatch")
            if row["state"] != "running":
                raise AssignmentConflictError(
                    f"assignment {assignment_id} is {row['state']}, "
                    "expected running")
            db.execute(
                "UPDATE task_assignments SET heartbeat_at=?, "
                "note=COALESCE(NULLIF(?,''), note) WHERE id=?",
                (_now(), note, assignment_id),
            )
            if row["claimed_by_executor"]:
                db.execute(
                    "UPDATE executors SET last_seen=? "
                    "WHERE id=? AND state<>'revoked'",
                    (_now(), row["claimed_by_executor"]),
                )
            return self._assignment(db, assignment_id)  # type: ignore[return-value]

    # Terminal outcome → assignment state (the audit/SSE kind mirrors it).
    _FINISH_TARGET_STATE = {
        "complete": "done", "fail": "failed",
        "cancel": "cancelled", "expired": "expired",
    }
    # Source states each outcome is legal from (ADR 0009 §3 diagram).
    _FINISH_SOURCE_STATES = {
        "complete": ("running",),
        "fail": ("claimed", "running"),
        "cancel": ("queued", "claimed", "running"),
        "expired": ("claimed", "running"),   # reaper only (phase 3)
    }
    # Task column mapping (ADR 0009 §3) — applied only for the task's LAST
    # active assignment and only from the source column:
    #   complete → resolved (NOT done: acceptance resolved→done stays owner);
    #   fail/expired → blocked ("in-progress with no live executor" is a lie);
    #   cancel → open.
    _FINISH_TASK_TARGET = {
        "complete": ("in-progress", "resolved"),
        "fail": ("in-progress", "blocked"),
        "expired": ("in-progress", "blocked"),
        "cancel": ("in-progress", "open"),
    }

    def finish_assignment(self, assignment_id: int, outcome: str,
                          note: str = "", *, token: str | None = None,
                          claimed_by: str | None = None,
                          token_executor_id: str | None = None,
                          allow_claimed_by_fallback: bool = False,
                          ) -> tuple[dict[str, Any], dict[str, Any] | None, str | None, str | None]:
        """Terminal transition + task column mapping.

        Token policy (correctness boundary + ARCH-9 identity gates):
        - complete: claim_token required, must match;
        - fail (security review PR #18, F1): the claimed_by string is
          SELF-ASSERTED and openly readable via GET /api/assignments —
          an approved executor must not be able to fail a foreign
          assignment by declaring the victim's name. Accepted:
          (a) a matching claim_token; OR
          (b) the token-BACKED executor identity equals the assignment's
              claimed_by_executor (``token_executor_id`` from the route —
              the mesh-leg recovery path: the executor lost its
              claim_token but still holds its secret); OR
          (c) a claimed_by string match — ONLY for the board-token class
              (``allow_claimed_by_fallback``; the laptop poller's
              recovery sweep authenticates with the board token, which
              is board-class trust, and has no executor secret);
        - cancel: no claim token — the owner's UI token is the auth (route);
        - expired: in-process reaper (phase 3), no token by construction.

        Returns (assignment, task_after, moved_from, moved_to); the move
        applies only when no OTHER active assignment holds the task.
        """
        target = self._FINISH_TARGET_STATE.get(outcome)
        if target is None:
            raise ValueError(f"invalid outcome: {outcome}")
        allowed_states = self._FINISH_SOURCE_STATES[outcome]
        now = _now()
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM task_assignments WHERE id=?", (assignment_id,)
            ).fetchone()
            if row is None:
                raise AssignmentNotFoundError(
                    f"assignment {assignment_id} not found")
            if outcome == "complete" and not self._claim_token_matches(
                    row["claim_token"], token):
                raise AssignmentTokenError("claim_token mismatch")
            if outcome == "fail" and not (
                    self._claim_token_matches(row["claim_token"], token)
                    or (token_executor_id
                        and token_executor_id == row["claimed_by_executor"])
                    or (allow_claimed_by_fallback and claimed_by
                        and row["claimed_by"] == claimed_by.strip())):
                raise AssignmentTokenError(
                    "claim_token, token-backed executor identity, or "
                    "board-class claimed_by match required to fail an "
                    "assignment")
            if row["state"] not in allowed_states:
                raise AssignmentConflictError(
                    f"assignment {assignment_id} is {row['state']}; "
                    f"'{outcome}' requires {' or '.join(allowed_states)}")
            if outcome == "expired" and not self._is_stale_for_reap(row):
                # The scan snapshot is stale: liveness moved inside the
                # scan→UPDATE window. Never expire a live assignment.
                raise AssignmentConflictError(
                    f"assignment {assignment_id} is no longer stale "
                    "(liveness updated after the reaper scan)")
            db.execute(
                "UPDATE task_assignments SET state=?, finished_at=?, "
                "note=COALESCE(NULLIF(?,''), note) WHERE id=?",
                (target, now, note, assignment_id))
            self._log(db, f"assignment.{target}", row["task_id"], {
                "assignment_id": assignment_id, "outcome": outcome,
                "by": (claimed_by or row["claimed_by"] or "")[:120],
                "executor_id": row["claimed_by_executor"][:120],
                # Amd 2 §7 (PR #18 F6b)
                "transport": self._executor_transport(
                    db, row["claimed_by_executor"]),
            })
            # Sibling guard: the column mapping belongs to the task's LAST
            # active assignment. The ≤1 create-side invariant keeps this a
            # no-op today; it stays as defense in depth for reaper paths.
            others = db.execute(
                "SELECT COUNT(*) AS n FROM task_assignments "
                "WHERE task_id=? AND id<>? "
                "AND state IN ('queued','claimed','running')",
                (row["task_id"], assignment_id),
            ).fetchone()["n"]
            moved_from = moved_to = None
            src, dst = self._FINISH_TASK_TARGET[outcome]
            trow = db.execute(
                "SELECT col FROM tasks WHERE id=?", (row["task_id"],)
            ).fetchone()
            if trow is not None and not others and trow["col"] == src:
                pos = db.execute(
                    "SELECT COALESCE(MAX(position)+1, 0) AS p FROM tasks "
                    "WHERE col=?", (dst,),
                ).fetchone()["p"]
                db.execute(
                    "UPDATE tasks SET col=?, status=?, position=?, updated_at=? "
                    "WHERE id=?", (dst, dst, pos, now, row["task_id"]))
                self._log(db, "task.moved", row["task_id"],
                          {"from": src, "to": dst})
                moved_from, moved_to = src, dst
            task = self._task_in_txn(db, row["task_id"])
            assignment = self._assignment(db, assignment_id)
        return assignment, task, moved_from, moved_to

    # ------------------------------------------- reaper scan (phase 3)
    # ADR 0009 §10: wall-clock staleness candidates for the in-process
    # reaper loop (app.py lifespan). Read-only scan; the terminal transition
    # itself goes through finish_assignment(outcome='expired'), so the audit
    # trail and the task-column mapping stay identical to the API paths.
    # Wall-clock on STORED timestamps — restart-safe: rows that went stale
    # during downtime are caught by the first tick after boot.

    @staticmethod
    def _is_stale_for_reap(row: Any) -> bool:
        """Deadline recheck inside the expire transaction (review P2):
        a heartbeat landing between the reaper scan and this UPDATE must
        not let a live assignment expire. Empty-string timestamps count as
        undatable (review P3) — never reaped."""
        def cutoff(seconds: float) -> str:
            return (datetime.now(timezone.utc) - timedelta(seconds=seconds)
                    ).isoformat(timespec="seconds")
        if row["state"] == "claimed":
            ts = row["claimed_at"] or ""
            return bool(ts) and ts < cutoff(REAP_CLAIM_AFTER_S)
        if row["state"] == "running":
            ts = (row["heartbeat_at"] or row["started_at"]
                  or row["claimed_at"] or "")
            return bool(ts) and ts < cutoff(REAP_HEARTBEAT_AFTER_S)
        return False

    def stale_assignments(self) -> list[dict[str, Any]]:
        """Active assignments past their deadlines (ADR 0009 §10).

        - ``claimed`` with no start for > REAP_CLAIM_AFTER_S;
        - ``running`` with no heartbeat for > REAP_HEARTBEAT_AFTER_S
          (liveness baseline is heartbeat_at — set at start; started_at /
          claimed_at are COALESCE fallbacks for hand-migrated rows).

        Each row comes back with a ``reap_reason`` field (finish note +
        notification message). An undatable row (NULL timestamps) is never
        reaped — the reaper must not destroy what it cannot date.
        """
        def cutoff(seconds: float) -> str:
            return (datetime.now(timezone.utc) - timedelta(seconds=seconds)
                    ).isoformat(timespec="seconds")

        rows: list[Any]
        with self._lock, self._conn() as db:
            rows = db.execute(
                """SELECT * FROM task_assignments
                   WHERE (state='claimed'
                          AND NULLIF(claimed_at, '') IS NOT NULL
                          AND claimed_at < ?)
                      OR (state='running'
                          AND COALESCE(NULLIF(heartbeat_at, ''),
                                       NULLIF(started_at, ''),
                                       NULLIF(claimed_at, ''))
                              IS NOT NULL
                          AND COALESCE(NULLIF(heartbeat_at, ''),
                                       NULLIF(started_at, ''),
                                       NULLIF(claimed_at, ''))
                              < ?)
                   ORDER BY id ASC""",
                (cutoff(REAP_CLAIM_AFTER_S), cutoff(REAP_HEARTBEAT_AFTER_S)),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            a = dict(r)
            claimed = a["state"] == "claimed"
            deadline_s = REAP_CLAIM_AFTER_S if claimed else REAP_HEARTBEAT_AFTER_S
            a["reap_reason"] = (
                f"reaper: {a['state']} без "
                f"{'start' if claimed else 'heartbeat'} "
                f"> {int(deadline_s // 60)} мин")
            out.append(a)
        return out

    def stagnant_queued_assignments(self) -> list[dict[str, Any]]:
        """``queued`` assignments older than REAP_QUEUED_AFTER_S — a dead
        poller must be diagnosable, not silent (ADR 0009 §4). Notification
        only: the state stays queued; cancelling stays the owner's call."""
        cut = (datetime.now(timezone.utc)
               - timedelta(seconds=REAP_QUEUED_AFTER_S)
               ).isoformat(timespec="seconds")
        with self._lock, self._conn() as db:
            rows = db.execute(
                """SELECT * FROM task_assignments
                   WHERE state='queued' AND created_at < ?
                   ORDER BY id ASC""",
                (cut,),
            ).fetchall()
        return [dict(r) for r in rows]

    def notification_exists(self, task_id: str | None, message: str) -> bool:
        """Exact (task_id, message) match — the reaper's dedup for
        stagnation notices: one notification per assignment, not one per
        tick. The message embeds the assignment id, so a re-taken task
        gets a fresh notice for its new assignment. Notifications are
        never pruned, so the guard survives restarts."""
        with self._lock, self._conn() as db:
            return db.execute(
                "SELECT 1 FROM notifications "
                "WHERE task_id IS ? AND message=? LIMIT 1",
                (task_id, message),
            ).fetchone() is not None

    # -------------------------------------- WF-1 validation sweep (24 h)
    # Proposal §6: the scan half of the validation timeout. The write half
    # (tag + audit event) lives in mark_validation_timeout; the app-level
    # sweep loop drives both. Wall-clock on the STORED validating_since —
    # restart-safe: rows that went stale during downtime are caught by the
    # first tick after boot, and the tag is the double-processing guard.

    def stale_validating_tasks(self) -> list[dict[str, Any]]:
        """Live tasks in ``validating`` past VALIDATING_WINDOW_S and not
        yet flagged for the archcom branch. The tag filter is part of the
        SELECT so a flagged task is never re-selected; the write side
        re-checks it inside its transaction (scan→write race guard)."""
        cut = (datetime.now(timezone.utc)
               - timedelta(seconds=VALIDATING_WINDOW_S)
               ).isoformat(timespec="seconds")
        with self._lock, self._conn() as db:
            rows = db.execute(
                """SELECT * FROM tasks
                   WHERE col='validating' AND archived=0
                     AND NULLIF(validating_since, '') IS NOT NULL
                     AND validating_since < ?
                     AND mnemos_tags NOT LIKE ?
                   ORDER BY validating_since ASC""",
                (cut, f'%"{ARCHCOM_REVIEW_TAG}"%'),
            ).fetchall()
        out: list[dict[str, Any]] = []
        for r in rows:
            t = dict(r)
            for k in ("agents", "specialists", "memory_ids", "mnemos_tags"):
                t[k] = _loads(t[k])
            out.append(t)
        return out

    def mark_validation_timeout(self, task_id: str) -> dict[str, Any] | None:
        """Flag one overdue validating task for the archcom branch (WF-1
        proposal §4.1 outcome B): append ARCHCOM_REVIEW_TAG to mnemos_tags
        and write the task.validation-timeout audit event. The task is NOT
        moved — the confirm-or-return decision belongs to the owner/archcom.

        Idempotent: the tag is re-checked inside the transaction, so sweep
        reruns (and any racing second sweeper) can never double-tag.
        Deliberately NOT update_task(): that path enforces the 24h CONTENT
        edit window, which would lock the sweep out of exactly the tasks
        it exists for. Returns the updated task, or None when the task
        left the lane / was archived between scan and write."""
        with self._lock, self._conn() as db:
            row = db.execute(
                """SELECT * FROM tasks
                   WHERE id=? AND col='validating' AND archived=0""",
                (task_id,),
            ).fetchone()
            if row is None:
                return None
            tags = _loads(row["mnemos_tags"])
            if ARCHCOM_REVIEW_TAG in tags:
                return self._task_in_txn(db, task_id)
            tags.append(ARCHCOM_REVIEW_TAG)
            db.execute(
                "UPDATE tasks SET mnemos_tags=?, updated_at=? WHERE id=?",
                (json.dumps(tags), _now(), task_id),
            )
            self._log(db, "task.validation-timeout", task_id, {
                "tag": ARCHCOM_REVIEW_TAG,
                "validating_since": row["validating_since"],
            })
            return self._task_in_txn(db, task_id)
    # ------------------------------------------------ executors (ARCH-9)
    def _executor(self, db: sqlite3.Connection,
                  executor_id: str) -> dict[str, Any] | None:
        row = db.execute(
            "SELECT * FROM executors WHERE id=?", (executor_id,)).fetchone()
        return dict(row) if row else None

    def get_executor(self, executor_id: str) -> dict[str, Any] | None:
        """Raw registry row (includes secret_hash — caller-side concern;
        the API layer NEVER serializes it)."""
        with self._lock, self._conn() as db:
            return self._executor(db, executor_id)

    def list_executors(self) -> list[dict[str, Any]]:
        with self._lock, self._conn() as db:
            return [dict(r) for r in db.execute(
                "SELECT * FROM executors ORDER BY name").fetchall()]

    def pending_executors_by_host(self, host: str) -> int:
        """Open pending registrations for one host (PR #18 F5): the owner
        notification fires for the FIRST pending registration per host —
        later ones from the same host are audit-only (spam guard). The
        audit event (executor.registered) is always written."""
        with self._lock, self._conn() as db:
            return db.execute(
                "SELECT COUNT(*) AS n FROM executors "
                "WHERE state='pending' AND host=?",
                (host,)).fetchone()["n"]

    def register_executor(self, name: str, harness: str, host: str = "",
                          transport: str = "local-poll", version: str = "",
                          enrollment: dict[str, Any] | None = None,
                          enrollment_ip: str = "") -> tuple[dict[str, Any], str]:
        """Create a PENDING registry record and mint its secret (L0, Amd 2
        §4). The board mints executor_secret (token_hex(24)); ONLY the
        sha256 hash is stored — the plaintext exists exactly once, in the
        register response (claim_token pattern, long-lived). Capabilities
        are NOT accepted here: they are owner-declared via update_executor,
        never executor-self-expanded.

        ``enrollment`` (Amd 2 §4 supplement): a live one-time registration
        token row (mne_ leg, _guard_register at the route). The CAS
        created→used rides THIS transaction — a rolled-back registration
        (duplicate name, quota) never burns the token, and two competing
        registrations of one token produce exactly one winner (the loser
        sees state≠created and raises). ``registered_via`` records the
        origin for the owner's approve-time review.

        Raises:
            ValueError — empty name / unknown harness / unknown transport
                         (HTTP 422 upstream);
            ExecutorConflictError — name already registered (409);
            ExecutorQuotaError — open-pending backlog at EXECUTOR_PENDING_CAP
                         (429; PR #18 F5 — pace limits bound requests, not
                         total volume; approve/revoke/delete frees quota);
            EnrollmentStateError — the token was spent between the guard's
                         lookup and the write (HTTP 410 upstream).
        """
        name = name.strip()[:120]
        if not name:
            raise ValueError("executor name is empty")
        if transport not in EXECUTOR_TRANSPORTS:
            raise ValueError(f"invalid transport: {transport}")
        secret = secrets.token_hex(24)
        secret_hash = hashlib.sha256(secret.encode("utf-8")).hexdigest()
        now = _now()
        registered_via = ""
        with self._lock, self._conn() as db:
            pending = db.execute(
                "SELECT COUNT(*) AS n FROM executors WHERE state='pending'"
            ).fetchone()["n"]
            if pending >= EXECUTOR_PENDING_CAP:
                raise ExecutorQuotaError(
                    f"open pending executor registrations are capped at "
                    f"{EXECUTOR_PENDING_CAP} — approve, revoke or delete "
                    "existing ones before registering more")
            # Wave 3C: the harness gate reads the LIVE dictionary inside the
            # registration transaction (no check-then-act window against a
            # concurrent harness deletion). A rolled-back registration never
            # fires.
            known = self._harness_names_db(db)
            if harness not in known:
                raise ValueError(
                    f"unknown harness: {harness}; known: {sorted(known)}")
            if db.execute("SELECT 1 FROM executors WHERE name=?",
                          (name,)).fetchone():
                raise ExecutorConflictError(
                    f"executor name '{name}' is already registered")
            # id 'ex-' + 12 hex chars; PK collision retried (48 bits — the
            # retry is paranoia, not expectation)
            executor_id = "ex-" + secrets.token_hex(6)
            while db.execute("SELECT 1 FROM executors WHERE id=?",
                             (executor_id,)).fetchone():
                executor_id = "ex-" + secrets.token_hex(6)
            if enrollment is not None:
                # Single-use CAS, same transaction as the INSERT below: the
                # guard already verified created+live, so rowcount!=1 means
                # a competing registration won — honest 410, never a second
                # executor on one token.
                cur = db.execute(
                    """UPDATE enrollment_tokens
                       SET state='used', used_at=?, used_ip=?, executor_id=?
                       WHERE id=? AND state='created'""",
                    (now, (enrollment_ip or "")[:64], executor_id,
                     enrollment["id"]))
                if cur.rowcount != 1:
                    raise EnrollmentStateError(
                        f"enrollment token {enrollment['id']} already used")
                registered_via = f"enrollment:{enrollment['id']}"
            db.execute(
                """INSERT INTO executors
                       (id, name, harness, host, transport, capabilities,
                        version, enabled, state, secret_hash, last_seen,
                        registered_via, registered_at, updated_at)
                       VALUES (?,?,?,?,?,'[]',?,0,'pending',?,'',?,?,?)""",
                (executor_id, name, harness, host.strip()[:200], transport,
                 version.strip()[:60], secret_hash, registered_via, now, now),
            )
            # token_id = tail of the stored hash: identifies the secret
            # version in the audit trail without exposing any material
            self._log(db, "executor.registered", None, {
                "executor_id": executor_id, "name": name,
                "harness": harness, "transport": transport,
                "token_id": secret_hash[-8:],
            })
            if enrollment is not None:
                self._log(db, "enrollment.used", None, {
                    "enrollment_id": enrollment["id"],
                    "token_id": enrollment["token_hash"][-8:],
                    "executor_id": executor_id, "executor_name": name,
                    "used_ip": (enrollment_ip or "")[:64],
                })
            row = self._executor(db, executor_id)
        return row, secret  # type: ignore[return-value]

    def authenticate_executor(self, token: str) -> dict[str, Any] | None:
        """Executor-token check (L0): sha256 the presented secret and
        constant-time compare the digest against every stored hash. Returns
        the raw row or None; callers apply their own state gates (presence
        ticks allow pending, the machine loop requires approved)."""
        if not token:
            return None
        digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
        with self._lock, self._conn() as db:
            rows = db.execute(
                "SELECT * FROM executors WHERE secret_hash<>''").fetchall()
        for row in rows:
            if hmac.compare_digest(row["secret_hash"], digest):
                return dict(row)
        return None

    def touch_executor_last_seen(self, executor_id: str) -> bool:
        """Presence tick: last_seen = now. Revoked executors never tick —
        their presence must decay to offline (kill-switch, Amd 2 §5). The
        background sweeper NEVER calls this (computed presence only)."""
        with self._lock, self._conn() as db:
            cur = db.execute(
                "UPDATE executors SET last_seen=? "
                "WHERE id=? AND state<>'revoked'",
                (_now(), executor_id))
            return cur.rowcount > 0

    def update_executor(self, executor_id: str, patch: dict[str, Any],
                        actor: str = "owner") -> tuple[dict[str, Any], dict[str, Any]]:
        """Owner PATCH (ui-token class): name / state / capabilities /
        enabled. Returns (row, changes) where ``changes`` maps field →
        [old, new]; empty changes = idempotent no-op (no audit event).

        State transitions: pending→approved (approve), pending/approved→
        revoked (kill-switch). ``revoked`` is terminal — ExecutorStateError
        on any attempt to leave it (re-register instead: a revoked secret
        must stay dead). Audit kinds: executor.approved / executor.revoked
        / executor.updated (approver + old→new carried in the payload).
        """
        changes: dict[str, list[Any]] = {}
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM executors WHERE id=?", (executor_id,)).fetchone()
            if row is None:
                raise ExecutorNotFoundError(f"executor {executor_id} not found")
            updates: dict[str, Any] = {}
            if patch.get("name") is not None:
                name = str(patch["name"]).strip()[:120]
                if not name:
                    raise ValueError("executor name is empty")
                if name != row["name"]:
                    dup = db.execute(
                        "SELECT 1 FROM executors WHERE name=? AND id<>?",
                        (name, executor_id)).fetchone()
                    if dup:
                        raise ExecutorConflictError(
                            f"executor name '{name}' is already registered")
                    updates["name"] = name
            if patch.get("state") is not None:
                target = patch["state"]
                if target not in EXECUTOR_STATES or target == "pending":
                    raise ValueError(
                        f"invalid executor state target: {target} "
                        "(patchable targets: approved, revoked)")
                if target != row["state"]:
                    if row["state"] == "revoked":
                        raise ExecutorStateError(
                            "executor is revoked — terminal state; "
                            "re-register a new executor instead")
                    updates["state"] = target
            if patch.get("capabilities") is not None:
                raw = patch["capabilities"]
                if (not isinstance(raw, list)
                        or not all(isinstance(c, str) for c in raw)):
                    raise ValueError("capabilities must be a list of strings")
                caps: list[str] = []
                for c in raw:
                    c = c.strip()[:120]
                    if c and c not in caps:
                        caps.append(c)
                if len(caps) > 64:
                    raise ValueError("too many capabilities (max 64)")
                packed = json.dumps(caps)
                if packed != row["capabilities"]:
                    updates["capabilities"] = packed
            if patch.get("enabled") is not None:
                flag = 1 if patch["enabled"] else 0
                if flag != row["enabled"]:
                    updates["enabled"] = flag
            if not updates:
                return dict(row), {}
            old = dict(row)
            updates["updated_at"] = _now()
            sets = ", ".join(f"{k}=?" for k in updates)
            db.execute(
                f"UPDATE executors SET {sets} WHERE id=?",  # noqa: S608 — keys from a fixed allow-list
                (*updates.values(), executor_id),
            )
            for k in ("name", "state", "capabilities", "enabled"):
                if k in updates:
                    old_v, new_v = old[k], updates[k]
                    if k == "capabilities":
                        old_v, new_v = _loads(old_v), _loads(new_v)
                    elif k == "enabled":
                        old_v, new_v = bool(old_v), bool(new_v)
                    changes[k] = [old_v, new_v]
            if updates.get("state") == "approved":
                self._log(db, "executor.approved", None, {
                    "executor_id": executor_id, "approver": actor[:120],
                    "changes": changes})
            elif updates.get("state") == "revoked":
                self._log(db, "executor.revoked", None, {
                    "executor_id": executor_id, "approver": actor[:120],
                    "token_id": old["secret_hash"][-8:], "changes": changes})
            else:
                self._log(db, "executor.updated", None, {
                    "executor_id": executor_id, "actor": actor[:120],
                    "changes": changes})
            out = self._executor(db, executor_id)
        return out, changes  # type: ignore[return-value]

    def delete_executor(self, executor_id: str) -> dict[str, Any] | None:
        """Remove a registry record (ui-token route). Active assignments
        are deliberately NOT touched: executor pins and claimed_by_executor
        attribution strings stay verbatim — the assignment lifecycle is
        independent of the registry (two-clock discipline, Amd 2 §3)."""
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM executors WHERE id=?", (executor_id,)).fetchone()
            if row is None:
                return None
            db.execute("DELETE FROM executors WHERE id=?", (executor_id,))
            self._log(db, "executor.deleted", None, {
                "executor_id": executor_id, "name": row["name"]})
        return dict(row)

    # ------------------------------------------- harness dictionary (wave 3C)
    # The owner-managed nomination dictionary (design 2026-09-22 §C). The
    # gates (registration, enrollment hint, assignment create, automation
    # payloads, rule conditions) read it LIVE; launching stays gated by the
    # poller's local allowlist (A3) — the dictionary never grants execution.
    # Audits: harness.added / harness.removed.

    @staticmethod
    def _harness_names_db(db: sqlite3.Connection) -> frozenset[str]:
        """Live dictionary snapshot on an OPEN connection (transaction-safe:
        callers inside a write transaction use this; standalone callers use
        harness_names())."""
        return frozenset(
            r["name"] for r in db.execute("SELECT name FROM harnesses"))

    def harness_names(self) -> frozenset[str]:
        """Live dictionary snapshot — the single lookup every nomination
        gate uses. A per-call SELECT: the table is tiny (cap 64) and the
        board sees single-digit rps; caching would only add a staleness
        window between add/delete and the next nomination."""
        with self._lock, self._conn() as db:
            return self._harness_names_db(db)

    def list_harnesses(self) -> list[dict[str, Any]]:
        """Full dictionary rows, alphabetical (open read — a dictionary,
        same boundary as GET /api/executors)."""
        with self._lock, self._conn() as db:
            rows = db.execute(
                "SELECT * FROM harnesses ORDER BY name").fetchall()
        return [dict(r) for r in rows]

    def add_harness(self, name: str, note: str = "",
                    added_via: str = "owner") -> dict[str, Any]:
        """Add a harness to the dictionary (ui-token route).

        Raises:
            ValueError — invalid name (HTTP 422 upstream);
            HarnessQuotaError — dictionary ceiling HARNESS_MAX_COUNT
                         (HTTP 422 upstream — entry validation);
            HarnessConflictError — duplicate name (HTTP 409 upstream).
        """
        name = (name or "").strip()
        if not HARNESS_NAME_RE.match(name):
            raise ValueError(
                f"invalid harness name: {name!r} (lowercase latin/digits "
                "first, then [a-z0-9._-], max 60 chars)")
        note = (note or "").strip()[:200]
        with self._lock, self._conn() as db:
            count = db.execute(
                "SELECT COUNT(*) AS n FROM harnesses").fetchone()["n"]
            if count >= HARNESS_MAX_COUNT:
                raise HarnessQuotaError(
                    f"the harness dictionary is capped at {HARNESS_MAX_COUNT} "
                    "— remove unused entries before adding more")
            if db.execute("SELECT 1 FROM harnesses WHERE name=?",
                          (name,)).fetchone():
                raise HarnessConflictError(
                    f"harness '{name}' is already registered")
            now = _now()
            db.execute(
                "INSERT INTO harnesses (name, added_at, added_via, note) "
                "VALUES (?,?,?,?)", (name, now, added_via, note))
            self._log(db, "harness.added", None, {
                "name": name, "added_via": added_via[:60]})
            row = db.execute(
                "SELECT * FROM harnesses WHERE name=?", (name,)).fetchone()
        return dict(row)

    def delete_harness(self, name: str) -> dict[str, Any]:
        """Remove a harness from the dictionary (ui-token route). Deletion
        is refused while the name is LIVE anywhere an executor could act on
        it: a registered executor (its poller.yaml allowlist matches this
        string), a non-terminal assignment (a queued nomination for it) or
        an ENABLED automation rule (schedule field / hook condition).
        Terminal history (done/failed/expired assignments, launch journal)
        and DISABLED rules do NOT block — a disabled rule cannot fire, and
        rules are soft-deleted (retention: the row is never destroyed), so
        counting them would make a harness undeletable forever. Re-enable
        of a rule whose harness is gone is the S2 engine's fire-time
        validation concern (422 at fire, decision logged), not a reason to
        trap the dictionary.

        Raises:
            HarnessNotFoundError — unknown name (HTTP 404 upstream);
            HarnessInUseError — live reference exists (HTTP 409 upstream).
        """
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM harnesses WHERE name=?", (name,)).fetchone()
            if row is None:
                raise HarnessNotFoundError(
                    f"harness {name!r} is not registered")
            if db.execute(
                    "SELECT 1 FROM executors WHERE harness=? LIMIT 1",
                    (name,)).fetchone():
                raise HarnessInUseError(
                    f"harness '{name}' is used by a registered executor — "
                    "revoke or delete that executor first")
            if db.execute(
                    "SELECT 1 FROM task_assignments WHERE harness=? AND "
                    "state IN ('queued','claimed','running') LIMIT 1",
                    (name,)).fetchone():
                raise HarnessInUseError(
                    f"harness '{name}' has active assignments — cancel or "
                    "finish them first")
            if db.execute(
                    "SELECT 1 FROM schedules WHERE harness=? AND enabled=1 "
                    "LIMIT 1", (name,)).fetchone():
                raise HarnessInUseError(
                    f"harness '{name}' is referenced by an automation "
                    "schedule — delete the schedule first")
            for hook in db.execute(
                    "SELECT name, condition FROM hooks "
                    "WHERE enabled=1").fetchall():
                try:
                    clauses = json.loads(hook["condition"] or "[]")
                except ValueError:
                    clauses = []
                if not isinstance(clauses, list):
                    continue
                for clause in clauses:
                    if (isinstance(clause, dict)
                            and clause.get("field") == "harness"
                            and str(clause.get("value")) == name):
                        raise HarnessInUseError(
                            f"harness '{name}' is referenced by automation "
                            f"hook '{hook['name']}' — delete the hook first")
            db.execute("DELETE FROM harnesses WHERE name=?", (name,))
            self._log(db, "harness.removed", None, {"name": name})
        return dict(row)

    def log_board_event(self, kind: str, payload: dict[str, Any]) -> None:
        """Board-level audit event with no task attached (registry and
        settings lifecycle — executor.*, default.changed)."""
        with self._lock, self._conn() as db:
            self._log(db, kind, None, payload)

    # ------------------------------------- pairing + devices (CV-7, ADR 0012)
    # Every method here is serialized by self._lock and does its state
    # transitions via CAS (UPDATE ... WHERE state=<expected>) inside the
    # write transaction, so the single-use / one-shot guarantees hold even
    # under concurrent exchanges (CWE-362, ADR §3.1-§3.2).

    @staticmethod
    def _pairing_public(row: sqlite3.Row) -> dict[str, Any]:
        """UI shape of a pairing request: verify is included (ui-token leg
        only — the API layer gates); code_hash never leaves the store."""
        return {
            "id": row["id"], "state": row["state"], "scope": row["scope"],
            "device_name": row["device_name"], "source_ip": row["source_ip"],
            "created_by": row["created_by"], "created_at": row["created_at"],
            "scanned_at": row["scanned_at"],
            "confirmed_at": row["confirmed_at"],
            "expires_at": row["expires_at"], "verify": row["verify"],
        }

    @staticmethod
    def _device_public(row: sqlite3.Row) -> dict[str, Any]:
        """UI shape of a device session: token_hash NEVER leaves the store
        (ADR §5 — the list must be safe to render on the trusted side)."""
        return {
            "id": row["id"], "name": row["name"], "scope": row["scope"],
            "state": row["state"], "created_at": row["created_at"],
            "last_seen_at": row["last_seen_at"],
            "last_seen": row["last_seen"], "expires_at": row["expires_at"],
            "hard_expires_at": row["hard_expires_at"],
            "ua": row["ua"], "ip": row["ip"],
        }

    @staticmethod
    def pairing_row_expired(row: sqlite3.Row | dict[str, Any]) -> bool:
        """Effective TTL verdict: a live-state pairing past expires_at is
        expired even before the sweep has flipped the column (the sweep
        owns the persisted transition + SSE; reads compute it)."""
        return (row["state"] in PAIRING_LIVE_STATES
                and _iso_past(row["expires_at"]))

    def create_pairing_request(
        self, *, created_by: str = "owner", scope: str = "read",
        ttl_s: float = PAIRING_TTL_S, device_name: str = "",
    ) -> tuple[dict[str, Any], str]:
        """Mint a pairing request (ADR 0012 §2.1). Returns (public row,
        code) — the plaintext code exists exactly once, right here; the
        store keeps only sha256(code). verify is 4 random digits for the
        screen check (§3.5: anti-mistake, NOT an auth factor).
        ``device_name`` is an optional owner-side label shown on the panel
        BEFORE any scan; the device's first exchange overwrites it with
        its own self-asserted name (§3.6 — that is the string the owner
        confirms against)."""
        code = secrets.token_urlsafe(16)          # 128-bit urlsafe
        verify = f"{secrets.randbelow(10 ** PAIRING_VERIFY_DIGITS):0{PAIRING_VERIFY_DIGITS}d}"
        now = datetime.now(timezone.utc)
        pairing_id = "pr-" + secrets.token_hex(6)
        row = {
            "id": pairing_id,
            "code_hash": hashlib.sha256(code.encode("utf-8")).hexdigest(),
            "verify": verify, "state": "created", "scope": scope,
            "created_by": (created_by or "owner")[:120],
            "device_name": (device_name or "").strip()[:64],
            "source_ip": "",
            "created_at": now.isoformat(timespec="seconds"),
            "scanned_at": "", "confirmed_at": "",
            "expires_at": _iso_in(ttl_s, now),
        }
        with self._lock, self._conn() as db:
            db.execute(
                """INSERT INTO pairing_requests
                       (id, code_hash, verify, state, scope, created_by,
                        device_name, source_ip, created_at, scanned_at,
                        confirmed_at, expires_at)
                       VALUES (:id, :code_hash, :verify, :state, :scope,
                        :created_by, :device_name, :source_ip, :created_at,
                        :scanned_at, :confirmed_at, :expires_at)""",
                row,
            )
            self._log(db, "pairing.created", None,
                      {"pairing_id": pairing_id, "created_by": row["created_by"],
                       "scope": scope})
        return dict(row), code

    def get_pairing(self, pairing_id: str) -> dict[str, Any] | None:
        """Raw row by id (caller shapes + gates); None when unknown."""
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM pairing_requests WHERE id=?",
                (pairing_id,)).fetchone()
        return dict(row) if row is not None else None

    def lookup_pairing_by_code(self, code: str) -> dict[str, Any] | None:
        """Raw row matching a presented code (sha256 lookup), newest first.
        Deliberately returns ANY state — the exchange leg must distinguish
        404 (unknown code) from 410 (known but issued/expired/revoked).
        Hash-indexed; constant work for garbage codes (memory-DoS guard
        for the pairing-keyed rate limiter, ADR §3.4)."""
        digest = hashlib.sha256((code or "").encode("utf-8")).hexdigest()
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM pairing_requests WHERE code_hash=? "
                "ORDER BY created_at DESC LIMIT 1",
                (digest,)).fetchone()
        return dict(row) if row is not None else None

    def scan_pairing(self, pairing_id: str, *, device_name: str,
                     source_ip: str) -> tuple[dict[str, Any], bool]:
        """created → scanned, binding source_ip (first exchange only, §3.1)
        and the self-asserted device_name (kept from the FIRST exchange —
        later polls cannot rewrite the identity the owner approves).

        Returns (public row, transitioned): transitioned=True only for the
        call that won the CAS — exactly one concurrent exchange emits the
        SSE pairing.requested; losers and repeats come back False with the
        CURRENT row (the handler answers by its state: scanned → 202
        idempotent without duplicate events, ADR §4; issued/revoked → 410).
        Raises PairingNotFoundError / PairingExpiredError (404 / 410)."""
        now = _now()
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM pairing_requests WHERE id=?",
                (pairing_id,)).fetchone()
            if row is None:
                raise PairingNotFoundError(f"pairing {pairing_id} not found")
            if self.pairing_row_expired(row):
                raise PairingExpiredError("pairing TTL exceeded")
            if row["state"] != "created":
                # scanned (repeat poll), confirmed, issued, revoked — the
                # handler answers by the row it re-reads below
                return self._pairing_public(row), False
            cur = db.execute(
                """UPDATE pairing_requests
                   SET state='scanned', scanned_at=?, device_name=?,
                       source_ip=?
                   WHERE id=? AND state='created'""",
                (now, (device_name or "")[:64], source_ip, pairing_id))
            if cur.rowcount != 1:  # lost the CAS — idempotent repeat
                row = db.execute(
                    "SELECT * FROM pairing_requests WHERE id=?",
                    (pairing_id,)).fetchone()
                return self._pairing_public(row), False
            self._log(db, "pairing.scanned", None,
                      {"pairing_id": pairing_id,
                       "device_name": (device_name or "")[:64],
                       "source_ip": source_ip})
            row = db.execute(
                "SELECT * FROM pairing_requests WHERE id=?",
                (pairing_id,)).fetchone()
            return self._pairing_public(row), True

    def confirm_pairing(self, pairing_id: str, *,
                        allow: bool) -> tuple[dict[str, Any], str]:
        """Owner decision on a scanned pairing (ADR §2.4). Returns (public
        row, outcome) with outcome ∈ {'confirmed', 'denied', 'idempotent'}:
        scanned + allow → confirmed (CAS, 'confirmed'); scanned + deny →
        revoked ('denied'); already confirmed/issued/revoked → 'idempotent'
        (200, state untouched — repeat confirm never re-decides; a change
        of mind after confirm is DELETE /api/pairing/{id}); created →
        PairingStateError (409 — nothing was scanned yet); TTL → 410."""
        now = _now()
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM pairing_requests WHERE id=?",
                (pairing_id,)).fetchone()
            if row is None:
                raise PairingNotFoundError(f"pairing {pairing_id} not found")
            if self.pairing_row_expired(row):
                raise PairingExpiredError("pairing TTL exceeded")
            if row["state"] == "created":
                raise PairingStateError(
                    "pairing has not been scanned by a device yet")
            if row["state"] != "scanned":
                return self._pairing_public(row), "idempotent"
            target = "confirmed" if allow else "revoked"
            cur = db.execute(
                "UPDATE pairing_requests SET state=?, confirmed_at=? "
                "WHERE id=? AND state='scanned'",
                (target, now if allow else "", pairing_id))
            if cur.rowcount != 1:
                return self._pairing_public(row), "idempotent"
            self._log(db, "pairing.confirmed" if allow else "pairing.denied",
                      None, {"pairing_id": pairing_id})
            row = db.execute(
                "SELECT * FROM pairing_requests WHERE id=?",
                (pairing_id,)).fetchone()
            return self._pairing_public(row), (
                "confirmed" if allow else "denied")

    def cancel_pairing(self, pairing_id: str) -> tuple[dict[str, Any], bool]:
        """Owner cancel/revoke before issued (ADR §10.2): created/scanned/
        confirmed → revoked. Returns (public row, transitioned); revoked →
        idempotent False; issued → PairingStateError (409 — the device
        token exists, revoke the DEVICE instead); TTL → 410."""
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM pairing_requests WHERE id=?",
                (pairing_id,)).fetchone()
            if row is None:
                raise PairingNotFoundError(f"pairing {pairing_id} not found")
            if self.pairing_row_expired(row):
                raise PairingExpiredError("pairing TTL exceeded")
            if row["state"] == "issued":
                raise PairingStateError(
                    "pairing already issued — revoke the device session "
                    "(DELETE /api/devices/{id}) instead")
            if row["state"] == "revoked":
                return self._pairing_public(row), False
            cur = db.execute(
                "UPDATE pairing_requests SET state='revoked' "
                "WHERE id=? AND state IN ('created','scanned','confirmed')",
                (pairing_id,))
            if cur.rowcount != 1:
                return self._pairing_public(row), False
            self._log(db, "pairing.revoked", None,
                      {"pairing_id": pairing_id})
            row = db.execute(
                "SELECT * FROM pairing_requests WHERE id=?",
                (pairing_id,)).fetchone()
            return self._pairing_public(row), True

    def issue_device_session(
        self, pairing_id: str, *, ua: str = "", ip: str = "",
    ) -> tuple[dict[str, Any], str]:
        """One-shot token issuance on a confirmed pairing (ADR §2.5/§3.2):
        CAS confirmed → issued + device-session INSERT in ONE transaction.
        The CAS makes the issuance single-shot — a second exchange finds
        `issued` and gets 410 upstream; a photo of the QR never gains
        equal-poll rights. The ≤5-active quota is checked BEFORE the CAS:
        a 409 leaves the pairing confirmed (retryable after the owner
        frees a slot). Returns (public device row, mnd_-prefixed token) —
        the plaintext token exists exactly once, right here.

        The device name comes ONLY from the scan-time row: it is the
        identity the owner saw and confirmed — a device presenting a
        different name on the issuance exchange cannot rewrite it."""
        token = DEVICE_TOKEN_PREFIX + secrets.token_urlsafe(24)
        token_hash = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = datetime.now(timezone.utc)
        now_s = now.isoformat(timespec="seconds")
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM pairing_requests WHERE id=?",
                (pairing_id,)).fetchone()
            if row is None:
                raise PairingNotFoundError(f"pairing {pairing_id} not found")
            if row["state"] in ("expired",) or self.pairing_row_expired(row):
                raise PairingExpiredError("pairing TTL exceeded")
            if row["state"] != "confirmed":
                raise PairingStateError(
                    f"pairing is {row['state']}, not confirmed")
            active = db.execute(
                "SELECT COUNT(*) AS n FROM device_sessions "
                "WHERE state='active'").fetchone()["n"]
            if active >= DEVICE_MAX_ACTIVE:
                raise DeviceQuotaError(
                    f"active device sessions are capped at "
                    f"{DEVICE_MAX_ACTIVE} — revoke one (DELETE "
                    "/api/devices/{id}) and retry the exchange; "
                    "auto-eviction is not performed")
            cur = db.execute(
                "UPDATE pairing_requests SET state='issued' "
                "WHERE id=? AND state='confirmed'",
                (pairing_id,))
            if cur.rowcount != 1:
                raise PairingStateError(
                    f"pairing is no longer confirmed (lost the issuance "
                    f"race)")
            name = (row["device_name"] or "unnamed device")[:64]
            device_id = "dev-" + secrets.token_hex(6)
            while db.execute(
                    "SELECT 1 FROM device_sessions WHERE id=?",
                    (device_id,)).fetchone():
                device_id = "dev-" + secrets.token_hex(6)
            device = {
                "id": device_id, "name": name, "scope": row["scope"],
                "token_hash": token_hash, "created_at": now_s,
                "last_seen_at": now_s,
                "expires_at": _iso_in(DEVICE_SLIDING_TTL_S, now),
                "hard_expires_at": _iso_in(DEVICE_HARD_TTL_S, now),
                "state": "active", "ua": (ua or "")[:200],
                "ip": (ip or "")[:64], "last_seen": now_s,
            }
            db.execute(
                """INSERT INTO device_sessions
                       (id, name, scope, token_hash, created_at,
                        last_seen_at, expires_at, hard_expires_at, state,
                        ua, ip, last_seen)
                       VALUES (:id, :name, :scope, :token_hash, :created_at,
                        :last_seen_at, :expires_at, :hard_expires_at,
                        :state, :ua, :ip, :last_seen)""",
                device)
            self._log(db, "pairing.issued", None, {
                "pairing_id": pairing_id, "device_id": device_id,
                # hash tail identifies the token version in the audit
                # trail without exposing material (executor precedent)
                "token_id": token_hash[-8:],
            })
            return self._device_public_from(device), token

    @staticmethod
    def _device_public_from(device: dict[str, Any]) -> dict[str, Any]:
        """_device_public for a just-minted dict (no Row at hand)."""
        return {k: v for k, v in device.items() if k != "token_hash"}

    def list_devices(self) -> list[dict[str, Any]]:
        """All device sessions, public shape (no token hashes), oldest
        first — the owner list is small and stable-ordered."""
        with self._lock, self._conn() as db:
            rows = db.execute(
                "SELECT * FROM device_sessions ORDER BY created_at, id"
            ).fetchall()
        return [self._device_public(r) for r in rows]

    def revoke_device(self, device_id: str) -> tuple[dict[str, Any], bool] | None:
        """Revoke a device session (terminal — only a new pairing restores
        access, ADR §5). Returns (public row, transitioned); already
        revoked/expired → (row, False) idempotent; None when unknown."""
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM device_sessions WHERE id=?",
                (device_id,)).fetchone()
            if row is None:
                return None
            cur = db.execute(
                "UPDATE device_sessions SET state='revoked' "
                "WHERE id=? AND state='active'",
                (device_id,))
            transitioned = cur.rowcount == 1
            if transitioned:
                self._log(db, "device.revoked", None, {
                    "device_id": device_id,
                    "token_id": row["token_hash"][-8:]})
                row = db.execute(
                    "SELECT * FROM device_sessions WHERE id=?",
                    (device_id,)).fetchone()
        return self._device_public(row), transitioned

    def validate_device_token(
        self, token: str, *, ua: str = "", ip: str = "",
    ) -> dict[str, Any] | None:
        """Device-token check (ADR §5): sha256 the presented token, index
        lookup, constant-time compare. Revoked / hard-TTL-passed /
        sliding-TTL-lapsed tokens answer None (401 upstream) and are
        lazily flipped to state='expired' when the clock says so. A valid
        active token slides expires_at forward (30 d) and ticks
        last_seen/ua/ip — one write per authenticated request, the
        executor presence-tick pattern."""
        if not token.startswith(DEVICE_TOKEN_PREFIX):
            return None
        digest = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = datetime.now(timezone.utc)
        now_s = now.isoformat(timespec="seconds")
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM device_sessions WHERE token_hash=?",
                (digest,)).fetchone()
            if row is None or not hmac.compare_digest(
                    row["token_hash"], digest):
                return None
            if row["state"] == "revoked":
                return None
            if (_iso_past(row["hard_expires_at"], now)
                    or _iso_past(row["expires_at"], now)):
                if row["state"] == "active":
                    db.execute(
                        "UPDATE device_sessions SET state='expired' "
                        "WHERE id=? AND state='active'", (row["id"],))
                return None
            if row["state"] != "active":
                return None
            db.execute(
                """UPDATE device_sessions
                   SET last_seen_at=?, last_seen=?, expires_at=?, ua=?, ip=?
                   WHERE id=? AND state='active'""",
                (now_s, now_s, _iso_in(DEVICE_SLIDING_TTL_S, now),
                 (ua or "")[:200], (ip or "")[:64], row["id"]))
            return self._device_public(row)

    def expire_stale_pairings(self) -> list[dict[str, Any]]:
        """TTL sweep, pairing side (ADR §10.3 pairing.expired): flip live
        pairings past expires_at to expired. Returns the transitioned rows
        (caller emits SSE + notification). CAS per row — a pairing that
        moved (confirmed→issued) between scan and write is skipped."""
        now = _now()
        transitioned: list[dict[str, Any]] = []
        with self._lock, self._conn() as db:
            rows = db.execute(
                "SELECT * FROM pairing_requests WHERE state IN "
                "('created','scanned','confirmed')").fetchall()
            for row in rows:
                if not _iso_past(row["expires_at"]):
                    continue
                cur = db.execute(
                    "UPDATE pairing_requests SET state='expired' "
                    "WHERE id=? AND state IN ('created','scanned','confirmed')",
                    (row["id"],))
                if cur.rowcount == 1:
                    self._log(db, "pairing.expired", None,
                              {"pairing_id": row["id"]})
                    transitioned.append(self._pairing_public(row))
        return transitioned

    def expire_stale_devices(self) -> list[dict[str, Any]]:
        """TTL sweep, device side: active sessions whose SLIDING or HARD
        expiry passed flip to expired (the sliding clock only moves on
        activity — a lapsed session is dead, the device must re-pair).
        No SSE: the dictionary has no device.* kinds and pairing.* is
        pairing-scoped (ADR §10.3); revocation events carry device ids,
        expiry does not. Returns transitioned rows (caller logs)."""
        now = datetime.now(timezone.utc)
        transitioned: list[dict[str, Any]] = []
        with self._lock, self._conn() as db:
            rows = db.execute(
                "SELECT * FROM device_sessions WHERE state='active'"
            ).fetchall()
            for row in rows:
                if not (_iso_past(row["expires_at"], now)
                        or _iso_past(row["hard_expires_at"], now)):
                    continue
                cur = db.execute(
                    "UPDATE device_sessions SET state='expired' "
                    "WHERE id=? AND state='active'", (row["id"],))
                if cur.rowcount == 1:
                    self._log(db, "device.expired", None,
                              {"device_id": row["id"]})
                    transitioned.append(self._device_public(row))
        return transitioned

    # ------------------------------------------------ enrollment (Amd 2 §4 suppl.)
    # One-time registration tokens (mne_) for REMOTE executors. Same
    # discipline as pairing (ADR 0012): hash-only, one TTL, single-use CAS,
    # audit without material — but ONE protocol step (present the token on
    # POST /api/executors), no verify digits, no IP binding: the human gate
    # is the existing pending→approve flow, not a mid-protocol confirm.

    @staticmethod
    def _enrollment_public(row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        """Public enrollment shape — token_hash NEVER leaves the store."""
        return {
            "enrollment_id": row["id"], "label": row["label"],
            "harness_hint": row["harness_hint"], "name_hint": row["name_hint"],
            "state": row["state"], "created_at": row["created_at"],
            "expires_at": row["expires_at"], "used_at": row["used_at"],
            "used_ip": row["used_ip"], "executor_id": row["executor_id"],
        }

    @staticmethod
    def enrollment_row_expired(row: sqlite3.Row | dict[str, Any]) -> bool:
        """Effective TTL verdict: a created token past expires_at is expired
        even before the sweep has flipped the column (the sweep owns the
        persisted transition + SSE; reads compute it)."""
        return (row["state"] == "created"
                and _iso_past(row["expires_at"]))

    def create_enrollment(self, *, label: str = "", harness_hint: str = "",
                          name_hint: str = "", created_by: str = "owner",
                          ttl_s: float = ENROLLMENT_TTL_S,
                          ) -> tuple[dict[str, Any], str]:
        """Mint a one-time enrollment token (ui leg). Returns (public row,
        token) — the plaintext ``mne_…`` exists exactly once, right here;
        the store keeps only sha256(token). The live-token quota is checked
        under the store lock (HTTP 409 upstream via EnrollmentQuotaError —
        no auto-revoke, the owner chooses). ``harness_hint`` is validated
        against the closed allowlist when non-empty: the UI renders it in
        the bootstrap command, a typo'd hint would mislead the VPS leg."""
        if label:
            label = label.strip()[:64]
        if name_hint:
            name_hint = name_hint.strip()[:120]
        harness_hint = (harness_hint or "").strip()[:60]
        if harness_hint:
            # Wave 3C: the hint gate reads the LIVE harness dictionary (the
            # hint feeds the bootstrap command — a bogus hint would mislead
            # the remote leg).
            known = self.harness_names()
            if harness_hint not in known:
                raise ValueError(
                    f"unknown harness: {harness_hint}; "
                    f"known: {sorted(known)}")
        token = ENROLLMENT_TOKEN_PREFIX + secrets.token_urlsafe(24)
        now = datetime.now(timezone.utc)
        enrollment_id = "enr-" + secrets.token_hex(6)
        row = {
            "id": enrollment_id,
            "token_hash": hashlib.sha256(token.encode("utf-8")).hexdigest(),
            "label": label, "harness_hint": harness_hint,
            "name_hint": name_hint, "state": "created",
            "created_by": (created_by or "owner")[:120],
            "created_at": now.isoformat(timespec="seconds"),
            "expires_at": _iso_in(ttl_s, now),
            "used_at": "", "used_ip": "", "executor_id": "",
        }
        with self._lock, self._conn() as db:
            live = db.execute(
                "SELECT COUNT(*) AS n FROM enrollment_tokens "
                "WHERE state='created'").fetchone()["n"]
            if live >= ENROLLMENT_MAX_LIVE:
                raise EnrollmentQuotaError(
                    f"live enrollment tokens are capped at {ENROLLMENT_MAX_LIVE} "
                    "— revoke one or wait for TTL before creating more")
            db.execute(
                """INSERT INTO enrollment_tokens
                       (id, token_hash, label, harness_hint, name_hint,
                        state, created_by, created_at, expires_at,
                        used_at, used_ip, executor_id)
                       VALUES (:id, :token_hash, :label, :harness_hint,
                        :name_hint, :state, :created_by, :created_at,
                        :expires_at, :used_at, :used_ip, :executor_id)""",
                row,
            )
            self._log(db, "enrollment.created", None, {
                "enrollment_id": enrollment_id,
                "token_id": row["token_hash"][-8:],
                "label": label, "harness_hint": harness_hint,
                "expires_at": row["expires_at"],
            })
        return self._enrollment_public(row), token

    def list_enrollments(self) -> list[dict[str, Any]]:
        """All enrollment tokens, newest first (ui leg — token list panel
        shows live ones plus recent terminal history). No hash, no token."""
        with self._lock, self._conn() as db:
            rows = db.execute(
                "SELECT * FROM enrollment_tokens "
                "ORDER BY created_at DESC, id DESC").fetchall()
        return [self._enrollment_public(r) for r in rows]

    def get_enrollment(self, enrollment_id: str) -> dict[str, Any] | None:
        """Raw public row by id; None when unknown."""
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM enrollment_tokens WHERE id=?",
                (enrollment_id,)).fetchone()
        return self._enrollment_public(row) if row is not None else None

    def revoke_enrollment(self, enrollment_id: str,
                          ) -> tuple[dict[str, Any], bool]:
        """Revoke a LIVE (created) token (ui leg). Returns (public row,
        transitioned): created → revoked (transitioned=True, caller emits
        SSE); already revoked → (row, False) idempotent (pairing-cancel
        pattern); used → EnrollmentStateError — the executor EXISTS, kill
        it via the executor registry (DELETE /api/executors/{id}), burning
        this row would orphan the audit link; expired → EnrollmentStateError
        (the TTL already did the job)."""
        now = _now()
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM enrollment_tokens WHERE id=?",
                (enrollment_id,)).fetchone()
            if row is None:
                raise EnrollmentNotFoundError(
                    f"enrollment {enrollment_id} not found")
            if row["state"] == "created":
                cur = db.execute(
                    "UPDATE enrollment_tokens SET state='revoked' "
                    "WHERE id=? AND state='created'", (enrollment_id,))
                if cur.rowcount != 1:  # pragma: no cover — store lock is exclusive
                    raise EnrollmentStateError(
                        "enrollment token moved concurrently; re-read it")
                self._log(db, "enrollment.revoked", None, {
                    "enrollment_id": enrollment_id,
                    "token_id": row["token_hash"][-8:],
                })
                row = db.execute(
                    "SELECT * FROM enrollment_tokens WHERE id=?",
                    (enrollment_id,)).fetchone()
                return self._enrollment_public(row), True
            if row["state"] == "revoked":
                return self._enrollment_public(row), False
            raise EnrollmentStateError(
                f"enrollment token is {row['state']} — nothing to revoke")

    def lookup_enrollment_by_token(self, token: str) -> dict[str, Any] | None:
        """Raw row matching a presented ``mne_`` token (sha256 lookup),
        newest first. Deliberately returns ANY state — the registration
        guard must distinguish 401 (unknown) from 410 (known but dead).
        Hash-indexed; constant work for garbage tokens."""
        digest = hashlib.sha256((token or "").encode("utf-8")).hexdigest()
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM enrollment_tokens WHERE token_hash=? "
                "ORDER BY created_at DESC LIMIT 1", (digest,)).fetchone()
        return dict(row) if row is not None else None

    def expire_stale_enrollments(self) -> list[dict[str, Any]]:
        """TTL sweep, enrollment side: flip created tokens past expires_at
        to expired (rides the pairing sweeper cycle). Returns the
        transitioned rows (caller emits SSE); CAS per row."""
        transitioned: list[dict[str, Any]] = []
        with self._lock, self._conn() as db:
            rows = db.execute(
                "SELECT * FROM enrollment_tokens WHERE state='created'"
            ).fetchall()
            for row in rows:
                if not _iso_past(row["expires_at"]):
                    continue
                cur = db.execute(
                    "UPDATE enrollment_tokens SET state='expired' "
                    "WHERE id=? AND state='created'", (row["id"],))
                if cur.rowcount == 1:
                    self._log(db, "enrollment.expired", None, {
                        "enrollment_id": row["id"],
                        "token_id": row["token_hash"][-8:],
                    })
                    transitioned.append(self._enrollment_public(row))
        return transitioned

    # ------------------------------------------------ automation (SCHED-1 S1)
    # ADR 0013 §2: rule CRUD + journal + manual run-now. NO engine, NO
    # loops, NO ECA in S1 — everything here is contracts the S2 engine
    # will execute behind the T2 gate. DELETE is soft-disable retention:
    # the row is never destroyed (journal cross-reference + audit), the
    # rule stays listed with enabled=false.

    @staticmethod
    def _rule_name(raw: Any) -> str:
        name = (raw or "").strip()[:_RULE_MAX_NAME] if isinstance(raw, str) else ""
        if not name:
            raise AutomationValidationError("rule name is empty")
        return name

    def _rule_exists(self, db: sqlite3.Connection, table: str,
                     name: str, exclude_id: int | None = None) -> bool:
        q = f"SELECT 1 FROM {table} WHERE name=?"  # noqa: S608 — fixed table name
        params: list[Any] = [name]
        if exclude_id is not None:
            q += " AND id<>?"
            params.append(exclude_id)
        return db.execute(q, params).fetchone() is not None

    @staticmethod
    def _schedule_public(row: Any) -> dict[str, Any]:
        out = dict(row)
        out["enabled"] = bool(out["enabled"])
        return out

    @staticmethod
    def _hook_public(row: Any) -> dict[str, Any]:
        out = dict(row)
        out["enabled"] = bool(out["enabled"])
        out["condition"] = _loads(out.get("condition") or "[]")
        out["source_allowlist"] = _loads(out.get("source_allowlist") or "[]")
        try:
            out["action_payload"] = json.loads(out.get("action_payload") or "{}")
        except (TypeError, ValueError):
            out["action_payload"] = {}
        return out

    @staticmethod
    def _launch_public(row: Any) -> dict[str, Any]:
        return dict(row)

    def _validate_schedule_fields(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Shared create/patch field validation → column dict. Values are
        validated independently; the trigger pair is checked together when
        both sides are known (see _validate_schedule_trigger)."""
        fields: dict[str, Any] = {}
        if "name" in payload:
            fields["name"] = self._rule_name(payload["name"])
        if "target_kind" in payload:
            if payload["target_kind"] != "task":
                raise AutomationValidationError(
                    f"target_kind {payload['target_kind']!r} is not supported "
                    "in v1 (only 'task' — recurring run on one task; ADR "
                    "0013 §6.1)")
        if "task_id" in payload:
            task_id = payload["task_id"]
            if (not isinstance(task_id, str)
                    or not task_id.strip() or len(task_id) > 100):
                raise AutomationValidationError(
                    "task_id must be a non-empty string (<=100 chars)")
            # Existence is deliberately NOT checked: assignability belongs
            # to fire time (TOCTOU, SCHED-1 Н2), not to rule save time.
            fields["task_id"] = task_id.strip()
        if "specialist" in payload:
            specialist = payload["specialist"]
            if (not isinstance(specialist, str) or not specialist.strip()
                    or len(specialist) > 120):
                raise AutomationValidationError(
                    "specialist must be a non-empty string (<=120 chars)")
            fields["specialist"] = specialist.strip()
        if "harness" in payload:
            known = self.harness_names()
            if payload["harness"] not in known:
                raise AutomationValidationError(
                    f"unknown harness: {payload['harness']!r}; known: "
                    f"{sorted(known)}")
            fields["harness"] = payload["harness"]
        if "executor_id" in payload:
            executor_id = payload["executor_id"]
            if not isinstance(executor_id, str) or len(executor_id) > 120:
                raise AutomationValidationError(
                    "executor_id must be a string (<=120 chars)")
            # designation without validation (Ф1 contract — ARCH-9 pins are
            # enforced at claim, never here)
            fields["executor_id"] = executor_id.strip()
        if "trigger_kind" in payload:
            if payload["trigger_kind"] not in SCHEDULE_TRIGGER_KINDS:
                raise AutomationValidationError(
                    f"unknown trigger_kind: {payload['trigger_kind']!r}; "
                    f"allowed: {sorted(SCHEDULE_TRIGGER_KINDS)}")
            fields["trigger_kind"] = payload["trigger_kind"]
        if "trigger_value" in payload:
            fields["trigger_value"] = payload["trigger_value"]
        if "window_from" in payload or "window_to" in payload:
            wf, wt = _validate_window(payload.get("window_from"),
                                      payload.get("window_to"))
            fields["window_from"], fields["window_to"] = wf, wt
        if "max_runs_per_day" in payload:
            v = payload["max_runs_per_day"]
            if not isinstance(v, int) or isinstance(v, bool) or not 1 <= v <= 1000:
                raise AutomationValidationError(
                    "max_runs_per_day must be an int in 1..1000")
            fields["max_runs_per_day"] = v
        if "cooldown_s" in payload:
            v = payload["cooldown_s"]
            if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 86400:
                raise AutomationValidationError(
                    "cooldown_s must be an int in 0..86400")
            fields["cooldown_s"] = v
        if "enabled" in payload:
            if not isinstance(payload["enabled"], bool):
                raise AutomationValidationError("enabled must be a boolean")
            fields["enabled"] = 1 if payload["enabled"] else 0
        return fields

    @staticmethod
    def _validate_schedule_trigger(trigger_kind: str, trigger_value: Any) -> None:
        """The trigger pair, checked together (kind tells how to read the
        value). Interval >= 60 s per ADR 0013 §2."""
        if not isinstance(trigger_value, str) or not trigger_value.strip():
            raise AutomationValidationError("trigger_value must be a string")
        trigger_value = trigger_value.strip()
        if trigger_kind == "interval":
            seconds = parse_iso8601_duration(trigger_value)
            if seconds < SCHEDULE_MIN_INTERVAL_S:
                raise AutomationValidationError(
                    f"interval must be >= {int(SCHEDULE_MIN_INTERVAL_S)}s, "
                    f"got {trigger_value!r}")
            if seconds > SCHEDULE_MAX_INTERVAL_S:
                raise AutomationValidationError(
                    f"interval must be <= {int(SCHEDULE_MAX_INTERVAL_S)}s, "
                    f"got {trigger_value!r}")
        else:  # time-of-day (kind validated upstream)
            _validate_hhmm(trigger_value, "trigger_value")

    def create_schedule(self, payload: dict[str, Any],
                        actor: str = "owner") -> dict[str, Any]:
        """Create a schedule rule (S1, ADR 0013 §2). Creation is DISABLED
        (``enabled DEFAULT 0``) — a client ``enabled`` flag is ignored:
        enablement is a separate audited PATCH (rule.toggled).
        ``next_run_at`` is computed here from now and on every later PATCH
        — never accepted from a client (schedule-clock family is
        server-owned)."""
        name = self._rule_name(payload.get("name"))
        rest = {k: v for k, v in payload.items() if k != "name"}
        # The harness default applies BEFORE validation: the effective
        # value must pass the live-dictionary gate like any provided one
        # (wave 3C review — a defaulted 'zcode' must not bypass the gate;
        # with the seed deleted the omission is an honest 422).
        rest.setdefault("harness", "zcode")
        fields = self._validate_schedule_fields(rest)
        # target_kind was validated against the v1 dictionary ('task' only)
        # inside _validate_schedule_fields; executor pin default:
        fields.setdefault("executor_id", "")
        fields.setdefault("max_runs_per_day", SCHEDULE_DEFAULT_MAX_RUNS_PER_DAY)
        fields.setdefault("cooldown_s", SCHEDULE_DEFAULT_COOLDOWN_S)
        for req in ("task_id", "specialist", "trigger_kind", "trigger_value"):
            if req not in fields:
                raise AutomationValidationError(f"{req} is required")
        self._validate_schedule_trigger(fields["trigger_kind"],
                                        fields["trigger_value"])
        now = _now()
        next_run_at = _compute_next_run(fields["trigger_kind"],
                                        fields["trigger_value"])
        with self._lock, self._conn() as db:
            if self._rule_exists(db, "schedules", name):
                raise AutomationValidationError(
                    f"schedule name '{name}' already exists")
            cur = db.execute(
                """INSERT INTO schedules
                       (name, enabled, target_kind, task_id, specialist,
                        harness, executor_id, trigger_kind, trigger_value,
                        window_from, window_to, max_runs_per_day, cooldown_s,
                        next_run_at, last_run_at, created_by, created_at,
                        updated_at)
                       VALUES (?,0,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)""",
                (name, "task", fields["task_id"],
                 fields["specialist"], fields["harness"],
                 fields["executor_id"], fields["trigger_kind"],
                 fields["trigger_value"], fields["window_from"],
                 fields["window_to"], fields["max_runs_per_day"],
                 fields["cooldown_s"], next_run_at,
                 actor[:120], now, now),
            )
            rule_id = int(cur.lastrowid)
            self._log(db, "rule.created", None, {
                "rule_id": rule_id, "rule_kind": "schedule", "name": name,
                "actor": actor[:120]})
            row = db.execute("SELECT * FROM schedules WHERE id=?",
                             (rule_id,)).fetchone()
        return self._schedule_public(row)

    def update_schedule(self, rule_id: int, patch: dict[str, Any],
                        actor: str = "owner") -> tuple[dict[str, Any], dict[str, list[Any]]]:
        """PATCH a schedule (ui-token route). Allow-listed fields only;
        ``next_run_at``/``last_run_at``/audit columns are never patchable.
        Every effective PATCH recomputes ``next_run_at`` from now (ADR
        0013 §2). Returns (row, changes) with changes field → [old, new];
        empty changes = idempotent no-op (no audit, no recompute)."""
        allowed = {"name", "target_kind", "task_id", "specialist", "harness",
                   "executor_id", "trigger_kind", "trigger_value",
                   "window_from", "window_to", "max_runs_per_day",
                   "cooldown_s", "enabled"}
        fields = self._validate_schedule_fields(
            {k: v for k, v in patch.items() if k in allowed})
        with self._lock, self._conn() as db:
            row = db.execute("SELECT * FROM schedules WHERE id=?",
                             (rule_id,)).fetchone()
            if row is None:
                raise RuleNotFoundError(f"schedule {rule_id} not found")
            old = self._schedule_public(row)
            if "name" in fields and fields["name"] != old["name"]:
                if self._rule_exists(db, "schedules", fields["name"],
                                     exclude_id=rule_id):
                    raise AutomationValidationError(
                        f"schedule name '{fields['name']}' already exists")
            updates = {k: v for k, v in fields.items() if v != old.get(k)}
            if not updates:
                return old, {}
            # effective trigger pair (patched or existing) for validation
            # and the next_run_at recompute
            eff_kind = updates.get("trigger_kind", old["trigger_kind"])
            eff_value = updates.get("trigger_value", old["trigger_value"])
            self._validate_schedule_trigger(eff_kind, eff_value)
            eff_window = _validate_window(
                updates.get("window_from", old["window_from"]),
                updates.get("window_to", old["window_to"]))
            updates["window_from"], updates["window_to"] = eff_window
            updates["next_run_at"] = _compute_next_run(eff_kind, eff_value)
            updates["updated_at"] = _now()
            sets = ", ".join(f"{k}=?" for k in updates)
            db.execute(
                f"UPDATE schedules SET {sets} WHERE id=?",  # noqa: S608 — keys from a fixed allow-list
                (*updates.values(), rule_id),
            )
            changes: dict[str, list[Any]] = {}
            for k, v in updates.items():
                if k in ("next_run_at", "updated_at", "window_from",
                         "window_to"):
                    changes[k] = [old.get(k), v]
                elif k == "enabled":
                    changes[k] = [bool(old[k]), bool(v)]
                else:
                    changes[k] = [old.get(k), v]
            # audit kind: a pure enable/disable flip is rule.toggled;
            # anything else (incl. mixed patches) is rule.updated
            kind = ("rule.toggled" if set(patch) == {"enabled"}
                    else "rule.updated")
            self._log(db, kind, None, {
                "rule_id": rule_id, "rule_kind": "schedule",
                "name": updates.get("name", old["name"]),
                "actor": actor[:120], "changes": changes})
            fresh = db.execute("SELECT * FROM schedules WHERE id=?",
                               (rule_id,)).fetchone()
        return self._schedule_public(fresh), changes

    def delete_schedule(self, rule_id: int,
                        actor: str = "owner") -> dict[str, Any]:
        """DELETE = soft-disable retention (ADR 0013 §2): the row is NEVER
        destroyed — the launch journal and the audit trail keep their
        cross-reference. The rule stays listed with enabled=false; the
        UNIQUE(name) constraint keeps holding (rename or re-enable via
        PATCH). Audited as rule.deleted."""
        with self._lock, self._conn() as db:
            row = db.execute("SELECT * FROM schedules WHERE id=?",
                             (rule_id,)).fetchone()
            if row is None:
                raise RuleNotFoundError(f"schedule {rule_id} not found")
            old = self._schedule_public(row)
            db.execute(
                "UPDATE schedules SET enabled=0, updated_at=? WHERE id=?",
                (_now(), rule_id),
            )
            self._log(db, "rule.deleted", None, {
                "rule_id": rule_id, "rule_kind": "schedule",
                "name": old["name"], "actor": actor[:120],
                "changes": {"enabled": [old["enabled"], False]}})
            fresh = db.execute("SELECT * FROM schedules WHERE id=?",
                               (rule_id,)).fetchone()
        return self._schedule_public(fresh)

    def get_schedule(self, rule_id: int) -> dict[str, Any] | None:
        with self._lock, self._conn() as db:
            row = db.execute("SELECT * FROM schedules WHERE id=?",
                             (rule_id,)).fetchone()
        return self._schedule_public(row) if row else None

    def list_schedules(self) -> list[dict[str, Any]]:
        with self._lock, self._conn() as db:
            rows = db.execute(
                "SELECT * FROM schedules ORDER BY name").fetchall()
        return [self._schedule_public(r) for r in rows]

    # ------------------------------------------------------- hooks CRUD

    def _validate_hook_fields(self, payload: dict[str, Any]) -> dict[str, Any]:
        fields: dict[str, Any] = {}
        if "name" in payload:
            fields["name"] = self._rule_name(payload["name"])
        if "on" in payload:
            if payload["on"] not in HOOK_EVENT_WHITELIST:
                raise AutomationValidationError(
                    f"unknown hook event: {payload['on']!r}; allowed: "
                    f"{sorted(HOOK_EVENT_WHITELIST)}")
            fields["on"] = payload["on"]
        if "condition" in payload:
            fields["condition"] = validate_condition(
                payload["condition"], self.harness_names())
        if "action" in payload:
            if payload["action"] not in HOOK_ACTIONS:
                raise AutomationValidationError(
                    f"unknown action: {payload['action']!r}; allowed: "
                    f"{sorted(HOOK_ACTIONS)}")
            fields["action"] = payload["action"]
        # SCHED-1 §5: executor.offline is notify-only — a create_assignment
        # hook on it is rejected at CRUD time so S2 never inherits an
        # unenforced intention.
        if payload.get("on") == "executor.offline" and \
                payload.get("action") == "create_assignment":
            raise AutomationValidationError(
                "executor.offline is notify-only (SCHED-1 §5): "
                "create_assignment hooks on it are not allowed")
        if "source_allowlist" in payload:
            action = payload.get("action")
            if action is None:
                # validated against the STORED action when the patch does
                # not carry one — the route resolves this before the call
                raise AutomationValidationError(
                    "source_allowlist requires the action context")
            fields["source_allowlist"] = validate_source_allowlist(
                payload["source_allowlist"], action)
        if "action_payload" in payload:
            ap = payload["action_payload"]
            if ap is None:
                ap = {}
            if not isinstance(ap, dict):
                raise AutomationValidationError(
                    "action_payload must be a JSON object")
            packed = json.dumps(ap, ensure_ascii=False)
            if len(packed) > _RULE_MAX_PAYLOAD_JSON:
                raise AutomationValidationError(
                    f"action_payload too large (>{_RULE_MAX_PAYLOAD_JSON} chars)")
            fields["action_payload"] = packed
        if "cooldown_s" in payload:
            v = payload["cooldown_s"]
            if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 86400:
                raise AutomationValidationError(
                    "cooldown_s must be an int in 0..86400")
            fields["cooldown_s"] = v
        if "budget" in payload:
            v = payload["budget"]
            if not isinstance(v, int) or isinstance(v, bool) or not 1 <= v <= 1000:
                raise AutomationValidationError(
                    "budget must be an int in 1..1000")
            fields["budget"] = v
        if "enabled" in payload:
            if not isinstance(payload["enabled"], bool):
                raise AutomationValidationError("enabled must be a boolean")
            fields["enabled"] = 1 if payload["enabled"] else 0
        return fields

    def create_hook(self, payload: dict[str, Any],
                    actor: str = "owner") -> dict[str, Any]:
        """Create a hook rule (S1). ``on`` is validated against the server
        constant HOOK_EVENT_WHITELIST; condition against the closed field/
        op allowlist; source_allowlist defaults by action (notify → every
        origin except automation; create_assignment → ui/server only —
        machine is an explicit owner opt-in, audited old→new on PATCH)."""
        name = self._rule_name(payload.get("name"))
        payload = dict(payload)
        # resolve the action default BEFORE field validation so an explicit
        # source_allowlist validates against the effective action (notify
        # unless stated otherwise)
        payload.setdefault("action", "notify")
        fields = self._validate_hook_fields(
            {k: v for k, v in payload.items() if k != "name"})
        for req in ("on",):
            if req not in fields:
                raise AutomationValidationError(f"{req} is required")
        action = fields["action"]
        # source default resolves against the FINAL action
        if "source_allowlist" not in fields:
            fields["source_allowlist"] = validate_source_allowlist(None, action)
        fields.setdefault("condition", [])
        fields.setdefault("action_payload", json.dumps({}))
        fields.setdefault("cooldown_s", SCHEDULE_DEFAULT_COOLDOWN_S)
        fields.setdefault("budget", SCHEDULE_DEFAULT_MAX_RUNS_PER_DAY)
        now = _now()
        with self._lock, self._conn() as db:
            if self._rule_exists(db, "hooks", name):
                raise AutomationValidationError(
                    f"hook name '{name}' already exists")
            cur = db.execute(
                """INSERT INTO hooks
                       (name, enabled, "on", condition, source_allowlist,
                        action, action_payload, cooldown_s, budget,
                        created_by, created_at, updated_at)
                       VALUES (?,0,?,?,?,?,?,?,?,?,?,?)""",
                (name, fields["on"], json.dumps(fields["condition"]),
                 json.dumps(fields["source_allowlist"]), action,
                 fields["action_payload"], fields["cooldown_s"],
                 fields["budget"], actor[:120], now, now),
            )
            rule_id = int(cur.lastrowid)
            self._log(db, "rule.created", None, {
                "rule_id": rule_id, "rule_kind": "hook", "name": name,
                "actor": actor[:120]})
            row = db.execute("SELECT * FROM hooks WHERE id=?",
                             (rule_id,)).fetchone()
        return self._hook_public(row)

    def update_hook(self, rule_id: int, patch: dict[str, Any],
                    actor: str = "owner") -> tuple[dict[str, Any], dict[str, list[Any]]]:
        """PATCH a hook. Action-dependent default re-resolution: when
        ``action`` changes and the SAME patch does not carry an explicit
        ``source_allowlist``, the stored list resets to the new action's
        default — silently keeping a machine-origin list under
        create_assignment would be a security regression (А-1)."""
        allowed = {"name", "on", "condition", "source_allowlist", "action",
                   "action_payload", "cooldown_s", "budget", "enabled"}
        provided = {k: v for k, v in patch.items() if k in allowed}
        with self._lock, self._conn() as db:
            row = db.execute("SELECT * FROM hooks WHERE id=?",
                             (rule_id,)).fetchone()
            if row is None:
                raise RuleNotFoundError(f"hook {rule_id} not found")
            old = self._hook_public(row)
            # resolve the action context for source_allowlist validation
            eff_action = provided.get("action", old["action"])
            if "source_allowlist" in provided and "action" not in provided:
                provided_with_action = dict(provided)
                provided_with_action["action"] = eff_action
            else:
                provided_with_action = provided
            fields = self._validate_hook_fields(provided_with_action)
            if ("action" in fields and fields["action"] != old["action"]
                    and "source_allowlist" not in fields):
                fields["source_allowlist"] = validate_source_allowlist(
                    None, fields["action"])
            # compare against the RAW row (JSON columns are packed strings
            # there; old is the parsed public shape) — an idempotent PATCH
            # must not produce a spurious audit event
            updates: dict[str, Any] = {}
            for k, v in fields.items():
                if k in ("condition", "source_allowlist"):
                    continue
                if v != row[k]:
                    updates[k] = v
            if "condition" in fields and fields["condition"] != old["condition"]:
                updates["condition"] = json.dumps(fields["condition"])
            if ("source_allowlist" in fields
                    and fields["source_allowlist"] != old["source_allowlist"]):
                updates["source_allowlist"] = json.dumps(
                    fields["source_allowlist"])
            if not updates:
                return old, {}
            updates["updated_at"] = _now()
            sets = ", ".join(f"{k}=?" for k in updates)
            db.execute(
                f'UPDATE hooks SET {sets} WHERE id=?',  # noqa: S608 — keys from a fixed allow-list
                (*updates.values(), rule_id),
            )
            changes: dict[str, list[Any]] = {}
            for k, v in updates.items():
                if k in ("condition", "source_allowlist"):
                    old_v = old[k]
                    new_v = _loads(v)
                elif k == "enabled":
                    old_v, new_v = bool(old[k]), bool(v)
                elif k == "action_payload":
                    old_v, new_v = old[k], json.loads(v)
                else:
                    old_v, new_v = old.get(k), v
                if k != "updated_at":
                    changes[k] = [old_v, new_v]
            kind = ("rule.toggled" if set(patch) == {"enabled"}
                    else "rule.updated")
            self._log(db, kind, None, {
                "rule_id": rule_id, "rule_kind": "hook",
                "name": updates.get("name", old["name"]),
                "actor": actor[:120], "changes": changes})
            fresh = db.execute("SELECT * FROM hooks WHERE id=?",
                               (rule_id,)).fetchone()
        return self._hook_public(fresh), changes

    def delete_hook(self, rule_id: int, actor: str = "owner") -> dict[str, Any]:
        """DELETE = soft-disable retention (same semantics as schedules)."""
        with self._lock, self._conn() as db:
            row = db.execute("SELECT * FROM hooks WHERE id=?",
                             (rule_id,)).fetchone()
            if row is None:
                raise RuleNotFoundError(f"hook {rule_id} not found")
            old = self._hook_public(row)
            db.execute("UPDATE hooks SET enabled=0, updated_at=? WHERE id=?",
                       (_now(), rule_id))
            self._log(db, "rule.deleted", None, {
                "rule_id": rule_id, "rule_kind": "hook", "name": old["name"],
                "actor": actor[:120],
                "changes": {"enabled": [old["enabled"], False]}})
            fresh = db.execute("SELECT * FROM hooks WHERE id=?",
                               (rule_id,)).fetchone()
        return self._hook_public(fresh)

    def get_hook(self, rule_id: int) -> dict[str, Any] | None:
        with self._lock, self._conn() as db:
            row = db.execute("SELECT * FROM hooks WHERE id=?",
                             (rule_id,)).fetchone()
        return self._hook_public(row) if row else None

    def list_hooks(self) -> list[dict[str, Any]]:
        with self._lock, self._conn() as db:
            rows = db.execute("SELECT * FROM hooks ORDER BY name").fetchall()
        return [self._hook_public(r) for r in rows]

    # -------------------------------------------------- manual run-now (S1)
    def run_schedule_now(self, schedule_id: int) -> dict[str, Any]:
        """«Запустить сейчас» — the manual, NON-automated trigger (ADR 0013
        §2: not T2; the owner's hand, not the engine).

        Journal-first, ONE transaction (the S2 fire_schedule pattern,
        prefigured): insert the launches row (run_at = click time, bumped
        +1 s on a same-second UNIQUE collision — bounded walk), then create
        the assignment through the SAME private code path as
        create_assignment with created_by='owner' (a manual run is a
        ui-token action, NOT automation — ADR 0013 §2). On a create gate
        failure the row flips to skipped(reason) IN THE SAME TRANSACTION
        and the original error re-raises after commit (honest 404/422/409
        upstream). Budgets/kill-switch do NOT apply (manual); the
        schedule-clock columns (next_run_at/last_run_at) are deliberately
        untouched — they belong to the S2 tick family (§7).

        Returns {launch_id, run_at, rule_name, assignment}.
        """
        failed: AssignmentError | None = None
        result: dict[str, Any] = {}
        with self._lock, self._conn() as db:
            row = db.execute("SELECT * FROM schedules WHERE id=?",
                             (schedule_id,)).fetchone()
            if row is None:
                raise RuleNotFoundError(f"schedule {schedule_id} not found")
            now = _now()
            # run_at = click time; same-second clicks on the same rule walk
            # forward 1 s at a time (max 10) — sharing the S2 occurrence
            # key instead of a divergent manual key keeps ONE idempotency
            # family for schedules.
            run_at = now
            launch_id: int | None = None
            for _ in range(10):
                try:
                    cur = db.execute(
                        """INSERT INTO launches
                               (rule_id, rule_kind, rule_name, run_at, event_id,
                                "trigger", origin, decision, reason,
                                assignment_id, attempted_at)
                               VALUES (?, 'schedule', ?, ?, NULL, 'manual',
                                       'ui', 'launched', '', NULL, ?)""",
                        (schedule_id, row["name"], run_at, now),
                    )
                    launch_id = int(cur.lastrowid)
                    break
                except sqlite3.IntegrityError:
                    run_at = _bump_iso_second(run_at)
            if launch_id is None:  # pragma: no cover — 10 same-second clicks
                raise AutomationValidationError(
                    "manual run journal collision unresolvable "
                    "(10 clicks within one second on the same rule)")
            try:
                assignment = self._create_assignment(
                    db, row["task_id"], row["specialist"], row["harness"],
                    created_by="owner", executor_id=row["executor_id"])
            except AssignmentError as exc:
                db.execute(
                    "UPDATE launches SET decision='skipped', reason=? "
                    "WHERE id=?", (str(exc)[:200], launch_id))
                failed = exc
            else:
                db.execute("UPDATE launches SET assignment_id=? WHERE id=?",
                           (assignment["id"], launch_id))
                result = {"launch_id": launch_id, "run_at": run_at,
                          "rule_name": row["name"], "assignment": assignment}
        if failed is not None:
            raise failed
        return result

    # --------------------------------------------------- launches journal
    def automation_launches(self, rule_id: int | None = None,
                            kind: str | None = None,
                            decision: str | None = None,
                            limit: int = 50, offset: int = 0,
                            ) -> tuple[list[dict[str, Any]], int]:
        """Journal page: attempted_at DESC with the id tiebreak (uniform
        pagination canon, ADR 0011 §11). Returns (rows, total_matching)."""
        where: list[str] = []
        params: list[Any] = []
        if rule_id is not None:
            where.append("rule_id=?")
            params.append(rule_id)
        if kind is not None:
            where.append("rule_kind=?")
            params.append(kind)
        if decision is not None:
            where.append("decision=?")
            params.append(decision)
        cond = f" WHERE {' AND '.join(where)}" if where else ""
        with self._lock, self._conn() as db:
            total = db.execute(
                f"SELECT COUNT(*) AS n FROM launches{cond}",  # noqa: S608 — fragments from fixed filters
                params,
            ).fetchone()["n"]
            rows = db.execute(
                f"SELECT * FROM launches{cond} "  # noqa: S608 — fragments from fixed filters
                "ORDER BY attempted_at DESC, id DESC LIMIT ? OFFSET ?",
                (*params, limit, offset),
            ).fetchall()
        return [self._launch_public(r) for r in rows], int(total)

    def automation_daily_used(self) -> int:
        """Automation-origin launches today (UTC) — the global daily cap's
        used counter. Manual runs are excluded by construction (they are
        the owner's hand); in S1 this is provably 0 (no engine exists),
        computed honestly from the journal so S2 keeps the same reader."""
        day = datetime.now(timezone.utc).date().isoformat()
        with self._lock, self._conn() as db:
            n = db.execute(
                """SELECT COUNT(*) AS n FROM launches
                   WHERE "trigger"<>'manual' AND attempted_at >= ?""",
                (day,),
            ).fetchone()["n"]
        return int(n)

    # ------------------------------------------- settings + condition meta
    def automation_settings(self) -> dict[str, Any]:
        """Global kill-switch + daily cap (board_meta, ADR 0013 §6).
        Defaults: enabled=false (disable-by-default, C-1), cap=20/day."""
        raw_enabled = self.get_meta(AUTOMATION_ENABLED_META_KEY)
        raw_cap = self.get_meta(AUTOMATION_CAP_META_KEY)
        try:
            cap = int(raw_cap) if raw_cap is not None else AUTOMATION_DEFAULT_GLOBAL_CAP
        except (TypeError, ValueError):
            cap = AUTOMATION_DEFAULT_GLOBAL_CAP
        return {"enabled": raw_enabled == "1",
                "cap_global_per_day": max(1, min(cap, 1000))}

    def set_automation_settings(self, enabled: bool | None = None,
                                cap_global_per_day: int | None = None,
                                actor: str = "owner",
                                ) -> tuple[dict[str, Any], dict[str, list[Any]]]:
        """PUT /api/automation/settings. Audit automation.settings.changed
        old→new on any effective change (in-transaction). In S1 flipping
        the kill-switch is INERT data — no engine exists to kill; the flag
        is the persistent owner opt-in the S2 loop will read at boot."""
        if cap_global_per_day is not None and (not isinstance(cap_global_per_day, int) or isinstance(cap_global_per_day, bool) or not 1 <= cap_global_per_day <= 1000):
            raise AutomationValidationError(
                "cap_global_per_day must be an int in 1..1000")
        old = self.automation_settings()
        changes: dict[str, list[Any]] = {}
        with self._lock, self._conn() as db:
            if enabled is not None and bool(enabled) != old["enabled"]:
                changes["enabled"] = [old["enabled"], bool(enabled)]
                db.execute(
                    "INSERT OR REPLACE INTO board_meta (key, value) "
                    "VALUES (?, ?)",
                    (AUTOMATION_ENABLED_META_KEY,
                     "1" if enabled else "0"),
                )
            if (cap_global_per_day is not None
                    and cap_global_per_day != old["cap_global_per_day"]):
                changes["cap_global_per_day"] = [
                    old["cap_global_per_day"], cap_global_per_day]
                db.execute(
                    "INSERT OR REPLACE INTO board_meta (key, value) "
                    "VALUES (?, ?)",
                    (AUTOMATION_CAP_META_KEY, str(cap_global_per_day)),
                )
            if changes:
                self._log(db, "automation.settings.changed", None, {
                    "actor": actor[:120], "changes": changes})
        return self.automation_settings(), changes

    def automation_condition_meta(self) -> dict[str, Any]:
        """The condition META-DICTIONARY for the UI form (Frontend blocker,
        АРХКОМ-5): fields/ops/values enums over the closed allowlists — a
        free-text condition control never needs to exist. ``values_hint``
        maps field → enum list, or null where no closed set exists."""
        enums = _condition_field_enums(self.harness_names())
        return {
            "fields": sorted(enums),
            "ops": sorted(RULE_CONDITION_OPS),
            "values_hint": {f: (list(v) if v is not None else None)
                            for f, v in sorted(enums.items())},
            "events": sorted(HOOK_EVENT_WHITELIST),
            "actions": sorted(HOOK_ACTIONS),
            "source_origins": sorted(HOOK_SOURCE_ORIGINS),
        }

    # ------------------------------------------------- reports backfill
    BACKFILL_META_KEY = "reports_backfill"
    BACKFILL_AGENT = "history-backfill"

    def _backfill_body(self, task: dict[str, Any], evs: list[dict[str, Any]],
                       run_date: str) -> str:
        """Honest auto-summary of a closed task, built from its audit trail.

        Format: "Автоотчёт из истории событий (бэкфилл <date>): создана <ts>;
        перемещена open → in-progress → done (последняя <ts>);
        связанных памятей: N". Without any move events the second fragment
        reads "перемещений не зафиксировано"."""
        created_ev = next((e for e in evs if e["kind"] == "task.created"), None)
        created_ts = created_ev["ts"] if created_ev else task["created_at"]
        parts = [f"создана {created_ts}"]
        moves = [e for e in evs if e["kind"] == "task.moved"]
        if moves:
            chain = [str(moves[0]["payload"].get("from") or task["col"])]
            for m in moves:
                to = str(m["payload"].get("to") or "?")
                if to != chain[-1]:
                    chain.append(to)
            parts.append(
                f"перемещена {' → '.join(chain)} (последняя {moves[-1]['ts']})")
        else:
            parts.append("перемещений не зафиксировано")
        parts.append(f"связанных памятей: {len(task.get('memory_ids') or [])}")
        return f"Автоотчёт из истории событий (бэкфилл {run_date}): " + "; ".join(parts)

    def backfill_reports(self) -> int:
        """One-shot backfill of agent reports for closed tasks (BE-7 wave).

        For every done/resolved task — live or archived (matched via ``col``
        OR ``archived_from``) — that has NO reports yet, insert exactly one
        kind="final" report (agent="history-backfill") summarizing the task's
        audit events. ``created_at`` is the timestamp of the task's LAST
        event (never "now"), so the report is dated when the work ended.

        Idempotency, two layers:
        - the ``reports_backfill`` board_meta flag: set when a run completes;
          a flagged run is a no-op (repeat boots / script runs do nothing);
        - tasks that already carry ANY report are never touched, even when
          the flag was cleared by an operator.

        Returns the number of reports created. Everything happens in a
        single write transaction (flag + inserts), so concurrent invocations
        cannot double-create.
        """
        run_date = datetime.now(timezone.utc).date().isoformat()
        created = 0
        with self._lock, self._conn() as db:
            armed = db.execute(
                "SELECT value FROM board_meta WHERE key=? AND value='1'",
                (self.BACKFILL_META_KEY,),
            ).fetchone()
            if armed:
                return 0
            rows = db.execute(
                """SELECT id, col, memory_ids, created_at, updated_at FROM tasks
                   WHERE (col IN ('done','resolved')
                          OR archived_from IN ('done','resolved'))
                     AND id NOT IN (SELECT task_id FROM task_reports)
                   ORDER BY created_at, id"""
            ).fetchall()
            candidates = [r["id"] for r in rows]
            evs_by_task: dict[str, list[dict[str, Any]]] = {}
            if candidates:
                marks = ", ".join("?" for _ in candidates)
                for erow in db.execute(
                    "SELECT id, ts, kind, task_id, payload FROM events "
                    f"WHERE task_id IN ({marks}) ORDER BY id ASC",  # noqa: S608 — marks placeholder list
                    candidates,
                ):
                    e = dict(erow)
                    e["payload"] = _loads(e["payload"])
                    evs_by_task.setdefault(e["task_id"], []).append(e)
            for row in rows:
                task = dict(row)
                task["memory_ids"] = _loads(task["memory_ids"])
                evs = evs_by_task.get(task["id"], [])
                body = self._backfill_body(task, evs, run_date)
                # date the report with the task's last event; a task with no
                # audit trail falls back to its own updated_at
                last_ts = evs[-1]["ts"] if evs else task["updated_at"]
                db.execute(
                    "INSERT INTO task_reports "
                    "(task_id, kind, agent, body, superseded, created_at) "
                    "VALUES (?,?,?,?,0,?)",
                    (task["id"], "final", self.BACKFILL_AGENT, body, last_ts),
                )
                created += 1
            # (re)arm the one-shot marker only after a completed run
            db.execute(
                "INSERT OR REPLACE INTO board_meta (key, value) VALUES (?, '1')",
                (self.BACKFILL_META_KEY,),
            )
        return created

    # -------------------------------------------------------- profile cache
    def get_profile_cache(self, specialist: str) -> dict[str, Any] | None:
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT json, updated_at FROM profile_cache WHERE specialist=?",
                (specialist,),
            ).fetchone()
        if row is None:
            return None
        try:
            data = json.loads(row["json"])
        except (TypeError, ValueError):
            return None
        return {"updated_at": row["updated_at"], "profile": data}

    def put_profile_cache(self, specialist: str, profile: dict[str, Any]) -> None:
        with self._lock, self._conn() as db:
            db.execute(
                """INSERT INTO profile_cache (specialist, updated_at, json)
                       VALUES (?,?,?)
                   ON CONFLICT(specialist) DO UPDATE SET
                       updated_at=excluded.updated_at, json=excluded.json""",
                (specialist, _now(), json.dumps(profile, ensure_ascii=False)),
            )

    # ---------------------------------------------------------- task inbox
    # AGG-1: mirror of task:queue memories from every active memory server.
    # Rows are keyed by memory_id and upserted on every scan; last_seen is
    # refreshed ONLY for records their server actually returned, so a record
    # that vanished from mnemos simply ages out into "stale" instead of
    # being deleted — the mirror never destroys data. adopted_task_id is
    # write-once from the adopt flow and survives re-scans.
    INBOX_STALE_SECONDS = 30 * 60
    INBOX_REFRESHED_AT_KEY = "task_inbox_refreshed_at"

    def upsert_inbox_records(self, records: list[dict[str, Any]],
                             seen_at: str) -> tuple[int, int]:
        """Upsert one scan batch (single transaction). Returns (found, new)
        where ``found`` is the batch size and ``new`` counts first-time
        mirror rows. Content fields and last_seen are refreshed on every
        scan; adopted_task_id is never touched here."""
        if not records:
            return 0, 0
        with self._lock, self._conn() as db:
            new = 0
            for rec in records:
                exists = db.execute(
                    "SELECT 1 FROM task_inbox WHERE memory_id=?",
                    (rec["memory_id"],),
                ).fetchone()
                if exists is None:
                    new += 1
                db.execute(
                    """INSERT INTO task_inbox
                           (memory_id, server, project, title, excerpt, tags,
                            priority, specialist, source_created_at, last_seen)
                       VALUES (?,?,?,?,?,?,?,?,?,?)
                       ON CONFLICT(memory_id) DO UPDATE SET
                           server=excluded.server,
                           project=excluded.project,
                           title=excluded.title,
                           excerpt=excluded.excerpt,
                           tags=excluded.tags,
                           priority=excluded.priority,
                           specialist=excluded.specialist,
                           source_created_at=excluded.source_created_at,
                           last_seen=excluded.last_seen""",
                    (rec["memory_id"], rec["server"], rec.get("project", ""),
                     rec.get("title", ""), rec.get("excerpt", ""),
                     json.dumps(rec.get("tags", [])),
                     rec.get("priority", "normal"), rec.get("specialist", ""),
                     rec.get("source_created_at", ""), seen_at),
                )
        return len(records), new

    def get_inbox_item(self, memory_id: str) -> dict[str, Any] | None:
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT * FROM task_inbox WHERE memory_id=?", (memory_id,)
            ).fetchone()
        return dict(row) if row else None

    def mark_inbox_adopted(self, memory_id: str, task_id: str) -> bool:
        """Stamp the native task id onto the mirror row (adopt flow).
        False when the row is gone (concurrent registry surgery)."""
        with self._lock, self._conn() as db:
            cur = db.execute(
                "UPDATE task_inbox SET adopted_task_id=? WHERE memory_id=?",
                (task_id, memory_id),
            )
        return cur.rowcount > 0

    def inbox_refreshed_at(self) -> str:
        return self.get_meta(self.INBOX_REFRESHED_AT_KEY) or ""

    def list_inbox(self, scope: str = "all", project: str = "",
                   include_adopted: bool = False) -> list[dict[str, Any]]:
        """Inbox projection for the API.

        Filters: ``scope`` is 'all' or one source server name (mirror rows
        know their server); ``project`` is an exact match; rows already
        adopted into a native task are hidden unless include_adopted.
        Dedup (unconditional): rows whose memory_id appears in ANY native
        task's memory_ids — archived included, the bulk import included —
        never leak back into the inbox. ``stale`` = last_seen older than
        INBOX_STALE_SECONDS, i.e. the source memory stopped coming back.
        """
        q = "SELECT * FROM task_inbox"
        where: list[str] = []
        params: list[Any] = []
        if scope and scope != "all":
            where.append("server=?")
            params.append(scope)
        if project:
            where.append("project=?")
            params.append(project)
        if not include_adopted:
            where.append("adopted_task_id IS NULL")
        if where:
            q += " WHERE " + " AND ".join(where)
        q += " ORDER BY last_seen DESC"
        with self._lock, self._conn() as db:
            rows = [dict(r) for r in db.execute(q, params).fetchall()]
            linked: set[str] = set()
            for t in db.execute("SELECT memory_ids FROM tasks").fetchall():
                linked.update(str(m) for m in _loads(t["memory_ids"]))
        items: list[dict[str, Any]] = []
        for r in rows:
            if r["memory_id"] in linked:
                continue
            items.append({
                "memory_id": r["memory_id"],
                "server": r["server"],
                "project": r["project"],
                "title": r["title"],
                "excerpt": r["excerpt"],
                "tags": _loads(r["tags"]),
                "priority": r["priority"],
                "specialist": r["specialist"],
                "created_at": r["source_created_at"],
                "last_seen": r["last_seen"],
                "stale": _age_seconds(r["last_seen"]) > self.INBOX_STALE_SECONDS,
                "adopted": r["adopted_task_id"] is not None,
                "adopted_task_id": r["adopted_task_id"],
            })
        return items

    def log_group_action(self, group: str, action: str, detail: str = "") -> None:
        with self._lock, self._conn() as db:
            db.execute(
                "INSERT INTO group_log (ts, group_name, action, detail) VALUES (?,?,?,?)",
                (_now(), group, action, detail[:500]),
            )

    def group_history(self, group: str, limit: int = 30) -> list[dict[str, Any]]:
        with self._lock, self._conn() as db:
            rows = db.execute(
                "SELECT ts, action, detail FROM group_log WHERE group_name=? "
                "ORDER BY id DESC LIMIT ?",
                (group, limit),
            ).fetchall()
        return [dict(r) for r in rows]
