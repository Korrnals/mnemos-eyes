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
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .security import mask_secrets

# Columns of the kanban board, in display order. Values equal the mnemos
# workflow state machine so a task can graduate into a memory later.
COLUMNS: tuple[str, ...] = ("open", "in-progress", "blocked", "resolved", "done")
VALID_STATUSES = frozenset(COLUMNS)
# BE-10: per-task status dictionary = the mnemos workflow state machine.
# Superset of COLUMNS: `withdrawn` is a terminal mnemos status with no board
# column (cancelled tasks are archived instead — WF-1 proposal §7). Validated
# on create and PATCH; `col` remains the kanban projection (see move_task).
TASK_STATUSES = frozenset({*COLUMNS, "withdrawn"})
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

_SCHEMA = """
CREATE TABLE IF NOT EXISTS board_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    col          TEXT NOT NULL CHECK (col IN ('open','in-progress','blocked','resolved','done')),
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
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    harness       TEXT NOT NULL,
    host          TEXT NOT NULL DEFAULT '',
    transport     TEXT NOT NULL DEFAULT 'local-poll'
                  CHECK (transport IN ('local-poll','mesh-r4')),
    capabilities  TEXT NOT NULL DEFAULT '[]',
    version       TEXT NOT NULL DEFAULT '',
    enabled       INTEGER NOT NULL DEFAULT 0,
    state         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','approved','revoked')),
    secret_hash   TEXT NOT NULL DEFAULT '',
    last_seen     TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
"""

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

    def _conn(self) -> sqlite3.Connection:
        db = sqlite3.connect(self._path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA foreign_keys=ON")
        return db

    # ------------------------------------------------------------------ meta
    # Harnesses are EXECUTION ENVIRONMENTS (zcode, hermes, pi, copilot,
    # claude-code, ...). GCW roles like "gcw-tech-lead" are SPECIALISTS,
    # never agents. Enforced on every write — cross-stack, config-independent.
    KNOWN_HARNESSES = frozenset({
        "zcode", "hermes", "pi", "copilot", "claude-code", "cursor",
        "aider", "continue", "cline", "windsurf",
    })

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
        counts = {c: 0 for c in COLUMNS}
        for r in stats:
            counts[r["col"]] = r["n"]
        return {"columns": list(COLUMNS), "tasks": tasks, "counts": counts}

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
            status = col
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
        with self._lock, self._conn() as db:
            pos = db.execute(
                "SELECT COALESCE(MAX(position)+1, 0) AS p FROM tasks WHERE col=?",
                (col,),
            ).fetchone()["p"]
            db.execute(
                """INSERT INTO tasks
                       (id, col, status, position, title, summary, spec,
                        agents, specialists, env, project, memory_ids,
                        mnemos_tags, priority, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    task_id, col, status, pos, payload["title"],
                    payload.get("summary", ""), payload.get("spec", ""),
                    json.dumps(payload.get("agents", [])),
                    json.dumps(payload.get("specialists", [])),
                    env, payload.get("project", ""),
                    json.dumps(payload.get("memory_ids", [])),
                    json.dumps(payload.get("mnemos_tags", [])),
                    priority,
                    now, now,
                ),
            )
            self._log(db, "task.created", task_id, {"col": col, "status": status})
        return self.task(task_id)  # type: ignore[return-value]

    def move_task(self, task_id: str, col: str, position: int | None = None) -> dict[str, Any] | None:
        """Kanban move (BE-10 v1 semantics): moving a column synchronously
        re-derives ``status`` from the column map. A status set by a manual
        PATCH therefore lives only until the next move — that keeps the
        ``?status=`` filter honest with respect to the kanban state.
        (Decision documented on BE-10; per-status persistence independent of
        columns is deferred to the WF-1 transition-machine phase.)"""
        if col not in VALID_STATUSES:
            raise ValueError(f"invalid col: {col}")
        with self._lock, self._conn() as db:
            row = db.execute("SELECT col FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                return None
            if position is None:
                position = db.execute(
                    "SELECT COALESCE(MAX(position)+1, 0) AS p FROM tasks WHERE col=?",
                    (col,),
                ).fetchone()["p"]
            db.execute(
                "UPDATE tasks SET col=?, status=?, position=?, updated_at=? WHERE id=?",
                (col, col, position, _now(), task_id),
            )
            self._log(db, "task.moved", task_id, {"from": row["col"], "to": col})
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
        (``archived_from=''``) fall back to ``open``. Status re-syncs to the
        restored column (same semantics as move). Returns the restored task
        or None when the id is unknown / not archived."""
        with self._lock, self._conn() as db:
            row = db.execute(
                "SELECT archived, archived_from FROM tasks WHERE id=?",
                (task_id,),
            ).fetchone()
            if row is None or not row["archived"]:
                return None
            col = row["archived_from"] or "open"
            db.execute(
                "UPDATE tasks SET archived=0, col=?, status=?, updated_at=? WHERE id=?",
                (col, col, _now(), task_id),
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
            AssignmentConflictError — the task already has an active
                                      assignment: the ≤1 invariant (409).
        """
        now = _now()
        with self._lock, self._conn() as db:
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
                     executor_id.strip()[:120], json.dumps(topics), now),
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

    def assignments(self, state: str | None = None,
                    task_id: str | None = None) -> list[dict[str, Any]]:
        """Assignment listing (poller inbox + UI badge source). ``state`` /
        ``task_id`` are optional exact filters; oldest first (queue order)."""
        q = "SELECT * FROM task_assignments"
        where: list[str] = []
        params: list[Any] = []
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
                          transport: str = "local-poll",
                          version: str = "") -> tuple[dict[str, Any], str]:
        """Create a PENDING registry record and mint its secret (L0, Amd 2
        §4). The board mints executor_secret (token_hex(24)); ONLY the
        sha256 hash is stored — the plaintext exists exactly once, in the
        register response (claim_token pattern, long-lived). Capabilities
        are NOT accepted here: they are owner-declared via update_executor,
        never executor-self-expanded.

        Raises:
            ValueError — empty name / unknown harness / unknown transport
                         (HTTP 422 upstream);
            ExecutorConflictError — name already registered (409);
            ExecutorQuotaError — open-pending backlog at EXECUTOR_PENDING_CAP
                         (429; PR #18 F5 — pace limits bound requests, not
                         total volume; approve/revoke/delete frees quota).
        """
        name = name.strip()[:120]
        if not name:
            raise ValueError("executor name is empty")
        if harness not in self.KNOWN_HARNESSES:
            raise ValueError(
                f"unknown harness: {harness}; known: {sorted(self.KNOWN_HARNESSES)}")
        if transport not in EXECUTOR_TRANSPORTS:
            raise ValueError(f"invalid transport: {transport}")
        secret = secrets.token_hex(24)
        secret_hash = hashlib.sha256(secret.encode("utf-8")).hexdigest()
        now = _now()
        with self._lock, self._conn() as db:
            pending = db.execute(
                "SELECT COUNT(*) AS n FROM executors WHERE state='pending'"
            ).fetchone()["n"]
            if pending >= EXECUTOR_PENDING_CAP:
                raise ExecutorQuotaError(
                    f"open pending executor registrations are capped at "
                    f"{EXECUTOR_PENDING_CAP} — approve, revoke or delete "
                    "existing ones before registering more")
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
            db.execute(
                """INSERT INTO executors
                       (id, name, harness, host, transport, capabilities,
                        version, enabled, state, secret_hash, last_seen,
                        registered_at, updated_at)
                       VALUES (?,?,?,?,?,'[]',?,0,'pending',?,'',?,?)""",
                (executor_id, name, harness, host.strip()[:200], transport,
                 version.strip()[:60], secret_hash, now, now),
            )
            # token_id = tail of the stored hash: identifies the secret
            # version in the audit trail without exposing any material
            self._log(db, "executor.registered", None, {
                "executor_id": executor_id, "name": name,
                "harness": harness, "transport": transport,
                "token_id": secret_hash[-8:],
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

    def log_board_event(self, kind: str, payload: dict[str, Any]) -> None:
        """Board-level audit event with no task attached (registry and
        settings lifecycle — executor.*, default.changed)."""
        with self._lock, self._conn() as db:
            self._log(db, kind, None, payload)

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
