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

import json
import secrets
import sqlite3
import threading
import time
from datetime import datetime, timezone
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
                        mnemos_tags, created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    task_id, col, status, pos, payload["title"],
                    payload.get("summary", ""), payload.get("spec", ""),
                    json.dumps(payload.get("agents", [])),
                    json.dumps(payload.get("specialists", [])),
                    env, payload.get("project", ""),
                    json.dumps(payload.get("memory_ids", [])),
                    json.dumps(payload.get("mnemos_tags", [])),
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

    def update_task(self, task_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        allowed = {"title", "summary", "spec", "agents", "specialists",
                   "env", "project", "memory_ids", "mnemos_tags", "status"}
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
            else:
                fields[key] = value
        if not fields:
            return self.task(task_id)
        fields["updated_at"] = _now()
        with self._lock, self._conn() as db:
            row = db.execute("SELECT id FROM tasks WHERE id=?", (task_id,)).fetchone()
            if row is None:
                return None
            sets = ", ".join(f"{k}=?" for k in fields)
            db.execute(
                f"UPDATE tasks SET {sets} WHERE id=?",  # noqa: S608 — keys from a fixed allow-list
                (*fields.values(), task_id),
            )
            self._log(db, "task.updated", task_id, {"fields": sorted(fields)})
        return self.task(task_id)

    def delete_task(self, task_id: str) -> bool:
        with self._lock, self._conn() as db:
            cur = db.execute("DELETE FROM tasks WHERE id=?", (task_id,))
            deleted = cur.rowcount > 0
            if deleted:
                # reports are payload data attached to the task (unlike the
                # events audit log) — they do not outlive it
                db.execute("DELETE FROM task_reports WHERE task_id=?", (task_id,))
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
                   agent: str = "") -> tuple[dict[str, Any], list[int]] | None:
        """Append an agent report to a task (BE-11a). A new ``final`` report
        supersedes all previous live finals (they stay in history flagged
        ``superseded``); intermediates are never touched. Returns
        (report, superseded_ids) or None when the task does not exist."""
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
            self._log(db, "task.report", task_id,
                      {"report_id": rid, "kind": kind, "agent": agent,
                       "superseded": superseded_ids})
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
