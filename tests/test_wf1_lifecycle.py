"""WF-1 task lifecycle: 7-column board, CHECK-widening table rebuild,
transition mirror, and the 24h validation sweep.

Coverage map (workflow-lifecycle-proposal §7-§8):
- migration: a pre-WF1 database (5-column CHECK, every additive column
  already present — today's prod shape) is rebuilt to the 7-column
  dictionary with rows, ids, reports and events preserved verbatim, a
  safety snapshot left in tasks_backup_wf1, NO SEED_VERSION bump;
- transitions: entering/leaving `validating` stamps/clears the 24h
  clock; blocked → done / blocked → resolved answer 422;
- sweep: stale validating tasks get the archcom tag + notification +
  SSE task.updated; fresh/off-lane/archived tasks are untouched; reruns
  never duplicate.

The legacy fixture below is a realistic dry-run of the prod migration:
it plants a 5-column-CHECK schema directly via sqlite3 (never through
Store) and then boots the real Store on top of it.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from server.seed import SEED_VERSION
from server.store import (
    ARCHCOM_REVIEW_TAG,
    COLUMN_STATUS_MAP,
    InvalidTransitionError,
    TASK_COLUMNS,
    VALID_STATUSES,
    Store,
)

SEVEN = list(TASK_COLUMNS)

# The tasks table exactly as TODAY's prod ships it: 5-column CHECK on
# col, every additive migration column (archived/status/archived_from/
# priority) already present, idx_tasks_col in place. This is the shape
# the WF-1 rebuild receives in the deploy window.
_LEGACY_DB = """
CREATE TABLE tasks (
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
    updated_at   TEXT NOT NULL,
    archived     INTEGER NOT NULL DEFAULT 0,
    status       TEXT NOT NULL DEFAULT 'open',
    archived_from TEXT NOT NULL DEFAULT '',
    priority     TEXT NOT NULL DEFAULT 'normal'
);
CREATE TABLE board_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
    kind TEXT NOT NULL, task_id TEXT, payload TEXT NOT NULL DEFAULT '{}');
CREATE TABLE task_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
    kind TEXT NOT NULL, agent TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
    superseded INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX idx_tasks_col ON tasks (col, position);
"""

_TS = "2026-01-01T00:00:00+00:00"


def _plant_legacy_db(path, tasks: list[dict], *, archived_one: bool = False,
                     with_report_for: str | None = None,
                     with_event_for: str | None = None) -> None:
    """Build the pre-WF1 database and plant tasks across the 5 old columns."""
    db = sqlite3.connect(path)
    db.executescript(_LEGACY_DB)
    db.execute("INSERT INTO board_meta (key, value) VALUES ('seed_version', ?)",
               (SEED_VERSION,))
    for pos, t in enumerate(tasks):
        db.execute(
            """INSERT INTO tasks (id, col, position, title, created_at,
                                  updated_at, archived, archived_from, status)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (t["id"], t["col"], pos, t["title"], _TS, _TS,
             1 if (archived_one and t.get("archived")) else 0,
             t.get("archived_from", ""), t["col"]),
        )
    if with_event_for:
        db.execute(
            "INSERT INTO events (ts, kind, task_id, payload) VALUES (?,?,?,?)",
            (_TS, "task.created", with_event_for, "{}"))
    if with_report_for:
        db.execute(
            """INSERT INTO task_reports
               (task_id, kind, agent, body, superseded, created_at)
               VALUES (?, 'final', 'legacy-agent', 'done earlier', 0, ?)""",
            (with_report_for, _TS))
    db.commit()
    db.close()


def _table_sql(path, table: str) -> str:
    db = sqlite3.connect(path)
    row = db.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?",
        (table,)).fetchone()
    db.close()
    return row[0] if row else ""


def _task_cols(path) -> set[str]:
    db = sqlite3.connect(path)
    cols = {r[1] for r in db.execute("PRAGMA table_info(tasks)").fetchall()}
    db.close()
    return cols


def _iso_hours_ago(hours: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)
            ).isoformat(timespec="seconds")


# --------------------------------------------------------------- migration
class TestWf1Migration:
    def test_rebuild_preserves_every_row_and_id(self, tmp_path):
        """Dry-run of the prod migration: N tasks across all 5 old columns
        (one archived) + reports + events survive the CHECK widen verbatim."""
        path = tmp_path / "board.db"
        planted = (
            [{"id": f"old-{c}-{i}", "col": c, "title": f"legacy {c} #{i}"}
             for c in ("open", "in-progress", "blocked", "resolved", "done")
             for i in (1, 2)]
            + [{"id": "old-arc-1", "col": "open", "title": "archived legacy",
                "archived": True, "archived_from": "open"}]
        )
        _plant_legacy_db(path, planted, archived_one=True,
                         with_report_for="old-done-1",
                         with_event_for="old-open-1")

        store = Store(path)  # boots _migrate: rebuild, no wipe

        for t in planted:
            task = store.task(t["id"])
            assert task is not None, f"rebuild lost {t['id']}"
            assert task["col"] == t["col"]
            assert task["title"] == t["title"]
            assert task["status"] == t["col"]  # identity for the old 5
        assert store.task("old-arc-1")["archived"] == 1
        # id-adjacent payload rows keep resolving (ids are verbatim)
        assert len(store.list_reports("old-done-1")) == 1
        assert store.task_events("old-open-1")[0]["kind"] == "task.created"

    def test_check_widened_to_seven_and_backup_created(self, tmp_path):
        path = tmp_path / "board.db"
        _plant_legacy_db(path, [{"id": "old-1", "col": "open",
                                 "title": "x"}])
        Store(path)

        sql = _table_sql(path, "tasks")
        assert "'validating'" in sql and "'backlog'" in sql
        # the live table now accepts the new dictionary values
        db = sqlite3.connect(path)
        db.execute(
            "INSERT INTO tasks (id, col, title, created_at, updated_at) "
            "VALUES ('new-1', 'backlog', 'fresh idea', '2026-01-02', '2026-01-02')")
        db.execute(
            "INSERT INTO tasks (id, col, title, created_at, updated_at) "
            "VALUES ('new-2', 'validating', 'under review', '2026-01-02', '2026-01-02')")
        db.commit()
        db.close()
        # safety snapshot exists in the same DB and holds the pre-migration rows
        db = sqlite3.connect(path)
        backup = db.execute(
            "SELECT id FROM tasks_backup_wf1").fetchall()
        db.close()
        assert [r[0] for r in backup] == ["old-1"]

    def test_migration_idempotent_and_snapshot_frozen(self, tmp_path):
        """Reopen never rebuilds twice: the snapshot keeps the pre-migration
        content even after post-migration edits (it is a point-in-time
        copy, not a mirror), and the rebuild audits exactly once."""
        path = tmp_path / "board.db"
        _plant_legacy_db(path, [{"id": "old-1", "col": "open",
                                 "title": "before"}])
        store = Store(path)
        # force: the planted 2026-01-01 created_at is outside the 24h
        # content-edit window (BE-12) — irrelevant to what we assert here
        store.update_task("old-1", {"title": "after"}, force=True)

        Store(path)  # reopen
        store2 = Store(path)  # and again

        assert store2.task("old-1")["title"] == "after"  # no wipe, no re-copy
        board_events = [e for e in store2.events()
                        if e["kind"] == "schema.wf1_tasks_rebuilt"]
        assert len(board_events) == 1, "rebuild must run exactly once"
        db = sqlite3.connect(path)
        snapshot_title = db.execute(
            "SELECT title FROM tasks_backup_wf1 WHERE id='old-1'").fetchone()[0]
        db.close()
        assert snapshot_title == "before", "snapshot is frozen pre-migration"

    def test_no_seed_version_bump_no_wipe(self, tmp_path):
        path = tmp_path / "board.db"
        _plant_legacy_db(path, [{"id": "old-1", "col": "open",
                                 "title": "precious"}])
        Store(path)
        db = sqlite3.connect(path)
        row = db.execute(
            "SELECT value FROM board_meta WHERE key='seed_version'").fetchone()
        db.close()
        assert row[0] == SEED_VERSION, "WF-1 must not ride the wipe path"

    def test_fresh_db_seven_columns_no_backup(self, tmp_path):
        """A database born on the new schema needs no rebuild: 7 columns
        from the start, no snapshot table cluttering it."""
        path = tmp_path / "board.db"
        store = Store(path)
        assert store.board()["columns"] == SEVEN
        task = store.create_task({"title": "idea", "col": "backlog"})
        assert task["col"] == "backlog"
        assert _table_sql(path, "tasks_backup_wf1") == ""

    def test_validating_since_column_exists_with_default(self, tmp_path):
        path = tmp_path / "board.db"
        _plant_legacy_db(path, [{"id": "old-1", "col": "open",
                                 "title": "x"}])
        store = Store(path)
        assert "validating_since" in _task_cols(path)
        assert store.task("old-1")["validating_since"] == ""


# ------------------------------------------------------- transition mirror
class TestMoveTransitions:
    def test_entering_validating_stamps_clock(self, tmp_path):
        store = Store(tmp_path / "board.db")
        task = store.create_task({"title": "idea", "col": "backlog"})
        before = datetime.now(timezone.utc)
        moved = store.move_task(task["id"], "validating")
        after = datetime.now(timezone.utc)
        assert moved["validating_since"]
        since = datetime.fromisoformat(moved["validating_since"])
        # _now() writes second precision — allow the truncation second
        assert before - timedelta(seconds=1) <= since <= after + timedelta(seconds=1)
        assert moved["status"] == "open"  # pre-validation lanes read as open

    def test_leaving_validating_clears_clock(self, tmp_path):
        store = Store(tmp_path / "board.db")
        task = store.create_task({"title": "idea"})
        store.move_task(task["id"], "validating")
        moved = store.move_task(task["id"], "open")
        assert moved["validating_since"] == ""
        assert moved["status"] == "open"

    def test_reorder_inside_validating_keeps_clock(self, tmp_path):
        store = Store(tmp_path / "board.db")
        a = store.create_task({"title": "a", "col": "validating"})
        store.create_task({"title": "b", "col": "validating"})
        first = store.task(a["id"])["validating_since"]
        moved = store.move_task(a["id"], "validating", position=0)
        assert moved["validating_since"] == first, \
            "a position-only move must not reset the 24h deadline"

    def test_create_in_validating_stamps_clock(self, tmp_path):
        store = Store(tmp_path / "board.db")
        task = store.create_task({"title": "born in the lane",
                                  "col": "validating"})
        assert task["validating_since"], \
            "the sweep must not skip a task born with an empty stamp"

    def test_blocked_direct_done_rejected(self, tmp_path):
        store = Store(tmp_path / "board.db")
        task = store.create_task({"title": "t"})
        store.move_task(task["id"], "blocked")
        with pytest.raises(InvalidTransitionError):
            store.move_task(task["id"], "done")
        assert store.task(task["id"])["col"] == "blocked"  # state untouched

    def test_blocked_direct_resolved_rejected(self, tmp_path):
        store = Store(tmp_path / "board.db")
        task = store.create_task({"title": "t"})
        store.move_task(task["id"], "blocked")
        with pytest.raises(InvalidTransitionError):
            store.move_task(task["id"], "resolved")

    def test_blocked_to_in_progress_and_back_open_allowed(self, tmp_path):
        """v1 keeps everything else free — the owner is free to move."""
        store = Store(tmp_path / "board.db")
        task = store.create_task({"title": "t"})
        store.move_task(task["id"], "blocked")
        store.move_task(task["id"], "in-progress")
        store.move_task(task["id"], "done")  # acceptance via resolved skipped
        assert store.task(task["id"])["col"] == "done"


# ------------------------------------------------------------- API surface
class TestApiTransitions:
    def test_move_blocked_to_done_answers_422(self, client, ui_auth, make_task):
        task = make_task()
        assert client.post(f"/api/tasks/{task['id']}/move",
                           json={"col": "blocked"},
                           headers=ui_auth).status_code == 200
        r = client.post(f"/api/tasks/{task['id']}/move",
                        json={"col": "done"}, headers=ui_auth)
        assert r.status_code == 422
        assert "недопустимый переход" in r.json()["detail"]
        # the board state is untouched
        board = client.get("/api/board").json()
        live = next(t for t in board["tasks"] if t["id"] == task["id"])
        assert live["col"] == "blocked"

    def test_move_blocked_to_resolved_answers_422(self, client, ui_auth,
                                                  make_task):
        task = make_task()
        client.post(f"/api/tasks/{task['id']}/move",
                    json={"col": "blocked"}, headers=ui_auth)
        r = client.post(f"/api/tasks/{task['id']}/move",
                        json={"col": "resolved"}, headers=ui_auth)
        assert r.status_code == 422

    def test_create_in_backlog_status_open(self, client, ui_auth, make_task):
        task = make_task(col="backlog")
        assert task["col"] == "backlog"
        assert task["status"] == "open"
        assert task["validating_since"] == ""

    def test_create_in_validating_via_api(self, client, ui_auth, make_task):
        task = make_task(col="validating")
        assert task["col"] == "validating"
        assert task["status"] == "open"
        assert task["validating_since"]

    def test_garbage_col_rejected_on_create_and_move(self, client, ui_auth,
                                                     make_task):
        assert client.post("/api/tasks",
                           json={"title": "x", "col": "banana"},
                           headers=ui_auth).status_code == 422
        task = make_task()
        for bad in ("banana", "withdrawn"):
            r = client.post(f"/api/tasks/{task['id']}/move",
                            json={"col": bad}, headers=ui_auth)
            assert r.status_code == 422, bad

    def test_move_notification_uses_ru_label(self, client, ui_auth, make_task,
                                             app_module):
        task = make_task()
        r = client.post(f"/api/tasks/{task['id']}/move",
                        json={"col": "validating"}, headers=ui_auth)
        assert r.status_code == 200
        assert app_module.COLUMN_RU["validating"] == "на валидации"
        notes = app_module.store.notifications()
        mine = [n for n in notes if n["task_id"] == task["id"]
                and "статус" in n["title"]]
        assert mine, "move must notify"
        assert "на валидации" in mine[-1]["title"]

    def test_openapi_task_out_declares_validating_since(self, client):
        spec = client.get("/openapi.json").json()
        out = spec["components"]["schemas"]["TaskOut"]
        assert "validating_since" in out["properties"]


# ------------------------------------------------------------------- sweep
class TestValidationSweep:
    """Sweep mechanics against the app's own store (reaper-tick pattern:
    drive _validation_sweep_once directly, no event loop needed)."""

    def _lane_task(self, client, app_module, make_task, hours: float | None):
        task = make_task(col="validating")
        if hours is not None:
            db = sqlite3.connect(app_module.DB_PATH)
            db.execute("UPDATE tasks SET validating_since=? WHERE id=?",
                       (_iso_hours_ago(hours), task["id"]))
            db.commit()
            db.close()
        return task

    def test_sweep_flags_stale_task(self, client, app_module, make_task,
                                    monkeypatch):
        task = self._lane_task(client, app_module, make_task, hours=25)
        captured: list[dict] = []
        monkeypatch.setattr(app_module, "_broadcast", captured.append)

        assert app_module._validation_sweep_once() == 1

        stored = app_module.store.task(task["id"])
        assert ARCHCOM_REVIEW_TAG in stored["mnemos_tags"]
        assert stored["col"] == "validating", "sweep must not move the task"
        # work notification with the decision prompt
        notes = [n for n in app_module.store.notifications()
                 if n["task_id"] == task["id"]
                 and n["category"] == "work"
                 and "подтвердить или вернуть" in n["message"]]
        assert notes
        # SSE: existing kind task.updated carrying the re-read task
        events = [e for e in captured if e.get("kind") == "task.updated"]
        assert events and ARCHCOM_REVIEW_TAG in events[-1]["task"]["mnemos_tags"]
        # audit trail
        kinds = [e["kind"] for e in app_module.store.task_events(task["id"])]
        assert "task.validation-timeout" in kinds

    def test_sweep_fresh_task_untouched(self, client, app_module, make_task,
                                        monkeypatch):
        task = self._lane_task(client, app_module, make_task, hours=1)
        captured: list[dict] = []
        monkeypatch.setattr(app_module, "_broadcast", captured.append)

        assert app_module._validation_sweep_once() == 0

        stored = app_module.store.task(task["id"])
        assert ARCHCOM_REVIEW_TAG not in stored["mnemos_tags"]
        assert not [n for n in app_module.store.notifications()
                    if n["task_id"] == task["id"]
                    and "подтвердить или вернуть" in n["message"]]

    def test_sweep_rerun_does_not_duplicate(self, client, app_module,
                                            make_task):
        task = self._lane_task(client, app_module, make_task, hours=30)
        assert app_module._validation_sweep_once() == 1
        assert app_module._validation_sweep_once() == 0  # tag = the guard

        stored = app_module.store.task(task["id"])
        assert stored["mnemos_tags"].count(ARCHCOM_REVIEW_TAG) == 1
        notes = [n for n in app_module.store.notifications()
                 if n["task_id"] == task["id"]
                 and "подтвердить или вернуть" in n["message"]]
        assert len(notes) == 1

    def test_sweep_ignores_archived_and_unstamped(self, client, app_module,
                                                  make_task, ui_auth):
        stale_archived = self._lane_task(client, app_module, make_task,
                                         hours=48)
        client.post(f"/api/tasks/{stale_archived['id']}/archive",
                    headers=ui_auth)
        unstamped = make_task(col="validating")
        db = sqlite3.connect(app_module.DB_PATH)
        db.execute("UPDATE tasks SET validating_since='' WHERE id=?",
                   (unstamped["id"],))
        db.commit()
        db.close()

        assert app_module._validation_sweep_once() == 0
        assert app_module.store.task(stale_archived["id"])["archived"] == 1
        assert ARCHCOM_REVIEW_TAG not in \
            app_module.store.task(unstamped["id"])["mnemos_tags"]


# -------------------------------------------------------------- board shape
class TestBoardSevenColumns:
    def test_board_columns_and_counts(self, client, ui_auth, make_task):
        before = client.get("/api/board").json()
        assert before["columns"] == SEVEN
        assert list(before["counts"]) == SEVEN
        task = make_task(col="backlog")
        after = client.get("/api/board").json()
        assert after["counts"]["backlog"] == before["counts"]["backlog"] + 1
        assert set(after["counts"]) == set(SEVEN)

    def test_column_ru_covers_seven(self, app_module):
        assert set(app_module.COLUMN_RU) == set(VALID_STATUSES)
        assert all(v.strip() for v in app_module.COLUMN_RU.values())
        assert app_module.COLUMN_RU["backlog"] == "бэклог"

    def test_column_status_map_covers_seven(self):
        assert set(COLUMN_STATUS_MAP) == set(VALID_STATUSES)
        assert {COLUMN_STATUS_MAP[c] for c in ("backlog", "validating",
                                               "open")} == {"open"}

    def test_archive_filter_accepts_new_columns(self, client, ui_auth,
                                                make_task):
        task = make_task(col="backlog")
        client.post(f"/api/tasks/{task['id']}/archive", headers=ui_auth)
        r = client.get("/api/archive", params={"col": "backlog"}).json()
        assert task["id"] in [t["id"] for t in r["items"]]
        assert client.get(
            "/api/archive", params={"col": "banana"}).status_code == 422
        r2 = client.get("/api/archive", params={"col": "validating"}).json()
        assert task["id"] not in [t["id"] for t in r2["items"]]
