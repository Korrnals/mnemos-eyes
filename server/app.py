"""vesmaro-eyes — task board server (FastAPI).

Serves the vanilla-JS SPA from ``../web`` and a small JSON API over the
board store, plus a narrow authenticated proxy to **one or more live
mnemos engines** (multi-server, groups = "memory clusters"), with full
UI management: add/edit/enable/disable/pause/remove servers and groups.

Run:    uvicorn server.app:app --host 0.0.0.0 --port 8080
Volume: /data (board.db)
"""

from __future__ import annotations

import asyncio
import base64
import fnmatch
import hashlib
import hmac
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncIterator, Literal

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.routing import APIRoute
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    RedirectResponse,
    StreamingResponse,
)
from pydantic import BaseModel, ConfigDict, Field

from . import mnemos_client
from .memory_registry import ServerRegistry, resolve_token, write_config_template
from .profiles import build_profile
from .security import (
    RateLimiter,
    ValidationError,
    validate_memory_url,
    validate_token_ref,
)
from .store import (
    ASSIGNMENT_STATES,
    AssignmentConflictError,
    AssignmentError,
    AssignmentNotFoundError,
    AssignmentTokenError,
    REAP_QUEUED_AFTER_S,
    AutomationError,
    AutomationValidationError,
    DEVICE_GRANTS,
    DEVICE_TOKEN_PREFIX,
    DeviceQuotaError,
    ENROLLMENT_MAX_LIVE,
    ENROLLMENT_TOKEN_PREFIX,
    EnrollmentNotFoundError,
    EnrollmentQuotaError,
    EnrollmentStateError,
    EXECUTOR_TRANSPORTS,
    ExecutorConflictError,
    ExecutorError,
    ExecutorNotFoundError,
    ExecutorQuotaError,
    ExecutorStateError,
    HarnessError,
    HarnessInUseError,
    HarnessNotFoundError,
    HarnessQuotaError,
    InvalidTransitionError,
    PRESENCE_ONLINE_S,
    PRESENCE_STALE_S,
    PairingExpiredError,
    PairingNotFoundError,
    PairingStateError,
    REPORT_KINDS,
    RuleNotFoundError,
    Store,
    TASK_PRIORITIES,
    TASK_STATUSES,
    TaskLockedError,
    TaskNotAssignableError,
    UnknownHarnessError,
    VALID_STATUSES,
    presence_from_last_seen,
)
from . import provisioner as provisioning
from . import provisioner as provisioner_mod
from .task_inbox import _hits_of as _listing_hits_of
from .task_inbox import background_refresher as inbox_background_refresher
from .task_inbox import field_edits, parse_edits, refresh_inbox
from .task_inbox import revision_memory_body

DATA_DIR = Path(os.environ.get("VESMARO_DATA", "/data"))
DB_PATH = DATA_DIR / "board.db"
STATIC_DIR = Path(os.environ.get("VESMARO_WEB", Path(__file__).resolve().parents[1] / "web"))
# Phase 0a (ADR 0011): dist of the React viewer inside the image. An image
# built without the Node stage legitimately has no directory — the /app
# routes then answer 404 with an explanatory detail and the board at /
# keeps working.
APP_DIR = Path(os.environ.get("VESMARO_APP_DIR", "/app/app"))


# Phase 4 (ADR 0011) root-UI switch: which frontend owns "/".
#   board (default) — today's layout: / is the frozen board (VESMARO_WEB),
#                     /app is the React viewer (VESMARO_APP_DIR);
#   app             — flipped layout: / is the viewer (history fallback),
#                     /board keeps serving the frozen board, /app 302s to /.
# The flip is driven by the Helm chart (values key rootApp -> env
# VESMARO_ROOT_APP) and is a pure routing change — no data, no image
# rebuild. Unknown/empty values FAIL SAFE to "board": a typo must neither
# take the pod down nor silently flip the root UI.
def _normalize_root_app(raw: str | None) -> str:
    value = (raw or "").strip().lower()
    return value if value in ("board", "app") else "board"


ROOT_APP = _normalize_root_app(os.environ.get("VESMARO_ROOT_APP"))
_raw_root_app = (os.environ.get("VESMARO_ROOT_APP") or "").strip()
if _raw_root_app and _raw_root_app.lower() not in ("board", "app"):
    logging.getLogger("vesmaro.rootapp").warning(
        "VESMARO_ROOT_APP=%r is not 'board' or 'app' — failing safe to "
        "'board' (the frozen board stays at /)", _raw_root_app)

# Board read/write is open on the LAN by design (the cluster ingress is the
# boundary); mnemos credentials stay server-side. Since SEC-3 the write
# guard is FAIL-CLOSED: mutations require a bearer token, and when none of
# the requested classes is configured every mutation answers 503. The Helm
# chart generates the tokens; compose.yaml ships a dev default for local
# runs.
#
# Token classes (ADR 0009 amendment A1, phase 1 — token split):
#   ui      — VESMARO_UI_TOKEN: every board mutation driven from the owner
#             UI (tasks CRUD/move/archive, task-drafts, inbox refresh/adopt,
#             notifications/read, memory servers/groups CRUD, board-reflect,
#             specialists/refresh-all).
#   machine — VESMARO_BOARD_TOKEN: the poller/agents (task reports today;
#             future assignment claim/start/heartbeat/complete/fail routes
#             annotate classes=("machine",)). The legacy env name is kept
#             DELIBERATELY: scripts/assignment_poller.py and the deployed
#             chart already ship it; renaming would break both.
# Transitional v1 (documented migration order in the chart RUNBOOK.md):
# while VESMARO_UI_TOKEN is NOT set, VESMARO_BOARD_TOKEN is also accepted
# on ui-class mutations, so the single-token deployment of today keeps
# working across the upgrade that lands this code. Once VESMARO_UI_TOKEN
# is set, the machine token no longer passes ui-class guards. Fail-closed
# holds either way: with neither token configured every mutation is 503.
UI_WRITE_TOKEN = os.environ.get("VESMARO_UI_TOKEN", "")
BOARD_WRITE_TOKEN = os.environ.get("VESMARO_BOARD_TOKEN", "")

# A1 (ADR 0009): two token classes from day one. UI token — owner-UI
# assignment actions (create/cancel). Board (machine) token — the poller /
# agent loop (claim/start/heartbeat/complete/fail) plus the existing
# mutation surface (reports, moves, task CRUD). Legacy single-token mode:
# when VESMARO_UI_TOKEN is unset, VESMARO_BOARD_TOKEN serves BOTH classes
# and a warning is logged at startup; in split mode the board token is
# REFUSED on UI routes — a machine token must not mint assignments (closes
# the create-assignment injection vector). Env name is pinned by the Helm
# chart (parallel task ARCH-6) — do not rename.
UI_WRITE_TOKEN = os.environ.get("VESMARO_UI_TOKEN", "")
if not UI_WRITE_TOKEN:
    logging.getLogger("vesmaro.auth").warning(
        "VESMARO_UI_TOKEN is not set — single-token legacy mode: "
        "VESMARO_BOARD_TOKEN serves both UI and machine token classes")
    UI_WRITE_TOKEN = BOARD_WRITE_TOKEN

# ADR 0014 Ф1 (archcom open question #2): login security rests on the
# ui token's entropy — the verify limiter only slows a guesser down. One
# startup line when the configured secret is suspiciously short.
if UI_WRITE_TOKEN and len(UI_WRITE_TOKEN) < 20:
    logging.getLogger("vesmaro.auth").warning(
        "VESMARO_UI_TOKEN is shorter than 20 chars — owner-login strength "
        "rests on token entropy; consider a longer secret")

write_config_template(DATA_DIR / "memories.yaml")

store = Store(DB_PATH)
registry = ServerRegistry(store)

# SSE fan-out: subscribers get every board event as it is logged.
_subscribers: set[asyncio.Queue[dict[str, Any]]] = set()


def _broadcast(event: dict[str, Any]) -> None:
    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:  # pragma: no cover — queue is unbounded
            pass


def _notify_and_broadcast(category: str, title: str, message: str = "",
                          task_id: str | None = None, event: dict[str, Any] | None = None) -> None:
    """Persist a notification, then broadcast it together with the board event."""
    n = store.notify(category, title, message, task_id)
    if event:
        event["notification"] = n
    _broadcast(event or {"kind": "notification", "notification": n})


def get_scope_servers(scope: str, active_only: bool = False) -> tuple[str, list[dict[str, Any]]]:
    """Resolve scope: 'all' | group name | server name → server list."""
    servers = registry.active_servers() if active_only else registry.servers()
    matched = [s for s in servers if s["name"] == scope]
    if matched:
        return "server", matched
    grouped = [s for s in servers if s["group_name"] == scope]
    if grouped:
        return "group", grouped
    if scope == "all":
        return "all", [s for s in servers if s.get("enabled")]
    raise HTTPException(404, f"no memory server or group named '{scope}'")


async def _profile_cache_refresher() -> None:
    """Refresh specialist profile caches in the background (every 5 min).

    BE-9: the deterministic filesystem build runs first; the mnemos probe
    below only serves names the builder cannot resolve. This keeps the
    scoped (deduplicated) profiles from being clobbered by the flat
    mnemos index, which duplicates plugin files across specialists.
    """
    while True:
        await asyncio.sleep(300)
        try:
            for name in {t["specialists"][0] for t in store.board()["tasks"]
                          if t.get("specialists")}:
                built = await asyncio.to_thread(build_profile, name)
                if built is not None:
                    store.put_profile_cache(name, built)
                    continue
                tag = f"specialist:{name.lower().replace('@gcw: ', 'gcw-').replace(' ', '-')}"
                tag2 = tag  # same value
                servers = registry.active_servers()
                if not servers:
                    continue
                probe_queries = ("*", "specialist", "[instructions]", "[skills]", "[rules]", "[triggers]")
                results = await asyncio.gather(*(
                    mnemos_client.post_json_async(
                        s, "/search", {"query": q, "tags": [tag], "limit": 60},
                        timeout=15.0,
                    ) for s in servers for q in probe_queries
                ))
                server_names = [s["name"] for s in servers for _ in probe_queries]
                sections: dict[str, list[dict[str, Any]]] = {
                    "instructions": [], "skills": [], "rules": [], "triggers": [],
                }
                seen: set[str] = set()
                for s_name, (code, data) in zip(server_names, results):
                    if code != 200:
                        continue
                    for it in (data if isinstance(data, list) else []):
                        mid = it.get("id")
                        if mid and mid in seen:
                            continue
                        if mid:
                            seen.add(mid)
                        kind = _section_of(it.get("title", ""))
                        if kind == "meta":
                            continue
                        if kind in sections:
                            sections[kind].append({
                                "title": (it.get("title") or "")[:140],
                                "source_url": (it.get("source_url") or ""),
                                "excerpt": (it.get("content") or "")[:200000],
                                "id": it.get("id"),
                                "server": s_name,
                            })
                if any(sections.values()):
                    store.put_profile_cache(name, {
                        "specialist": name,
                        "slug": name.lower().replace("@gcw: ", "gcw-").replace(" ", "-"),
                        "meta": {"role": name},
                        "sections": sections, "errors": [],
                        "indexed": True,
                    })
        except Exception:  # noqa — background loop must never die
            pass


# ------------------------------------ assignment reaper (ARCH-7, phase 3)
# ADR 0009 §10: in-process wall-clock reaper for stuck assignments.
# claimed without a start > 10 min, or running without a heartbeat
# > 30 min → expired (task → blocked) + notification + SSE
# assignment.expired (ui-contract §11). The same tick notices stagnant
# queued assignments (> 30 min, notification only — cancelling stays the
# owner's call). Deadlines live in store.py (REAP_* constants).
_REAPER_INTERVAL_S = 60.0
_REAPER_START_STAGGER_S = 30.0   # never tick in lockstep with the loops above
_reaper_log = logging.getLogger("vesmaro.reaper")


def _assignment_reaper_tick() -> dict[str, int]:
    """One synchronous reaper pass — no sleeps, directly testable.

    Expiry reuses finish_assignment(outcome='expired'): terminal state +
    in-progress → blocked column mapping + audit event, identical to the
    API paths (the 409 a poller then gets on heartbeat is the kill
    signal). Races with a concurrent API transition (complete/fail/
    cancel/delete) surface as AssignmentError and skip the row; the next
    tick re-scans from stored state.
    """
    expired = stagnation_notified = 0
    for row in store.stale_assignments():
        try:
            a, task, moved_from, _moved_to = store.finish_assignment(
                row["id"], "expired", note=row["reap_reason"])
        except AssignmentError as exc:
            _reaper_log.info("reaper skipped assignment id=%s: %s",
                             row["id"], exc)
            continue
        if moved_from and task is not None:
            _broadcast({"kind": "task.moved", "task": task})
        _notify_and_broadcast(
            "work", f"{a['task_id']}: назначение истекло (reaper)",
            row["reap_reason"], a["task_id"],
            {"kind": "assignment.expired",
             "assignment": _assignment_public(a), "task_id": a["task_id"]})
        _reaper_log.info("reaper expired assignment id=%s task=%s reason=%s",
                         a["id"], a["task_id"], row["reap_reason"])
        expired += 1
    for row in store.stagnant_queued_assignments():
        message = (f"assignment #{row['id']} в queued дольше "
                   f"{int(REAP_QUEUED_AFTER_S // 60)} мин — poller не забирает")
        if store.notification_exists(row["task_id"], message):
            continue
        _notify_and_broadcast(
            "work", f"{row['task_id']}: назначение зависло в очереди",
            message, row["task_id"])
        _reaper_log.info("reaper stagnation notice assignment id=%s task=%s",
                         row["id"], row["task_id"])
        stagnation_notified += 1
    return {"expired": expired, "stagnation_notified": stagnation_notified}


async def _assignment_reaper() -> None:
    """Background loop (pattern: _profile_cache_refresher). A tick failure
    is logged with the traceback and never kills the loop (АРХКОМ-5: the
    except-pass anti-pattern stays out)."""
    await asyncio.sleep(_REAPER_START_STAGGER_S)
    while True:
        try:
            _assignment_reaper_tick()
        except Exception:
            _reaper_log.exception("assignment reaper tick failed")
        await asyncio.sleep(_REAPER_INTERVAL_S)
# ------------------------------------------- executors (ARCH-9, ADR 0009 Amd 2)
# Third entity registry: presence computed on read, transitions detected
# by a background sweeper that NEVER mutates executor rows (two-clock
# discipline — assignment clocks belong to the ARCH-7 reaper, presence
# clocks to this block; they never collapse).

_PRESENCE_SWEEP_INTERVAL_S = 60.0
# Last-EMITTED presence per executor id — the diff baseline for SSE
# transition events. Deliberately in-process memory, NOT board_meta or a
# table: the authoritative presence is always recomputed from last_seen,
# SSE has no persistence (at-most-once; clients re-fetch GET after any
# reconnect), and persisting a derived value would turn the sweeper into
# a DB writer — exactly what Amd 2 §3 forbids. Restart semantics: the
# first sweep after boot seeds the baseline silently (no offline storm);
# later transitions emit executor.online / executor.offline.
_presence_emitted: dict[str, str] = {}


def _executor_public(e: dict[str, Any]) -> dict[str, Any]:
    """Public executor shape: secret_hash NEVER leaves the store;
    presence is computed from the last_seen TTL (never stored)."""
    try:
        caps = json.loads(e.get("capabilities") or "[]")
    except (TypeError, ValueError):
        caps = []
    return {
        "id": e["id"],
        "name": e["name"],
        "harness": e["harness"],
        "host": e.get("host", ""),
        "transport": e.get("transport", "local-poll"),
        "capabilities": [c for c in caps if isinstance(c, str)],
        "version": e.get("version", ""),
        "enabled": bool(e.get("enabled")),
        "state": e.get("state", "pending"),
        "last_seen": e.get("last_seen", ""),
        "presence": presence_from_last_seen(e.get("last_seen", "")),
        "registered_via": e.get("registered_via", ""),
        "registered_at": e.get("registered_at", ""),
        "updated_at": e.get("updated_at", ""),
    }


def _presence_sweep_once() -> list[dict[str, Any]]:
    """One presence sweep: compute every executor's presence from last_seen
    and broadcast executor.online / executor.offline on TRANSITION only
    (stale is a silent hysteresis corridor — no event kind for it).
    Reads only; never mutates a row. Returns the emitted events (tests)."""
    emitted: list[dict[str, Any]] = []
    current: dict[str, str] = {}
    for e in store.list_executors():
        state = presence_from_last_seen(e["last_seen"])
        current[e["id"]] = state
        prev = _presence_emitted.get(e["id"])
        if prev is not None and prev != state and state in ("online", "offline"):
            event = {
                "kind": f"executor.{state}",
                "executor": _executor_public(e),
                "prev_state": prev,
                "state": state,
                "last_seen_at": e["last_seen"],
            }
            _broadcast(event)
            emitted.append(event)
    _presence_emitted.clear()
    _presence_emitted.update(current)
    return emitted


async def _presence_sweeper() -> None:
    """Background presence-transition detector (ARCH-9): every 60 s call
    _presence_sweep_once. Per-heartbeat events are forbidden (§11) —
    clients render ages from GET + a local 1 Hz ticker; SSE is only the
    change notification."""
    while True:
        await asyncio.sleep(_PRESENCE_SWEEP_INTERVAL_S)
        try:
            _presence_sweep_once()
        except Exception:  # noqa — background loop must never die
            pass


# ------------------------------------- WF-1 validation sweep (24 h timeout)
# Proposal §6 variant A: an in-process loop (pattern: the reaper above).
# Every 15 min it flags tasks sitting in `validating` longer than 24 h:
# ARCHCOM_REVIEW_TAG + work notification + SSE task.updated. The task is
# NEVER auto-moved — the confirm-or-return decision belongs to the owner /
# architectural committee (proposal §4.1 outcome B). Idempotency is the
# tag itself: store.mark_validation_timeout re-checks it inside the write
# transaction, so reruns and restarts never duplicate the flag.
_VALIDATION_SWEEP_INTERVAL_S = 900.0
_validation_sweep_log = logging.getLogger("vesmaro.validation-sweep")


def _validation_sweep_once() -> int:
    """One synchronous sweep pass — no sleeps, directly testable (the
    reaper-tick pattern). Returns the number of newly flagged tasks."""
    flagged = 0
    for row in store.stale_validating_tasks():
        task = store.mark_validation_timeout(row["id"])
        if task is None:
            # raced out of the lane (moved/archived) between scan and
            # write — nothing to flag; the next tick re-scans from state
            _validation_sweep_log.info(
                "validation sweep skipped task=%s: left the lane before "
                "the write", row["id"])
            continue
        flagged += 1
        _notify_and_broadcast(
            "work", f"{task['id']}: в валидации >24ч",
            "требуется решение: подтвердить или вернуть",
            task["id"], {"kind": "task.updated", "task": task})
        _validation_sweep_log.info(
            "validation timeout flagged task=%s since=%s",
            task["id"], task.get("validating_since", ""))
    if flagged:
        _validation_sweep_log.info(
            "validation sweep pass: flagged=%d", flagged)
    return flagged


async def _validation_sweeper() -> None:
    """Background loop (WF-1 §6): every 900 s call _validation_sweep_once.
    A tick failure is logged with the traceback and never kills the loop."""
    while True:
        await asyncio.sleep(_VALIDATION_SWEEP_INTERVAL_S)
        try:
            _validation_sweep_once()
        except Exception:  # noqa — background loop must never die
            _validation_sweep_log.exception("validation sweep tick failed")


# --------------------------------------- pairing TTL sweep (CV-7, ADR 0012 §6)
# One TTL for code/QR/verify (3 min). The sweep flips live pairings past
# expires_at to `expired` and emits SSE pairing.expired + notification;
# it also expires device sessions whose sliding (30 d, no activity) or
# hard (90 d) clock ran out (no SSE — the §11 dictionary has no device.*
# kinds; the device learns via 401 on its next request). Enrollment tokens
# (Amd 2 §4 supplement) ride the same cycle: created past the 15-min TTL
# → expired + SSE enrollment.expired (no notification — owner-initiated
# surface, the UI dialog carries its own countdown arc).
_PAIRING_SWEEP_INTERVAL_S = 60.0
_PAIRING_SWEEP_START_STAGGER_S = 45.0   # never tick in lockstep with the reaper
_pairing_sweep_log = logging.getLogger("vesmaro.pairing-sweep")


def _pairing_sweep_once() -> dict[str, int]:
    """One synchronous sweep pass — no sleeps, directly testable (the
    reaper-tick pattern). Notifications say the FACT only: no code, no
    verify digits, no tokens (payload audit, ADR §3.3)."""
    pairings = store.expire_stale_pairings()
    for row in pairings:
        _notify_and_broadcast(
            "system", "Пейринг истёк",
            f"пейринг {row['id']} истёк по TTL — начните заново", None,
            {"kind": "pairing.expired", "pairing_id": row["id"]})
        _pairing_sweep_log.info("pairing expired id=%s", row["id"])
    devices = store.expire_stale_devices()
    for row in devices:
        _pairing_sweep_log.info(
            "device session expired id=%s name=%s", row["id"], row["name"])
    enrollments = store.expire_stale_enrollments()
    for row in enrollments:
        _broadcast({"kind": "enrollment.expired",
                    "enrollment_id": row["enrollment_id"]})
        _pairing_sweep_log.info(
            "enrollment token expired id=%s", row["enrollment_id"])
    if pairings or devices or enrollments:
        _pairing_sweep_log.info(
            "pairing sweep pass: pairings_expired=%d devices_expired=%d "
            "enrollments_expired=%d",
            len(pairings), len(devices), len(enrollments))
    return {"pairings_expired": len(pairings),
            "devices_expired": len(devices),
            "enrollments_expired": len(enrollments)}


async def _pairing_sweeper() -> None:
    """Background loop (pattern: _assignment_reaper): every 60 s call
    _pairing_sweep_once. A tick failure is logged with the traceback and
    never kills the loop."""
    await asyncio.sleep(_PAIRING_SWEEP_START_STAGGER_S)
    while True:
        try:
            _pairing_sweep_once()
        except Exception:
            _pairing_sweep_log.exception("pairing sweep tick failed")
        await asyncio.sleep(_PAIRING_SWEEP_INTERVAL_S)


# Routing resolution chain (Amd 2 §5), computed per GET — stored nowhere
# (no staleness). Tiers: explicit pin → assignment.specialist capability
# match → task.specialists match → project default → global default →
# auto best-match → unmatched. Only the EXPLICIT pin is enforced at claim;
# everything else is a visibility/annotation filter — CAS stays the single
# arbiter. ``best'' = presence rank then id (deterministic, no preference
# theater). Nomination tiers (specialist / task-specialists) are
# presence-agnostic — a competent-but-offline executor is still the route
# (АРХКОМ-4: no silent substitution); the auto tier is the live-worker
# fallback (online + local-poll — remote executors are dispatch-ineligible
# until R4).
_PRESENCE_RANK = {"online": 0, "stale": 1, "offline": 2}


def _executor_capabilities(e: dict[str, Any]) -> set[str]:
    try:
        caps = json.loads(e.get("capabilities") or "[]")
    except (TypeError, ValueError):
        return set()
    return {c for c in caps if isinstance(c, str)}


def _routing_annotation(a: dict[str, Any], task: dict[str, Any] | None,
                        executors: list[dict[str, Any]],
                        project_default: str, global_default: str) -> dict[str, Any]:
    """{resolved, reason} for one assignment (GET /api/assignments items).
    ``resolved=None`` with reason 'unmatched' means visible-to-all."""
    pin = (a.get("executor_id") or "").strip()
    if pin:
        return {"resolved": pin, "reason": "explicit"}
    eligible = [e for e in executors
                if e.get("state") == "approved" and e.get("enabled")]

    def best(cands: list[dict[str, Any]]) -> dict[str, Any]:
        return min(cands, key=lambda e: (
            _PRESENCE_RANK[presence_from_last_seen(e["last_seen"])], e["id"]))

    specialist = (a.get("specialist") or "").strip()
    task_specialists = [s.strip() for s in ((task or {}).get("specialists") or [])
                        if isinstance(s, str) and s.strip()]
    if specialist:
        cands = [e for e in eligible if specialist in _executor_capabilities(e)]
        if cands:
            return {"resolved": best(cands)["id"], "reason": "specialist"}
    for s in task_specialists:
        cands = [e for e in eligible if s in _executor_capabilities(e)]
        if cands:
            return {"resolved": best(cands)["id"], "reason": "task-specialists"}
    # Defaults: resolved even when the target is offline (the owner chose
    # it; silently substituting another executor is forbidden). Ineligible
    # (revoked/disabled/gone) defaults fall through to the next tier.
    eligible_ids = {e["id"] for e in eligible}
    if project_default and project_default in eligible_ids:
        return {"resolved": project_default, "reason": "project-default"}
    if global_default and global_default in eligible_ids:
        return {"resolved": global_default, "reason": "global-default"}
    # Auto tier = live local worker, caps-free. Design note (AC6
    # resolution): gating auto on caps∩wanted would make the tier
    # structurally unreachable — any executor satisfying that predicate
    # would already have resolved the presence-agnostic nomination tiers
    # above, so the chain could never reach reason 'auto'. Capability
    # coverage therefore stays the nomination predicate; auto is the
    # generic live-worker fallback ("someone approved, enabled, online and
    # local can take it"). This also matches the L0 bootstrap: executor
    # #1 (laptop-poller) carries no owner-declared capabilities, and a
    # caps-gated auto could never point at it. Deterministic pick: lowest
    # id among the online local-poll candidates.
    auto = [e for e in eligible
            if e.get("transport") == "local-poll"
            and presence_from_last_seen(e["last_seen"]) == "online"]
    if auto:
        return {"resolved": best(auto)["id"], "reason": "auto"}
    return {"resolved": None, "reason": "unmatched"}


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # One-shot reports backfill (BE-7 wave) — strictly opt-in via env so a
    # plain boot never mutates data. Intended for the deploy window; the
    # same backfill is available as scripts/backfill_reports.py (pick one).
    # Idempotent inside the store: board_meta flag + tasks with existing
    # reports are never touched.
    if os.environ.get("VESMARO_BACKFILL_REPORTS", "") == "1":
        created = await asyncio.to_thread(store.backfill_reports)
        logging.getLogger("vesmaro.backfill").info(
            "reports backfill finished: created=%d", created)
    task = asyncio.create_task(_profile_cache_refresher())
    # AGG-1: inbox scan starts right after boot (non-blocking) and repeats
    # every 5 min inside the task; errors are absorbed in the loop.
    inbox_task = asyncio.create_task(inbox_background_refresher(registry, store))
    # ARCH-7 (ADR 0009 §10): assignment reaper — starts staggered (~30 s)
    # so it never ticks in lockstep with the two loops above.
    reaper_task = asyncio.create_task(_assignment_reaper())
    # ---- ARCH-9: presence sweeper (separate block, staggered from reaper).
    presence_task = asyncio.create_task(_presence_sweeper())
    # ---- WF-1: validation sweep (24h timeout → archcom branch).
    validation_task = asyncio.create_task(_validation_sweeper())
    # ---- CV-7 (ADR 0012 §6): pairing/device TTL sweep (staggered).
    pairing_sweep_task = asyncio.create_task(_pairing_sweeper())
    # ---- wave 4 provisioning: live jobs die with the old process (their
    # transit token context is gone) — honest failure at boot, then the
    # worker accepts new jobs (when provisioner.enabled).
    restarted = provisioning.fail_stale(store, _broadcast)
    if restarted:
        logging.getLogger("vesmaro.provisioner").info(
            "provision jobs failed on restart: %d", restarted)
    yield
    task.cancel()
    inbox_task.cancel()
    reaper_task.cancel()
    presence_task.cancel()
    validation_task.cancel()
    pairing_sweep_task.cancel()


COLUMN_RU = {
    "backlog": "бэклог", "validating": "на валидации",
    "open": "открыто", "in-progress": "в работе", "blocked": "блокировано",
    "resolved": "решено", "done": "готово",
}

# /docs belongs to the SPA documentation section when the viewer owns the
# root (rootApp=app): FastAPI's built-in swagger would shadow the client
# route on server-loaded /docs (F5/deep-link). Swagger stays reachable at
# /api/docs; board mode keeps the historical /docs.
_docs_url = "/api/docs" if ROOT_APP == "app" else "/docs"
app = FastAPI(title="vesmaro-eyes", version="1.34.0", lifespan=lifespan,
              docs_url=_docs_url)


class _UiCookieReissueRoute(APIRoute):
    """Route wrapper applying a PENDING ``vesmaro_ui`` reissue (ADR 0014 Ф2,
    the owner's sliding 6h idle TTL). The auth DECISION stays in the guards
    — ``_guard_write``/``_guard_ui_write`` mark ``request.state`` when a
    request passed on the cookie leg and the per-IP throttle allows a
    reissue; this wrapper only transfers the header onto the outgoing
    response. Deliberately NOT a middleware (ADR 0014: no auth middleware):
    the request path is untouched, and a request without the marker gets a
    byte-identical default handler."""

    def get_route_handler(self):
        original = super().get_route_handler()

        async def reissue_handler(request: Request) -> Response:
            response = await original(request)
            if getattr(request.state, "vesmaro_ui_reissue", False):
                request.state.vesmaro_ui_reissue = False
                _commit_ui_cookie_reissue(request)
                response.set_cookie(
                    _UI_COOKIE_NAME, _token_classes()["ui"],
                    max_age=_UI_COOKIE_MAX_AGE_S, httponly=True,
                    samesite="strict", path="/",
                    secure=request.url.scheme == "https",
                )
            return response

        return reissue_handler


app.router.route_class = _UiCookieReissueRoute

# ------------------------------------- device-token scope guard (ADR 0012 §5)
# The single scope middleware for PREFIX-CLASSIFIED tokens, standing
# BEFORE every handler-level guard (_guard_write / _guard_ui_write see
# only non-device bearers). Today exactly one prefix exists: mnd_ =
# device. mnu_/mnm_ join this same table when the ui/machine prefixes
# roll out. Non-prefixed bearers pass through UNTOUCHED — the deployed
# ui/machine tokens (including the owner's systemd poller riding
# VESMARO_BOARD_TOKEN) keep their existing validation legs byte-for-byte;
# prefix classification only ADDS the device class.
#
# Scope v1 (ADR 0012 Amendment, archcom 2026-09-23): the table became
# LOAD-BEARING per scope — (method, fnmatch-pattern) pairs. `read` is the
# v0 GET table plus the reads-добавка (board/tags/archive/notifications/
# assignments); `control` added board mutations. Owner override
# 2026-09-23 (§A.7, revocation-first): the load-bearing rights split is
# now the PER-DEVICE GRANTS set (store.device_sessions.grants), not the
# scope column — the tables below decompose the old control scope into
# granules (DEVICE_GRANTS in store.py). New pairings default to control
# + the full granule set (store layer); the data migrations backfilled
# active rows in place (Store._migrate_device_scope_v1 /
# Store._migrate_device_grants_v1).
#
# HARD-DENY (never in any scope/grant table — closed for devices ALWAYS;
# the allow-list below is exhaustive, so anything outside it is already
# 403 — this list documents the intent so nobody "fixes" the table later):
#   pairing*, devices*, auth*        — pairing/device/token management is
#                                      owner-only (a device must never be
#                                      able to pair, list or revoke peers,
#                                      or touch the ui-token legs)
#   assignments* mutations, executors*, harnesses* — the agent loop
#                                      (queue/claim/heartbeat/complete,
#                                      registry, enrollment): launch lever
#   automation* (incl. GET) + /run   — stolen phone ≠ persistent runner
#                                      (Security verdict over SE's)
#   memories servers*/groups*, mesh* — connection config and tokens
#                                      (GET /api/memories/servers is
#                                      deliberately OUT: it lists URLs and
#                                      token_refs — the v0 read-gap)
#   PUT /api/settings/execution      — launch-adjacent (Security)
#   DELETE /api/tasks/{id}           — irreversible: trusted side only
#   POST /api/board-reflect          — v1-not-needed (archcom Р5)
#   POST /api/specialists/refresh-all, GET /api/tags/{tag}/drill,
#   GET /api/agents/*, POST /api/task-drafts, GET /api/mnemos/search
#                                    — outside both scopes in v1
#
# Semantics (QA matrix v1 + §A.7):
#   - VALIDATE FIRST: an invalid/revoked/expired mnd_ token answers 401 on
#     ANY route — an unauthenticated request gets no scope verdict (v0
#     answered 403 for mutations; that ordering inverted the honest codes).
#   - GLOBAL READ always: a hit in _DEVICE_READ_ROUTES lets the request
#     through for EVERY valid device (the owner's «глобальные read
#     всегда») — grants gate MUTATIONS only.
#   - mutation route → its granule must be in the device's grants; not
#     there (or grants empty) → 403: the token authenticates fine, the
#     owner has not granted this component — 403, never 401.
#   - route allowed → the handler runs; _guard_write accepts the
#     middleware's verdict via request.state.device (the choke point —
#     no per-handler re-derivation).
# Comparison discipline: classification is prefix-only (no secret
# material); the digest compare inside the store is constant-time.
# Registered BEFORE add_security_headers so the header middleware stays
# outermost and every 401/403 answered here still carries CSP/nosniff.
_DEVICE_READ_ROUTES: tuple[tuple[str, str], ...] = (
    ("GET", "/api/tasks*"),      # board/task/history/reports/inbox reads
    ("GET", "/api/health"),
    ("GET", "/api/events"),      # SSE stream
    # memory READS only — the v0 blanket "/api/memories*" narrowed: the
    # servers*/groups* management shapes are hard-denied (see above).
    ("GET", "/api/memories"),
    ("GET", "/api/memories/pulse"),
    ("GET", "/api/memories/item/*"),
    # reads-добавка v1 (archcom 2026-09-23 — closing the read-gap)
    ("GET", "/api/board"),
    ("GET", "/api/tags"),
    ("GET", "/api/archive"),
    ("GET", "/api/notifications"),
    ("GET", "/api/assignments"),
)

# The old control scope, decomposed into per-device granules (§A.7). Each
# key MUST exist in store.DEVICE_GRANTS (pinned by tests); appending a new
# granule = add it there + add its rows here. fnmatch is whole-string, so
# the exact "POST /api/tasks" row does NOT swallow the inbox/reports
# sub-rows — every mutation belongs to EXACTLY one granule.
_DEVICE_GRANT_ROUTES: dict[str, tuple[tuple[str, str], ...]] = {
    # task mutations (board management proper; DELETE stays hard-denied)
    "tasks": (
        ("POST", "/api/tasks"),
        ("PATCH", "/api/tasks/*"),
        ("POST", "/api/tasks/*/move"),
        ("POST", "/api/tasks/*/archive"),
        ("POST", "/api/tasks/*/unarchive"),
    ),
    # reports — the device is the 4th leg of the composition
    "reports": (
        ("POST", "/api/tasks/*/reports"),
    ),
    # inbox pipeline (mirror queue refresh + adopt into the board)
    "inbox": (
        ("POST", "/api/tasks/inbox/refresh"),
        ("POST", "/api/tasks/inbox/*/adopt"),
    ),
    # notification state (mark-read)
    "notifications": (
        ("POST", "/api/notifications/read"),
    ),
}

# Legacy names kept for the 403 detail + the pairing scope record; NOT
# consulted by the guard anymore (grants are the single source of truth).
_DEVICE_SCOPE_ROUTES: dict[str, tuple[tuple[str, str], ...]] = {
    "read": _DEVICE_READ_ROUTES,
    "control": _DEVICE_READ_ROUTES + tuple(
        row for granule in DEVICE_GRANTS
        for row in _DEVICE_GRANT_ROUTES[granule]),
}


@app.middleware("http")
async def device_scope_guard(request: Request, call_next):
    """Classify bearers by token prefix (ADR 0012 §5 + Amendment §A.7).
    Everything not starting with ``Bearer mnd_`` rides the existing guards
    unchanged."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith(f"Bearer {DEVICE_TOKEN_PREFIX}"):
        return await call_next(request)
    # Order (QA matrix v1): validate → rights. An invalid token is 401 on
    # ANY route; only a VALID session earns a rights verdict.
    device = store.validate_device_token(
        auth[len("Bearer "):].strip(),
        ua=request.headers.get("User-Agent", ""),
        ip=request.client.host if request.client else "",
    )
    if device is None:
        return JSONResponse(
            status_code=401,
            content={"detail": "device token is invalid, expired or revoked"})
    path = request.url.path
    granted: frozenset[str] = frozenset(device.get("grants") or [])
    allowed = (
        any(request.method == method and fnmatch.fnmatch(path, pattern)
            for method, pattern in _DEVICE_READ_ROUTES)
        or any(
            request.method == method and fnmatch.fnmatch(path, pattern)
            for granule in granted
            for method, pattern in _DEVICE_GRANT_ROUTES.get(granule, ())))
    if not allowed:
        return JSONResponse(
            status_code=403,
            content={"detail": f"device grants {sorted(granted)} do not "
                               "cover this route (global reads are open "
                               "to every valid device; mutations need a "
                               "granule the owner granted; closed for "
                               "devices always: pairing/devices/auth "
                               "management, agent loop, automation, "
                               "memory-server config, task DELETE)"})
    # identity for downstream handlers/audit (task-history actor,
    # reports composition); nothing else reads it
    request.state.device = device
    return await call_next(request)


# --------------------------------------------------- security headers (Ф0a)
# АРХКОМ-3 decision 13 / security verdict §5.2: on EVERY response — CSP,
# nosniff, no-referrer (URLs carry record ids: no-referrer keeps them
# on-LAN). Plus Cache-Control: no-store on /api/* — the compensator for
# the "PWA without service worker" invariant (no client-side API cache).
# Header-only middleware: no body buffering, so SSE (/api/events) keeps
# streaming (its no-cache is deliberately superseded by no-store — an
# EventSource never caches either way).
_CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; "
        "base-uri 'self'; frame-ancestors 'none'; connect-src 'self'; "
        "img-src 'self' data:")


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["Content-Security-Policy"] = _CSP
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


# --------------------------------------------------------------------- models
class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    summary: str = ""
    spec: str = ""
    col: str = "open"
    # BE-10: optional explicit workflow status; defaults to the col map.
    status: str | None = None
    # BE-12: priority dictionary value; store validates and defaults to
    # 'normal' (garbage → ValueError → 422, same boundary as env/status).
    priority: str = "normal"
    env: str = "unknown"
    agents: list[str] = []
    specialists: list[str] = []
    project: str = ""
    memory_ids: list[str] = []
    mnemos_tags: list[str] = []


class TaskPatch(BaseModel):
    title: str | None = None
    summary: str | None = None
    spec: str | None = None
    # BE-10: full workflow dictionary (incl. `withdrawn`, which has no
    # board column); lives until the next column move — see store.move_task.
    status: str | None = None
    # BE-12: content edit of a task older than 24h (EDITABLE_FIELDS) is
    # rejected with 423 unless the request opts in here. Status changes are
    # workflow transitions and stay free at any age (UI-8 «Вернуть в работу»).
    force: bool = False
    priority: str | None = None
    env: str | None = None
    agents: list[str] | None = None
    specialists: list[str] | None = None
    project: str | None = None
    memory_ids: list[str] | None = None
    mnemos_tags: list[str] | None = None


def _validate_agents(agents: list[str]) -> None:
    """ADR 0005 (BE-5): ``agents`` are execution harnesses (zcode, hermes,
    ...); role-like slugs are specialists and belong in ``specialists``.
    Enforced identically on create AND patch, server-side, so every client
    inherits the rule. Raises HTTP 422."""
    bad = [a for a in agents if a.startswith("gcw-") or a.startswith("@")]
    if bad:
        raise HTTPException(
            422,
            f"agents must be harnesses (zcode, hermes, ...), not roles: {bad}; "
            "use specialists for @GCW roles",
        )


class MoveBody(BaseModel):
    col: str
    position: int | None = None


class ServerSpec(BaseModel):
    """Create/update a memory server connection. token: never returned."""
    name: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    url: str = Field(min_length=1)
    group_name: str = "default"
    description: str = ""
    token_ref: str = ""   # env:VAR | file:<path under a provisioned secrets dir>;
                          # plain: is rejected via the API (SEC-2)
    enabled: bool = True


class ServerAction(BaseModel):
    action: str  # enable | disable | pause | resume | reload | sync | test


class GroupSpec(BaseModel):
    name: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    title: str = ""
    description: str = ""


# OpenAPI response contract (arch-committee mandate #1). All models allow
# extra fields so serialization never drops keys the SPA reads; required
# fields are only those the store provably always returns.
class _ApiModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class TaskOut(_ApiModel):
    id: str
    col: str
    position: int
    title: str
    summary: str
    spec: str
    agents: list[str]
    specialists: list[str]
    env: str
    project: str
    memory_ids: list[str]
    mnemos_tags: list[str]
    created_at: str
    updated_at: str
    archived: int = 0
    status: str                     # BE-10: workflow dictionary value — store always returns it post-migration
    priority: str                   # BE-12: priority dictionary value — store always returns it post-migration
    archived_from: str = ""         # BE-11b: pre-archive column
    validating_since: str = ""      # WF-1: 24h clock start (ISO) while col=validating; '' off-lane


class BoardOut(_ApiModel):
    columns: list[str]
    tasks: list[TaskOut]
    counts: dict[str, int]


class OkOut(_ApiModel):
    ok: bool


class OkNoteOut(_ApiModel):
    ok: bool
    note: str = ""


class TaskMemoriesOut(_ApiModel):
    items: dict[str, Any]
    unresolved: list[dict[str, Any]]
    sources: dict[str, str]


class GroupOut(_ApiModel):
    name: str
    title: str = ""
    description: str = ""
    created_at: str = ""
    servers: list[str] = []


class MemoryServerOut(_ApiModel):
    """Public server shape (``_server_public``) — token values never present."""
    name: str
    url: str
    group_name: str
    description: str = ""
    enabled: bool = True
    state: str = "idle"
    token_ref: str = ""
    has_token: bool = False
    ok: bool | None = None
    latency_ms: float | None = None
    probe_status: int | None = None


class MemoryServersOut(_ApiModel):
    ok: bool
    servers: list[MemoryServerOut]
    groups: list[GroupOut]


class ServerActionOut(_ApiModel):
    ok: bool
    server: MemoryServerOut | None = None


# W5 (ROADMAP-v2 §5): mesh nodes as observable entities. A node row holds
# NO secret — healthz is unauthenticated by contract, so there is no
# token_ref to model (and nothing to redact). ``health`` is the live
# healthz snapshot (None when disabled / not probed yet).
class MeshNodeSpec(BaseModel):
    """Create/update a mesh-node observation entry."""
    name: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    base_url: str = Field(min_length=1)   # host:port of the node metrics/healthz addr
    description: str = ""
    enabled: bool = True


class MeshNodeHealthOut(_ApiModel):
    version: str = ""
    node_id: str = ""
    uptime_seconds: int | None = None
    core_connected: bool | None = None
    unix_socket_path: str = ""
    peers_total: int = 0
    peers_reachable: int = 0


class MeshNodeOut(_ApiModel):
    name: str
    base_url: str
    description: str = ""
    enabled: bool = True
    status: str = "unknown"     # ok | degraded | offline | disabled
    ok: bool | None = None
    error: str | None = None
    health: MeshNodeHealthOut | None = None
    probe_status: int | None = None


class MeshNodesOut(_ApiModel):
    ok: bool
    nodes: list[MeshNodeOut]


class GroupsOut(_ApiModel):
    ok: bool
    groups: list[GroupOut]


class GroupSaveOut(_ApiModel):
    ok: bool
    group: GroupOut


class GroupMemberBody(_ApiModel):
    server: str = Field(min_length=1)
    op: str = "add"  # add | remove


class GroupMemberOut(_ApiModel):
    ok: bool
    server: MemoryServerOut | None = None


class ReflectOut(_ApiModel):
    ok: bool
    memory_id: str | None = None
    server: str


class TaskDraftBody(BaseModel):
    """UI-6: raw owner thought from the "Новая задача" board form.
    ``project`` / ``tags`` are free-form strings — they are folded into the
    memory CONTENT as metadata, never into memory tags (poisoning
    invariant, ui-contract §12)."""
    text: str = Field(min_length=1, max_length=8000)
    project: str = Field(default="", max_length=120)
    tags: str = Field(default="", max_length=400)


class TaskDraftOut(_ApiModel):
    ok: bool
    memory_id: str | None = None
    server: str


# Task inbox mirror (AGG-1). ``created_at`` is the SOURCE memory's creation
# timestamp; ``stale`` means the record stopped coming back from its server
# (last_seen older than Store.INBOX_STALE_SECONDS); ``adopted`` means a
# native board task was created from it. ``edits`` (UI-25) is the owner's
# pre-adoption overlay (title/summary/priority/project; None = unedited) —
# the sibling ``title``/``project``/``priority``/``excerpt`` fields already
# carry the EFFECTIVE (overlay-applied) values.
class TaskInboxItem(_ApiModel):
    memory_id: str
    server: str
    project: str
    title: str
    excerpt: str
    tags: list[str]
    priority: str
    specialist: str
    created_at: str
    last_seen: str
    stale: bool
    adopted: bool
    adopted_task_id: str | None = None
    edits: dict[str, str] | None = None


class TaskInboxEditSpec(_ApiModel):
    """Owner corrections to a queue record BEFORE adoption (UI-25). Partial:
    omitted fields stay at their mirror/edited value. ``summary`` becomes
    the native task's summary on adopt (and the revision record's content);
    ``project``/``priority`` ride the task and the revision tags."""
    title: str | None = Field(default=None, min_length=1, max_length=200)
    summary: str | None = Field(default=None, max_length=4000)
    priority: str | None = None
    project: str | None = Field(default=None, max_length=80)


class TaskInboxOut(_ApiModel):
    items: list[TaskInboxItem]
    count: int
    refreshed_at: str


class TaskInboxRefreshOut(_ApiModel):
    scanned_servers: int
    found: int
    new: int
    errors: list[dict[str, Any]]


# Merged memory list + aggregated tags (Ф0b, ADR 0011 §6/§11 — the two
# additive endpoints the BoardAdapter needs). Cursor contract (uniform
# pagination canon): ``limit`` + opaque ``cursor`` → ``next_cursor``;
# sort ``created_at DESC`` with the unique tiebreak ``id``; ``truncated``
# is true only when results were silently capped with no continuation
# offered (here: the request ``limit`` exceeded the 200 page cap). The
# cursor is base64(JSON ``{"v":1,"offsets":{server:offset}}``) — opaque to
# the client, per-store offsets under the hood; it is only valid for the
# same query parameters (filters/scope) it was issued with.
class MemoryListItem(_ApiModel):
    id: str
    server: str
    title: str = ""
    tags: list[str] = []
    status: str | None = None
    project: str = ""
    created_at: str = ""
    updated_at: str = ""
    excerpt: str = ""


class MemoryListOut(_ApiModel):
    items: list[MemoryListItem]
    next_cursor: str | None = None
    truncated: bool = False
    errors: list[dict[str, Any]] = []


class TagCountOut(_ApiModel):
    name: str
    count: int


class TagListOut(_ApiModel):
    tags: list[TagCountOut]
    servers_scanned: int
    errors: list[dict[str, Any]] = []


class NotificationOut(_ApiModel):
    id: int
    category: str
    title: str
    message: str = ""
    task_id: str | None = None
    ts: str
    read: bool


class NotificationsOut(_ApiModel):
    ok: bool
    unread: int
    items: list[NotificationOut]


class NotificationReadBody(_ApiModel):
    id: int | None = None  # None marks ALL as read


class NotificationReadOut(_ApiModel):
    ok: bool
    unread: int


# Agent report contract (BE-11a). Body is capped at 16K server-side; kind is
# the two-value report dictionary. A second kind="final" supersedes previous
# live finals — history is kept, flagged with superseded=true.
class ReportCreate(BaseModel):
    body: str = Field(min_length=1, max_length=16384)
    kind: str = "intermediate"  # intermediate | final
    agent: str = Field(default="", max_length=120)


class ReportOut(_ApiModel):
    id: int
    task_id: str
    kind: str
    agent: str
    body: str
    superseded: bool
    created_at: str


class ReportCreatedOut(_ApiModel):
    ok: bool
    report: ReportOut
    superseded: list[int] = []  # ids of previous finals marked superseded


class ReportsOut(_ApiModel):
    ok: bool
    task_id: str
    count: int
    items: list[ReportOut]


# CV-6 (Agents §5): cross-task report feed — same row shape as ReportsOut
# minus the addressed task_id (the feed spans tasks; a per-item task_id
# rides inside every ReportOut row).
class ReportsFeedOut(_ApiModel):
    ok: bool
    count: int
    items: list[ReportOut]
    # uniform cursor canon (§11, as MemoryListOut/LaunchesOut): true when
    # the requested limit was silently capped at the page cap.
    truncated: bool = False


# Agent-bridge assignment contract (ADR 0009 phase 1). The public
# ``Assignment`` shape follows ui-contract §11: claim_token and
# spec_snapshot are NEVER part of the SSE/list payload — the token rides
# only in the claim response, the snapshot only in the claim response (the
# poller's immutable execution view, A2). spec_hash is public.
class AssignmentOut(_ApiModel):
    id: int
    task_id: str
    specialist: str = ""
    harness: str = "zcode"
    state: str
    created_by: str = "owner"
    claimed_by: str | None = None
    note: str = ""
    spec_hash: str = ""
    executor_id: str = ""              # ARCH-9 designation, stored verbatim
    claimed_by_executor: str = ""      # claim-time executor attribution
    created_at: str
    claimed_at: str | None = None
    started_at: str | None = None
    heartbeat_at: str | None = None
    finished_at: str | None = None
    # ARCH-9 (Amd 2 §9): denormalized project/domain tags (metadata tier —
    # what mesh subscription filters read without joining through mnemos).
    topics: list[str] = []
    # ARCH-9 (Amd 2 §5): GET-only routing annotation {resolved, reason};
    # absent from SSE payloads (computed per read, never stored).
    routing: dict[str, Any] | None = None
    # spec_snapshot is deliberately NOT a declared field: it must be absent
    # from every serialized assignment except the claim response, where it
    # rides as an extra key (extra="allow") for the machine consumer.


class AssignmentsOut(_ApiModel):
    ok: bool
    count: int
    items: list[AssignmentOut]


class AssignmentCreate(BaseModel):
    task_id: str = Field(min_length=1, max_length=100)
    specialist: str = Field(min_length=1, max_length=120)
    harness: str = "zcode"
    executor_id: str = Field(default="", max_length=120)


class AssignmentCreatedOut(_ApiModel):
    ok: bool
    assignment: AssignmentOut


class AssignmentClaimBody(BaseModel):
    claimed_by: str = Field(min_length=1, max_length=120)
    executor_id: str = Field(default="", max_length=120)


class AssignmentClaimedOut(_ApiModel):
    ok: bool
    assignment: AssignmentOut
    claim_token: str
    task: TaskOut | None = None


class AssignmentTokenBody(BaseModel):
    claim_token: str = Field(min_length=1, max_length=64)


class AssignmentHeartbeatBody(BaseModel):
    claim_token: str = Field(min_length=1, max_length=64)
    note: str = Field(default="", max_length=2000)


class AssignmentCompleteBody(BaseModel):
    claim_token: str = Field(min_length=1, max_length=64)
    final_report: str = Field(default="", max_length=16384)
    note: str = Field(default="", max_length=2000)


class AssignmentFailBody(BaseModel):
    reason: str = Field(default="", max_length=2000)
    claim_token: str = Field(default="", max_length=64)
    claimed_by: str = Field(default="", max_length=120)


class AssignmentCancelBody(BaseModel):
    reason: str = Field(default="", max_length=2000)


class AssignmentStateOut(_ApiModel):
    ok: bool
    assignment: AssignmentOut


class AssignmentFinishedOut(_ApiModel):
    ok: bool
    assignment: AssignmentOut
    task: TaskOut | None = None
    moved: list[str] = []              # [from, to] when the task column moved
    report: ReportOut | None = None    # final report written by complete


# Executor registry contract (ARCH-9, ADR 0009 Amendment 2). The public
# Executor shape never carries secret material — the plaintext
# executor_secret exists exactly once, in the register response.
class ExecutorOut(_ApiModel):
    id: str
    name: str
    harness: str
    host: str = ""
    transport: str = "local-poll"
    capabilities: list[str] = []
    version: str = ""
    enabled: bool = False
    state: str = "pending"             # pending | approved | revoked
    last_seen: str = ""
    presence: str = "offline"          # online | stale | offline (computed)
    registered_via: str = ""           # '' = machine bootstrap; 'enrollment:<id>'
    registered_at: str = ""
    updated_at: str = ""


class ExecutorListOut(_ApiModel):
    ok: bool
    count: int
    items: list[ExecutorOut]
    meta: dict[str, Any]               # presence thresholds — clients read, never hardcode


class ExecutorRegister(BaseModel):
    """L0 bootstrap registration (machine token). Capabilities are NOT
    accepted here — they are owner-declared via PATCH (Amd 2 §4)."""
    name: str = Field(min_length=1, max_length=120)
    harness: str = Field(min_length=1, max_length=60)
    host: str = Field(default="", max_length=200)
    transport: str = "local-poll"      # local-poll | mesh-r4
    version: str = Field(default="", max_length=60)


class ExecutorRegisteredOut(_ApiModel):
    ok: bool
    executor: ExecutorOut
    executor_secret: str               # shown EXACTLY once — never again


# Harness dictionary contracts (wave 3C, design 2026-09-22 §C): the
# owner-managed nomination registry. Reads are open (a dictionary, same
# boundary as GET /api/executors); writes are ui-token. ``seed_min_count``
# tells clients how many entries the boot seed guarantees minimum — the UI
# never hardcodes the set.
class HarnessCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    note: str = Field(default="", max_length=200)


class HarnessOut(_ApiModel):
    name: str
    added_at: str = ""
    added_via: str = "seed"            # seed | owner
    note: str = ""


class HarnessListOut(_ApiModel):
    ok: bool
    count: int
    items: list[HarnessOut]
    meta: dict[str, Any]               # seed_min_count — the guaranteed seed size


class HarnessStateOut(_ApiModel):
    ok: bool
    harness: HarnessOut


# Provisioner contracts (wave 4, blocks A/B/D variant α): the owner hands
# the board an install-time SSH job; the board runs the FROZEN bootstrap
# one-liner remotely and watches the enrollment. The enrollment token and
# the ssh secret NEVER appear in a response (transit-only invariant).
class ProvisionAuth(BaseModel):
    kind: str = Field(pattern="^(password|key|alias)$")
    secret: str = Field(default="", max_length=8192)
    passphrase: str = Field(default="", max_length=8192)


# Injection boundary (design §B, security P1-1): host/name ride into the
# SSH command line and into SSE/audit/step texts — strict charsets here,
# shlex.quote in the worker as the second layer. host is a lowercase
# FQDN/IP charset label sequence WITHOUT a trailing dot; name is the
# executor registry charset.
_PROVISION_HOST_RE = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$")
_PROVISION_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$")


class ProvisionBody(BaseModel):
    name: str = Field(default="", max_length=120,
                      pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$")
    host: str = Field(min_length=1, max_length=253,
                      pattern=r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
                              r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$")
    port: int = Field(default=22, ge=1, le=65535)
    auth: ProvisionAuth
    harness_hint: str = Field(default="zcode", max_length=60)
    board_url_for_host: str = Field(default="", max_length=200)
    expected_host_key_fingerprint: str = Field(default="", max_length=128)
    reuse_enrollment_id: str = Field(default="", max_length=64)


class ProvisionCreatedOut(_ApiModel):
    ok: bool
    job_id: str
    enrollment_id: str
    state: str = "queued"


class ProvisionJobOut(_ApiModel):
    ok: bool
    job: dict[str, Any]
    enrollment: dict[str, Any]


class HostRepinBody(BaseModel):
    fingerprint: str = Field(min_length=8, max_length=128)


# Enrollment contracts (ADR 0009 Amd 2 §4 supplement): one-time mne_ tokens
# the owner mints from the UI; the executor presents one on POST
# /api/executors. Hints are advisory UI material (bootstrap-command text),
# validated against the closed allowlist at creation, never contract fields.
class EnrollmentCreateBody(BaseModel):
    label: str = Field(default="", max_length=64)
    harness_hint: str = Field(default="", max_length=60)
    name_hint: str = Field(default="", max_length=120)


class EnrollmentOut(_ApiModel):
    enrollment_id: str
    label: str = ""
    harness_hint: str = ""
    name_hint: str = ""
    state: str = "created"             # created | used | expired | revoked
    created_at: str = ""
    expires_at: str = ""
    used_at: str = ""
    used_ip: str = ""
    executor_id: str = ""


class EnrollmentCreatedOut(_ApiModel):
    ok: bool
    enrollment: EnrollmentOut
    token: str                         # the ONLY place mne_… ever appears
    # AGW-9 (АРХКОМ-8 В1): the lab-CA fingerprint in the board canon
    # (SHA256:base64 over DER, provisioner parity). The UI embeds it into
    # the bootstrap command as --expect-fp. Advisory like the hints: ''
    # when the CA is not mounted (the front then omits the anchor flag).
    ca_fingerprint: str = ""


class EnrollmentListOut(_ApiModel):
    ok: bool
    count: int
    items: list[EnrollmentOut]


class EnrollmentRevokedOut(_ApiModel):
    ok: bool
    enrollment: EnrollmentOut


class ExecutorPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    state: str | None = None           # approved | revoked (pending is not patchable)
    capabilities: list[str] | None = None
    enabled: bool | None = None


class ExecutorStateChangeOut(_ApiModel):
    ok: bool
    executor: ExecutorOut


class ExecutionSettingsOut(_ApiModel):
    ok: bool
    default_executor: str = ""
    fallback_executor: str = ""
    scope: str = ""


class ExecutionSettingsBody(BaseModel):
    """Default/fallback executor settings (Amd 2 §5). ``scope`` reserves
    project-level defaults: '' (global, default) or 'project:<slug>'. The
    fallback is a global-scope UI-preview value (no silent substitution);
    it does not participate in the GET routing chain."""
    default_executor: str = Field(default="", max_length=120)
    fallback_executor: str = Field(default="", max_length=120)
    scope: str = Field(default="", max_length=120)


# Automation contracts (SCHED-1 S1, ADR 0013 §2) — freeze-frame portable
# shapes for codegen. next_run_at/last_run_at are SERVER-owned columns:
# they appear in *Out only; the create/patch bodies deliberately do not
# declare them (a client value is silently ignored, house allow-list
# pattern — same as ``col`` in TaskPatch).
class ConditionItem(BaseModel):
    """One hook condition clause. Strict: unknown keys are a 422 at the
    pydantic boundary; field/op/value dictionaries are re-validated in the
    store against the closed allowlists (defense in depth)."""
    model_config = ConfigDict(extra="forbid")
    field: str
    op: str                            # eq | ne | in
    value: Any                         # scalar, or list of scalars for 'in'


class ScheduleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    target_kind: str = "task"          # v1: 'task' only — 422 on anything else
    task_id: str = Field(min_length=1, max_length=100)
    specialist: str = Field(min_length=1, max_length=120)
    harness: str = "zcode"
    executor_id: str = Field(default="", max_length=120)
    trigger_kind: str                  # interval | time-of-day
    trigger_value: str = Field(min_length=1, max_length=32)
    window_from: str | None = None     # 'HH:MM' UTC; None = always (pair rule)
    window_to: str | None = None
    max_runs_per_day: int = Field(default=4, ge=1, le=1000)
    cooldown_s: int = Field(default=300, ge=0, le=86400)
    # NOTE: no ``enabled`` — creation is disabled by definition (ADR 0013
    # §2); enablement is a separate audited PATCH (rule.toggled).


class SchedulePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    target_kind: str | None = None
    task_id: str | None = Field(default=None, min_length=1, max_length=100)
    specialist: str | None = Field(default=None, min_length=1, max_length=120)
    harness: str | None = None
    executor_id: str | None = Field(default=None, max_length=120)
    trigger_kind: str | None = None
    trigger_value: str | None = Field(default=None, min_length=1, max_length=32)
    window_from: str | None = None     # '' clears the window (both ends)
    window_to: str | None = None
    max_runs_per_day: int | None = Field(default=None, ge=1, le=1000)
    cooldown_s: int | None = Field(default=None, ge=0, le=86400)
    enabled: bool | None = None


class ScheduleOut(_ApiModel):
    id: int
    name: str
    enabled: bool
    target_kind: str
    task_id: str
    specialist: str
    harness: str = "zcode"
    executor_id: str = ""
    trigger_kind: str
    trigger_value: str
    window_from: str | None = None
    window_to: str | None = None
    max_runs_per_day: int = 4
    cooldown_s: int = 300
    next_run_at: str | None = None     # server-computed only
    last_run_at: str | None = None     # S2 tick writes this (S1: stays NULL)
    created_by: str = "owner"
    created_at: str
    updated_at: str


class SchedulesOut(_ApiModel):
    ok: bool
    count: int
    items: list[ScheduleOut]


class HookCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    on: str                            # single kind from HOOK_EVENT_WHITELIST
    condition: list[ConditionItem] | None = None
    source_allowlist: list[str] | None = None   # None → action-dependent default
    action: str = "notify"             # notify | create_assignment
    action_payload: dict[str, Any] | None = None
    cooldown_s: int = Field(default=300, ge=0, le=86400)
    budget: int = Field(default=4, ge=1, le=1000)
    # no ``enabled`` — same creation-is-disabled rule as schedules


class HookPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    on: str | None = None
    condition: list[ConditionItem] | None = None
    source_allowlist: list[str] | None = None
    action: str | None = None
    action_payload: dict[str, Any] | None = None
    cooldown_s: int | None = Field(default=None, ge=0, le=86400)
    budget: int | None = Field(default=None, ge=1, le=1000)
    enabled: bool | None = None


class HookOut(_ApiModel):
    id: int
    name: str
    enabled: bool
    on: str
    condition: list[ConditionItem] = []
    source_allowlist: list[str] = []
    action: str
    action_payload: dict[str, Any] = {}
    cooldown_s: int = 300
    budget: int = 4
    created_by: str = "owner"
    created_at: str
    updated_at: str


class HooksOut(_ApiModel):
    ok: bool
    count: int
    items: list[HookOut]


class LaunchOut(_ApiModel):
    id: int
    rule_id: int
    rule_kind: str                     # schedule | hook
    rule_name: str                     # snapshot — survives rule surgery
    run_at: str
    event_id: int | None = None
    trigger: str                       # tick | manual | event
    origin: str = ""
    decision: str                      # launched | skipped | missed
    reason: str = ""
    assignment_id: int | None = None
    attempted_at: str


class LaunchesOut(_ApiModel):
    ok: bool
    count: int                         # page size
    total: int                         # full matching set
    items: list[LaunchOut]
    next_cursor: str | None = None
    truncated: bool = False


class ScheduleRunOut(_ApiModel):
    """Synchronous «Запустить сейчас» result. Gates of create_assignment
    are translated honestly as HTTP 404/422/409 (a journal skipped row is
    still written); the 200 arm is decision=launched. The skipped arm of
    ``decision`` is reserved for soft refusals the engine may add in S2."""
    ok: bool
    decision: str
    reason: str = ""
    assignment_id: int | None = None
    launch_id: int
    run_at: str


class AutomationStatusOut(_ApiModel):
    ok: bool
    engine: bool                       # S1: constant false — the S2 loop does not exist
    global_kill_switch: bool
    daily_cap: int
    daily_used: int
    condition_meta: dict[str, Any]     # fields/ops/values_hint (+ events/actions)
    rules: dict[str, dict[str, int]]   # per-kind {total, enabled} counts


class AutomationSettingsBody(BaseModel):
    enabled: bool | None = None
    cap_global_per_day: int | None = Field(default=None, ge=1, le=1000)


class AutomationSettingsOut(_ApiModel):
    ok: bool
    enabled: bool
    cap_global_per_day: int


class RuleDeletedOut(_ApiModel):
    ok: bool
    note: str = ""


# BE-7: task history timeline for the task modal — board audit events plus
# linked memory checkpoints. Optional context keys (detail/source/ts) are
# absent when empty (route sets response_model_exclude_none).
class EventItem(_ApiModel):
    ts: str
    title: str
    detail: str | None = None


class MemoryItem(_ApiModel):
    ts: str | None = None
    title: str
    source: str | None = None
    detail: str | None = None


class HistoryOut(_ApiModel):
    events: list[EventItem]
    memories: list[MemoryItem]


class UnarchiveOut(_ApiModel):
    ok: bool
    task: TaskOut | None = None


# Archive v2 (BE-11b): flat filtered page + per-project grouping over the
# FULL matching set (not the page), so the v1 teaser counts stay stable
# under pagination. ``count`` is the legacy total-matching key.
class ArchiveOut(_ApiModel):
    ok: bool
    count: int
    total: int
    limit: int
    offset: int
    items: list[TaskOut]
    projects: dict[str, list[dict[str, Any]]]


# Specialist profile contract (BE-9). ``sections`` carry ONLY what the
# agent's own .md owns or references; plugin-level material available to
# every agent of the plugin lives in ``shared`` (shared=true, scope=
# "plugin") so it is never repeated per card. Entry shape keeps the
# legacy keys (title/source_url/excerpt); id/server come from the legacy
# mnemos path, path/kind/scope/source from the filesystem builder.
class ProfileEntry(_ApiModel):
    title: str = ""
    source_url: str = ""
    excerpt: str = ""
    path: str = ""
    kind: str = ""
    shared: bool | None = None   # None = legacy mnemos entry (unknown)
    scope: str = ""
    source: str = ""
    also_in: list[str] = []      # other plugins shipping the same name


class SpecialistProfileOut(_ApiModel):
    ok: bool
    cached: bool = False
    specialist: str
    slug: str
    meta: dict[str, Any]
    sections: dict[str, list[ProfileEntry]]
    shared: dict[str, Any] = {}
    errors: list[Any] = []
    indexed: bool = False


class RefreshAllOut(_ApiModel):
    ok: bool
    refreshed: int  # built + legacy-fallback successes (legacy field)
    built: int = 0
    memory_fallback: int = 0
    failed: int = 0


# ------------------------------------------------------------------ board API
@app.get("/api/health")
async def health() -> dict[str, Any]:
    servers = registry.servers()
    probes = await asyncio.gather(*(mnemos_client.ping(s) for s in servers))
    stats = await asyncio.gather(*(mnemos_client.store_stats(s) for s in servers))
    per_server = []
    for s, p, st in zip(servers, probes, stats):
        per_server.append({
            "name": s["name"],
            "group_name": s["group_name"],
            "enabled": bool(s["enabled"]),
            "state": s["state"],
            "description": s["description"],
            "ok": p["ok"],
            "latency_ms": p["latency_ms"],
            "error": p.get("error"),
            "memories_total": (st or {}).get("memories_total"),
        })
    # W5: mesh nodes ride the same on-request health snapshot (short
    # healthz timeout, honest-offline) so the UI health loop and probes
    # share one aggregation point.
    mesh_rows = store.list_mesh_nodes()
    mesh_healths = await asyncio.gather(
        *(_mesh_node_health(r) for r in mesh_rows))
    mesh_nodes_health = [_mesh_node_public(r, h)
                         for r, h in zip(mesh_rows, mesh_healths)]
    return {
        "ok": True,
        "service": "vesmaro-eyes",
        # Single version source (archcom C5: FastAPI(version=...)) exposed
        # for the UI version label (owner feedback: «какая версия перед
        # глазами» — Sidebar footer). Additive field.
        "app_version": app.version,
        "board_tasks": sum(store.board()["counts"].values()),
        "servers": per_server,
        "groups": store.list_groups(),
        "mesh": {"nodes": mesh_nodes_health},
    }


@app.get("/api/board")
async def board(status: str = "") -> BoardOut:
    """Board projection; BE-10 optional ``?status=`` filter over the
    workflow dictionary (422 on unknown values). ``counts`` always describe
    the whole board, not the filtered view."""
    if status:
        if status not in TASK_STATUSES:
            raise HTTPException(422, f"invalid status: {status}")
        return store.board(status=status)
    return store.board()


@app.post("/api/tasks", status_code=201)
async def create_task(body: TaskCreate, request: Request) -> TaskOut:
    _guard_write(request, classes=("ui",))
    if body.col not in VALID_STATUSES:
        raise HTTPException(422, f"invalid col: {body.col}")
    _validate_agents(body.agents)  # ADR 0005: harnesses only
    # store raises ValueError on unknown env/col — surface as 422, not 500
    try:
        task = store.create_task(body.model_dump(),
                                 actor=_device_actor(request))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    _notify_and_broadcast("work", f"{task['id']}: новая задача", task["title"][:120], task["id"], {"kind": "task.created", "task": task})
    return task


@app.patch("/api/tasks/{task_id}")
async def patch_task(task_id: str, body: TaskPatch, request: Request) -> TaskOut:
    """Task PATCH (BE-12).

    - Content fields (EDITABLE_FIELDS: title, summary, spec, project, env,
      priority, agents, specialists, memory_ids, mnemos_tags) on a task
      older than 24h answer **423 Locked** unless ``force=true``; a forced
      edit is echoed back with ``forced: true`` and audited in the
      task.updated event (payload ``forced: true``).
    - ``status`` is NOT content: workflow transitions (e.g. UI-8 «Вернуть
      в работу») stay free at any task age — the 423 window never applies.
    - ``col`` is silently ignored by the store allow-list (columns move via
      POST /move) — long-standing v1 semantics, not an error.
    - ``force`` itself is a request mode, never a task column: it is popped
      here and never reaches the update payload.
    """
    _guard_write(request, classes=("ui",))
    if body.agents is not None:
        _validate_agents(body.agents)  # ADR 0005 (BE-5): same rule as create
    dump = body.model_dump(exclude_none=True)
    force = dump.pop("force", False)  # request mode — not part of the payload
    # store raises ValueError on unknown env/priority — surface as 422, not 500
    try:
        task = store.update_task(task_id, dump, force=force,
                                 actor=_device_actor(request))
    except TaskLockedError:
        raise HTTPException(
            423,
            "задача старше 24ч — редактирование заблокировано "
            "(force=true для принудительной правки)",
        ) from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if task is None:
        raise HTTPException(404, "task not found")
    if force:
        # extra="allow" keeps the flag in the serialized TaskOut
        task["forced"] = True
    _broadcast({"kind": "task.updated", "task": task})
    return task


@app.post("/api/tasks/{task_id}/move")
async def move_task(task_id: str, body: MoveBody, request: Request) -> TaskOut:
    _guard_write(request, classes=("ui",))
    try:
        task = store.move_task(task_id, body.col, body.position,
                               actor=_device_actor(request))
    except InvalidTransitionError as exc:
        # WF-1 v1 transition mirror: blocked → done/resolved is refused
        # with a hint (422, owner-facing message from the store).
        raise HTTPException(422, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if task is None:
        raise HTTPException(404, "task not found")
    _notify_and_broadcast("work", f"{task['id']}: статус → {COLUMN_RU.get(task['col'], task['col'])}", "", task["id"], {"kind": "task.moved", "task": task})
    return task


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str, request: Request) -> OkOut:
    _guard_write(request, classes=("ui",))
    if not store.delete_task(task_id):
        raise HTTPException(404, "task not found")
    _notify_and_broadcast("work", f"{task_id}: удалена", "", task_id, {"kind": "task.deleted", "task_id": task_id})
    return {"ok": True}


async def _resolve_task_memory_cards(
    task_id: str, scope: str = ""
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]:
    """Shared memory-link resolver (task drawer + BE-7 history timeline):
    resolve ``task.memory_ids`` across a server, a group, or all active
    servers. Returns ``(items, unresolved, sources)`` — ``items`` maps a
    memory id to its card, ``sources`` to the resolving server's name.
    404 when the task does not exist; empty structures without links."""
    task = store.task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    ids: list[str] = task.get("memory_ids") or []
    if not ids:
        return {}, [], {}

    if scope and scope != "all":
        _, servers = get_scope_servers(scope)
    else:
        servers = registry.active_servers()

    results = await asyncio.gather(
        *(mnemos_client.resolve_memories(s, ids) for s in servers)
    )
    items: dict[str, Any] = {}
    unresolved: list[dict[str, Any]] = []
    sources: dict[str, str] = {}
    for s, r in zip(servers, results):
        for mid, card in r["items"].items():
            if mid not in items:
                items[mid] = card
                sources[mid] = s["name"]
        for u in r["unresolved"]:
            if u["id"] not in items and all(u["id"] != x["id"] for x in unresolved):
                unresolved.append({"id": u["id"], "status": u["status"],
                                   "server": s["name"]})
    seen: set[str] = set()
    unresolved = [u for u in unresolved if not (u["id"] in seen or seen.add(u["id"]))]
    return items, unresolved, sources


@app.get("/api/tasks/{task_id}/memories")
async def task_memories(task_id: str, scope: str = "") -> TaskMemoriesOut:
    """Resolve task memory links against a server, a group, or all servers."""
    items, unresolved, sources = await _resolve_task_memory_cards(task_id, scope)
    return {"items": items, "unresolved": unresolved, "sources": sources}


def _event_detail(e: dict[str, Any]) -> str:
    """Human-readable context line for one board audit event (BE-7 history
    timeline). An empty return means "omit the detail row"."""
    p = e.get("payload") or {}
    kind = e["kind"]
    if kind == "task.moved":
        return f"{p.get('from', '?')} → {p.get('to', '?')}"
    if kind == "task.updated":
        # updated_at is bookkeeping the store stamps on every write — not a
        # semantic field, so it never appears in the human digest
        fields = ", ".join(f for f in p.get("fields", []) if f != "updated_at")
        return f"поля: {fields}" if fields else ""
    if kind == "task.created":
        return f"колонка {p.get('col', '?')}"
    if kind == "task.archived":
        return f"из колонки {p.get('from', '?')}"
    if kind == "task.unarchived":
        return f"в колонку {p.get('to', '?')}"
    if kind == "task.report":
        return f"{p.get('kind', 'отчёт')}, агент: {p.get('agent') or '—'}"
    if kind == "task.deleted":
        return ""
    if kind == "assignment.created":
        return (f"назначение #{p.get('assignment_id')} — "
                f"{p.get('harness')}/{p.get('specialist')}")
    if kind == "assignment.claimed":
        return f"№{p.get('assignment_id')}: забрал {p.get('claimed_by') or '—'}"
    if kind == "assignment.started":
        return f"№{p.get('assignment_id')}: запуск"
    if kind == "assignment.done":
        return f"№{p.get('assignment_id')}: выполнено"
    if kind in ("assignment.failed", "assignment.cancelled",
                "assignment.expired"):
        ru = {"assignment.failed": "провалено",
              "assignment.cancelled": "отменено",
              "assignment.expired": "истекло"}
        return f"№{p.get('assignment_id')}: {ru[kind]}"
    text = str(p)[:200]
    return "" if text == "{}" else text


@app.get("/api/tasks/{task_id}/history", response_model_exclude_none=True)
async def task_history(task_id: str) -> HistoryOut:
    """BE-7: merged timeline for the task modal — the task's board audit
    events (title = event kind, detail = human-readable payload digest) plus
    its linked memory checkpoints (source = resolving server, detail =
    excerpt capped at 200 chars). The SPA merges and sorts both lists by
    ``ts`` desc; the server pre-sorts defensively."""
    task = store.task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")

    events: list[dict[str, Any]] = []
    for e in store.task_events(task_id):
        item: dict[str, Any] = {"ts": e["ts"], "title": e["kind"]}
        detail = _event_detail(e)
        if detail:
            item["detail"] = detail
        events.append(item)
    events.sort(key=lambda i: i["ts"], reverse=True)

    cards, _unresolved, sources = await _resolve_task_memory_cards(task_id)
    memories: list[dict[str, Any]] = []
    for mid, card in cards.items():
        m: dict[str, Any] = {
            "ts": card.get("created_at") or None,
            "title": card.get("title") or mid,
            "source": sources.get(mid) or None,
        }
        excerpt = (card.get("excerpt") or "")[:200]
        if excerpt:
            m["detail"] = excerpt
        memories.append(m)
    memories.sort(key=lambda i: i.get("ts") or "", reverse=True)
    return {"events": events, "memories": memories}


# ------------------------------------------------------- memory servers CRUD
def _server_public(s: dict[str, Any]) -> dict[str, Any]:
    """Public shape — token values are NEVER included; legacy ``plain:``
    refs are masked (SEC-2) while ``has_token`` still reports that a
    secret is provisioned for this server."""
    ref = s.get("token_ref", "") or ""
    return {
        "name": s["name"],
        "url": s["url"],
        "group_name": s["group_name"],
        "description": s["description"],
        "enabled": bool(s["enabled"]),
        "state": s["state"],
        "token_ref": "plain:<redacted>" if ref.startswith("plain:") else ref,
        "has_token": bool(resolve_token(ref)),
    }


@app.get("/api/memories/servers")
async def memory_servers() -> MemoryServersOut:
    rows = registry.servers()
    probes = await asyncio.gather(*(mnemos_client.ping(s) for s in rows))
    by_name = {p["server"]: p for p in probes}
    return {
        "ok": True,
        "servers": [
            {**_server_public(s),
             "ok": by_name.get(s["name"], {}).get("ok", False),
             "latency_ms": by_name.get(s["name"], {}).get("latency_ms")}
            for s in rows
        ],
        "groups": registry.groups(),
    }


async def _validate_server_spec(body: ServerSpec) -> tuple[str, str]:
    """SEC-1 boundary: validate url (scheme + host egress policy) and
    token_ref (no plain:, file: only under provisioned dirs) BEFORE any
    network activity or persistence. Raises 422 on violation."""
    try:
        # getaddrinfo inside validate_memory_url is a blocking syscall;
        # keep the event loop free while DNS resolves (or times out)
        url = await asyncio.to_thread(validate_memory_url, body.url)
        token_ref = validate_token_ref(body.token_ref)
    except ValidationError as exc:
        raise HTTPException(422, str(exc)) from exc
    return url, token_ref


@app.post("/api/memories/servers", status_code=201)
async def add_memory_server(body: ServerSpec, request: Request) -> MemoryServerOut:
    _guard_write(request, classes=("ui",))
    url, token_ref = await _validate_server_spec(body)
    existing = store.get_server(body.name)
    if existing is None:
        # verify reachability before first save (honest, non-blocking).
        # SEC-1: the probe for a NEW host carries NO Authorization header —
        # an attacker-chosen URL must never receive the memory token.
        probe_spec = {"name": body.name, "url": url, "token": ""}
        code, _ = await mnemos_client.post_json_async(probe_spec, "/search",
                                                      {"query": "ping", "limit": 1}, timeout=6.0)
        row = registry.add_or_update({
            "name": body.name, "url": url, "group_name": body.group_name,
            "description": body.description, "token_ref": token_ref,
        })
        store.log_server_action(body.name, "added", f"probe http {code}")
        if code == 503:
            row = registry.set_state(body.name, "error") or row
        _broadcast({"kind": "server.changed"})
        return {**_server_public(row), "probe_status": code}
    raise HTTPException(409, f"server '{body.name}' already exists")


@app.patch("/api/memories/servers/{name}")
async def edit_memory_server(name: str, body: ServerSpec, request: Request) -> MemoryServerOut:
    _guard_write(request, classes=("ui",))
    url, token_ref = await _validate_server_spec(body)
    if store.get_server(name) is None:
        raise HTTPException(404, f"server '{name}' not found")
    row = registry.add_or_update({
        "name": name, "url": url, "group_name": body.group_name,
        "description": body.description, "token_ref": token_ref,
    })
    _broadcast({"kind": "server.changed", "server": name})
    return _server_public(row)


@app.post("/api/memories/servers/{name}/action")
async def memory_server_action(name: str, body: ServerAction, request: Request) -> ServerActionOut:
    _guard_write(request, classes=("ui",))
    row = store.get_server(name)
    if row is None:
        raise HTTPException(404, f"server '{name}' not found")
    act = body.action
    if act == "enable":
        out = registry.set_enabled(name, True)
    elif act == "disable":
        out = registry.set_enabled(name, False)
    elif act == "pause":
        out = registry.set_state(name, "paused")
    elif act == "resume":
        out = registry.set_state(name, "idle")
    elif act == "reload":
        # re-read connection data and probe
        s = next(x for x in registry.servers() if x["name"] == name)
        code, _ = await mnemos_client.post_json_async(s, "/search", {"query": "ping", "limit": 1}, timeout=6.0)
        out = registry.set_state(name, "idle" if code != 503 else "error")
        store.log_server_action(name, "reloaded", f"probe http {code}")
        _broadcast({"kind": "server.changed", "server": name})
        return {"ok": True, "server": _server_public(out) if out else None, "probe_status": code}
    elif act == "sync":
        # mark syncing, probe, then settle back to idle (a real store-level
        # sync lands with mnemos-mesh; for now it validates connectivity)
        registry.set_state(name, "syncing")
        s = next(x for x in registry.servers() if x["name"] == name)
        code, _ = await mnemos_client.post_json_async(s, "/search", {"query": "sync-check", "limit": 1}, timeout=8.0)
        st = await mnemos_client.store_stats(s)
        out = registry.set_state(name, "idle" if code == 200 else "error")
        store.log_server_action(name, "synced", f"probe http {code}, memories={(st or {}).get('memories_total')}")
        _broadcast({"kind": "server.changed", "server": name})
        return {"ok": code == 200, "server": _server_public(out) if out else None,
                "probe_status": code, "stats": st}
    elif act == "test":
        s = next(x for x in registry.servers() if x["name"] == name)
        p = await mnemos_client.health(s)
        return {"ok": p["ok"], "probe": p}
    else:
        raise HTTPException(422, f"unknown action: {act}")
    store.log_server_action(name, act)
    _notify_and_broadcast("system", f"хранилище {name}: {act}", "", None, {"kind": "server.changed", "server": name})
    return {"ok": True, "server": _server_public(out) if out else None}


@app.delete("/api/memories/servers/{name}")
async def delete_memory_server(name: str, request: Request) -> OkNoteOut:
    """Remove from the board registry. The memory store itself is untouched."""
    _guard_write(request, classes=("ui",))
    if not registry.delete(name):
        raise HTTPException(404, f"server '{name}' not found")
    _broadcast({"kind": "server.changed", "server": name})
    return {"ok": True, "note": "removed from board; the store itself is untouched"}


@app.get("/api/memories/servers/{name}/history")
async def memory_server_history(name: str) -> dict[str, Any]:
    return {"ok": True, "server": name, "history": store.server_history(name)}


@app.get("/api/memories/groups")
async def memory_groups() -> GroupsOut:
    return {"ok": True, "groups": registry.groups()}


@app.post("/api/memories/groups")
async def save_memory_group(body: GroupSpec, request: Request) -> GroupSaveOut:
    _guard_write(request, classes=("ui",))
    g = registry.save_group(body.name, body.title, body.description)
    _broadcast({"kind": "server.changed", "server": f"group:{body.name}"})
    return {"ok": True, "group": g}


@app.delete("/api/memories/groups/{name}")
async def delete_memory_group(name: str, request: Request) -> OkNoteOut:
    _guard_write(request, classes=("ui",))
    if name == "default":
        raise HTTPException(422, "cannot delete the default group")
    if not registry.delete_group(name):
        raise HTTPException(404, f"group '{name}' not found")
    _broadcast({"kind": "server.changed", "server": f"group:{name}"})
    return {"ok": True, "note": "servers moved to group 'default'"}


# -------------------------------------------------- mesh nodes (W5 board)
# ROADMAP-v2 §5: mesh nodes appear on the board alongside memory servers,
# honest-offline principle identical to stores. Health is PROBED, never
# persisted: every read of the list (or /api/health) re-fetches healthz
# with a short timeout. No token exists for a node — nothing to store,
# nothing to leak.
def _parse_healthz(body: Any) -> dict[str, Any]:
    """Distill the mesh healthz contract into the board's health block:
    version / node_id / uptime / unix-socket core state / peer counts.
    Unknown or malformed fields degrade to honest defaults, never raise."""
    if not isinstance(body, dict):
        return {}
    peers = body.get("peers")
    peer_list = peers if isinstance(peers, list) else []
    sock = body.get("unix_socket")
    sock = sock if isinstance(sock, dict) else {}
    uptime = body.get("uptime_seconds")
    return {
        "version": str(body.get("version") or ""),
        "node_id": str(body.get("node_id") or ""),
        "uptime_seconds": uptime if isinstance(uptime, int) else None,
        "core_connected": sock.get("core_connected")
        if isinstance(sock.get("core_connected"), bool) else None,
        "unix_socket_path": str(sock.get("path") or ""),
        "peers_total": len(peer_list),
        "peers_reachable": sum(1 for p in peer_list
                               if isinstance(p, dict) and p.get("reachable") is True),
    }


def _health_from_probe(code: int, body: Any) -> dict[str, Any]:
    """Health dict from one healthz probe result — 200 + a dict carrying
    status ok/degraded is healthy; EVERYTHING else (non-200, non-JSON,
    unknown status) is honestly offline with the reason."""
    if code == 200 and isinstance(body, dict) and body.get("status") in ("ok", "degraded"):
        return {"status": body["status"], "ok": True, "error": None,
                "health": _parse_healthz(body)}
    detail = body.get("detail") if isinstance(body, dict) else str(body)
    return {"status": "offline", "ok": False,
            "error": f"http {code}: {detail}" if detail else f"http {code}",
            "health": None}


async def _mesh_node_health(row: dict[str, Any]) -> dict[str, Any]:
    """Live healthz snapshot for one node row (disabled rows are not
    probed — the metrics address may legitimately be firewalled off)."""
    if not row.get("enabled"):
        return {"status": "disabled", "ok": None, "error": None, "health": None}
    code, body = await mnemos_client.mesh_node_healthz(
        {"name": row["name"], "base_url": row["base_url"]})
    return _health_from_probe(code, body)


def _mesh_node_public(row: dict[str, Any],
                      health: dict[str, Any] | None = None) -> dict[str, Any]:
    """Public node shape — there is no secret material anywhere in the
    row; ``health`` (when given) is the live probe snapshot."""
    out = {
        "name": row["name"],
        "base_url": row["base_url"],
        "description": row.get("description", ""),
        "enabled": bool(row.get("enabled")),
    }
    if health is None:
        out["status"], out["ok"], out["error"] = "unknown", None, None
        out["health"] = None
    else:
        out.update(health)
    return out


async def _validate_mesh_node_url(raw_url: str) -> str:
    """SEC-1 boundary for node base_url — same egress policy as memory
    servers (VESMARO_ALLOWED_MEMORY_HOSTS allowlist, SSRF-safe parse)
    BEFORE any network activity or persistence. Raises 422 on violation."""
    try:
        return await asyncio.to_thread(validate_memory_url, raw_url)
    except ValidationError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/mesh/nodes")
async def mesh_nodes() -> MeshNodesOut:
    rows = store.list_mesh_nodes()
    healths = await asyncio.gather(*(_mesh_node_health(r) for r in rows))
    return {"ok": True,
            "nodes": [_mesh_node_public(r, h) for r, h in zip(rows, healths)]}


@app.post("/api/mesh/nodes", status_code=201)
async def add_mesh_node(body: MeshNodeSpec, request: Request) -> MeshNodeOut:
    _guard_write(request, classes=("ui",))
    base_url = await _validate_mesh_node_url(body.base_url)
    if store.get_mesh_node(body.name) is not None:
        raise HTTPException(409, f"mesh node '{body.name}' already exists")
    # reachability probe before first save, honest and non-blocking.
    # healthz is unauthenticated BY CONTRACT: the probe never carries a
    # token (nothing to exfiltrate — same SEC-1 posture as store probes).
    code, hz = await mnemos_client.mesh_node_healthz(
        {"name": body.name, "base_url": base_url})
    row = store.upsert_mesh_node({
        "name": body.name, "base_url": base_url,
        "description": body.description, "enabled": body.enabled,
    })
    if not body.enabled:
        # disabled from birth: probe still validated the address (the
        # honest probe_status rides along) but the health block keeps the
        # disabled shape — the list endpoint never probes disabled rows.
        health: dict[str, Any] = {"status": "disabled", "ok": None,
                                  "error": None, "health": None}
    else:
        health = _health_from_probe(code, hz)
    _broadcast({"kind": "mesh.node.changed", "node": body.name})
    return {**_mesh_node_public(row, health), "probe_status": code}


@app.patch("/api/mesh/nodes/{name}")
async def edit_mesh_node(name: str, body: MeshNodeSpec,
                         request: Request) -> MeshNodeOut:
    """Full-spec update (create body semantics, memory-server PATCH
    pattern). ``enabled`` rides here — nodes deliberately have no action
    endpoint; node management is API-only, the UI is read-only."""
    _guard_write(request, classes=("ui",))
    base_url = await _validate_mesh_node_url(body.base_url)
    if store.get_mesh_node(name) is None:
        raise HTTPException(404, f"mesh node '{name}' not found")
    row = store.upsert_mesh_node({
        "name": name, "base_url": base_url,
        "description": body.description, "enabled": body.enabled,
    })
    _broadcast({"kind": "mesh.node.changed", "node": name})
    return _mesh_node_public(row)


@app.delete("/api/mesh/nodes/{name}")
async def delete_mesh_node(name: str, request: Request) -> OkNoteOut:
    """Remove from the board registry. The mesh node itself is untouched."""
    _guard_write(request, classes=("ui",))
    if not store.delete_mesh_node(name):
        raise HTTPException(404, f"mesh node '{name}' not found")
    _broadcast({"kind": "mesh.node.changed", "node": name})
    return {"ok": True, "note": "removed from board; the mesh node itself is untouched"}


# ------------------------------------------------------------- merged views
@app.get("/api/memories/pulse")
async def memory_pulse_all(project: str = "", limit: int = 12,
                           scope: str = "") -> dict[str, Any]:
    """Merged pulse across scope (all servers | group | one server)."""
    if scope and scope != "all":
        kind, servers = get_scope_servers(scope)
    else:
        kind, servers = "all", registry.active_servers()
    limit = min(limit, 20)
    results = await asyncio.gather(
        *(mnemos_client.memory_pulse(s, project=project, limit=limit) for s in servers)
    )
    merged_items: list[dict[str, Any]] = []
    per_server: list[dict[str, Any]] = []
    for s, r in zip(servers, results):
        per_server.append({
            "server": s["name"], "ok": r["ok"],
            "items": len(r.get("items", [])), "detail": r.get("detail"),
        })
        for item in r.get("items", []):
            item["server"] = s["name"]
            merged_items.append(item)
    merged_items.sort(key=lambda i: i.get("created_at") or "", reverse=True)
    if not merged_items:
        stats = await asyncio.gather(*(mnemos_client.store_stats(s) for s in servers))
        store_stats = [
            {"server": s["name"], "stats": st}
            for s, st in zip(servers, stats)
        ]
        return {
            "ok": any(p["ok"] for p in per_server),
            "scope": scope or "all", "kind": kind, "items": [],
            "per_server": per_server, "store_stats": store_stats,
        }
    return {
        "ok": True, "scope": scope or "all", "kind": kind,
        "items": merged_items[:limit], "per_server": per_server,
    }


@app.get("/api/memories/servers/{scope}/pulse")
async def memory_pulse(scope: str, project: str = "mnemos-eyes", limit: int = 8) -> dict[str, Any]:
    return await memory_pulse_all(project=project, limit=limit, scope=scope)


# ------------------------------------------- merged memories + tags (Ф0b)
# The two additive endpoints of ADR 0011 §6: a merged memory listing with
# the uniform cursor contract (§11) and the aggregated tag listing that
# closes the BoardAdapter "no listTags" probe gap.
_MEMORY_PAGE_CAP = 200        # hard page cap; a request above it → truncated
_MEM_EXCERPT_CHARS = 200     # SEC-4: excerpt only, capped — no full content


def _encode_cursor(offsets: dict[str, int]) -> str:
    payload = json.dumps({"v": 1, "offsets": offsets}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")


def _decode_cursor(cursor: str) -> dict[str, int]:
    """Opaque cursor → per-server offsets. Raises HTTP 422 on anything this
    server did not issue (garbage base64/JSON, wrong version, non-string
    keys, negative or non-integer offsets)."""
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
    except (ValueError, UnicodeEncodeError):
        raise HTTPException(422, "invalid cursor") from None
    if (not isinstance(data, dict) or data.get("v") != 1
            or not isinstance(data.get("offsets"), dict)):
        raise HTTPException(422, "invalid cursor")
    offsets = data["offsets"]
    if not all(isinstance(k, str) and isinstance(v, int)
               and not isinstance(v, bool) and v >= 0
               for k, v in offsets.items()):
        raise HTTPException(422, "invalid cursor")
    return offsets


def _merged_memory_item(server_name: str, m: dict[str, Any]) -> dict[str, Any]:
    """Public card of one mnemos listing hit. Ids are NOT prefixed or
    mutated — per-store ids may collide by design; the ``server`` field
    disambiguates. SEC-4: only an excerpt travels, never full content."""
    tags = [t for t in (m.get("tags") or []) if isinstance(t, str)]
    return {
        "id": str(m.get("id") or ""),
        "title": (m.get("title") or (m.get("content") or "")[:80]),
        "tags": tags,
        "status": m.get("status"),
        "project": m.get("project") or next(
            (t[len("project:"):] for t in tags if t.startswith("project:")), ""),
        "created_at": m.get("created_at") or "",
        "updated_at": m.get("updated_at") or "",
        "excerpt": (m.get("excerpt") or m.get("content") or "")[:_MEM_EXCERPT_CHARS],
        "server": server_name,
    }


def _memory_sort_key(m: dict[str, Any]) -> tuple[str, str]:
    """Uniform pagination tiebreak (ADR 0011 §11): created_at DESC, id."""
    return (m.get("created_at") or "", m.get("id") or "")


def _upstream_error(server_name: str, code: int, body: Any) -> dict[str, Any]:
    detail = (body.get("detail") or "") if isinstance(body, dict) else str(body)
    return {"server": server_name, "status": code, "detail": str(detail)[:200]}


@app.get("/api/memories")
async def memories_merged(
    limit: int = Query(50, ge=1),
    cursor: str = "",
    scope: str = "",
    status: str = "",
    project: str = "",
    agent: str = "",
    tags: str = "",
    since: str = "",
    until: str = "",
) -> MemoryListOut:
    """Merged memory listing across active servers (Ф0b — BoardAdapter's
    list primitive). Native mnemos ``GET /memories`` listing per server
    with ``offset`` under the hood; the client sees the uniform cursor
    contract: ``limit`` (default 50, hard cap 200) + opaque ``cursor`` →
    ``next_cursor``; sort ``created_at DESC`` with the ``id`` tiebreak.

    Cursor mechanics: each server's slice is pre-sorted by the merge key,
    so the merged page is a union of per-server PREFIXES — advancing a
    server's offset by exactly its consumed count loses nothing and
    duplicates nothing. ``scope``: 'all' (default) or one ACTIVE server
    name (simplified like the inbox — no groups); unknown name → 404. The
    native filters (status/project/agent/tags/since/until) pass through
    verbatim; a cursor is only valid for the parameters it was issued
    with. A failing server degrades to its own ``errors[]`` entry and
    keeps its old offset for the next page. ``truncated`` is true when
    the requested limit exceeded the page cap (silent cap); content drops
    beyond the page always come with a non-null ``next_cursor``.
    """
    truncated = limit > _MEMORY_PAGE_CAP
    limit = min(limit, _MEMORY_PAGE_CAP)
    offsets = _decode_cursor(cursor) if cursor else {}

    if scope and scope != "all":
        matched = [s for s in registry.active_servers() if s["name"] == scope]
        if not matched:
            raise HTTPException(404, f"no active memory server named '{scope}'")
        servers = matched
    else:
        servers = registry.active_servers()

    listing_filters = {k: v for k, v in (
        ("status", status), ("project", project), ("agent", agent),
        ("tags", tags), ("since", since), ("until", until)) if v}
    results = await asyncio.gather(*(
        mnemos_client.fetch_json(s, "/memories", {
            "limit": limit, "offset": offsets.get(s["name"], 0),
            **listing_filters,
        }) for s in servers
    ))

    errors: list[dict[str, Any]] = []
    slices: dict[str, list[dict[str, Any]]] = {}
    for s, (code, body) in zip(servers, results):
        hits = _listing_hits_of(body)  # shared listing-body normalizer
        if code != 200 or hits is None:
            errors.append(_upstream_error(s["name"], code, body))
            continue
        items = [_merged_memory_item(s["name"], h) for h in hits]
        items.sort(key=_memory_sort_key, reverse=True)
        slices[s["name"]] = items

    merged = sorted((m for its in slices.values() for m in its),
                    key=_memory_sort_key, reverse=True)
    page = merged[:limit]

    consumed = {name: 0 for name in slices}
    for m in page:
        consumed[m["server"]] += 1
    next_offsets = {name: offsets.get(name, 0) + consumed[name]
                    for name in slices}
    # Full slices may continue (mnemos answers in limit-sized pages);
    # unconsumed items mean the merge dropped some — both must offer a
    # continuation. Short fully-consumed slices are exhausted.
    has_more = (len(merged) > len(page)
                or any(len(its) >= limit for its in slices.values()))
    return MemoryListOut(
        items=page,
        next_cursor=_encode_cursor(next_offsets) if has_more else None,
        truncated=truncated,
        errors=errors,
    )


@app.get("/api/tags")
async def tags_merged() -> TagListOut:
    """Aggregated tag listing across all ACTIVE memory servers (Ф0b).
    Primitive: mnemos ``GET /tags`` (TagCount[]); counts are summed per
    tag name across stores; sort count DESC, name ASC. A failing server
    degrades to its own ``errors[]`` entry; ``servers_scanned`` counts
    only the stores that answered."""
    servers = registry.active_servers()
    results = await asyncio.gather(*(
        mnemos_client.fetch_json(s, "/tags") for s in servers))
    counts: dict[str, int] = {}
    errors: list[dict[str, Any]] = []
    scanned = 0
    for s, (code, body) in zip(servers, results):
        if code != 200 or not isinstance(body, list):
            errors.append(_upstream_error(s["name"], code, body))
            continue
        scanned += 1
        for t in body:
            if not (isinstance(t, dict) and isinstance(t.get("tag"), str)):
                continue
            try:
                counts[t["tag"]] = counts.get(t["tag"], 0) + int(t.get("count") or 0)
            except (TypeError, ValueError):
                continue  # one malformed record never breaks the aggregate
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    return TagListOut(
        tags=[{"name": n, "count": c} for n, c in ordered],
        servers_scanned=scanned,
        errors=errors,
    )


@app.get("/api/memories/item/{memory_id}")
async def memory_item(memory_id: str) -> dict[str, Any]:
    """Full memory card for the pulse/session modal (first resolving server)."""
    servers = registry.active_servers()
    for s in servers:
        code, body = await mnemos_client.fetch_json(s, f"/memories/{memory_id}")
        if code == 200 and isinstance(body, dict):
            return {
                "ok": True,
                "server": s["name"],
                "memory": {
                    "id": body.get("id", memory_id),
                    "title": body.get("title") or "",
                    "content": body.get("content") or "",
                    "raw_content": body.get("raw_content"),
                    "tags": body.get("tags", []),
                    "status": body.get("status"),
                    "memory_type": body.get("memory_type"),
                    "source": body.get("source"),
                    "source_url": body.get("source_url"),
                    "project": (body.get("tags") or [""])[0].replace("project:", "") if body.get("tags") else "",
                    "agent": next((t[6:] for t in (body.get("tags") or []) if t.startswith("agent:")), ""),
                    "created_at": body.get("created_at"),
                    "updated_at": body.get("updated_at"),
                },
            }
    return {"ok": False, "error": "memory not found on any active server"}


@app.get("/api/memories/servers/{scope}/stats")
async def memory_stats(scope: str) -> dict[str, Any]:
    kind, servers = get_scope_servers(scope)
    stats = await asyncio.gather(*(mnemos_client.store_stats(s) for s in servers))
    return {
        "ok": True, "scope": scope, "kind": kind,
        "stores": [
            {"server": s["name"], "group": s["group_name"], "stats": st or None}
            for s, st in zip(servers, stats)
        ],
    }


@app.get("/api/memories/groups/{name}/info")
async def group_info(name: str) -> dict[str, Any]:
    """Cluster card data: membership, per-member live state, history."""
    groups = {g["name"]: g for g in registry.groups()}
    g = groups.get(name)
    if g is None:
        raise HTTPException(404, f"group '{name}' not found")
    members = [s for s in registry.servers() if s["group_name"] == name]
    probes = await asyncio.gather(*(mnemos_client.ping(s) for s in members))
    stats = await asyncio.gather(*(mnemos_client.store_stats(s) for s in members))
    per_member = []
    for s, p, st in zip(members, probes, stats):
        per_member.append({
            "name": s["name"], "url": s["url"], "enabled": bool(s["enabled"]),
            "state": s["state"], "ok": p["ok"], "latency_ms": p["latency_ms"],
            "memories_total": (st or {}).get("memories_total"),
            "version": (st or {}).get("version"),
            "by_project": (st or {}).get("by_project", {}),
        })
    return {
        "ok": True, "group": {"name": name, "members": g["servers"],
                               "description": g.get("description", "")},
        "members": per_member,
        "history": store.group_history(name),
    }


@app.post("/api/memories/groups/{name}/members")
async def group_membership(name: str, body: GroupMemberBody, request: Request) -> GroupMemberOut:
    """Add/remove a server to/from a group: body {server, op: 'add'|'remove'}."""
    _guard_write(request, classes=("ui",))
    server = body.server
    op = body.op
    if store.get_server(server) is None:
        raise HTTPException(404, f"server '{server}' not found")
    if op == "add":
        out = registry.set_group(server, name)
        store.log_group_action(name, "member-added", server)
    elif op == "remove":
        out = registry.set_group(server, "default")
        store.log_group_action(name, "member-removed", server)
    else:
        raise HTTPException(422, f"unknown op: {op}")
    _broadcast({"kind": "server.changed", "server": server})
    return {"ok": True, "server": _server_public(out) if out else None}


@app.get("/api/memories/groups/{name}/history")
async def group_history(name: str) -> dict[str, Any]:
    return {"ok": True, "group": name, "history": store.group_history(name)}


@app.get("/api/mnemos/search")
async def mnemos_search(q: str, limit: int = 10, project: str = "", scope: str = "") -> dict[str, Any]:
    """Search one server (scope=server name), a group, or all active servers."""
    if scope and scope != "all":
        _, scoped = get_scope_servers(scope)
    else:
        scoped = registry.active_servers()
    limit = min(limit, 25)
    results = await asyncio.gather(
        *(mnemos_client.search(s, q, limit=limit, project=project) for s in scoped)
    )
    merged: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for s, (code, data) in zip(scoped, results):
        if code != 200:
            errors.append({"server": s["name"], "status": code,
                           "detail": data.get("detail") if isinstance(data, dict) else str(data)})
            continue
        items = data if isinstance(data, list) else data.get("results", [])
        for it in items:
            if isinstance(it, dict):
                it["server"] = s["name"]
                merged.append(it)
    merged.sort(key=lambda i: i.get("score") or 0, reverse=True)
    return {"ok": not errors or bool(merged), "results": merged[:limit], "errors": errors}


class ReflectBody(BaseModel):
    specialist: str
    problem: str = ""
    kind: str = "agent-refine-request"  # agent-refine-request | agent-refine-commit


# Board reflections are DATA, never instructions (SEC-4 poisoning hardening):
# mnemos:decision and any other subtype are forbidden here, so agent
# harnesses treat these records as open questions from the board, not as
# directives. The mnemos strict tag contract additionally requires exactly
# one project:<slug> and one agent:<slug> per memory — the board stamps its
# own identity (never a specialist slug) to stay attributable without
# impersonating an agent.
BOARD_PROJECT_TAG = "project:mnemos-eyes"
BOARD_AGENT_TAG = "agent:zcode"
BOARD_REFLECT_TAGS = [
    BOARD_PROJECT_TAG,
    BOARD_AGENT_TAG,
    "mnemos:open-question",
    "source:board",
]
_REFLECT_RATE_LIMIT = 10        # requests per client ...
_REFLECT_RATE_WINDOW = 60.0     # ... per sliding window (seconds)
_reflect_limiter = RateLimiter(limit=_REFLECT_RATE_LIMIT, window=_REFLECT_RATE_WINDOW)


@app.post("/api/board-reflect")
async def board_reflect(body: ReflectBody, request: Request) -> ReflectOut:
    """Refine cycle persistence: write the request/commit-marker into mnemos
    memory tagged ``mnemos:open-question`` + ``source:board`` plus the
    contract-required project/agent stamps (SEC-4: board data is not
    instructions — harnesses must not treat these records as decisions or
    directives). Rate limited per client. Returns the created memory id."""
    _guard_write(request, classes=("ui",))
    client_ip = request.client.host if request.client else "unknown"
    if not _reflect_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"board-reflect rate limit exceeded "
            f"({_REFLECT_RATE_LIMIT} per {_REFLECT_RATE_WINDOW:.0f}s per client)",
        )
    if body.kind not in ("agent-refine-request", "agent-refine-commit"):
        raise HTTPException(422, f"unknown kind: {body.kind}")

    servers = registry.active_servers()
    if not servers:
        raise HTTPException(503, "no active memory server")
    server = servers[0]

    if body.kind == "agent-refine-commit":
        content = (
            f"AGENT-REFINE COMMIT PREPARED for {body.specialist}: "
            f"{body.problem}. Tag: agent-refine. GCW commit pending — embed in next release (orphan-commit policy)."
        )
        title = f"agent-refine commit marker — {body.specialist}"
    else:
        content = (
            f"AGENT-REFINE REQUEST for {body.specialist}: {body.problem} "
            f"Owner feedback from the vesmaro-eyes specialist card. "
            f"@GCW: Agent Architect to analyze instructions/skills/rules and propose changes."
        )
        title = f"agent-refine request: {body.specialist}"

    # BE-4: must stay async — a sync httpx call here would freeze the event
    # loop and stall every concurrent request (e.g. GET /api/board) for the
    # full mnemos round-trip.
    code, body_resp = await mnemos_client.post_json_async(server, "/memories", {
        "content": content[:4000],
        "title": title[:120],
        "tags": list(BOARD_REFLECT_TAGS),
        "source": "mcp",
        "memory_type": "note",
    })
    if code not in (200, 201):
        detail = body_resp.get("detail") if isinstance(body_resp, dict) else str(body_resp)
        raise HTTPException(code, f"mnemos: {detail}")
    memory_id = body_resp.get("id") if isinstance(body_resp, dict) else None
    return {"ok": True, "memory_id": memory_id, "server": server["name"]}


# UI-6 "Новая задача": raw owner thought → memory draft. Freeze exception
# (ADR 0006): tracker workflow feature — "the tracker needs itself".
# Poisoning invariant (ui-contract §12, same SEC-4 rule as board-reflect):
# records written here carry EXACTLY the three tags below — user-supplied
# project/tags from the form are metadata inside CONTENT, never raw tags.
# The memory still needs the mnemos strict-contract stamps (exactly one
# project:<slug> + one agent:<slug>): the slug is sanitized server-side and
# the agent stamp is the board's own identity, so no specialist slug can be
# injected through this endpoint. Subtype tags keep the record data, not
# instructions (SEC-4).
_DRAFT_PROJECT_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,48}")
_DRAFT_RATE_LIMIT = 10         # requests per client ...
_DRAFT_RATE_WINDOW = 60.0      # ... per sliding window (seconds)
_draft_limiter = RateLimiter(limit=_DRAFT_RATE_LIMIT, window=_DRAFT_RATE_WINDOW)


def _draft_tags(project: str) -> list[str]:
    slug = project.strip().lower().replace("_", "-")
    if not _DRAFT_PROJECT_SLUG.fullmatch(slug):
        slug = "mnemos-eyes"
    return [
        f"project:{slug}",
        BOARD_AGENT_TAG,
        "mnemos:open-question",
        "task-draft",
        "source:board",
    ]


@app.post("/api/task-drafts", status_code=201)
async def create_task_draft(body: TaskDraftBody, request: Request) -> TaskDraftOut:
    """Persist the owner's raw thought as a mnemos draft note (tags pinned
    to the _draft_tags() contract set) and return the memory coordinates;
    the SPA then files the "Оформить черновик задачи" chore on the board.
    Rate limited per client like board-reflect."""
    _guard_write(request, classes=("ui",))
    client_ip = request.client.host if request.client else "unknown"
    if not _draft_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"task-drafts rate limit exceeded "
            f"({_DRAFT_RATE_LIMIT} per {_DRAFT_RATE_WINDOW:.0f}s per client)",
        )
    text = body.text.strip()
    if not text:
        raise HTTPException(422, "draft text is empty")

    servers = registry.active_servers()
    if not servers:
        raise HTTPException(503, "no active memory server")
    server = servers[0]

    # project / tags from the form are CONTENT metadata only — never tags
    meta_lines = [f"проект: {body.project.strip() or '—'}",
                  f"теги: {body.tags.strip() or '—'}"]
    content = text + "\n\n— метаданные формы —\n" + "\n".join(meta_lines)
    title = f"task-draft: {text[:60]}"

    # BE-4: async mnemos round-trip — never block the event loop.
    code, body_resp = await mnemos_client.post_json_async(server, "/memories", {
        "content": content[:4000],
        "title": title[:120],
        "tags": _draft_tags(body.project),
        "source": "mcp",
        "memory_type": "note",
    })
    if code not in (200, 201):
        detail = body_resp.get("detail") if isinstance(body_resp, dict) else str(body_resp)
        raise HTTPException(code, f"mnemos: {detail}")
    memory_id = body_resp.get("id") if isinstance(body_resp, dict) else None
    return {"ok": True, "memory_id": memory_id, "server": server["name"]}


# ----------------------------------------------------------- notifications
@app.get("/api/notifications")
async def notifications(after_id: int = 0, limit: int = 50,
                        unread_only: bool = False) -> NotificationsOut:
    return {
        "ok": True,
        "unread": store.unread_count(),
        "items": store.notifications(after_id=after_id, limit=limit,
                                     unread_only=unread_only),
    }


@app.post("/api/notifications/read")
async def notifications_read(
    request: Request, body: NotificationReadBody | None = None
) -> NotificationReadOut:
    _guard_write(request, classes=("ui",))
    # no body or {"id": null} marks ALL as read (previous contract kept)
    store.mark_read(body.id if body else None)
    return {"ok": True, "unread": store.unread_count()}


@app.get("/api/archive")
async def archive(
    q: str = "",
    status: str = "",
    col: str = "",
    agent: str = "",
    project: str = "",
    limit: int = 50,
    offset: int = 0,
) -> ArchiveOut:
    """Archive v2 (BE-11b): ``q`` LIKE over title/summary, ``status`` /
    ``col`` exact, ``agent`` a member of the agents array, ``project``
    exact; ``limit``/``offset`` paginate ``items`` while ``total`` (and the
    legacy ``count`` key) always report the full matching set. ``projects``
    grouping also covers the full matching set so v1 teaser counts stay
    stable under pagination."""
    if status and status not in TASK_STATUSES:
        raise HTTPException(422, f"invalid status: {status}")
    if col and col not in VALID_STATUSES:
        raise HTTPException(422, f"invalid col: {col}")
    limit = max(0, min(limit, 200))
    offset = max(0, offset)
    rows = store.archived_tasks(q=q.strip(), status=status, col=col,
                                agent=agent.strip(), project=project)
    total = len(rows)
    by_project: dict[str, list[dict[str, Any]]] = {}
    for t in rows:
        by_project.setdefault(t.get("project") or "без проекта", []).append({
            "id": t["id"], "title": t["title"], "col": t["col"],
            "agents": t.get("agents", []), "env": t.get("env"),
            "updated_at": t.get("updated_at"),
        })
    return {
        "ok": True,
        "count": total,   # legacy key (v1 SPA reads it)
        "total": total,
        "limit": limit,
        "offset": offset,
        "items": rows[offset:offset + limit],
        "projects": by_project,
    }


@app.post("/api/tasks/{task_id}/archive")
async def archive_task(task_id: str, request: Request) -> OkOut:
    _guard_write(request, classes=("ui",))
    if not store.archive_task(task_id, actor=_device_actor(request)):
        raise HTTPException(404, "task not found or already archived")
    _notify_and_broadcast("work", f"{task_id}: в архиве", "задача архивирована", task_id, {"kind": "task.archived", "task_id": task_id})
    return {"ok": True}


@app.post("/api/tasks/{task_id}/unarchive")
async def unarchive_task(task_id: str, request: Request) -> UnarchiveOut:
    """Restore an archived task to its pre-archive column (BE-11b); rows
    archived before ``archived_from`` existed fall back to ``open``."""
    _guard_write(request, classes=("ui",))
    task = store.unarchive_task(task_id, actor=_device_actor(request))
    if task is None:
        raise HTTPException(404, "task not found or not archived")
    _notify_and_broadcast("work", f"{task_id}: из архива", "задача возвращена на доску", task_id, {"kind": "task.unarchived", "task_id": task_id})
    return {"ok": True, "task": task}


# ------------------------------------------------------- agent reports (BE-11a)
# Same per-client sliding-window pattern as task-drafts; a friendlier budget
# because agents report several times per task (intermediates + final).
_REPORT_RATE_LIMIT = 30         # requests per client ...
_REPORT_RATE_WINDOW = 60.0      # ... per sliding window (seconds)
_report_limiter = RateLimiter(limit=_REPORT_RATE_LIMIT, window=_REPORT_RATE_WINDOW)


@app.post("/api/tasks/{task_id}/reports", status_code=201)
async def create_task_report(task_id: str, body: ReportCreate,
                             request: Request) -> ReportCreatedOut:
    """Append an agent report to a task. 404 on unknown task; 422 on an
    unknown kind or an empty body; 429 when the per-client rate limit is
    exhausted. A second kind="final" supersedes previous live finals
    (history kept, flagged).

    Auth composition (ADR 0009 A1 + Amd 2 §2 + scope v1): the owner UI
    writes with the ui-class token; the machine loop writes with the board
    (machine) token OR an approved executor token (the mesh leg reports
    with its own credential); a paired device writes on its mnd_ leg when
    the scope middleware validated it AND matched this route against the
    device scope table (control scope). When the report is executor-
    token-backed, a declared ``agent`` string that references neither the
    executor's registered name nor its harness lands in the audit trail
    flagged ``identity_mismatch`` (Amd 2 §7 spoofing signal — signal, not
    a refusal: the report is still accepted)."""
    executor = None
    device = getattr(request.state, "device", None)
    header_present = bool(request.headers.get("Authorization", ""))
    cookie_ui = not header_present and _cookie_ui_ok(request)
    if device is not None:
        # Device leg (scope v1): the middleware's verdict IS the auth —
        # checked FIRST so a device bearer never falls into the machine
        # leg (the machine guard would answer 401 for an mnd_ bearer).
        pass
    elif (cookie_ui or _bearer_is_class(request, "ui")
          or not _token_classes().get("machine")):
        # Leg pick (ADR 0014 Ф2 + review gap matrix): a live `vesmaro_ui`
        # cookie picks the ui leg ONLY when no header rides along — the
        # determinism rule keeps a header-present request on its own leg
        # (a valid machine bearer + a valid cookie is a machine request,
        # never a ui one). When the machine class is not configured at all
        # the endpoint stays reachable through ui REGARDLESS of the bearer
        # (a wrong-class bearer then gets 401, not a 503 disable).
        _guard_write(request, classes=("ui",))
    else:
        executor = _guard_machine_write(request)
    client_ip = request.client.host if request.client else "unknown"
    if not _report_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"task reports rate limit exceeded "
            f"({_REPORT_RATE_LIMIT} per {_REPORT_RATE_WINDOW:.0f}s per client)",
        )
    if body.kind not in REPORT_KINDS:
        raise HTTPException(422, f"unknown report kind: {body.kind}")
    if not body.body.strip():
        raise HTTPException(422, "report body is empty")
    try:
        added = store.add_report(
            task_id, body.body, body.kind, body.agent,
            identity_mismatch=_report_identity_mismatch(executor, body.agent))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if added is None:
        raise HTTPException(404, "task not found")
    report, superseded_ids = added
    _notify_and_broadcast(
        "work", f"{task_id}: отчёт агента ({body.kind})",
        report["body"][:120], task_id,
        # actor = declared identity (ADR 0009 §8: unverified self-assertion).
        # Agents spec §5 p.7: one uniform actor field across execution
        # events — this closes the kind:"report" gap. Additive field.
        {"kind": "report", "task_id": task_id, "actor": body.agent,
         "report": {**report, "body": report["body"][:200]}},
    )
    return {"ok": True, "report": report, "superseded": superseded_ids}


@app.get("/api/tasks/{task_id}/reports")
async def list_task_reports(task_id: str) -> ReportsOut:
    """Chronological report history for a task (oldest first)."""
    reports = store.list_reports(task_id)
    if reports is None:
        raise HTTPException(404, "task not found")
    return {"ok": True, "task_id": task_id,
            "count": len(reports), "items": reports}


# Cross-task feed page size (CV-6). Above the cap the limit is silently
# clamped — board convention (GET /api/archive), not a 422: a live feed
# must tolerate an aggressive client asking for everything.
_REPORTS_FEED_PAGE_CAP = 200


@app.get("/api/reports")
async def reports_feed(
    limit: int = Query(50, ge=1),
    before_id: int | None = None,
    task_id: str = "",
    kind: str = "",
    include_superseded: bool = False,
) -> ReportsFeedOut:
    """Cross-task agent-report feed, freshest first (CV-6: the server side
    of the Agents-domain activity stream; OPEN read like the other GET
    listings — the cluster ingress is the auth boundary).

    Cursor pagination: ``limit`` (default 50, hard cap 200 — silently
    clamped) + ``before_id`` (rows with id strictly below it, so pages
    stay stable while new reports land; the feed ends where a full-width
    page comes back short). Filters: ``task_id`` exact, ``kind``
    (intermediate | final — 422 on garbage). A ``task_id`` matching
    nothing — including an UNKNOWN task — is an empty page (200, count 0),
    not 404: here the task is a filter value, not an addressed resource
    (per-task GET keeps its 404 semantics). Superseded finals are excluded
    by default (the live feed shows one final per task);
    ``include_superseded`` restores them flagged ``superseded``.
    ``truncated`` is true when the requested limit exceeded the page cap
    (silent clamp); a NON-POSITIVE limit is a 422 (``ge=1``), the numeric-
    validation pattern of the cursor listings /api/memories and
    /api/automation/launches."""
    if kind and kind not in REPORT_KINDS:
        raise HTTPException(422, f"unknown report kind: {kind}")
    truncated = limit > _REPORTS_FEED_PAGE_CAP
    limit = min(limit, _REPORTS_FEED_PAGE_CAP)
    items = store.list_recent_reports(
        task_id=task_id or None, kind=kind or None, limit=limit,
        before_id=before_id, include_superseded=include_superseded)
    return {"ok": True, "count": len(items), "items": items,
            "truncated": truncated}


# -------------------------------------------------- assignments (ADR 0009 Ф1)
# Variant A′ assignment queue: the owner nominates (UI token), the poller
# decides (machine token). Rate limits follow the house pattern — UI class
# 10/60 s like task-drafts, machine class 30/60 s like reports.
_ASSIGNMENT_UI_RATE_LIMIT = 10        # requests per client ...
_ASSIGNMENT_UI_RATE_WINDOW = 60.0     # ... per sliding window (seconds)
_assignment_ui_limiter = RateLimiter(
    limit=_ASSIGNMENT_UI_RATE_LIMIT, window=_ASSIGNMENT_UI_RATE_WINDOW)
_ASSIGNMENT_RATE_LIMIT = 30           # requests per client ...
_ASSIGNMENT_RATE_WINDOW = 60.0        # ... per sliding window (seconds)
_assignment_limiter = RateLimiter(
    limit=_ASSIGNMENT_RATE_LIMIT, window=_ASSIGNMENT_RATE_WINDOW)


def _assignment_public(a: dict[str, Any], include_snapshot: bool = False) -> dict[str, Any]:
    """SSE/list shape of an assignment: claim_token NEVER leaves the claim
    response; spec_snapshot only there (machine consumer, A2). spec_hash,
    executor_id and claimed_by_executor are public."""
    out = {k: v for k, v in a.items()
           if k not in ("claim_token", "spec_snapshot")}
    if include_snapshot:
        out["spec_snapshot"] = a.get("spec_snapshot", "")
    return out


def _assignment_http(exc: AssignmentError) -> HTTPException:
    """Map store assignment errors onto the HTTP contract (ADR 0009):
    404 unknown id / 403 token / 422 not assignable or unknown harness /
    409 state+invariant."""
    if isinstance(exc, AssignmentNotFoundError):
        return HTTPException(404, str(exc))
    if isinstance(exc, AssignmentTokenError):
        return HTTPException(403, str(exc))
    if isinstance(exc, (TaskNotAssignableError, UnknownHarnessError)):
        return HTTPException(422, str(exc))
    if isinstance(exc, AssignmentConflictError):
        return HTTPException(409, str(exc))
    return HTTPException(409, str(exc))  # defensive: unknown subclass → 409


def _assignment_rate_limit(request: Request, ui: bool) -> None:
    limiter = _assignment_ui_limiter if ui else _assignment_limiter
    limit = _ASSIGNMENT_UI_RATE_LIMIT if ui else _ASSIGNMENT_RATE_LIMIT
    window = _ASSIGNMENT_UI_RATE_WINDOW if ui else _ASSIGNMENT_RATE_WINDOW
    client_ip = request.client.host if request.client else "unknown"
    if not limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"assignments rate limit exceeded "
            f"({limit} per {window:.0f}s per client)",
        )


def _touch_presence_if_authenticated(request: Request, executor_id: str) -> None:
    """Presence piggyback for GET /api/assignments?executor_id=... — the
    poll announces itself and its clock ticks. Auth-gated: only the
    executor's OWN token or the machine token may tick presence (an open
    endpoint must not let arbitrary readers fake liveness — presence feeds
    the auto-pick routing tier). Unauthenticated reads stay legal, they
    just don't tick."""
    executor = _authenticate_executor(request)
    if executor is not None:
        if executor["id"] == executor_id and executor["state"] != "revoked":
            store.touch_executor_last_seen(executor_id)
        return
    auth = request.headers.get("Authorization", "")
    if BOARD_WRITE_TOKEN and hmac.compare_digest(
            auth.encode("utf-8"),
            f"Bearer {BOARD_WRITE_TOKEN}".encode("utf-8")):
        store.touch_executor_last_seen(executor_id)


@app.get("/api/assignments")
async def list_assignments(request: Request, state: str = "",
                           task_id: str = "", executor_id: str = "",
                           by: str = "") -> AssignmentsOut:
    """Assignment queue projection (ADR 0009). OPEN read (no bearer), same
    boundary as GET /api/board: the cluster ingress is the auth boundary.
    ``state`` must be a dictionary value (422); ``task_id`` is an exact
    filter. Items never carry claim_token or spec_snapshot — the SSE
    dictionary §11 keeps them out for the same reason.

    ARCH-9 additions:
    - ``?executor_id=`` presence piggyback: a poller announcing itself
      ticks that executor's last_seen — but only when authenticated as
      that executor (its token) or with the machine token.
    - every item carries ``routing`` {resolved, reason} — the resolution
      chain (Amd 2 §5) computed per GET, stored nowhere: explicit pin →
      assignment specialist → task specialists → project default →
      global default → auto best-match (online + local-poll) →
      unmatched (visible to all). Only the explicit pin is enforced at
      claim; the annotation is a visibility hint, CAS stays the arbiter.
    - ``topics``: denormalized project/domain tags (metadata tier)."""
    if state and state not in ASSIGNMENT_STATES:
        raise HTTPException(422, f"invalid state: {state}")
    executor_id = executor_id.strip()
    if executor_id:
        _touch_presence_if_authenticated(request, executor_id)
    items = store.assignments(state=state or None, task_id=task_id or None, by=(by or None))
    executors = store.list_executors()
    global_default = (store.get_meta("default_executor") or "").strip()
    task_cache: dict[str, dict[str, Any] | None] = {}
    project_defaults: dict[str, str] = {}
    for i in items:
        tid = i["task_id"]
        if tid not in task_cache:
            task_cache[tid] = store.task(tid)
        task = task_cache[tid]
        project = (task or {}).get("project") or ""
        if project and project not in project_defaults:
            project_defaults[project] = (
                store.get_meta(f"default_executor:project:{project}")
                or "").strip()
        i["routing"] = _routing_annotation(
            i, task, executors, project_defaults.get(project, ""),
            global_default)
    public = [_assignment_public(i) for i in items]
    return {"ok": True, "count": len(public), "items": public}


@app.post("/api/assignments", status_code=201)
async def create_assignment(body: AssignmentCreate,
                            request: Request) -> AssignmentCreatedOut:
    """Queue an execution attempt on a task (ADR 0009 §3). UI-token class
    (A1) — the owner nominates, the poller decides (A3). 404 unknown task;
    422 archived/terminal task or unknown harness; 409 while another active
    assignment holds the task (≤1 invariant). The harness gate lives IN the
    store's in-transaction assignment core (wave 3C) — the same gate the
    manual run-now goes through, so no window can mint a nomination on a
    DELETED harness (a zombie queued row launchable by nobody)."""
    _guard_ui_write(request)
    _assignment_rate_limit(request, ui=True)
    try:
        a = store.create_assignment(
            body.task_id, body.specialist, body.harness,
            executor_id=body.executor_id)
    except AssignmentError as exc:
        raise _assignment_http(exc) from exc
    _notify_and_broadcast(
        "work", f"{a['task_id']}: назначение ({body.specialist})",
        f"специалист {body.specialist}, harness {body.harness}",
        a["task_id"],
        {"kind": "assignment.created",
         "assignment": _assignment_public(a), "task_id": a["task_id"]},
    )
    return {"ok": True, "assignment": _assignment_public(a)}


@app.post("/api/assignments/{assignment_id}/claim")
async def claim_assignment(assignment_id: int, body: AssignmentClaimBody,
                           request: Request) -> AssignmentClaimedOut:
    """Atomic claim (A4): machine-token class — the board token OR an
    approved executor token (ARCH-9: on the mesh leg the executor token
    is the credential; a mesh node must not hold board-class secrets).
    CAS on state='queued'; the task column moves open → in-progress in
    the same transaction. The response carries the claim_token
    (correctness boundary: a stale poller cannot finish a re-claimed
    assignment) and the spec_snapshot (A2: the poller executes the
    snapshot, never the live spec). 409 when another poller got there
    first.

    ARCH-9 explicit-pin enforcement (Amd 2 §5, in the store transaction):
    an assignment pinned via executor_id claims ONLY with the pinned
    executor's token — a plain machine claim is 409, another executor's
    token is 403 (spoofing gate, CWE-290). A claim with an executor token
    records claimed_by_executor from the token identity (authoritative)."""
    executor = _guard_machine_write(request)
    _assignment_rate_limit(request, ui=False)
    try:
        a, token, task, moved = store.claim_assignment(
            assignment_id, body.claimed_by, executor_id=body.executor_id,
            token_executor_id=(executor or {}).get("id"))
    except AssignmentError as exc:
        raise _assignment_http(exc) from exc
    if moved and task is not None:
        _broadcast({"kind": "task.moved", "task": task})
    _broadcast({"kind": "assignment.claimed",
                "assignment": _assignment_public(a),
                "task_id": a["task_id"]})
    return {"ok": True, "assignment": _assignment_public(a, include_snapshot=True),
            "claim_token": token, "task": task}


@app.post("/api/assignments/{assignment_id}/start")
async def start_assignment(assignment_id: int, body: AssignmentTokenBody,
                           request: Request) -> AssignmentStateOut:
    """claimed → running (machine class + claim_token)."""
    _guard_machine_write(request)
    _assignment_rate_limit(request, ui=False)
    try:
        a = store.start_assignment(assignment_id, body.claim_token)
    except AssignmentError as exc:
        raise _assignment_http(exc) from exc
    _broadcast({"kind": "assignment.started",
                "assignment": _assignment_public(a),
                "task_id": a["task_id"]})
    return {"ok": True, "assignment": _assignment_public(a)}


@app.post("/api/assignments/{assignment_id}/heartbeat")
async def heartbeat_assignment(assignment_id: int,
                               body: AssignmentHeartbeatBody,
                               request: Request) -> AssignmentStateOut:
    """Executor liveness tick (machine class + claim_token). 409 unless
    running — on an expired assignment that 409 doubles as the kill signal
    to the poller (ADR 0009 §10). Deliberately NO SSE: heartbeats are
    noise. PR #13 review P3b: own rate budget (60/60 s) — heartbeat
    traffic never touches the shared machine 30/60 s budget. ARCH-9: the
    tick also refreshes the claiming executor's presence clock
    (claimed_by_executor piggyback, store-side)."""
    _guard_machine_write(request)
    client_ip = request.client.host if request.client else "unknown"
    if not _assignment_heartbeat_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"assignment heartbeat rate limit exceeded "
            f"({_ASSIGNMENT_HEARTBEAT_RATE_LIMIT} per "
            f"{_ASSIGNMENT_HEARTBEAT_RATE_WINDOW:.0f}s per client)",
        )
    try:
        a = store.heartbeat_assignment(assignment_id, body.claim_token,
                                       note=body.note)
    except AssignmentError as exc:
        raise _assignment_http(exc) from exc
    return {"ok": True, "assignment": _assignment_public(a)}


@app.post("/api/assignments/{assignment_id}/complete")
async def complete_assignment(assignment_id: int,
                              body: AssignmentCompleteBody,
                              request: Request) -> AssignmentFinishedOut:
    """running → done (machine class + claim_token). The final report rides
    inline: it is written through the existing reports store (kind='final',
    agent = the declared claim identity) right after the terminal
    transition — a 409/403 leaves no half-written report behind. Task maps
    in-progress → resolved (acceptance resolved → done stays with the
    owner). ARCH-9: machine class = board token OR an approved executor
    token (claim_token stays the correctness boundary; the executor loop
    keeps one credential end-to-end, Amd 2 §2). PR #18 F3: the final
    report's declared agent string (the claim identity) runs through the
    same identity_mismatch check as intermediate reports — from the
    token-BACKED executor identity, not the self-assertion."""
    executor = _guard_machine_write(request)
    _assignment_rate_limit(request, ui=False)
    final = body.final_report.strip()
    report: dict[str, Any] | None = None
    try:
        a, task, moved_from, moved_to = store.finish_assignment(
            assignment_id, "complete", note=body.note, token=body.claim_token)
        if final:
            try:
                added = store.add_report(
                    a["task_id"], final, "final",
                    agent=(a.get("claimed_by") or ""),
                    identity_mismatch=_report_identity_mismatch(
                        executor, a.get("claimed_by") or ""))
            except Exception:
                # The terminal transition is already committed; a report
                # failure must not turn a done assignment into a client 500
                # (a retry would 409 and the report would be lost).
                added = None
            if added is not None:  # None only when the task vanished mid-flight
                report, _superseded = added
    except AssignmentError as exc:
        raise _assignment_http(exc) from exc
    if moved_from:
        _broadcast({"kind": "task.moved", "task": task})
    _notify_and_broadcast(
        "work", f"{a['task_id']}: назначение выполнено",
        (final or "финальный отчёт отсутствует")[:120], a["task_id"],
        {"kind": "assignment.done",
         "assignment": _assignment_public(a), "task_id": a["task_id"]},
    )
    return {"ok": True, "assignment": _assignment_public(a), "task": task,
            "moved": [moved_from, moved_to] if moved_from else [],
            "report": report}


@app.post("/api/assignments/{assignment_id}/fail")
async def fail_assignment(assignment_id: int, body: AssignmentFailBody,
                          request: Request) -> AssignmentFinishedOut:
    """Fail an execution attempt (machine class). Auth (PR #18 F1 — the
    claimed_by string is self-asserted and openly readable, so it is no
    longer a standalone credential for executor tokens): a matching
    claim_token; OR the token-BACKED executor identity equal to the
    assignment's claimed_by_executor (mesh-leg recovery: the secret
    outlives the claim_token); OR a claimed_by string match — board-token
    class only (the laptop poller's recovery sweep, board-class trust).
    Task maps in-progress → blocked."""
    executor = _guard_machine_write(request)
    _assignment_rate_limit(request, ui=False)
    try:
        a, task, moved_from, moved_to = store.finish_assignment(
            assignment_id, "fail", note=body.reason,
            token=body.claim_token or None,
            claimed_by=body.claimed_by.strip() or None,
            token_executor_id=(executor or {}).get("id"),
            allow_claimed_by_fallback=executor is None)
    except AssignmentError as exc:
        raise _assignment_http(exc) from exc
    if moved_from:
        _broadcast({"kind": "task.moved", "task": task})
    _notify_and_broadcast(
        "work", f"{a['task_id']}: назначение провалено",
        body.reason[:120], a["task_id"],
        {"kind": "assignment.failed",
         "assignment": _assignment_public(a), "task_id": a["task_id"]},
    )
    return {"ok": True, "assignment": _assignment_public(a), "task": task,
            "moved": [moved_from, moved_to] if moved_from else []}


@app.post("/api/assignments/{assignment_id}/cancel")
async def cancel_assignment(assignment_id: int, body: AssignmentCancelBody,
                            request: Request) -> AssignmentFinishedOut:
    """Cancel an assignment (UI-token class — an owner action). Legal from
    queued/claimed/running; the task returns to open when it had moved to
    in-progress. No claim token: the UI token is the auth."""
    _guard_ui_write(request)
    _assignment_rate_limit(request, ui=True)
    try:
        a, task, moved_from, moved_to = store.finish_assignment(
            assignment_id, "cancel", note=body.reason, claimed_by="owner")
    except AssignmentError as exc:
        raise _assignment_http(exc) from exc
    if moved_from:
        _broadcast({"kind": "task.moved", "task": task})
    _notify_and_broadcast(
        "work", f"{a['task_id']}: назначение отменено",
        body.reason[:120], a["task_id"],
        {"kind": "assignment.cancelled",
         "assignment": _assignment_public(a), "task_id": a["task_id"]},
    )
    return {"ok": True, "assignment": _assignment_public(a), "task": task,
            "moved": [moved_from, moved_to] if moved_from else []}


# -------------------------------------------- executor registry (ARCH-9)
# Rate budgets follow the house pattern: registration is a machine-class
# bootstrap mutation (10/60 s, same budget family as task-drafts); the
# presence heartbeat carries its OWN budget (PR #13 review P3b: heartbeat
# traffic must never starve or be starved by the shared machine 30/60 s
# bucket — one tick per executor per minute, so 60/60 s is generous).
_EXECUTOR_REGISTER_RATE_LIMIT = 10     # requests per client ...
_EXECUTOR_REGISTER_RATE_WINDOW = 60.0  # ... per sliding window (seconds)
_executor_register_limiter = RateLimiter(
    limit=_EXECUTOR_REGISTER_RATE_LIMIT, window=_EXECUTOR_REGISTER_RATE_WINDOW)
_EXECUTOR_HEARTBEAT_RATE_LIMIT = 60    # presence ticks per client ...
_EXECUTOR_HEARTBEAT_RATE_WINDOW = 60.0
_executor_heartbeat_limiter = RateLimiter(
    limit=_EXECUTOR_HEARTBEAT_RATE_LIMIT, window=_EXECUTOR_HEARTBEAT_RATE_WINDOW)
# Assignment-heartbeat budget (P3b): separate from BOTH the machine budget
# and the executor presence budget above.
_ASSIGNMENT_HEARTBEAT_RATE_LIMIT = 60
_ASSIGNMENT_HEARTBEAT_RATE_WINDOW = 60.0
_assignment_heartbeat_limiter = RateLimiter(
    limit=_ASSIGNMENT_HEARTBEAT_RATE_LIMIT,
    window=_ASSIGNMENT_HEARTBEAT_RATE_WINDOW)
# Enrollment budgets (Amd 2 §4 supplement): creation mirrors pairing's
# owner-initiated 3/10 min; revoke is a cheap ui mutation on the task-drafts
# family. ENROLLMENT_MAX_LIVE (imported from the store) caps the live-token
# volume at 3 — pace limits bound requests, quotas bound volume (PR #18 F5).
_ENROLLMENT_CREATE_RATE_LIMIT = 3       # creations per client ...
_ENROLLMENT_CREATE_RATE_WINDOW = 600.0  # ... per sliding 10 min (pairing §3.4)
_enrollment_create_limiter = RateLimiter(
    limit=_ENROLLMENT_CREATE_RATE_LIMIT, window=_ENROLLMENT_CREATE_RATE_WINDOW)
_ENROLLMENT_REVOKE_RATE_LIMIT = 10      # revokes per client ...
_ENROLLMENT_REVOKE_RATE_WINDOW = 60.0   # ... per sliding minute (ui family)
_enrollment_revoke_limiter = RateLimiter(
    limit=_ENROLLMENT_REVOKE_RATE_LIMIT, window=_ENROLLMENT_REVOKE_RATE_WINDOW)
# Harness dictionary (wave 3C): adds/deletes are rare owner actions — the
# enrollment-revoke budget (10/60 s per client) is the right shape. The
# dictionary CAP (HARNESS_MAX_COUNT) bounds volume; this bounds pace.
_HARNESS_WRITE_RATE_LIMIT = 10          # mutations per client ...
_HARNESS_WRITE_RATE_WINDOW = 60.0       # ... per sliding minute (ui family)
_harness_write_limiter = RateLimiter(
    limit=_HARNESS_WRITE_RATE_LIMIT, window=_HARNESS_WRITE_RATE_WINDOW)


def _executor_http(exc: ExecutorError) -> HTTPException:
    """Map store executor-registry errors onto HTTP: 404 unknown id /
    409 duplicate name or illegal state transition / 429 pending quota."""
    if isinstance(exc, ExecutorNotFoundError):
        return HTTPException(404, str(exc))
    if isinstance(exc, ExecutorQuotaError):
        return HTTPException(429, str(exc))
    if isinstance(exc, (ExecutorConflictError, ExecutorStateError)):
        return HTTPException(409, str(exc))
    return HTTPException(409, str(exc))  # defensive: unknown subclass → 409


def _harness_http(exc: HarnessError) -> HTTPException:
    """Map store harness-dictionary errors onto HTTP: 404 unknown name /
    409 duplicate or still-in-use / 422 bad name or dictionary cap (an
    entry-validation class, not a rate guard)."""
    if isinstance(exc, HarnessNotFoundError):
        return HTTPException(404, str(exc))
    if isinstance(exc, HarnessQuotaError):
        return HTTPException(422, str(exc))
    return HTTPException(409, str(exc))  # conflict + in-use (defensive: base)


@app.post("/api/executors", status_code=201)
async def register_executor(body: ExecutorRegister,
                            request: Request) -> ExecutorRegisteredOut:
    """Register an executor (ARCH-9, ladder L0 — Amd 2 §4).

    MACHINE-token bootstrap OR a one-time ENROLLMENT token (``mne_…``,
    Amd 2 §4 supplement): both legs create a PENDING record; the owner
    approves via ui-token PATCH. The board mints ``executor_secret``
    (token_hex(24)) and stores ONLY its sha256 hash — the plaintext appears
    exactly once, in this response (claim_token pattern, long-lived).
    Capabilities are owner-declared via PATCH, never accepted at
    registration. The enrollment leg spends the token in the same store
    transaction as the INSERT (single-use; a rolled-back registration never
    burns it) and broadcasts ``enrollment.used`` (NO duplicate notification
    — the registration notification below already covers the owner; spam
    guard per host applies). 422 unknown harness/transport; 409 duplicate
    name; 410 spent/dead enrollment token; 429 rate 10/60 s per client AND
    a total cap on OPEN pending registrations (PR #18 F5: pace limits bound
    requests, not volume — approving/revoking/deleting frees quota). The
    owner NOTIFICATION fires for the first open pending registration per
    host; later ones from the same host are audit + SSE only (spam guard —
    the audit event is always written)."""
    enrollment = _guard_register(request)
    client_ip = request.client.host if request.client else "unknown"
    if not _executor_register_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"executor registration rate limit exceeded "
            f"({_EXECUTOR_REGISTER_RATE_LIMIT} per "
            f"{_EXECUTOR_REGISTER_RATE_WINDOW:.0f}s per client)",
        )
    if body.transport not in EXECUTOR_TRANSPORTS:
        raise HTTPException(422, f"invalid transport: {body.transport}")
    try:
        row, secret = store.register_executor(
            body.name, body.harness, body.host, body.transport, body.version,
            enrollment=enrollment, enrollment_ip=client_ip)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except EnrollmentStateError as exc:
        raise HTTPException(410, "enrollment token already used") from exc
    except ExecutorError as exc:
        raise _executor_http(exc) from exc
    event = {"kind": "executor.registered",
             "executor": _executor_public(row),
             "prev_state": None, "state": row["state"]}
    if enrollment is not None:
        # Payload audit: id + executor link + presenting IP only — never a
        # token fragment (the dictionary rule, ADR 0012 §3.3 pattern).
        _broadcast({"kind": "enrollment.used",
                    "enrollment_id": enrollment["id"],
                    "executor_id": row["id"],
                    "executor_name": row["name"],
                    "used_ip": client_ip})
    if store.pending_executors_by_host(row.get("host") or "") <= 1:
        _notify_and_broadcast(
            "system", f"Исполнитель {row['name']} зарегистрирован",
            "ожидает подтверждения владельца", None, event,
        )
    else:
        _broadcast(event)
    return {"ok": True, "executor": _executor_public(row),
            "executor_secret": secret}


@app.get("/api/executors")
async def list_executors() -> ExecutorListOut:
    """Executor registry projection — OPEN read (same boundary as
    GET /api/board; the cluster ingress is the auth boundary).

    ``presence`` is COMPUTED from last_seen per the two-clock discipline:
    online = last tick ≤ 120 s ago, stale = ≤ 600 s, offline = beyond
    (never-heartbeated included). These are server-owned constants and
    travel in ``meta`` — clients must read them, never hardcode. The
    sweeper interval is exposed the same way. secret_hash never leaves
    the store."""
    rows = store.list_executors()
    return {
        "ok": True,
        "count": len(rows),
        "items": [_executor_public(r) for r in rows],
        "meta": {
            "presence": {
                "online_max_age_s": int(PRESENCE_ONLINE_S),
                "stale_max_age_s": int(PRESENCE_STALE_S),
            },
            "sweeper_interval_s": int(_PRESENCE_SWEEP_INTERVAL_S),
        },
    }


# -------------------------------------- executor enrollment (Amd 2 §4 suppl.)
# Owner-side minting of one-time registration tokens (mne_). Declared BEFORE
# the parametric /api/executors/{executor_id} routes — same-prefix paths must
# not depend on FastAPI match order. Fail-closed 503 while the ui token is
# not configured (the _guard_ui_write pattern): no owner, no minting.

# AGW-9: the lab-CA fingerprint for the enrollment response — SAME canon as
# provisioner.fingerprint_of_bytes (SHA256:base64 over DER), computed over
# the SAME certificate /api/poller/artifacts/ca.crt serves (the
# VESMARO_TLS_CA_FILE mount). Lazy + cached by (path, mtime, size) so cert
# rotation re-computes and tests can repoint the env per-case. '' whenever
# the CA is unknown (unmounted/missing/not PEM) — the field is advisory:
# the mint itself must not fail on display data.
_CA_FINGERPRINT_CACHE: dict[str, str] = {}


def _board_ca_fingerprint() -> str:
    ca_file = os.environ.get(_TLS_CA_FILE_ENV, "").strip()
    if not ca_file:
        return ""
    path = Path(ca_file)
    try:
        stat = path.stat()
        cache_key = f"{path}|{stat.st_mtime_ns}|{stat.st_size}"
    except OSError:
        return ""
    if _CA_FINGERPRINT_CACHE.get("key") == cache_key:
        return _CA_FINGERPRINT_CACHE.get("fp", "")
    fingerprint = ""
    data = path.read_bytes()
    if data.lstrip().startswith(b"-----BEGIN CERTIFICATE-----"):
        body = b"".join(
            line for line in data.splitlines()
            if line and not line.startswith(b"-----"))
        try:
            der = base64.b64decode(body, validate=True)
        except Exception:
            der = b""
        if der:
            fingerprint = provisioning.fingerprint_of_bytes(der)
    _CA_FINGERPRINT_CACHE.clear()
    _CA_FINGERPRINT_CACHE["key"] = cache_key
    _CA_FINGERPRINT_CACHE["fp"] = fingerprint
    return fingerprint


@app.post("/api/executors/enrollment", status_code=201)
async def create_enrollment(body: EnrollmentCreateBody,
                            request: Request) -> EnrollmentCreatedOut:
    """Mint a one-time enrollment token (ui-token; ADR 0009 Amd 2 §4
    supplement). 201 returns the ``mne_`` token — it appears in exactly one
    response body, this one; the store keeps only its sha256. TTL 15 min
    (server constant; renewal = a new token). Rate 3 per 10 min per client
    (pairing-create pattern); live tokens capped at ENROLLMENT_MAX_LIVE →
    409 with NO auto-revoke (the owner chooses, device-quota principle).
    422 unknown harness_hint (the hint feeds the bootstrap command — a
    bogus hint would mislead the remote leg). ``ca_fingerprint`` rides
    along (AGW-9): the UI bakes it into the bootstrap command as
    --expect-fp, the installer then fail-closes on a wrong CA."""
    _guard_ui_write(request)
    client_ip = request.client.host if request.client else "unknown"
    if not _enrollment_create_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"enrollment creation rate limit exceeded "
            f"({_ENROLLMENT_CREATE_RATE_LIMIT} per "
            f"{_ENROLLMENT_CREATE_RATE_WINDOW:.0f}s per client)",
        )
    try:
        row, token = store.create_enrollment(
            label=body.label, harness_hint=body.harness_hint,
            name_hint=body.name_hint)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except EnrollmentQuotaError as exc:
        raise HTTPException(409, str(exc)) from exc
    _broadcast({"kind": "enrollment.created",
                "enrollment_id": row["enrollment_id"],
                "label": row["label"]})
    return {"ok": True, "enrollment": row, "token": token,
            "ca_fingerprint": _board_ca_fingerprint()}


@app.get("/api/executors/enrollment")
async def list_enrollments(request: Request) -> EnrollmentListOut:
    """Enrollment tokens for the owner panel (ui-token). Items carry NO
    token material — token_hash stays in the store (hash-only); the list
    shows live tokens plus terminal history for the TTL/used audit trail."""
    _guard_ui_write(request)
    items = store.list_enrollments()
    return {"ok": True, "count": len(items), "items": items}


@app.delete("/api/executors/enrollment/{enrollment_id}")
async def revoke_enrollment(enrollment_id: str,
                            request: Request) -> EnrollmentRevokedOut:
    """Revoke a LIVE enrollment token (ui-token). created → revoked + SSE
    ``enrollment.revoked``; already revoked → 200 idempotent; used → 409
    (the executor EXISTS — kill it via the executor registry, never here);
    expired → 409 (the TTL already did the job); unknown → 404."""
    _guard_ui_write(request)
    client_ip = request.client.host if request.client else "unknown"
    if not _enrollment_revoke_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"enrollment revoke rate limit exceeded "
            f"({_ENROLLMENT_REVOKE_RATE_LIMIT} per "
            f"{_ENROLLMENT_REVOKE_RATE_WINDOW:.0f}s per client)",
        )
    try:
        row, transitioned = store.revoke_enrollment(enrollment_id)
    except EnrollmentNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except EnrollmentStateError as exc:
        raise HTTPException(409, str(exc)) from exc
    if transitioned:
        _broadcast({"kind": "enrollment.revoked",
                    "enrollment_id": enrollment_id})
    return {"ok": True, "enrollment": row}


@app.get("/api/executors/{executor_id}")
async def get_executor(executor_id: str) -> ExecutorOut:
    """One registry row — OPEN read, the same boundary as GET /api/executors
    (the cluster ingress is the auth boundary); unknown id → 404. The answer
    is the SAME _executor_public projection as the list — secret_hash never
    leaves the store, presence is computed from last_seen on read.

    Declared AFTER the literal /api/executors/enrollment routes (FastAPI
    matches in declaration order): "enrollment" must keep resolving to the
    token list, never as an executor id."""
    row = store.get_executor(executor_id)
    if row is None:
        raise HTTPException(404, f"executor {executor_id} not found")
    return _executor_public(row)


@app.post("/api/executors/{executor_id}/heartbeat")
async def executor_heartbeat(executor_id: str,
                             request: Request) -> ExecutorStateChangeOut:
    """Executor presence tick (idle poller liveness; assignment heartbeats
    piggyback separately in the assignment routes). EXECUTOR-token class:
    the URL id must equal the token-backed executor — a mismatch is 403
    (identity error), which also means an unknown id never 404s here.
    Pending executors MAY tick (the owner sees liveness before approving);
    revoked may not (kill-switch — presence must decay to offline). Own
    rate budget 60/60 s. NO SSE: per-heartbeat events are forbidden (§11)
    — clients render age from GET + a local 1 Hz ticker."""
    executor = _authenticate_executor(request)
    if executor is None:
        raise HTTPException(401, "executor token required")
    if executor["id"] != executor_id:
        raise HTTPException(
            403, "heartbeat executor does not match the token identity")
    if executor["state"] == "revoked":
        raise HTTPException(403, "executor is revoked")
    client_ip = request.client.host if request.client else "unknown"
    if not _executor_heartbeat_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"executor heartbeat rate limit exceeded "
            f"({_EXECUTOR_HEARTBEAT_RATE_LIMIT} per "
            f"{_EXECUTOR_HEARTBEAT_RATE_WINDOW:.0f}s per client)",
        )
    store.touch_executor_last_seen(executor_id)
    fresh = store.get_executor(executor_id)
    return {"ok": True, "executor": _executor_public(fresh or executor)}


@app.patch("/api/executors/{executor_id}")
async def patch_executor(executor_id: str, body: ExecutorPatch,
                         request: Request) -> ExecutorStateChangeOut:
    """Owner PATCH (ui-token): approve (state=approved), revoke
    (state=revoked — terminal kill-switch; re-register to revive), rename,
    owner-declared capabilities, enabled (routing kill-switch). Audit
    old→new lands in the board events (executor.approved / revoked /
    updated); SSE carries executor.updated with the registry
    prev_state→state. Idempotent: a no-op PATCH emits nothing."""
    _guard_ui_write(request)
    try:
        row, changes = store.update_executor(
            executor_id, body.model_dump(exclude_none=True), actor="owner")
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except ExecutorError as exc:
        raise _executor_http(exc) from exc
    if changes:
        prev_state = changes.get("state", [row["state"]])[0]
        _broadcast({"kind": "executor.updated",
                    "executor": _executor_public(row),
                    "prev_state": prev_state, "state": row["state"]})
    return {"ok": True, "executor": _executor_public(row)}


@app.delete("/api/executors/{executor_id}")
async def delete_executor(executor_id: str, request: Request) -> OkOut:
    """Remove a registry record (ui-token). Active assignments are NOT
    touched: executor pins and claimed_by_executor attribution strings
    stay verbatim — the assignment lifecycle is independent of the
    registry (two-clock discipline, Amd 2 §3)."""
    _guard_ui_write(request)
    row = store.delete_executor(executor_id)
    if row is None:
        raise HTTPException(404, f"executor {executor_id} not found")
    _presence_emitted.pop(row["id"], None)
    _notify_and_broadcast(
        "system", f"Исполнитель {row['name']} удалён", "", None,
        {"kind": "executor.deleted", "executor": _executor_public(row),
         "prev_state": row["state"], "state": row["state"]},
    )
    return {"ok": True}


# ----------------------------------------- harness dictionary (wave 3C)
# The owner-managed nomination registry (design 2026-09-22 §C) that replaced
# the closed KNOWN_HARNESSES gate (the constant survives as the SEED).
# Nomination hygiene lives HERE — every gate (registration, enrollment hint,
# assignment create, automation payloads, rule conditions) reads the table —
# while launching stays gated by the poller's local allowlist (A3): adding
# "myagent" only lets the owner NOMINATE it, no poller will ever run it
# until its own config says so. GET is an open read (a dictionary, same
# boundary as GET /api/executors); POST/DELETE are ui-token.
@app.get("/api/harnesses")
async def list_harnesses() -> HarnessListOut:
    """The harness dictionary (open read). ``meta.seed_min_count`` is the
    size of the boot seed — clients learn the guaranteed minimum and never
    hardcode the set. Alphabetical; ``added_via`` distinguishes ``seed``
    rows from owner-added ones."""
    rows = store.list_harnesses()
    return {
        "ok": True,
        "count": len(rows),
        "items": rows,
        "meta": {"seed_min_count": len(Store.KNOWN_HARNESSES)},
    }


@app.post("/api/harnesses", status_code=201)
async def create_harness(body: HarnessCreateBody,
                         request: Request) -> HarnessStateOut:
    """Add a harness to the dictionary (ui-token; wave 3C). 201 → row;
    422 invalid name (``^[a-z0-9][a-z0-9._-]{0,59}$``) or dictionary cap
    (≤64 — entry validation, not a rate guard); 409 duplicate. Audit
    ``harness.added`` + SSE — the UI select refreshes from the frame."""
    _guard_ui_write(request)
    client_ip = request.client.host if request.client else "unknown"
    if not _harness_write_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"harness dictionary rate limit exceeded "
            f"({_HARNESS_WRITE_RATE_LIMIT} per "
            f"{_HARNESS_WRITE_RATE_WINDOW:.0f}s per client)",
        )
    try:
        row = store.add_harness(body.name, body.note)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except HarnessError as exc:
        raise _harness_http(exc) from exc
    _broadcast({"kind": "harness.added", "harness": row})
    return {"ok": True, "harness": row}


@app.delete("/api/harnesses/{name}")
async def delete_harness(name: str, request: Request) -> OkOut:
    """Remove a harness from the dictionary (ui-token; wave 3C). 404
    unknown; 409 while the name is LIVE anywhere an executor could act on
    it — a registered executor, a non-terminal assignment or an automation
    rule (schedule field / hook condition). Terminal history does NOT
    block: it is archival and stays verbatim. Audit ``harness.removed`` +
    SSE. Seed rows are deletable like any other (the seed does not
    resurrect across restarts — it fills an EMPTY table only)."""
    _guard_ui_write(request)
    client_ip = request.client.host if request.client else "unknown"
    if not _harness_write_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"harness dictionary rate limit exceeded "
            f"({_HARNESS_WRITE_RATE_LIMIT} per "
            f"{_HARNESS_WRITE_RATE_WINDOW:.0f}s per client)",
        )
    try:
        row = store.delete_harness(name)
    except HarnessError as exc:
        raise _harness_http(exc) from exc
    _broadcast({"kind": "harness.removed", "name": row["name"]})
    return {"ok": True}


# --------------------------------------- provisioner (wave 4, blocks A/B/D)
# Variant α: the BOARD drives an install-time SSH job to run the frozen
# bootstrap one-liner on the remote machine. Security posture (design
# review): one global active-job cap (2) + one active job per host:port +
# a per-host cooldown + a dedicated rate limit tighter than the ui one;
# password auth is a deployment flag (default OFF); the enrollment token
# and the ssh secret are TRANSIT-ONLY (worker task context, never SQLite/
# logs/SSE); host keys are TOFU+pin with re-pin as a separate owner act.
_PROVISION_RATE_LIMIT = 5        # creations per client ...
_PROVISION_RATE_WINDOW = 60.0    # ... per sliding minute (tighter than ui)
_provision_limiter = RateLimiter(
    limit=_PROVISION_RATE_LIMIT, window=_PROVISION_RATE_WINDOW)
_PROVISION_COOLDOWN_S = 90.0     # per host:port
_PROVISION_ACTIVE_CAP = 2        # global active jobs
_PROVISION_BOARD_URL_RE = re.compile(r"^https://[A-Za-z0-9.-]+(:\d{1,5})?$")


def _created_ts(iso: str) -> float:
    """Epoch seconds of a stored UTC ISO timestamp. P3: the old
    mktime(timezone double-correction) math drifted on any non-UTC host
    (cooldown age went negative — the gate silently disarmed).
    fromisoformat is offset-aware and host-TZ neutral."""
    try:
        return datetime.fromisoformat(iso).timestamp()
    except (ValueError, TypeError):
        return 0.0


def _provisioner_enabled() -> bool:
    return os.environ.get("VESMARO_PROVISIONER_ENABLED", "1") == "1"


def _provision_password_auth() -> bool:
    return os.environ.get("VESMARO_PROVISION_PASSWORD_AUTH", "0") == "1"


@app.post("/api/executors/provision", status_code=202)
async def provision_executor(body: ProvisionBody,
                             request: Request) -> ProvisionCreatedOut:
    """Queue an install-time provisioning job (ui-token; wave 4). 202
    carries the job id and the enrollment id — NEVER the mne_ token (the
    worker consumes it transit-only). Anti-spray: a global cap of 2 live
    jobs, one live job per host:port (409), a 90 s per-host cooldown
    (429), and a dedicated 5/60 s rate limit. password auth answers 422
    while the deployment flag is off."""
    _guard_ui_write(request)
    if not _provisioner_enabled():
        raise HTTPException(
            503, "the provisioner is disabled on this board (fail-closed; "
                 "enable via the chart value provisioner.enabled)")
    if body.auth.kind == "password" and not _provision_password_auth():
        raise HTTPException(
            422, "password ssh auth is disabled on this board (default) — "
                 "use key or alias auth, or enable it via the chart value "
                 "provisioner.passwordAuth")
    client_ip = request.client.host if request.client else "unknown"
    if not _provision_limiter.acquire(client_ip):
        raise HTTPException(429, f"provision rate limit exceeded "
                                 f"({_PROVISION_RATE_LIMIT} per "
                                 f"{_PROVISION_RATE_WINDOW:.0f}s per client)")
    if (body.auth.kind in ("password", "key")
            and not body.auth.secret.strip()):
        raise HTTPException(422, f"{body.auth.kind} auth requires secret")
    # Injection boundary (P1-1): the harness hint feeds the remote command
    # line — validated against the LIVE dictionary on EVERY path here
    # (the reuse_enrollment_id branch never calls create_enrollment, whose
    # allowlist gate is the only other one), before anything is stored.
    harness_hint = body.harness_hint.strip()
    if harness_hint and harness_hint not in store.harness_names():
        raise HTTPException(
            422, f"unknown harness: {harness_hint}; "
                 f"known: {sorted(store.harness_names())}")
    # P1-3: both owner-supplied forms (ssh-keygen base64 AND hex64)
    # normalize to the canonical form the worker compares against — one
    # format everywhere (job row, pins, audit).
    expected_fp = ""
    if body.expected_host_key_fingerprint.strip():
        expected_fp = provisioner_mod.normalize_fingerprint(
            body.expected_host_key_fingerprint)
        if not expected_fp:
            raise HTTPException(
                422, "expected_host_key_fingerprint must be SHA256:base64 "
                     "(ssh-keygen form) or hex sha256")

    host = body.host.strip()
    if live := store.active_job_for_host(host, body.port):
        raise HTTPException(409, f"a provisioning job for {host}:{body.port} "
                                 f"is already live ({live['id']}, {live['state']})")
    if (last := store.last_provision_job_for_host(host, body.port)) is not None:
        age = time.time() - _created_ts(last["created_at"])
        if age < _PROVISION_COOLDOWN_S:
            raise HTTPException(
                429, f"host {host}:{body.port} is in cooldown — retry in "
                     f"{int(_PROVISION_COOLDOWN_S - age)}s")
    if store.count_active_provision_jobs() >= _PROVISION_ACTIVE_CAP:
        raise HTTPException(429, f"the global live-job cap "
                                 f"({_PROVISION_ACTIVE_CAP}) is reached — wait "
                                 "for a job to finish")

    board_url = (body.board_url_for_host.strip()
                 or os.environ.get("VESMARO_PUBLIC_BOARD_URL", "").strip())
    # P1-1: charset-strict URL (no path, no query — the host part rides the
    # command line twice); anything the regex refuses cannot be quoted into
    # an argument boundary anyway, but refusing HERE keeps bad values out of
    # job facts, steps and SSE.
    if not _PROVISION_BOARD_URL_RE.match(board_url):
        raise HTTPException(
            422, "board_url_for_host must be https://host[:port] that "
                 "resolves FROM the target machine (or set "
                 "VESMARO_PUBLIC_BOARD_URL)")

    name = (body.name.strip() or host)
    if not _PROVISION_NAME_RE.match(name):
        # the host-fallback name is charset-covered by the host pattern;
        # this guard keeps an owner-supplied name honest at the boundary
        raise HTTPException(
            422, "name must start with an alphanumeric and contain only "
                 "letters, digits, '.', '_' and '-'")
    # A live enrollment may be reused; otherwise the route mints one
    # ATOMICALLY with the job (the token goes to the worker's transit
    # context, never into the response or the DB).
    if body.reuse_enrollment_id:
        row = store.get_enrollment(body.reuse_enrollment_id.strip())
        if row is None or row.get("state") != "created":
            raise HTTPException(422, "reuse_enrollment_id is not a live token")
        enrollment_id = row["id"]
        mne_token = provisioning.reveal_by_enrollment(enrollment_id)
        if not mne_token:
            raise HTTPException(
                422, "reuse_enrollment_id has no live token material — hash-only "
                     "storage makes UI-minted tokens unreusable; leave the field "
                     "empty to mint a fresh one")
    else:
        try:
            row, mne_token = store.create_enrollment(
                label=f"provision:{host}", harness_hint=harness_hint,
                name_hint=name)
        except EnrollmentQuotaError as exc:
            raise HTTPException(409, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        enrollment_id = row["enrollment_id"]

    # P2-2 (CWE-759): ZERO derivations of the ssh secret in the DB or the
    # API. The old code stored unsalted sha256(password) and returned it
    # to the owner. For key auth the fingerprint of the PUBLIC half is
    # display material (useful, comparable with ssh-keygen -lf).
    if body.auth.kind == "password":
        key_fp = "password"
    elif body.auth.kind == "alias":
        key_fp = "alias:" + host
    else:
        key_fp = provisioner_mod.public_key_fingerprint(
            body.auth.secret, body.auth.passphrase)
    job = store.create_provision_job(
        host=host, port=body.port, auth_kind=body.auth.kind,
        key_fingerprint=key_fp, harness_hint=harness_hint,
        board_url_for_host=board_url, enrollment_id=enrollment_id,
        expected_host_key_fingerprint=expected_fp)
    provisioning.remember(job["id"], enrollment_id, mne_token)
    provisioning.get(store, _broadcast).start_job(provisioner_mod.JobFacts(
        job_id=job["id"], host=host, port=body.port, auth_kind=body.auth.kind,
        secret=provisioner_mod.Redacted(body.auth.secret) if body.auth.secret else None,
        passphrase=(provisioner_mod.Redacted(body.auth.passphrase)
                    if body.auth.passphrase else None),
        username="", harness_hint=harness_hint,
        enrollment_id=enrollment_id, executor_name=name, board_url=board_url,
        bootstrap_token=provisioner_mod.Redacted(mne_token),
        expected_host_key_fingerprint=expected_fp))
    _notify_and_broadcast(
        "system", f"Подключение {host}:{body.port} запущено",
        f"provision job {job['id']} ({body.auth.kind})",
        None, {"kind": "provisioning.created", "job_id": job["id"],
               "host": host, "port": body.port,
               "enrollment_id": enrollment_id})
    return {"ok": True, "job_id": job["id"], "enrollment_id": enrollment_id,
            "state": job["state"]}


@app.get("/api/executors/provision/{job_id}")
async def provision_job_status(job_id: str, request: Request) -> ProvisionJobOut:
    """Job progress for the owner UI (ui-token): state, steps, the pinned
    host-key fingerprint and the linked enrollment. No secrets travel."""
    _guard_ui_write(request)
    row = store.get_provision_job(job_id)
    if row is None:
        raise HTTPException(404, f"provision job {job_id} not found")
    enrollment: dict[str, Any] = {}
    if row["enrollment_id"]:
        erow = store.get_enrollment(row["enrollment_id"])
        if erow is not None:
            enrollment = {"state": erow["state"], "expires_at": erow["expires_at"],
                          "executor_id": erow.get("executor_id", "")}
    return {"ok": True, "job": row, "enrollment": enrollment}


@app.post("/api/executors/provision/host/{host}/repin")
async def provision_repin(host: str, body: HostRepinBody, request: Request,
                          port: int = Query(default=22, ge=1, le=65535)) -> OkOut:
    """Re-pin a host key (ui-token): a separate OWNER action with the
    old→new pair in the audit (provisioning.host_key_repinned). Use after
    a deliberate host reinstall — never to silence a mismatch. P2-1: the
    pin identity is (host, port); live jobs of that identity are failed
    (pin.invalidated) — they were authenticating against the old pin."""
    _guard_ui_write(request)
    if not _PROVISION_HOST_RE.match(host):
        # P1-1 charset gate: the host rides audit payloads and SSE frames
        raise HTTPException(422, "host must be a lowercase FQDN/IP name")
    # P1-3: same normalization as strict mode — hex64 input becomes the
    # canonical ssh-keygen form before it lands in the pin table.
    fp = provisioner_mod.normalize_fingerprint(body.fingerprint)
    if not fp:
        raise HTTPException(
            422, "fingerprint must be SHA256:base64 (ssh-keygen form) or "
                 "hex sha256")
    old = store.get_host_pin(host, port)
    store.set_host_pin(host, port, fp)
    store.log_board_event("provisioning.host_key_repinned", {
        "host": host, "port": port,
        "old": old["fingerprint"] if old else "",
        "new": fp,
    })
    invalidated = store.fail_live_provision_jobs_for_host(
        host, port, "pin.invalidated")
    for row in invalidated:
        _broadcast({"kind": "provisioning.failed", "job_id": row["id"],
                    "error_code": "pin.invalidated"})
    _broadcast({"kind": "provisioning.repinned", "host": host, "port": port,
                "fingerprint": fp})
    return {"ok": True}


# ------------------------------------- poller bootstrap (wave 3D, design §D)
# The ONE-COMMAND onboarding: the board serves its own installer and the
# runtime artifacts it needs, straight from the packaged files — always in
# sync with the RUNNING board (no version skew; the snapshot-discipline
# answer to installer staleness). All four routes are OPEN READS (the
# script and the artifacts carry NO secret material — the enrollment token
# travels as a command ARGUMENT typed on the VPS, never in a URL:
# ADR 0012 §9). Cache-Control: no-store rides the global /api/* middleware.
#
#   bootstrap.sh   — deploy/poller/bootstrap.sh in the repo;
#   poller.py      — scripts/assignment_poller.py in the repo;
#   the unit       — deploy/poller/vesmaro-assignment-poller.service;
#   ca.crt         — the lab CA (the self-signed leaf cert IS its own
#                    anchor). It is PUBLIC material, but it does not live in
#                    the image: TLS terminates on the ingress (traefik) and
#                    the cert lives in the k8s secret `vesmaro-eyes-tls`.
#                    The chart mounts the PUBLIC tls.crt into the container
#                    (see values `pollerBootstrap.caFile`) and points
#                    VESMARO_TLS_CA_FILE at it. Without the mount the route
#                    answers an HONEST 503 with the fix in the message —
#                    fail-closed, never a guess.
#
# Resolution order for the packaged dir: VESMARO_POLLER_DIR (the image
# keeps /app/poller) first; the repo layout second (dev/tests run from a
# checkout where the artifacts live under scripts/ and deploy/poller/).
_POLLER_DIR_ENV = "VESMARO_POLLER_DIR"
_TLS_CA_FILE_ENV = "VESMARO_TLS_CA_FILE"


def _poller_artifact(filename: str) -> Path | None:
    """Resolve a served bootstrap artifact to an existing file, or None."""
    env_dir = os.environ.get(_POLLER_DIR_ENV, "").strip()
    candidates: list[Path] = []
    if env_dir:
        candidates.append(Path(env_dir) / filename)
    else:  # dev/tests: the repo layout
        repo = Path(__file__).resolve().parents[1]
        candidates.append(repo / "deploy" / "poller" / filename)
        if filename == "assignment_poller.py":
            candidates.append(repo / "scripts" / filename)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def _serve_artifact(filename: str, media_type: str) -> Response:
    path = _poller_artifact(filename)
    if path is None:
        raise HTTPException(
            404,
            f"bootstrap artifact {filename!r} is not packaged on this board "
            f"(set {_POLLER_DIR_ENV} to the packaged dir)",
        )
    return Response(content=path.read_bytes(), media_type=media_type)


@app.get("/api/poller/bootstrap.sh")
async def poller_bootstrap_script() -> Response:
    """The one-command installer (open read). Served from the packaged
    file — the script carries NO secrets: the enrollment token arrives as
    a CLI argument on the VPS, everything else rides pinned TLS."""
    return _serve_artifact("bootstrap.sh", "text/x-shellscript; charset=utf-8")


@app.get("/api/poller/artifacts/bootstrap.sh.sha256")
async def poller_bootstrap_script_sha256() -> Response:
    """SHA256 (hex) of the EXACT installer bytes the sibling route serves
    (AGW-9, АРХКОМ-8 В1): out-of-band verification of the installer TEXT
    for the paranoid two-step (fetch, verify, read, run). Same resolution
    order as /api/poller/bootstrap.sh — the hash can never describe a
    different file than the one downloadable next to it. Open read: a
    digest of a secret-free script is not secret material."""
    path = _poller_artifact("bootstrap.sh")
    if path is None:
        raise HTTPException(
            404,
            f"bootstrap artifact 'bootstrap.sh' is not packaged on this "
            f"board (set {_POLLER_DIR_ENV} to the packaged dir)",
        )
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return Response(content=digest + "\n",
                    media_type="text/plain; charset=utf-8")


@app.get("/api/poller/artifacts/poller.py")
async def poller_artifact_poller_py() -> Response:
    """The poller itself, always fresh from the RUNNING board — installer
    re-run doubles as upgrade (no version skew between board and poller)."""
    return _serve_artifact("assignment_poller.py", "text/x-python; charset=utf-8")


@app.get("/api/poller/artifacts/vesmaro-assignment-poller.service")
async def poller_artifact_unit() -> Response:
    """The systemd system unit (the bootstrap adapts User/config paths to
    the target machine with sed — the artifact stays verbatim in the repo)."""
    return _serve_artifact(
        "vesmaro-assignment-poller.service", "text/plain; charset=utf-8"
    )


@app.get("/api/poller/artifacts/ca.crt")
async def poller_artifact_ca() -> Response:
    """The lab CA for pinning (open read — a certificate is public
    material). 503 while the CA file is not mounted: the chart ships the
    optional mount (values `pollerBootstrap.caFile`); the honest refusal
    names the fix instead of serving a guess."""
    ca_file = os.environ.get(_TLS_CA_FILE_ENV, "").strip()
    if not ca_file:
        raise HTTPException(
            503,
            f"the lab CA is not mounted into this container — mount the "
            f"PUBLIC tls.crt of the board TLS secret and point "
            f"{_TLS_CA_FILE_ENV} at it (chart values "
            f"pollerBootstrap.caFile; see deploy/poller/REMOTE-EXECUTOR.md)",
        )
    path = Path(ca_file)
    if not path.is_file():
        raise HTTPException(
            503,
            f"{_TLS_CA_FILE_ENV}={ca_file} does not exist — fix the mount "
            f"or unset the variable (fail-closed: no CA, no download)",
        )
    data = path.read_bytes()
    # A mispointed variable must not leak an arbitrary file to anonymous
    # readers: only a PEM certificate is servable here.
    if not data.lstrip().startswith(b"-----BEGIN CERTIFICATE-----"):
        raise HTTPException(
            503,
            f"{_TLS_CA_FILE_ENV}={ca_file} is not a PEM certificate — "
            f"refusing to serve it (fail-closed: this route serves "
            f"certificates only)",
        )
    return Response(content=data, media_type="application/x-x509-ca-cert")


# ------------------------------------- execution settings (ARCH-9, Amd 2 §5)
_PROJECT_SCOPE_RE = re.compile(r"^project:[a-z0-9][a-z0-9_-]{0,63}$")


def _execution_settings_keys(scope: str) -> tuple[str, str]:
    """scope → (board_meta default key, fallback key). Global scope keeps
    the fallback; project scope reserves defaults only (one global default
    + one fallback per the АРХКОМ-4 resolution). Raises 422 on garbage."""
    scope = scope.strip()
    if not scope:
        return "default_executor", "default_executor_fallback"
    if not _PROJECT_SCOPE_RE.match(scope):
        raise HTTPException(
            422, f"invalid scope: {scope!r} (use '' for global or "
                 "'project:<slug>')")
    return f"default_executor:{scope}", ""


def _validate_default_executor(executor_id: str) -> None:
    """Amd 2 §5 gates: a default must exist, be approved, enabled, have a
    LIVE heartbeat (presence online at set time) and travel local-poll —
    remote executors are dispatch-ineligible until R4."""
    row = store.get_executor(executor_id)
    if row is None:
        raise HTTPException(422, f"unknown executor: {executor_id}")
    if row["state"] != "approved":
        raise HTTPException(
            422, f"executor {executor_id} is {row['state']} — a default "
                 "must be approved")
    if not row["enabled"]:
        raise HTTPException(
            422, f"executor {executor_id} is disabled — a default must be "
                 "enabled")
    if presence_from_last_seen(row["last_seen"]) != "online":
        raise HTTPException(
            422, f"executor {executor_id} has no live heartbeat — a "
                 "default requires current presence (online)")
    if row["transport"] != "local-poll":
        raise HTTPException(
            422, f"executor {executor_id} is {row['transport']} — remote "
                 "executors are ineligible as defaults until R4")


@app.get("/api/settings/execution")
async def get_execution_settings() -> ExecutionSettingsOut:
    """Read the default-executor resolution settings (OPEN read — ids
    only, no secrets; the chain itself is computed per GET on
    /api/assignments)."""
    return {
        "ok": True,
        "default_executor": store.get_meta("default_executor") or "",
        "fallback_executor": store.get_meta("default_executor_fallback") or "",
        "scope": "",
    }


@app.put("/api/settings/execution")
async def put_execution_settings(body: ExecutionSettingsBody,
                                 request: Request) -> ExecutionSettingsOut:
    """Set the default / fallback executor (UI-token only — Amd 2 §5
    gates, see _validate_default_executor). Empty string clears a slot.
    Audit: default.changed old→new per field (actor = the ui-token class).
    ``scope`` reserves project defaults (board_meta
    ``default_executor:project:<slug>``); the fallback is global-scope
    only. The fallback does NOT join the GET routing chain — it is the
    UI's no-silent-substitution preview value; dispatch stays explicit."""
    _guard_ui_write(request)
    default_key, fallback_key = _execution_settings_keys(body.scope)
    if body.fallback_executor and not fallback_key:
        raise HTTPException(
            422, "fallback executor is global-scope only")
    if body.default_executor:
        _validate_default_executor(body.default_executor)
    if body.fallback_executor:
        _validate_default_executor(body.fallback_executor)
    old_default = store.get_meta(default_key) or ""
    old_fallback = (store.get_meta(fallback_key) or "") if fallback_key else ""
    changes: dict[str, list[str]] = {}
    if body.default_executor != old_default:
        changes["default_executor"] = [old_default, body.default_executor]
    if fallback_key and body.fallback_executor != old_fallback:
        changes["fallback_executor"] = [old_fallback, body.fallback_executor]
    if changes:
        store.set_meta(default_key, body.default_executor)
        if fallback_key:
            store.set_meta(fallback_key, body.fallback_executor)
        store.log_board_event("default.changed", {
            "actor": "owner", "scope": body.scope.strip(),
            "changes": changes})
    return {
        "ok": True,
        "default_executor": body.default_executor,
        "fallback_executor": body.fallback_executor,
        "scope": body.scope.strip(),
    }


# --------------------------------------- automation (SCHED-1 S1, ADR 0013)
# Contracts WITHOUT an engine: rule CRUD + journal + manual «Запустить
# сейчас» + status/settings. NO loops, NO ECA, NO tick, NO missed-detection
# — all of that is S2 behind the T2 gate (ADR 0013 §5). Mutations are
# ui-token class (the owner's domain), house rate budget 10/60 s.
_AUTOMATION_RATE_LIMIT = 10        # mutations per client ...
_AUTOMATION_RATE_WINDOW = 60.0     # ... per sliding window (seconds)
_automation_limiter = RateLimiter(
    limit=_AUTOMATION_RATE_LIMIT, window=_AUTOMATION_RATE_WINDOW)
_AUTOMATION_PAGE_CAP = 200         # journal page cap; above → truncated


def _automation_rate_limit(request: Request) -> None:
    client_ip = request.client.host if request.client else "unknown"
    if not _automation_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"automation rate limit exceeded "
            f"({_AUTOMATION_RATE_LIMIT} per {_AUTOMATION_RATE_WINDOW:.0f}s "
            "per client)",
        )


def _automation_http(exc: AutomationError) -> HTTPException:
    """Map store automation errors onto HTTP: 404 unknown rule id / 422
    contract violation (incl. duplicate names — S1 AC) / 409 defensive."""
    if isinstance(exc, RuleNotFoundError):
        return HTTPException(404, str(exc))
    if isinstance(exc, AutomationValidationError):
        return HTTPException(422, str(exc))
    return HTTPException(409, str(exc))


def _encode_launch_cursor(offset: int) -> str:
    payload = json.dumps({"v": 1, "offset": offset}, separators=(",", ":"))
    return base64.urlsafe_b64encode(payload.encode("utf-8")).decode("ascii")


def _decode_launch_cursor(cursor: str) -> int:
    """Opaque cursor → journal offset. 422 on anything this server did not
    issue (garbage base64/JSON, wrong version, negative/non-int offset)."""
    try:
        data = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
    except (ValueError, UnicodeEncodeError):
        raise HTTPException(422, "invalid cursor") from None
    offset = data.get("offset") if isinstance(data, dict) else None
    if (not isinstance(data, dict) or data.get("v") != 1
            or not isinstance(offset, int) or isinstance(offset, bool)
            or offset < 0):
        raise HTTPException(422, "invalid cursor")
    return offset


def _broadcast_rule_event(kind: str, rule_kind: str, rule: dict[str, Any],
                          changes: dict[str, Any] | None = None) -> None:
    """automation.rule.* SSE (ui-contract §11 reserve, S1 emitters live in
    the CRUD routes). One event per mutation; clients treat the family as
    a single list-sync signal (АРХКОМ-5 FE verdict)."""
    event: dict[str, Any] = {"kind": kind, "rule_kind": rule_kind,
                             "rule": rule}
    if changes is not None:
        event["changes"] = changes
    _broadcast(event)


@app.get("/api/automation/schedules")
async def automation_schedules() -> SchedulesOut:
    """List schedule rules (OPEN read — same boundary as GET /api/board;
    the cluster ingress is the auth boundary). Soft-deleted rules stay
    listed with enabled=false (retention, ADR 0013 §2)."""
    items = store.list_schedules()
    return {"ok": True, "count": len(items), "items": items}


@app.post("/api/automation/schedules", status_code=201)
async def automation_create_schedule(body: ScheduleCreate,
                                    request: Request) -> ScheduleOut:
    """Create a schedule (ui-token, 10/60 s). Creation is DISABLED —
    enablement is a separate audited PATCH (rule.toggled). next_run_at is
    computed server-side from now; a client value is ignored. 422 on
    contract violations (unknown harness/target_kind, interval < 60 s,
    bad 'HH:MM'/ISO-duration, duplicate name); never on task existence —
    assignability belongs to fire time (SCHED-1 Н2)."""
    _guard_ui_write(request)
    _automation_rate_limit(request)
    try:
        rule = store.create_schedule(body.model_dump(), actor="owner")
    except AutomationError as exc:
        raise _automation_http(exc) from exc
    _broadcast_rule_event("automation.rule.created", "schedule", rule)
    return rule


@app.patch("/api/automation/schedules/{rule_id}")
async def automation_patch_schedule(rule_id: int, body: SchedulePatch,
                                    request: Request) -> ScheduleOut:
    """PATCH a schedule (ui-token). Every effective patch recomputes
    next_run_at from now (schedule clock is server-owned). A pure
    {enabled} flip is audited as rule.toggled — the per-rule kill-switch;
    anything else is rule.updated (old→new in the audit trail). Idempotent
    no-op patches emit nothing."""
    _guard_ui_write(request)
    _automation_rate_limit(request)
    patch = body.model_dump(exclude_none=True)
    try:
        rule, changes = store.update_schedule(
            rule_id, patch, actor="owner")
    except AutomationError as exc:
        raise _automation_http(exc) from exc
    if changes:
        kind = ("automation.rule.toggled" if set(patch) == {"enabled"}
                else "automation.rule.updated")
        _broadcast_rule_event(kind, "schedule", rule, changes)
    return rule


@app.delete("/api/automation/schedules/{rule_id}")
async def automation_delete_schedule(rule_id: int,
                                     request: Request) -> RuleDeletedOut:
    """DELETE = soft-disable retention (ADR 0013 §2): the row is never
    destroyed, the rule stays listed with enabled=false and its UNIQUE
    name keeps holding (rename or re-enable via PATCH). Audited as
    rule.deleted old→new."""
    _guard_ui_write(request)
    _automation_rate_limit(request)
    try:
        rule = store.delete_schedule(rule_id, actor="owner")
    except AutomationError as exc:
        raise _automation_http(exc) from exc
    _broadcast_rule_event(
        "automation.rule.deleted", "schedule", rule,
        {"enabled": [True, False]})
    return {"ok": True, "note": "soft-disabled and retained (retention)"}


@app.post("/api/automation/schedules/{rule_id}/run")
async def automation_run_schedule(rule_id: int,
                                  request: Request) -> ScheduleRunOut:
    """«Запустить сейчас» — the MANUAL trigger (ADR 0013 §2: not T2; the
    owner's hand, not the engine).

    Synchronous: the response carries the decision and the assignment id.
    The assignment is created through the same code path as POST
    /api/assignments with created_by='owner' (manual = ui-token action,
    NOT automation); budgets and the global kill-switch do NOT apply. The
    create gates translate honestly: 404 unknown task, 422 archived/
    terminal, 409 while an active assignment holds the task (≤1
    invariant) — a journal skipped(reason) row is written for every
    refused attempt. The launches row is trigger='manual', origin='ui',
    run_at = click time (+1 s walk on a same-second collision — the S2
    occurrence key is shared, not forked). Works on disabled rules: the
    per-rule kill-switch stops the engine, not the owner (manual run-now
    is the conscious replacement for missed occurrences, ADR §4).

    SSE: assignment.created via the standard notification path — and
    deliberately NO scheduler.launched (this is not automation)."""
    _guard_ui_write(request)
    _automation_rate_limit(request)
    try:
        result = store.run_schedule_now(rule_id)
    except AutomationError as exc:
        raise _automation_http(exc) from exc
    except AssignmentError as exc:
        raise _assignment_http(exc) from exc
    a = result["assignment"]
    _notify_and_broadcast(
        "work", f"{a['task_id']}: запуск по правилу «{result['rule_name']}»",
        f"специалист {a['specialist']}, harness {a['harness']}",
        a["task_id"],
        {"kind": "assignment.created",
         "assignment": _assignment_public(a), "task_id": a["task_id"]},
    )
    return {"ok": True, "decision": "launched", "reason": "",
            "assignment_id": a["id"], "launch_id": result["launch_id"],
            "run_at": result["run_at"]}


@app.get("/api/automation/hooks")
async def automation_hooks() -> HooksOut:
    """List hook rules (OPEN read; retention semantics as schedules)."""
    items = store.list_hooks()
    return {"ok": True, "count": len(items), "items": items}


@app.post("/api/automation/hooks", status_code=201)
async def automation_create_hook(body: HookCreate,
                                 request: Request) -> HookOut:
    """Create a hook (ui-token). ``on`` is validated against the server
    constant HOOK_EVENT_WHITELIST (automation.* and heartbeats are
    structurally absent); condition fields/ops/values against the closed
    allowlist (422 at CRUD time, never at fire time); source_allowlist
    defaults by action — notify hears everything except automation,
    create_assignment only ui/server (machine = explicit audited opt-in).
    Creation is disabled; enablement is a separate PATCH."""
    _guard_ui_write(request)
    _automation_rate_limit(request)
    try:
        rule = store.create_hook(body.model_dump(), actor="owner")
    except AutomationError as exc:
        raise _automation_http(exc) from exc
    _broadcast_rule_event("automation.rule.created", "hook", rule)
    return rule


@app.patch("/api/automation/hooks/{rule_id}")
async def automation_patch_hook(rule_id: int, body: HookPatch,
                                request: Request) -> HookOut:
    """PATCH a hook (ui-token). Changing ``action`` without an explicit
    ``source_allowlist`` resets the list to the new action's default (А-1:
    a machine-origin list must not silently survive under
    create_assignment). rule.toggled / rule.updated audit as schedules."""
    _guard_ui_write(request)
    _automation_rate_limit(request)
    patch = body.model_dump(exclude_none=True)
    try:
        rule, changes = store.update_hook(rule_id, patch, actor="owner")
    except AutomationError as exc:
        raise _automation_http(exc) from exc
    if changes:
        kind = ("automation.rule.toggled" if set(patch) == {"enabled"}
                else "automation.rule.updated")
        _broadcast_rule_event(kind, "hook", rule, changes)
    return rule


@app.delete("/api/automation/hooks/{rule_id}")
async def automation_delete_hook(rule_id: int,
                                 request: Request) -> RuleDeletedOut:
    """DELETE = soft-disable retention (same semantics as schedules)."""
    _guard_ui_write(request)
    _automation_rate_limit(request)
    try:
        rule = store.delete_hook(rule_id, actor="owner")
    except AutomationError as exc:
        raise _automation_http(exc) from exc
    _broadcast_rule_event(
        "automation.rule.deleted", "hook", rule, {"enabled": [True, False]})
    return {"ok": True, "note": "soft-disabled and retained (retention)"}


@app.get("/api/automation/launches")
async def automation_launches(
    rule_id: int | None = None,
    kind: str = "",
    decision: str = "",
    limit: int = Query(50, ge=1),
    cursor: str = "",
) -> LaunchesOut:
    """Launch journal page (OPEN read; append-only). Uniform cursor
    contract (ADR 0011 §11): ``limit`` (default 50, hard cap 200) + opaque
    ``cursor`` → ``next_cursor``; sort ``attempted_at DESC`` with the
    unique ``id`` tiebreak; ``truncated`` is true only when the request
    limit was silently capped. Filters: rule_id, kind (schedule|hook),
    decision (launched|skipped|missed) — 422 on garbage; a cursor is only
    valid for the parameters it was issued with."""
    if kind and kind not in ("schedule", "hook"):
        raise HTTPException(422, f"invalid kind: {kind}")
    if decision and decision not in ("launched", "skipped", "missed"):
        raise HTTPException(422, f"invalid decision: {decision}")
    truncated = limit > _AUTOMATION_PAGE_CAP
    limit = min(limit, _AUTOMATION_PAGE_CAP)
    offset = _decode_launch_cursor(cursor) if cursor else 0
    rows, total = store.automation_launches(
        rule_id=rule_id, kind=kind or None, decision=decision or None,
        limit=limit, offset=offset)
    next_cursor = (_encode_launch_cursor(offset + len(rows))
                   if offset + len(rows) < total else None)
    return {"ok": True, "count": len(rows), "total": total, "items": rows,
            "next_cursor": next_cursor, "truncated": truncated}


@app.get("/api/automation/status")
async def automation_status() -> AutomationStatusOut:
    """Engine/caps/condition-meta projection (OPEN read — the UI status
    banner source). ``engine`` is a CONSTANT false in S1: the scheduler
    loop does not exist in this build (ADR 0013 §2 — contracts only).
    ``daily_used`` counts non-manual launches today (provably 0 in S1,
    computed honestly so S2 keeps the reader). ``condition_meta`` is the
    meta-dictionary the condition form is built from — the Frontend
    blocker: fields/ops/values come from the server, never hardcoded."""
    settings = store.automation_settings()
    schedules = store.list_schedules()
    hooks = store.list_hooks()
    return {
        "ok": True,
        "engine": False,
        "global_kill_switch": settings["enabled"],
        "daily_cap": settings["cap_global_per_day"],
        "daily_used": store.automation_daily_used(),
        "condition_meta": store.automation_condition_meta(),
        "rules": {
            "schedules": {"total": len(schedules),
                          "enabled": sum(1 for r in schedules if r["enabled"])},
            "hooks": {"total": len(hooks),
                      "enabled": sum(1 for r in hooks if r["enabled"])},
        },
    }


@app.get("/api/automation/settings")
async def automation_get_settings() -> AutomationSettingsOut:
    """Read the global kill-switch + daily cap (OPEN read — ids and flags
    only, no secrets)."""
    s = store.automation_settings()
    return {"ok": True, "enabled": s["enabled"],
            "cap_global_per_day": s["cap_global_per_day"]}


@app.put("/api/automation/settings")
async def automation_put_settings(body: AutomationSettingsBody,
                                  request: Request) -> AutomationSettingsOut:
    """Set the kill-switch / daily cap (ui-token, audited old→new as
    automation.settings.changed). In S1 flipping ``enabled`` is INERT
    data — no engine exists to kill; the flag is the persistent owner
    opt-in the S2 loop will read at boot (default false, C-1)."""
    _guard_ui_write(request)
    _automation_rate_limit(request)
    try:
        settings, changes = store.set_automation_settings(
            enabled=body.enabled,
            cap_global_per_day=body.cap_global_per_day,
            actor="owner")
    except AutomationError as exc:
        raise _automation_http(exc) from exc
    return {"ok": True, "enabled": settings["enabled"],
            "cap_global_per_day": settings["cap_global_per_day"]}


# --------------------------------------------------------- task inbox (AGG-1)
# Mirror of task:queue memories from every active memory server, refreshed
# by the background scanner (task_inbox.background_refresher) or on demand
# via POST /api/tasks/inbox/refresh. Queue-memories are DATA (SEC-4): the
# mirror stores title/excerpt/tags only and never treats content as
# instructions.
_INBOX_REFRESH_RATE_LIMIT = 5   # requests per client ...
_INBOX_REFRESH_RATE_WINDOW = 60.0  # ... per sliding window (seconds)
_inbox_refresh_limiter = RateLimiter(
    limit=_INBOX_REFRESH_RATE_LIMIT, window=_INBOX_REFRESH_RATE_WINDOW)


@app.get("/api/tasks/inbox")
async def tasks_inbox(scope: str = "all", project: str = "",
                      include_adopted: bool = False) -> TaskInboxOut:
    """AGG-1 inbox: task:queue records mirrored from active memory servers.

    - dedup (unconditional): records whose memory_id is linked from ANY
      native task's memory_ids (bulk import included) never appear here;
    - ``scope``: 'all' or one source server name; ``project``: exact match;
    - ``include_adopted``: re-include rows that already produced a native
      task (hidden by default);
    - ``stale``: the source server stopped returning the record (last_seen
      older than 30 min);
    - ``refreshed_at``: timestamp of the last completed scan (board_meta).
    """
    items = store.list_inbox(scope=scope, project=project,
                             include_adopted=include_adopted)
    return TaskInboxOut(
        items=[TaskInboxItem(**i) for i in items],
        count=len(items),
        refreshed_at=store.inbox_refreshed_at(),
    )


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str) -> TaskOut:
    """Task detail by id (BE-16): one handler for BOTH active and archived
    tasks. The store keeps them in a single ``tasks`` table split only by
    the ``archived`` flag and ``store.task`` applies no archived filter, so
    the response shape never diverges from the board/PATCH TaskOut — the
    SPA may drop its archive-list probe (UI-18 pair 4) without adding a
    single conditional beyond 404. Read-only: covered by the global device
    read wildcard (``GET /api/tasks*``) and, like every other task read,
    open without a token; DELETE hard-deny and archive/unarchive mutations
    are untouched. Registered AFTER ``GET /api/tasks/inbox`` on purpose:
    FastAPI matches routes in registration order and ``{task_id}`` would
    otherwise swallow the static inbox path."""
    task = store.task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    return task


@app.post("/api/tasks/inbox/refresh")
async def tasks_inbox_refresh(request: Request) -> TaskInboxRefreshOut:
    """Force one inbox scan synchronously (mutation-action). The mnemos
    round-trips are async, so the event loop never blocks; the request may
    take seconds — that is accepted for an explicit refresh. Rate limited
    per client; a failing server degrades its own slice only."""
    _guard_write(request, classes=("ui",))
    client_ip = request.client.host if request.client else "unknown"
    if not _inbox_refresh_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"task-inbox refresh rate limit exceeded "
            f"({_INBOX_REFRESH_RATE_LIMIT} per {_INBOX_REFRESH_RATE_WINDOW:.0f}s per client)",
        )
    result = await refresh_inbox(registry, store)
    return TaskInboxRefreshOut(**result)


@app.patch("/api/tasks/inbox/{memory_id}")
async def tasks_inbox_edit(memory_id: str, body: TaskInboxEditSpec,
                           request: Request) -> TaskInboxItem:
    """Owner corrections to a queue record BEFORE adoption (UI-25).

    Stores the provided fields (title/summary/priority/project) as an
    overlay on the mirror row (``edits`` JSON) — the mirror's base fields
    stay as the source returned them, and GET /api/tasks/inbox projects the
    EFFECTIVE values plus the overlay. 409 once the row is adopted (the
    task exists; edit that instead); 404 unknown; 422 empty/garbage body."""
    _guard_write(request, classes=("ui",))
    rec = store.get_inbox_item(memory_id)
    if rec is None:
        raise HTTPException(404, "memory not found in task inbox")
    if rec.get("adopted_task_id"):
        raise HTTPException(409, "inbox record already adopted")
    edits = body.model_dump(exclude_none=True)
    if not edits:
        raise HTTPException(422, "no fields to edit")
    if "priority" in edits and edits["priority"] not in TASK_PRIORITIES:
        raise HTTPException(
            422, f"priority must be one of {sorted(TASK_PRIORITIES)}")
    if not store.save_inbox_edits(memory_id, edits):
        raise HTTPException(404, "memory not found in task inbox")
    items = store.list_inbox(include_adopted=True, memory_id=memory_id)
    if not items:
        raise HTTPException(404, "memory not found in task inbox")
    logging.getLogger("vesmaro.inbox").info(
        "task-inbox edit saved: memory=%s fields=%s", memory_id, sorted(edits))
    return TaskInboxItem(**items[0])


async def _sync_inbox_edits_revision(
        rec: dict[str, Any], edits: dict[str, str]) -> tuple[str | None, str | None]:
    """Write the EDITED revision of a task:queue record back to mnemos
    (UI-25 adopt-with-edits sync). Best-effort by design: the adopt contract
    must not depend on a memory engine round-trip.

    mnemos has no content-update over HTTP (no PATCH/PUT /memories route;
    verified against prod 4.1.0 and the 4.3.0 source), so the honest
    minimal mechanism is a NEW revision record via POST /memories on the
    source server (``metadata.supersedes`` names the original; tags carry
    the edited project:/severity: values plus a ``task:edit`` provenance
    tag). Returns ``(revision_id, error)``: ``(None, None)`` = nothing to
    sync (no field edits); ``(None, detail)`` = the engine kept the old
    version — logged, notified and documented, never silently dropped.
    """
    if not edits:
        return None, None
    server_name = rec.get("server") or ""
    try:
        _, servers = get_scope_servers(server_name, active_only=True)
    except HTTPException:
        servers = []
    if not servers:
        detail = f"source server '{server_name}' is not active — revision not written"
        logging.getLogger("vesmaro.inbox").warning(
            "adopt sync: %s (memory=%s)", detail, rec.get("memory_id"))
        return None, detail
    body = revision_memory_body(rec, edits)
    code, resp = await mnemos_client.post_json_async(servers[0], "/memories", body)
    if code in (200, 201) and isinstance(resp, dict) and resp.get("id"):
        revision_id = str(resp["id"])
        logging.getLogger("vesmaro.inbox").info(
            "adopt sync: revision %s written for memory=%s (supersedes)",
            revision_id, rec.get("memory_id"))
        return revision_id, None
    detail = str(resp.get("detail") if isinstance(resp, dict) else resp)[:300]
    logging.getLogger("vesmaro.inbox").warning(
        "adopt sync: mnemos rejected the revision write (http=%s) for "
        "memory=%s: %s", code, rec.get("memory_id"), detail)
    return None, detail


@app.post("/api/tasks/inbox/{memory_id}/adopt", status_code=201)
async def tasks_inbox_adopt(memory_id: str, request: Request) -> TaskOut:
    """Adopt a mirrored task:queue record as a NATIVE board task.

    The memory content is never copied — the task links it via memory_ids
    (SEC-4). Owner edits (UI-25 overlay) win over the mirror fields, and a
    task created from edited fields links an EDITED revision memory written
    back to the source store (best-effort; a failed sync is logged and
    notified, never a failed adopt). 409 with the existing ``task_id`` on
    double adoption; 404 when the mirror row is unknown."""
    _guard_write(request, classes=("ui",))
    rec = store.get_inbox_item(memory_id)
    if rec is None:
        raise HTTPException(404, "memory not found in task inbox")
    if rec.get("adopted_task_id"):
        return JSONResponse(
            status_code=409,
            content={
                "task_id": rec["adopted_task_id"],
                "detail": "inbox record already adopted",
            },
        )
    edits = field_edits(parse_edits(rec.get("edits")))
    # Overlay semantics: a CLEARED summary ('') falls back to the standard
    # provenance line — the adopt text is never empty on a board task.
    revision_id, sync_error = await _sync_inbox_edits_revision(rec, edits)
    if revision_id:
        store.save_inbox_edits(memory_id, {"revision_memory_id": revision_id})
    elif sync_error:
        store.save_inbox_edits(memory_id, {"revision_error": sync_error})
    specialist = rec.get("specialist") or ""
    # store raises ValueError on a garbage env/priority in the mirror row —
    # surface as 422, never as a 500
    try:
        task = store.create_task({
            "title": (edits.get("title")
                      or rec.get("title")
                      or f"task:queue {memory_id[:8]}")[:200],
            "summary": edits.get("summary") or (
                f"Принято из task:queue ({rec['server']}, память {memory_id[:8]}) "
                "— полное описание в связанной памяти."
            ),
            "project": edits.get("project", rec.get("project", "")),
            "priority": edits.get("priority", rec.get("priority", "normal")),
            "env": "laptop",
            "agents": ["zcode"],
            "specialists": [specialist] if specialist else [],
            "memory_ids": [memory_id] + ([revision_id] if revision_id else []),
            "mnemos_tags": ["task-queue-import"],
        }, actor=_device_actor(request))
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not store.mark_inbox_adopted(memory_id, task["id"]):
        logging.getLogger("vesmaro.inbox").warning(
            "adopt: mirror row %s vanished mid-adopt (native task %s kept)",
            memory_id, task["id"])
    _notify_and_broadcast(
        "work", f"{task['id']}: принята из task:queue",
        task["title"][:120], task["id"],
        {"kind": "task.created", "task": task},
    )
    if sync_error:
        _notify_and_broadcast(
            "work", f"{task['id']}: правка НЕ синхронизирована в память",
            sync_error[:200], task["id"],
            {"kind": "task.updated", "task": task},
        )
    return task


# -------------------------------------------------------- specialist profile
@app.get("/api/specialists/profile")
async def specialist_profile_q(name: str, refresh: bool = False) -> SpecialistProfileOut:
    """Query-param variant (slash-safe for names like SRE/DevOps)."""
    return await specialist_profile(name=name, refresh=refresh)


@app.get("/api/specialists/{name}/profile")
async def specialist_profile(name: str, refresh: bool = False) -> SpecialistProfileOut:
    """Specialist composition (instructions/skills/rules/triggers).

    BE-9 semantics: ``sections`` hold only this agent's own files and the
    skills/instructions its .md explicitly references; plugin-level
    material available to every agent of the plugin is returned once in
    ``shared`` (``shared: true``, ``scope: "plugin"``, ``counts`` and a
    ``summary`` line) instead of being repeated on every card.

    Serving order: SQLite cache (instant, populated by refresh-all or the
    background loop) → deterministic filesystem build from the GCW plugin
    tree → legacy mnemos-index search for names the builder cannot
    resolve. Pass ?refresh=1 to force a rebuild.
    """
    slug = (name.lower().replace("@gcw: ", "gcw-")
            .replace(" ", "-").replace("/", "-"))

    if not refresh:
        cached = store.get_profile_cache(name)
        if cached:
            return {"ok": True, "cached": True, "updated_at": cached["updated_at"],
                    **cached["profile"]}

    # BE-9 fast path: deterministic build from GCW plugin files. No
    # memory-server round-trip; duplication is structurally impossible
    # because sections come from explicit per-agent references only.
    built = await asyncio.to_thread(build_profile, name)
    if built is not None:
        store.put_profile_cache(name, built)
        return {"ok": True, "cached": False, **built}

    # legacy slow path: search memory servers for the index tag.
    # A single probe query misses records (hybrid scoring quirks), so run
    # several probe queries and merge by id.
    tag = f"specialist:{slug}"
    legacy_tag = tag.replace("-", "/", 2) if "/" not in tag else tag
    tags_probe = [tag, legacy_tag]
    servers = registry.active_servers()
    probe_queries = ("*", "specialist", "[instructions]", "[skills]", "[rules]", "[triggers]", "[meta]")
    results = await asyncio.gather(*(
        mnemos_client.post_json_async(
            s, "/search", {"query": q, "tags": [t], "limit": 60},
            timeout=15.0,
        )
        for s in servers for q in probe_queries for t in tags_probe
    ))
    server_names = [s["name"] for s in servers for q in probe_queries for t in tags_probe]
    packed = list(zip(server_names, results))
    sections: dict[str, list[dict[str, Any]]] = {
        "instructions": [], "skills": [], "rules": [], "triggers": [], "other": [],
    }
    meta: dict[str, Any] = {"role": name, "slug": slug}
    errors = []
    seen: set[str] = set()
    for s_name, (code, data) in packed:
        if code != 200:
            errors.append({"server": s_name, "status": code})
            continue
        for it in (data if isinstance(data, list) else []):
            mid = it.get("id")
            if mid and mid in seen:
                continue
            if mid:
                seen.add(mid)
            kind = _section_of(it.get("title", ""))
            entry = {
                "title": (it.get("title") or "")[:140],
                "source_url": (it.get("source_url") or ""),
                "excerpt": (it.get("content") or "")[:200000],
                "id": it.get("id"),
                "server": s_name,
            }
            if kind in sections and kind != "other":
                sections[kind].append(entry)
            elif kind == "meta":
                meta.update(_parse_meta_excerpt(it.get("content") or ""))
            else:
                sections["other"].append(entry)

    profile = {
        "specialist": name, "slug": slug, "meta": meta,
        "sections": sections, "errors": errors,
        "indexed": any(sections.values()),
    }
    if profile["indexed"]:
        store.put_profile_cache(name, profile)
    return {"ok": True, "cached": False, **profile}


@app.post("/api/specialists/refresh-all")
async def specialists_refresh_all(request: Request) -> RefreshAllOut:
    """Prime/refresh all profile caches now (used right after sync).

    BE-9: rebuilds every board specialist from GCW plugin files via the
    deterministic scoped builder (idempotent upsert — one stable cache
    row per specialist, repeats never duplicate). Names the builder
    cannot resolve fall back to the legacy memory-server refresh.
    """
    _guard_write(request, classes=("ui",))
    specialists = sorted({s for t in store.board()["tasks"] for s in (t.get("specialists") or [])})
    built = memory_fallback = failed = 0
    for name in specialists:
        try:
            profile = await asyncio.to_thread(build_profile, name)
            if profile is not None:
                store.put_profile_cache(name, profile)
                built += 1
                continue
            await specialist_profile(name=name, refresh=True)
            memory_fallback += 1
        except Exception:
            failed += 1
    return {"ok": True, "refreshed": built + memory_fallback,
            "built": built, "memory_fallback": memory_fallback,
            "failed": failed}


def _section_of(title: str) -> str:
    tl = title.lower()
    if tl.startswith("[meta]"):
        return "meta"
    if tl.startswith("[instructions]"):
        return "instructions"
    if tl.startswith("[skills]"):
        return "skills"
    if tl.startswith("[rules]"):
        return "rules"
    if tl.startswith("[triggers]"):
        return "triggers"
    return "other"


def _parse_meta_excerpt(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for line in text.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            out[k.strip().lower()] = v.strip()[:200]
    return out


@app.get("/api/tags/{tag}/drill")
async def tag_drill(tag: str, limit: int = 12) -> dict[str, Any]:
    """Cross-cutting drill-down: everything tied to one tag.

    Returns: board tasks carrying this tag + memories matching the tag
    across all active memory servers (tags filter, recency order).
    """
    servers = registry.active_servers()
    results = await asyncio.gather(*(
        mnemos_client.post_json_async(
            s, "/search", {"query": "*", "tags": [tag], "limit": min(limit, 25)},
            timeout=15.0,
        ) for s in servers
    ))
    memories: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for s, (code, data) in zip(servers, results):
        if code != 200:
            errors.append({"server": s["name"], "status": code})
            continue
        for it in (data if isinstance(data, list) else []):
            if isinstance(it, dict):
                it["server"] = s["name"]
                memories.append(it)
    memories.sort(key=lambda i: i.get("created_at") or "", reverse=True)

    board_tasks = [
        {
            "id": t["id"], "title": t["title"], "col": t["col"],
            "agents": t["agents"], "env": t["env"],
        }
        for t in store.board()["tasks"]
        if tag in (t.get("mnemos_tags") or []) or tag in (t.get("specialists") or [])
        or tag in (t.get("agents") or [])
    ]
    return {
        "ok": not errors or bool(memories),
        "tag": tag,
        "tasks": board_tasks,
        "memories": [
            {
                "id": m["id"], "title": m.get("title") or "",
                "tags": m.get("tags", []), "server": m.get("server"),
                "created_at": m.get("created_at"), "status": m.get("status"),
                "excerpt": (m.get("content") or "")[:180],
            }
            for m in memories[:limit]
        ],
        "errors": errors,
    }


@app.get("/api/agents/{name}/activity")
async def agent_activity(name: str, project: str = "", limit: int = 10) -> dict[str, Any]:
    """Cross-store agent activity: recent memories per agent (mnemos /recall)."""
    servers = registry.active_servers()
    results = await asyncio.gather(*(
        mnemos_client.fetch_json(
            s, f"/recall/agent/{name}",
            {"limit": min(limit, 25), **({"project": project} if project else {})},
        ) for s in servers
    ))
    items: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for s, (code, body) in zip(servers, results):
        if code != 200 or not isinstance(body, list):
            errors.append({"server": s["name"], "status": code})
            continue
        for it in body:
            if isinstance(it, dict):
                it["server"] = s["name"]
                items.append(it)
    items.sort(key=lambda i: i.get("created_at") or "", reverse=True)
    board_tasks = [
        {"id": t["id"], "title": t["title"], "col": t["col"], "env": t["env"]}
        for t in store.board()["tasks"] if name in (t.get("agents") or [])
    ]
    return {
        "ok": not errors or bool(items),
        "agent": name,
        "tasks": board_tasks,
        "memories": [
            {
                "id": i["id"], "title": i.get("title") or "",
                "tags": i.get("tags", []), "server": i.get("server"),
                "created_at": i.get("created_at"),
                "excerpt": (i.get("content") or "")[:180],
            }
            for i in items[:limit]
        ],
        "errors": errors,
    }


# Env var to name in the 503 detail per class (operator-facing hint).
_TOKEN_CLASS_ENV = {"ui": "VESMARO_UI_TOKEN", "machine": "VESMARO_BOARD_TOKEN"}


def _token_classes() -> dict[str, str]:
    """Effective bearer token per class ('' = class not configured).

    ui falls back to the machine token while the token split is rolling
    out (transitional v1, see the token-classes note at module top);
    machine is exactly VESMARO_BOARD_TOKEN. Reads the module globals at
    call time so tests can monkeypatch the configuration per test.
    """
    return {
        "ui": UI_WRITE_TOKEN or BOARD_WRITE_TOKEN,
        "machine": BOARD_WRITE_TOKEN,
    }


def _guard_write(request: Request, *, classes: tuple[str, ...] = ("machine",)) -> None:
    """Mutation guard (SEC-3 fail-closed; ADR 0009 A1 token classes).

    ``classes`` names the token classes allowed through this endpoint:
    ("ui",) for owner-UI mutations, ("machine",) for agent/poller
    endpoints, ("ui", "machine") where both sides legitimately write
    (task reports). Default is the machine class — assignment-loop routes
    (ARCH-9 track) may omit the argument; board-UI routes pass ("ui",).
    New assignment routes annotate their class in this single argument
    and nothing else changes.

    Semantics: when NO token of the requested classes is configured the
    endpoint is disabled — 503, fail-closed (the Helm chart provisions
    the tokens; compose.yaml ships dev values for local runs). A
    configured but non-matching bearer is 401. Every comparison is
    constant-time (hmac.compare_digest per class).

    Device leg (scope v1, ADR 0012 Amendment): the scope middleware has
    ALREADY validated this mnd_ bearer AND matched the (method, path)
    against the device scope table for this exact route — a non-None
    ``request.state.device`` is proof; re-comparing the device digest
    here would only re-derive the choke point's verdict. Deliberately
    placed AFTER the fail-closed 503: a board with no write tokens
    configured stays disabled for devices too (fail-closed everywhere).
    """
    effective = _token_classes()
    allowed = [effective[c] for c in classes if effective.get(c)]
    if not allowed:
        envs = " or ".join(dict.fromkeys(_TOKEN_CLASS_ENV[c] for c in classes))
        raise HTTPException(
            503,
            f"mutation auth is not configured: set {envs} to "
            "enable board writes (fail-closed; see compose.yaml for local dev)",
        )
    if getattr(request.state, "device", None) is not None:
        return
    auth = request.headers.get("Authorization", "")
    if auth:
        # Determinism rule (ADR 0014 Ф2): a header present → the header leg
        # ONLY, including the cross-class mismatch detail. No cookie fallback.
        for token in allowed:
            expected = f"Bearer {token}"
            if hmac.compare_digest(auth.encode("utf-8"), expected.encode("utf-8")):
                # Review P1 (sliding TTL): a request that proved ui-token
                # possession on the HEADER leg extends the owner session too —
                # the dialog flow keeps the token in sessionStorage, so its
                # mutations never touch the cookie leg. Machine/executor
                # matches (reports composite) must NOT touch the session.
                if "ui" in classes and token == effective.get("ui"):
                    _schedule_ui_cookie_reissue(request)
                return
        raise HTTPException(401, _token_mismatch_detail(auth, effective, classes))
    # Header absent → the cookie leg (owner session, ADR 0014 Ф2). Only
    # guards that include the ui class consult the cookie — a machine route
    # can never be opened by it (its 401 detail is unchanged).
    if "ui" in classes:
        if _cookie_ui_ok(request):
            _schedule_ui_cookie_reissue(request)
            return
        raise HTTPException(401, _ui_session_expired_detail(classes))
    raise HTTPException(401, _token_mismatch_detail(auth, effective, classes))


def _token_mismatch_detail(auth: str, effective: dict[str, str],
                           classes: tuple[str, ...]) -> str:
    """401 detail for a non-matching bearer (owner feedback 2026-09-22:
    the board token pasted into a ui action read as a generic "token not
    accepted" and the owner rightly read it as the system demanding one
    token per section). When the bearer matches a CONFIGURED token of a
    DIFFERENT class, say so precisely — which class arrived, which one the
    action wants. Constant-time per class; still a 401 (the client's
    re-login flow keys on it)."""
    for cls, token in effective.items():
        if not token or cls in classes:
            continue
        if hmac.compare_digest(auth.encode("utf-8"),
                               f"Bearer {token}".encode("utf-8")):
            need = " or ".join(_TOKEN_CLASS_ENV[c] for c in classes)
            return (f"the bearer is a {cls}-class token — this action "
                    f"requires {need}")
    return "board write token required"


def _bearer_is_class(request: Request, cls: str) -> bool:
    """Constant-time check: does the request carry THIS class's token?

    Used where an endpoint legitimately accepts several auth legs with
    different shapes (e.g. reports: ui class vs machine/executor loop) —
    pick the leg by bearer, then run the full guard on the picked class.
    """
    token = _token_classes().get(cls, "")
    if not token:
        return False
    auth = request.headers.get("Authorization", "")
    expected = f"Bearer {token}"
    return hmac.compare_digest(auth.encode("utf-8"), expected.encode("utf-8"))


def _device_actor(request: Request) -> str:
    """Task-history actor for a device-driven mutation (scope v1, ADR 0012
    Amendment): ``device:<id> <name>`` — the audit trail answers WHO rode
    the mnd_ token without exposing material (same discipline as the
    pairing.issued token_id hash tail). Empty for every non-device
    request: the ui/machine legs keep their history shape unchanged."""
    device = getattr(request.state, "device", None)
    if not device:
        return ""
    return f"device:{device['id']} {device.get('name') or ''}".strip()[:120]


def _cookie_ui_ok(request: Request) -> bool:
    """Constant-time check of the ``vesmaro_ui`` session cookie (ADR 0014
    Ф2): does it carry the effective ui-class token? Fail-closed on an
    unconfigured class (False → the guards answer 503/401 exactly as
    before). The session is STATELESS: the cookie value IS the token, so a
    ui-token rotation invalidates every cookie immediately and
    authoritatively — no server-side session store to reason about."""
    token = _token_classes().get("ui", "")
    if not token:
        return False
    supplied = request.cookies.get(_UI_COOKIE_NAME, "")
    if not supplied:
        return False
    return hmac.compare_digest(supplied.encode("utf-8"), token.encode("utf-8"))


def _ui_session_expired_detail(classes: tuple[str, ...]) -> str:
    """401 detail for a headerless request whose cookie leg failed (ADR
    0014 Ф2): the owner-facing «сессия истекла» beat — the browser killed
    the 6h-idle cookie or the token was rotated mid-flight. The dialog
    keys its distinct text on the 401; the words stay free of any value."""
    need = " or ".join(dict.fromkeys(_TOKEN_CLASS_ENV[c] for c in classes))
    return (f"ui session missing or expired — sign in again "
            f"(owner login verifies {need})")


def _guard_ui_write(request: Request) -> None:
    """UI-class mutation guard (ADR 0009 A1): assignment create/cancel are
    owner-UI actions and take VESMARO_UI_TOKEN. Fail-closed exactly like
    _guard_write: when the effective UI token is empty (neither class
    configured) every UI mutation answers 503. Legacy single-token mode
    (VESMARO_UI_TOKEN unset → falls back to the board token at import) keeps
    existing deployments working; in split mode the board token is REFUSED
    here — a machine token must not mint assignments. Constant-time compare."""
    if not UI_WRITE_TOKEN:
        raise HTTPException(
            503,
            "ui mutation auth is not configured: set VESMARO_UI_TOKEN "
            "(or VESMARO_BOARD_TOKEN for single-token legacy mode) to "
            "enable assignment UI actions (fail-closed)",
        )
    auth = request.headers.get("Authorization", "")
    if auth:
        # Header present → header leg only (ADR 0014 determinism rule).
        expected = f"Bearer {UI_WRITE_TOKEN}"
        if not hmac.compare_digest(auth.encode("utf-8"), expected.encode("utf-8")):
            raise HTTPException(401, "ui write token required")
        # Review P1: this guard IS the ui class — a passed header mutation
        # extends the sliding session exactly like a cookie-leg one.
        _schedule_ui_cookie_reissue(request)
        return
    # Header absent → the cookie leg (owner session, ADR 0014 Ф2).
    if _cookie_ui_ok(request):
        _schedule_ui_cookie_reissue(request)
        return
    raise HTTPException(401, _ui_session_expired_detail(("ui",)))


def _authenticate_executor(request: Request) -> dict[str, Any] | None:
    """Executor-token class (ARCH-9, L0): ``Bearer <executor_secret>``
    matched by sha256 digest, constant-time per stored hash. Returns the
    raw executor row (state included — callers apply class policy) or
    None when the bearer is not an executor secret. Never raises."""
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    return store.authenticate_executor(auth[len("Bearer "):].strip())


def _guard_machine_write(request: Request) -> dict[str, Any] | None:
    """Machine-class mutation guard (ADR 0009 A1 + Amd 2 §2): accepts the
    board (machine) token OR an APPROVED executor token — on the mesh leg
    the executor token is mandatory and a node must not hold board-class
    credentials. Returns the token-backed executor row (None = board-token
    class). Pending executor tokens are refused (the registry is the
    identity gate — unapproved is not yet a work identity); revoked are
    the kill-switch. Constant-time comparisons on both legs."""
    executor = _authenticate_executor(request)
    if executor is not None:
        if executor["state"] != "approved":
            raise HTTPException(
                403, "executor token is not approved for the machine loop")
        return executor
    _guard_write(request, classes=("machine",))
    return None


def _guard_register(request: Request) -> dict[str, Any] | None:
    """Registration guard (ADR 0009 A1 + Amd 2 §4 supplement): accepts the
    board (machine) token — the L0 bootstrap — OR a single-use ``mne_``
    enrollment token. Returns the live enrollment row (truthy) on the
    enrollment leg, None on the machine leg; the route passes it into
    store.register_executor, which CASes created→used in the same
    transaction as the executor INSERT.

    Bearer ``mne_…`` semantics (design §3.1): unknown → 401 "enrollment
    token required or invalid" (a guarded mutation answers 401 for a bad
    credential — deliberately NOT pairing's 404, which belongs to the
    dedicated unauthenticated exchange leg); known but expired / used /
    revoked → 410 with the reason (diagnostic for the remote leg; hash
    lookups leak nothing). No env 503 on this leg: the token itself is the
    credential and approval waits downstream anyway (unlike pairing, whose
    protocol cannot complete without the trusted side)."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith(f"Bearer {ENROLLMENT_TOKEN_PREFIX}"):
        token = auth[len("Bearer "):].strip()
        row = store.lookup_enrollment_by_token(token)
        if row is None:
            raise HTTPException(401, "enrollment token required or invalid")
        state = ("expired" if store.enrollment_row_expired(row)
                 else row["state"])
        if state == "expired":
            raise HTTPException(
                410, "enrollment token expired — request a new one from the owner")
        if state == "used":
            raise HTTPException(410, "enrollment token already used")
        if state == "revoked":
            raise HTTPException(410, "enrollment token revoked")
        return row
    _guard_write(request, classes=("machine",))
    return None


def _identity_tokens(value: str) -> set[str]:
    """Casefolded whole-token set of a self-asserted identity string
    ('Laptop-Poller_1' → {'laptop', 'poller', '1'}). PR #18 F3: substring
    matching is spoofable in both directions ('pi' hides inside
    'copilot', a decorated 'evil-laptop-poller' hides 'laptop-poller');
    only alphanumeric-run boundaries count."""
    return {t for t in re.split(r"[^0-9a-z]+", (value or "").casefold()) if t}


def _report_identity_mismatch(executor: dict[str, Any] | None,
                              agent: str) -> bool:
    """Amd 2 §7 spoofing signal: does the declared ``agent`` string
    disagree with the token-backed executor? Consistent = the declared
    whole-token set COVERS the executor's registered name tokens or its
    harness tokens (casefolded); anything less is a mismatch. Empty
    declaration = nothing to contradict = consistent. Only computable on
    executor-token requests — a board-token report carries no token-backed
    identity to disagree with (flag stays False there). Signal, not a
    gate: the report is still accepted; residual window — a decorated
    string that fully contains the real name as whole tokens still
    passes (contiguity is not enforced; the hard gate is claim)."""
    if not executor:
        return False
    declared = _identity_tokens(agent or "")
    if not declared:
        return False
    name_tokens = _identity_tokens(executor["name"])
    harness_tokens = _identity_tokens(executor["harness"])
    covers = ((name_tokens and name_tokens <= declared)
              or (harness_tokens and harness_tokens <= declared))
    return not covers


# --------------------------------------- owner session login (ADR 0014, Ф1+Ф2)
# Owner login = server verification at the door + a stateless session
# cookie. POST /api/auth/ui-token checks the pasted value against the
# effective ui-class token and SETS `vesmaro_ui` (HttpOnly, SameSite=Strict,
# Secure by request scheme, Max-Age 21600); every ui-guarded mutation that
# passes on the cookie leg reissues it (sliding idle TTL — the owner's
# ratification amendment: activity extends, 6h of silence logs out).
# DELETE is the SERVER-side logout: an HttpOnly cookie cannot be cleared
# from JS. The read injection lives INSIDE _guard_write/_guard_ui_write —
# deliberately no auth middleware; determinism: header present → header leg
# only, header absent → cookie leg, machine class and mnd_ device tokens
# are never opened by the cookie. Invariants: the token is never echoed in
# a response body nor logged (not even truncated); POST-only verify;
# body ≤512 chars; no CORS headers on this surface.
_UI_COOKIE_NAME = "vesmaro_ui"
_UI_COOKIE_MAX_AGE_S = 6 * 3600    # 21600 — sliding idle TTL (owner, 2026-09-22)

# Flat limiters on the verify leg (the _pairing_ip_limiter pattern), keyed
# on the real client IP (--proxy-headers + RUNBOOK §10.1). Per-IP 10/60s is
# the brute-force budget; global 60/60s caps the whole-board noise. The
# EXPONENTIAL per-IP lockout is deliberately postponed (ADR 0014
# Alternatives rejected): behind traefik the whole household shares one NAT
# IP — an exponent would let one stale tab DoS the owner. Trigger to
# revisit: attack metrics or a multi-tenant deployment.
_AUTH_VERIFY_RATE_LIMIT = 10           # verify attempts per client ...
_AUTH_VERIFY_RATE_WINDOW = 60.0        # ... per sliding minute
_auth_verify_ip_limiter = RateLimiter(
    limit=_AUTH_VERIFY_RATE_LIMIT, window=_AUTH_VERIFY_RATE_WINDOW)
_AUTH_VERIFY_GLOBAL_RATE_LIMIT = 60    # verify attempts board-wide ...
_AUTH_VERIFY_GLOBAL_WINDOW = 60.0      # ... per sliding minute
_auth_verify_global_limiter = RateLimiter(
    limit=_AUTH_VERIFY_GLOBAL_RATE_LIMIT, window=_AUTH_VERIFY_GLOBAL_WINDOW)

# Sliding-reissue throttle (ADR 0014 Ф2): at most one Set-Cookie per
# client IP per 5 minutes, so an active owner doesn't get Set-Cookie on
# literally every response. In-memory per-IP NOTE only — the session
# itself stays stateless; the table is bounded against unbounded growth.
_UI_REISSUE_THROTTLE_S = 300.0
_UI_REISSUE_MAX_IPS = 256
_ui_reissue_last: dict[str, float] = {}


def _schedule_ui_cookie_reissue(request: Request) -> None:
    """Sliding idle TTL, server half (ADR 0014 Ф2): a ui-guarded request
    that passed (either leg — review P1) marks the request so
    ``_UiCookieReissueRoute`` reissues the cookie with a fresh Max-Age —
    activity extends the session, 6h of silence lets the browser kill the
    cookie and the next mutation lands on the «сессия истекла» 401.
    The throttle BUDGET is only READ here; the table is written by the
    route wrapper AFTER a successful response (review P3: a handler that
    raises 409/500 must not spend the 5-minute sliding budget)."""
    ip = request.client.host if request.client else "unknown"
    last = _ui_reissue_last.get(ip)
    if last is not None and time.monotonic() - last < _UI_REISSUE_THROTTLE_S:
        return
    request.state.vesmaro_ui_reissue = True


def _commit_ui_cookie_reissue(request: Request) -> None:
    """Wrapper-side half: the request proved the reissue right and the
    response is on its way — spend the budget, touch the IP LRU-wise."""
    ip = request.client.host if request.client else "unknown"
    now = time.monotonic()
    if len(_ui_reissue_last) >= _UI_REISSUE_MAX_IPS and ip not in _ui_reissue_last:
        _ui_reissue_last.pop(next(iter(_ui_reissue_last)))  # oldest entry
    _ui_reissue_last.pop(ip, None)  # re-insert → true LRU touch on refresh
    _ui_reissue_last[ip] = now


class UiTokenVerifyIn(_ApiModel):
    """Owner login body. 1..512: non-empty and bounded — the verify leg is
    the one unauthenticated surface that handles secret material."""
    token: str = Field(min_length=1, max_length=512)


class UiTokenVerifyOut(_ApiModel):
    ok: bool
    token_class: Literal["ui", "legacy"]


def _ui_verify_mismatch_detail(supplied: str, effective: dict[str, str]) -> str:
    """Class-aware 401 detail for the login — the ``_token_mismatch_detail``
    analogue for a RAW pasted value (owner feedback 2026-09-22: the board
    token pasted at login must say WHICH class arrived; the two secret
    names are near-identical and that exact mistake started ADR 0014).
    Constant-time per class; never echoes the value, not even truncated."""
    machine = effective.get("machine", "")
    if (machine and machine != effective.get("ui", "")
            and hmac.compare_digest(supplied.encode("utf-8"),
                                    machine.encode("utf-8"))):
        return ("the pasted token is a machine-class token "
                f"({_TOKEN_CLASS_ENV['machine']}) — this login requires "
                f"{_TOKEN_CLASS_ENV['ui']}")
    return f"invalid ui token — this login requires {_TOKEN_CLASS_ENV['ui']}"


@app.post("/api/auth/ui-token")
async def verify_ui_token(body: UiTokenVerifyIn, request: Request,
                          response: Response) -> UiTokenVerifyOut:
    """Verify the owner's ui token at the door (ADR 0014 Ф1) and open the
    session (Ф2): on success the ``vesmaro_ui`` cookie is set right here —
    HttpOnly, SameSite=Strict, Secure when the request is https, Max-Age
    21600 (sliding idle TTL; guards reissue on activity). ``token_class``
    is honest about legacy mode: with no dedicated VESMARO_UI_TOKEN the ui
    class is served by the board token and the login says ``legacy``.
    Errors: 401 class-aware (never a generic "not accepted"), 429 on the
    flat limiters, 503 fail-closed while no token class is configured."""
    client_ip = request.client.host if request.client else "unknown"
    if not _auth_verify_ip_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"login rate limit exceeded "
            f"({_AUTH_VERIFY_RATE_LIMIT} per "
            f"{_AUTH_VERIFY_RATE_WINDOW:.0f}s per client)",
        )
    if not _auth_verify_global_limiter.acquire("global"):
        raise HTTPException(
            429,
            f"login rate limit exceeded "
            f"({_AUTH_VERIFY_GLOBAL_RATE_LIMIT} per "
            f"{_AUTH_VERIFY_GLOBAL_WINDOW:.0f}s board-wide)",
        )
    effective = _token_classes()
    ui = effective.get("ui", "")
    if not ui:
        raise HTTPException(
            503,
            "owner login is not configured: set VESMARO_UI_TOKEN "
            "(or VESMARO_BOARD_TOKEN for single-token legacy mode) to "
            "enable it (fail-closed)",
        )
    supplied = body.token
    if not hmac.compare_digest(supplied.encode("utf-8"), ui.encode("utf-8")):
        raise HTTPException(401, _ui_verify_mismatch_detail(supplied, effective))
    _set_ui_cookie(response, request)
    return {"ok": True,
            "token_class": "legacy" if ui == effective.get("machine") else "ui"}


@app.get("/api/auth/ui-token", status_code=204)
async def probe_ui_session(request: Request) -> None:
    """Boot probe for the viewer's session hydration (ADR 0014 Ф2): 204 =
    a live ``vesmaro_ui`` cookie (hasUiToken() → true, no login window);
    401 = none; 503 = login not configured (fail-closed). The viewer also
    re-probes in its 401 branch BEFORE opening the window — a stale header
    token beside a live cookie must replay, not re-prompt (the incident's
    mid-flight beat). No limiter: it is a constant-time boolean oracle
    with the same profile as the guards themselves; token entropy is the
    defence, as everywhere."""
    if not _token_classes().get("ui"):
        raise HTTPException(
            503,
            "owner login is not configured: set VESMARO_UI_TOKEN "
            "(or VESMARO_BOARD_TOKEN for single-token legacy mode) to "
            "enable it (fail-closed)",
        )
    if not _cookie_ui_ok(request):
        raise HTTPException(401, _ui_session_expired_detail(("ui",)))


@app.delete("/api/auth/ui-token", status_code=204)
async def logout_ui_token(response: Response) -> None:
    """Server-side logout (ADR 0014 Ф2; PA's special opinion). NO guard by
    design: a logout that 401s on an already-expired cookie is a trap —
    the route is how the browser gets RID of the cookie. Max-Age=0 kills
    it; HttpOnly means no JS path could have done this client-side."""
    response.set_cookie(_UI_COOKIE_NAME, "", max_age=0, httponly=True,
                        samesite="strict", path="/")


def _set_ui_cookie(response: Response, request: Request) -> None:
    """Set the ``vesmaro_ui`` session cookie (ADR 0014 Ф2). Secure follows
    the REQUEST scheme: the compose deploy is plain http 8090, and an
    unconditional Secure flag would silently drop the cookie there — a
    login loop no console message would explain."""
    response.set_cookie(
        _UI_COOKIE_NAME, _token_classes()["ui"],
        max_age=_UI_COOKIE_MAX_AGE_S, httponly=True, samesite="strict",
        path="/", secure=request.url.scheme == "https",
    )


# ------------------------------------------- QR pairing + devices (CV-7, ADR 0012)
# Server side of the LAN-direct pairing protocol (§2): the trusted side
# creates + confirms (ui-token, fail-closed 503 while unconfigured — the
# _guard_ui_write pattern), the device only ever presents the single-use
# code on the unauthenticated exchange leg. Security invariants baked in
# here (§3, all blocking): verify digits NEVER ride SSE or stored
# notifications (payload audit); token issuance is one-shot (the store
# CASes confirmed→issued); the first exchange binds the pairing to the
# client IP; device tokens are read-only by the scope middleware above.
_PAIRING_CREATE_RATE_LIMIT = 3          # creations per client ...
_PAIRING_CREATE_RATE_WINDOW = 600.0    # ... per sliding 10 min (§3.4)
_pairing_create_limiter = RateLimiter(
    limit=_PAIRING_CREATE_RATE_LIMIT, window=_PAIRING_CREATE_RATE_WINDOW)
_PAIRING_CONFIRM_RATE_LIMIT = 3         # confirms per client ...
_PAIRING_CONFIRM_RATE_WINDOW = 600.0    # ... per sliding 10 min
_pairing_confirm_limiter = RateLimiter(
    limit=_PAIRING_CONFIRM_RATE_LIMIT, window=_PAIRING_CONFIRM_RATE_WINDOW)
_PAIRING_EXCHANGE_RATE_LIMIT = 5        # exchange attempts per pairing ...
_PAIRING_EXCHANGE_RATE_WINDOW = 600.0   # ... per sliding 10 min (§3.4)
_pairing_exchange_limiter = RateLimiter(
    limit=_PAIRING_EXCHANGE_RATE_LIMIT, window=_PAIRING_EXCHANGE_RATE_WINDOW)
# Global per-IP budget for the UNAUTHENTICATED pairing surface (§3.4
# "глобальный per-IP лимит на /api/pairing/*"). Scoped to /api/pairing/
# exchange on purpose: every other /api/pairing* route is ui-token-gated
# with its own limiter, and folding them into one per-IP bucket would let
# the owner's own panel starve the device leg.
_PAIRING_IP_RATE_LIMIT = 30
_PAIRING_IP_RATE_WINDOW = 600.0
_pairing_ip_limiter = RateLimiter(
    limit=_PAIRING_IP_RATE_LIMIT, window=_PAIRING_IP_RATE_WINDOW)


class PairingCreateBody(BaseModel):
    """Optional owner-side label; the device's self-asserted name at
    exchange is what the owner actually confirms (§3.6). Cap 64 chars —
    rendered as text downstream (stored-XSS prophylaxis)."""
    device_name: str = Field(default="", max_length=64)


class PairingExchangeBody(BaseModel):
    code: str = Field(min_length=1, max_length=64)
    device_name: str = Field(default="", max_length=64)


class PairingConfirmBody(BaseModel):
    allow: bool


class PairingCreatedOut(_ApiModel):
    ok: bool
    pairing_id: str
    code: str            # the ONLY place the code ever appears (§2.1)
    verify: str
    expires_at: str
    state: str = "created"


class PairingStatusOut(_ApiModel):
    ok: bool
    pairing_id: str
    state: str
    verify: str          # trusted side's only source of the digits (§3.3)
    device_name: str = ""
    source_ip: str = ""
    scope: str = "read"
    created_at: str = ""
    scanned_at: str = ""
    confirmed_at: str = ""
    expires_at: str = ""


class PairingExchangeAwaitingOut(_ApiModel):
    ok: bool
    status: str          # "awaiting_confirmation"
    pairing_id: str
    state: str
    verify: str          # device-side screen check (§3.5 — not a secret)


class PairingIssuedOut(_ApiModel):
    ok: bool
    device_id: str
    device_token: str    # the ONLY place the mnd_ token ever appears (§2.5)
    scope: str
    expires_at: str
    hard_expires_at: str


class PairingConfirmOut(_ApiModel):
    ok: bool
    pairing_id: str
    state: str
    outcome: str         # confirmed | denied | idempotent


class DeviceOut(_ApiModel):
    """Public device session — token_hash never leaves the store. grants is
    the live per-device granule set (Amendment §A.7) the owner panel's
    toggles bind to."""
    id: str
    name: str
    scope: str
    grants: list[str] = []
    state: str
    created_at: str
    last_seen_at: str = ""
    last_seen: str = ""
    expires_at: str = ""
    hard_expires_at: str = ""
    ua: str = ""
    ip: str = ""


class DevicesOut(_ApiModel):
    ok: bool
    count: int
    items: list[DeviceOut]


class DeviceRevokedOut(_ApiModel):
    ok: bool
    device: DeviceOut


class DeviceGrantsBody(_ApiModel):
    """FULL-REPLACEMENT granule set (PUT semantics). Unknown names → 422
    (the granule dictionary is server-owned — the viewer mirrors it for
    labels, never for validation)."""
    grants: list[str] = Field(default_factory=list)


class DeviceGrantsOut(_ApiModel):
    ok: bool
    device: DeviceOut


def _pairing_state_of(row: dict[str, Any]) -> str:
    """Effective state for status reads: a live pairing past its TTL
    reports expired even before the sweep persists it."""
    return "expired" if Store.pairing_row_expired(row) else row["state"]


@app.post("/api/pairing", status_code=201)
async def create_pairing(body: PairingCreateBody,
                         request: Request) -> PairingCreatedOut:
    """Start a pairing (ui-token; ADR 0012 §2.1). 201 returns the code
    (128-bit urlsafe, single-use, TTL 3 min) and the 4 verify digits —
    the code appears in exactly one response body, this one. Rate 3 per
    10 min per client (§3.4). Fail-closed 503 while the ui token is not
    configured (no pairing on a tokenless board)."""
    _guard_ui_write(request)
    client_ip = request.client.host if request.client else "unknown"
    if not _pairing_create_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"pairing creation rate limit exceeded "
            f"({_PAIRING_CREATE_RATE_LIMIT} per "
            f"{_PAIRING_CREATE_RATE_WINDOW:.0f}s per client)",
        )
    row, code = store.create_pairing_request(
        created_by="owner", device_name=body.device_name.strip())
    return {"ok": True, "pairing_id": row["id"], "code": code,
            "verify": row["verify"], "expires_at": row["expires_at"],
            "state": row["state"]}


@app.post("/api/pairing/exchange", response_model=None,
          responses={200: {"model": PairingIssuedOut},
                     202: {"model": PairingExchangeAwaitingOut}})
async def exchange_pairing(body: PairingExchangeBody,
                           request: Request):
    """The device leg (NO auth — the single-use code IS the credential;
    ADR 0012 §2.3/§2.5). Poll semantics:

    - created → scanned: binds the client IP (§3.1, first exchange only)
      and the self-asserted device_name, emits SSE pairing.requested,
      answers 202 {status: awaiting_confirmation, verify};
    - scanned (repeat): 202 identically, NO duplicate SSE (§4);
    - confirmed (first): 200 {device_id, device_token (mnd_…), scope,
      expires_at} — issuance is one-shot (store CAS); the code is spent,
      every later exchange gets 410;
    - unknown code → 404; TTL-passed/expired/issued/revoked → 410;
    - a different client IP → 403 + a security notification (§3.1).

    Rate: 5 per 10 min keyed on pairing_id AFTER a successful code lookup
    (§3.4 — garbage codes must not grow the limiter's key space), plus a
    global per-IP budget on this endpoint."""
    # fail-closed: a board without a configured ui token does not pair
    if not UI_WRITE_TOKEN:
        raise HTTPException(
            503,
            "pairing is disabled: no ui token configured (fail-closed; "
            "set VESMARO_UI_TOKEN or VESMARO_BOARD_TOKEN to enable)",
        )
    client_ip = request.client.host if request.client else "unknown"
    if not _pairing_ip_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"pairing exchange rate limit exceeded "
            f"({_PAIRING_IP_RATE_LIMIT} per "
            f"{_PAIRING_IP_RATE_WINDOW:.0f}s per client)",
        )
    row = store.lookup_pairing_by_code(body.code.strip())
    if row is None:
        raise HTTPException(404, "unknown pairing code")
    if not _pairing_exchange_limiter.acquire(row["id"]):
        raise HTTPException(
            429,
            f"pairing exchange rate limit exceeded "
            f"({_PAIRING_EXCHANGE_RATE_LIMIT} per "
            f"{_PAIRING_EXCHANGE_RATE_WINDOW:.0f}s per pairing)",
        )
    if row["source_ip"] and row["source_ip"] != client_ip:
        # §3.1: the pairing is bound to the first exchange's IP — a second
        # presenter loses NOW (no equal chances on issuance, CWE-362). The
        # dictionary has no kind for this signal, so the owner-facing fact
        # rides a plain system notification (fact only — no digits).
        _notify_and_broadcast(
            "system", "Пейринг: код предъявлен с чужого IP",
            f"пейринг {row['id']}: код показан с {client_ip}, а привязан "
            f"к {row['source_ip']} — запрос отклонён")
        raise HTTPException(
            403, "pairing code is bound to another client IP")
    state = _pairing_state_of(row)
    if state == "expired":
        raise HTTPException(410, "pairing expired — start a new one")
    if state == "issued":
        raise HTTPException(410, "pairing code already used")
    if state == "revoked":
        raise HTTPException(410, "pairing revoked")
    if state == "created":
        try:
            pub, transitioned = store.scan_pairing(
                row["id"], device_name=body.device_name.strip(),
                source_ip=client_ip)
        except PairingExpiredError as exc:
            raise HTTPException(410, "pairing expired — start a new one") from exc
        if pub["source_ip"] and pub["source_ip"] != client_ip:
            # §3.1: the row above was read before the scan race resolved —
            # the winner bound the pairing to its own IP under the store
            # lock; a foreign loser answers 403 here, never a borrowed 202
            raise HTTPException(
                403, "pairing code is bound to another client IP")
        if transitioned:
            # exactly one concurrent exchange lands here (store CAS) —
            # repeats and losers answer 202 without re-emitting (§4)
            _notify_and_broadcast(
                "system", "Пейринг: запрос подключения",
                f"устройство «{pub['device_name'] or 'без имени'}» "
                f"отсканировало QR (пейринг {pub['id']})", None,
                {"kind": "pairing.requested", "pairing_id": pub["id"],
                 "device_name": pub["device_name"]})
        return JSONResponse(status_code=202, content={
            "ok": True, "status": "awaiting_confirmation",
            "pairing_id": pub["id"], "state": pub["state"],
            "verify": pub["verify"]})
    if state == "scanned":
        pub = store.get_pairing(row["id"])
        if pub["source_ip"] and pub["source_ip"] != client_ip:
            # same §3.1 re-check: the top-of-handler row predates any
            # concurrent scan binding — answer from the CURRENT row
            raise HTTPException(
                403, "pairing code is bound to another client IP")
        return JSONResponse(status_code=202, content={
            "ok": True, "status": "awaiting_confirmation",
            "pairing_id": pub["id"], "state": pub["state"],
            "verify": pub["verify"]})
    # state == "confirmed": one-shot issuance
    try:
        device, token = store.issue_device_session(
            row["id"], ua=request.headers.get("User-Agent", ""), ip=client_ip)
    except DeviceQuotaError as exc:
        raise HTTPException(409, str(exc)) from exc
    except PairingExpiredError as exc:
        raise HTTPException(410, "pairing expired — start a new one") from exc
    except PairingStateError as exc:
        # lost the issuance race — the code is spent by the winner
        raise HTTPException(410, "pairing code already used") from exc
    return {"ok": True, "device_id": device["id"], "device_token": token,
            "scope": device["scope"], "expires_at": device["expires_at"],
            "hard_expires_at": device["hard_expires_at"]}


@app.get("/api/pairing/{pairing_id}")
async def get_pairing(pairing_id: str, request: Request) -> PairingStatusOut:
    """Pairing status for the trusted side (ui-token) — the ONLY source of
    the verify digits besides the device's own exchange response (§3.3:
    /api/events is unauthenticated, so the digits never ride SSE or stored
    notifications)."""
    _guard_ui_write(request)
    row = store.get_pairing(pairing_id)
    if row is None:
        raise HTTPException(404, f"pairing {pairing_id} not found")
    return {"ok": True, "pairing_id": row["id"],
            "state": _pairing_state_of(row), "verify": row["verify"],
            "device_name": row["device_name"], "source_ip": row["source_ip"],
            "scope": row["scope"], "created_at": row["created_at"],
            "scanned_at": row["scanned_at"], "confirmed_at": row["confirmed_at"],
            "expires_at": row["expires_at"]}


@app.post("/api/pairing/{pairing_id}/confirm")
async def confirm_pairing(pairing_id: str, body: PairingConfirmBody,
                          request: Request) -> PairingConfirmOut:
    """Owner decision on a scanned pairing (ui-token; ADR 0012 §2.4).
    allow=true → confirmed (SSE pairing.confirmed); allow=false → revoked
    (SSE pairing.revoked). Repeat confirms answer 200 idempotently without
    re-deciding (§4); confirm before any scan → 409; TTL-passed → 410.
    The endpoint never accepts verify digits as input (§3.5, CWE-307)."""
    _guard_ui_write(request)
    client_ip = request.client.host if request.client else "unknown"
    if not _pairing_confirm_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"pairing confirm rate limit exceeded "
            f"({_PAIRING_CONFIRM_RATE_LIMIT} per "
            f"{_PAIRING_CONFIRM_RATE_WINDOW:.0f}s per client)",
        )
    try:
        row, outcome = store.confirm_pairing(pairing_id, allow=body.allow)
    except PairingNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except PairingExpiredError as exc:
        raise HTTPException(410, "pairing expired — start a new one") from exc
    except PairingStateError as exc:
        raise HTTPException(409, str(exc)) from exc
    if outcome == "confirmed":
        _notify_and_broadcast(
            "system", "Пейринг подтверждён",
            f"пейринг {pairing_id} подтверждён — устройство может забрать "
            "токен", None,
            {"kind": "pairing.confirmed", "pairing_id": pairing_id,
             "device_name": row["device_name"]})
    elif outcome == "denied":
        _notify_and_broadcast(
            "system", "Пейринг отклонён",
            f"пейринг {pairing_id} отклонён владельцем", None,
            {"kind": "pairing.revoked", "pairing_id": pairing_id})
    return {"ok": True, "pairing_id": pairing_id,
            "state": _pairing_state_of(row), "outcome": outcome}


@app.delete("/api/pairing/{pairing_id}")
async def cancel_pairing(pairing_id: str, request: Request) -> PairingConfirmOut:
    """Owner cancel of a not-yet-issued pairing (ui-token; §10.2): created/
    scanned/confirmed → revoked + SSE pairing.revoked. Already revoked →
    200 idempotent; issued → 409 (the device token EXISTS — revoke the
    device via DELETE /api/devices/{id}); TTL-passed → 410."""
    _guard_ui_write(request)
    try:
        row, transitioned = store.cancel_pairing(pairing_id)
    except PairingNotFoundError as exc:
        raise HTTPException(404, str(exc)) from exc
    except PairingExpiredError as exc:
        raise HTTPException(410, "pairing expired — start a new one") from exc
    except PairingStateError as exc:
        raise HTTPException(409, str(exc)) from exc
    if transitioned:
        _notify_and_broadcast(
            "system", "Пейринг отменён",
            f"пейринг {pairing_id} отменён владельцем", None,
            {"kind": "pairing.revoked", "pairing_id": pairing_id})
    return {"ok": True, "pairing_id": pairing_id,
            "state": _pairing_state_of(row),
            "outcome": "revoked" if transitioned else "idempotent"}


@app.get("/api/devices")
async def list_devices(request: Request) -> DevicesOut:
    """Device sessions for the owner panel (ui-token; §10.2). Items carry
    NO token material — token_hash stays in the store (hash-only, §5)."""
    _guard_ui_write(request)
    items = store.list_devices()
    return {"ok": True, "count": len(items), "items": items}


@app.delete("/api/devices/{device_id}")
async def revoke_device(device_id: str, request: Request) -> DeviceRevokedOut:
    """Revoke a device session (ui-token; §5). One step, terminal — only a
    new pairing restores access. SSE pairing.revoked carries the device_id;
    the next request with that token gets 401 (scope middleware)."""
    _guard_ui_write(request)
    result = store.revoke_device(device_id)
    if result is None:
        raise HTTPException(404, f"device {device_id} not found")
    row, transitioned = result
    if transitioned:
        _notify_and_broadcast(
            "system", "Устройство отключено",
            f"device-сессия «{row['name']}» ({device_id}) отозвана", None,
            {"kind": "pairing.revoked", "device_id": device_id})
    return {"ok": True, "device": row}


@app.put("/api/devices/{device_id}/grants")
async def set_device_grants(device_id: str, body: DeviceGrantsBody,
                            request: Request) -> DeviceGrantsOut:
    """Owner sets the per-device granule set (ui-token; Amendment §A.7,
    owner directive «пользователь-администратор сам определяет кому
    сколько и куда разрешений выдать и забрать»). FULL replacement (PUT):
    the sent list IS the set — [] revokes every granule (reads stay open,
    global-read always). Idempotent 200 on an unchanged set; applies to
    the LIVE session immediately (the guard reads grants per request —
    the device's very next call runs under the new set). 404 unknown
    device; 409 not-active (granting to a dead session is meaningless —
    revoke/re-pair instead); 422 unknown granule names."""
    _guard_ui_write(request)
    unknown = sorted(set(body.grants) - set(DEVICE_GRANTS))
    if unknown:
        raise HTTPException(
            422, f"unknown device grants: {', '.join(unknown)} "
                 f"(known: {', '.join(DEVICE_GRANTS)})")
    result = store.set_device_grants(device_id, body.grants)
    if result is None:
        raise HTTPException(404, f"device {device_id} not found")
    row, changed = result
    if row["state"] != "active":
        raise HTTPException(
            409, f"device {device_id} is {row['state']} — grants apply to "
                 "active sessions only (revoke it or pair a new one)")
    if changed:
        _notify_and_broadcast(
            "system", "Доступы устройства изменены",
            f"«{row['name']}» ({device_id}): гранулы "
            f"{row['grants'] or '— ничего —'}")
    return {"ok": True, "device": row}


# ------------------------------------------------------------------------ SSE
@app.get("/api/events")
async def events() -> StreamingResponse:
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=256)
    _subscribers.add(queue)

    async def stream() -> AsyncIterator[bytes]:
        try:
            # Initial retry hint + a hello event so proxies flush headers.
            yield b"retry: 3000\n\n"
            yield _sse({"kind": "hello", "last_event_id": store.last_event_id()})
            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield _sse(event)
                except asyncio.TimeoutError:
                    yield b": keep-alive\n\n"  # comment frame — keeps proxies from idling out
        except asyncio.CancelledError:  # client disconnected
            pass
        finally:
            _subscribers.discard(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _sse(event: dict[str, Any]) -> bytes:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8")


# ----------------------------------------------------------------- static SPA
# Root UI ownership (ADR 0011 Ф4, env VESMARO_ROOT_APP -> ROOT_APP above):
# handlers branch on the module global at REQUEST time (the same contract
# as APP_DIR/STATIC_DIR monkeypatching in tests). Routes are registered
# BEFORE the root catch-all below, so /api/* and these explicit paths
# always win.


def _board_index_response() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "index.html",
        headers={"Cache-Control": "no-cache"},  # entry point always fresh
    )


def _board_file_response(path: str) -> FileResponse | None:
    """A real file under VESMARO_WEB, or None when there is none (missing,
    a directory, or a traversal attempt — security verdict §5.4 applies
    to the board tree exactly as it does to VESMARO_APP_DIR)."""
    root = STATIC_DIR.resolve()
    candidate = (root / path).resolve()
    if candidate != root and root not in candidate.parents:
        return None
    if not candidate.is_file():
        return None
    return FileResponse(candidate)


@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    if ROOT_APP == "app":
        return _app_index_response()
    return _board_index_response()


# ------------------------------------------------------ /board (Ф4 flip only)
# The frozen board after the flip (root=app). It is a SPA without a client
# router, so /board serving its index.html IS the whole history story; the
# board's index.html references its assets with absolute root paths
# (/styles/..., /js/...), which the root catch-all below keeps serving —
# no URL rewrite is needed for the board to work under /board.
@app.get("/board", include_in_schema=False)
@app.get("/board/", include_in_schema=False)
async def board_index() -> FileResponse:
    if ROOT_APP != "app":
        # Parity with the pre-Ф4 world: /board does not exist in board mode.
        raise HTTPException(404)
    return _board_index_response()


@app.get("/board/{path:path}", include_in_schema=False)
async def board_asset(path: str) -> FileResponse:
    if ROOT_APP != "app":
        raise HTTPException(404)
    response = _board_file_response(path)
    if response is None:
        raise HTTPException(404, f"no such board asset: /board/{path}")
    return response


# ---------------------------------------------------------------- /app (Ф0a)
# React viewer dist (ADR 0011 Ф0a): history-API routing needs a fallback —
# every /app path that is not a real file resolves to index.html. Path
# joining is traversal-safe (security verdict §5.4): the resolved
# candidate must stay inside APP_DIR. Under the Ф4 flip (root=app) the
# viewer owns / instead: bare /app then 302s to / and non-file /app/...
# paths 302 to their prefix-stripped location, so pre-switch bookmarks
# keep working.
def _app_index_response() -> FileResponse:
    index = APP_DIR / "index.html"
    if not index.is_file():
        # An image built without the Node stage is a legitimate state —
        # say so instead of leaking a bare 404. Point at wherever the
        # board lives under the CURRENT root mode.
        board_home = "/board" if ROOT_APP == "app" else "/"
        raise HTTPException(
            404,
            "viewer app is not deployed (VESMARO_APP_DIR has no index.html); "
            f"the board UI stays at {board_home}",
        )
    return FileResponse(index, headers={"Cache-Control": "no-cache"})


@app.get("/app", include_in_schema=False)
@app.get("/app/", include_in_schema=False)
async def app_index():
    """SPA entries: /app and /app/ serve the viewer's index.html; after the
    Ф4 flip they redirect to the new root so old bookmarks survive."""
    if ROOT_APP == "app":
        return RedirectResponse("/", status_code=302)
    return _app_index_response()


@app.get("/app/{path:path}", include_in_schema=False)
async def app_spa(path: str):
    """Catch-all under /app: real files are served (vite emits them under
    assets/ with content-hashed names → immutable — the production vite
    base is /app/, so these file URLs stay valid in BOTH root modes),
    anything else falls back to index.html for the client router; after
    the flip non-file paths redirect prefix-stripped."""
    if not (APP_DIR / "index.html").is_file():
        board_home = "/board" if ROOT_APP == "app" else "/"
        raise HTTPException(
            404,
            "viewer app is not deployed (VESMARO_APP_DIR has no index.html); "
            f"the board UI stays at {board_home}",
        )
    root = APP_DIR.resolve()
    candidate = (root / path).resolve()
    if candidate != root and root not in candidate.parents:
        # traversal attempt (or a symlink escaping the dist) — reject
        raise HTTPException(400, "path escapes the viewer root")
    if candidate.is_file():
        rel = candidate.relative_to(root)
        cache = ("public, max-age=31536000, immutable"
                 if rel.parts and rel.parts[0] == "assets"
                 else "no-cache")
        return FileResponse(candidate, headers={"Cache-Control": cache})
    if ROOT_APP == "app":
        # A client route: its canonical home since the flip is the same
        # path without the /app prefix (/app/tasks/42 -> /tasks/42).
        return RedirectResponse(f"/{path}", status_code=302)
    return _app_index_response()


# ----------------------------------------------------------- root catch-all
# Replaces the pre-Ф4 StaticFiles mount at "/". Board files live at
# absolute root paths (/styles/..., /js/..., /fonts/...), so they are
# served here in BOTH modes; in board mode everything else 404s (the old
# mount's contract — the one visible delta: a bare directory path now
# 404s directly instead of a 307 to a trailing slash; nothing links to
# directories); in app mode unknown paths fall back to the viewer index —
# history-API routing for deep links like /tasks/42 at the root.
@app.get("/{path:path}", include_in_schema=False)
async def root_catch_all(path: str) -> FileResponse:
    board_file = _board_file_response(path)
    if board_file is not None:
        return board_file
    if ROOT_APP == "app":
        # A viewer client route (or a stale board asset URL): fresh shell.
        return _app_index_response()
    raise HTTPException(404)
