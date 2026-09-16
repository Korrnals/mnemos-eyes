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
        # schema evolution for pre-0.7 databases
        cols = {r["name"] for r in db.execute(
            "PRAGMA table_info(tasks)").fetchall()}
        if "archived" not in cols:
            db.execute("ALTER TABLE tasks ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
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
                       (id, col, position, title, summary, spec, agents,
                        specialists, env, project, memory_ids, mnemos_tags,
                        created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    task["id"],
                    task["col"],
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

    # ----------------------------------------------------------------- read
    def board(self) -> dict[str, Any]:
        with self._lock, self._conn() as db:
            tasks = [dict(r) for r in db.execute(
                "SELECT * FROM tasks WHERE archived=0 ORDER BY col, position"
            ).fetchall()]
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
                       (id, col, position, title, summary, spec, agents,
                        specialists, env, project, memory_ids, mnemos_tags,
                        created_at, updated_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    task_id, col, pos, payload["title"],
                    payload.get("summary", ""), payload.get("spec", ""),
                    json.dumps(payload.get("agents", [])),
                    json.dumps(payload.get("specialists", [])),
                    env, payload.get("project", ""),
                    json.dumps(payload.get("memory_ids", [])),
                    json.dumps(payload.get("mnemos_tags", [])),
                    now, now,
                ),
            )
            self._log(db, "task.created", task_id, {"col": col})
        return self.task(task_id)  # type: ignore[return-value]

    def move_task(self, task_id: str, col: str, position: int | None = None) -> dict[str, Any] | None:
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
                "UPDATE tasks SET col=?, position=?, updated_at=? WHERE id=?",
                (col, position, _now(), task_id),
            )
            self._log(db, "task.moved", task_id, {"from": row["col"], "to": col})
        return self.task(task_id)

    def update_task(self, task_id: str, patch: dict[str, Any]) -> dict[str, Any] | None:
        allowed = {"title", "summary", "spec", "agents", "specialists",
                   "env", "project", "memory_ids", "mnemos_tags"}
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
        with self._lock, self._conn() as db:
            cur = db.execute(
                "UPDATE tasks SET archived=1, updated_at=? WHERE id=? AND archived=0",
                (_now(), task_id),
            )
            done = cur.rowcount > 0
            if done:
                self._log(db, "task.archived", task_id, {})
        return done

    def unarchive_task(self, task_id: str) -> bool:
        with self._lock, self._conn() as db:
            cur = db.execute(
                "UPDATE tasks SET archived=0, updated_at=? WHERE id=? AND archived=1",
                (_now(), task_id),
            )
            return cur.rowcount > 0

    def archived_tasks(self) -> list[dict[str, Any]]:
        with self._lock, self._conn() as db:
            rows = [dict(r) for r in db.execute(
                "SELECT * FROM tasks WHERE archived=1 ORDER BY updated_at DESC"
            ).fetchall()]
        for t in rows:
            for k in ("agents", "specialists", "memory_ids", "mnemos_tags"):
                t[k] = _loads(t[k])
        return rows

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
