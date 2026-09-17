"""BE-12: task priority dictionary + 24h content-edit window.

Covered here:

- migration: pre-BE-12 databases gain the priority column via additive
  ALTER TABLE with DEFAULT 'normal' (no backfill needed); NO task loss and
  NO SEED_VERSION bump (the seed-version check wipes tasks — the known
  trap, workflow-lifecycle-proposal §7);
- create: priority defaults to 'normal', explicit dictionary values are
  honored, garbage answers 422;
- PATCH: priority validated like env/status; task.updated event carries
  the field;
- 24h edit window: content fields (EDITABLE_FIELDS) on a task older than
  24h answer 423 unless the PATCH carries force=true; forced writes are
  echoed with ``forced: true`` and audited in the event payload;
- status is NOT content: PATCH status stays free at any age (UI-8
  «Вернуть в работу» never hits the window);
- ``col`` PATCH is silently ignored by the store allow-list (columns move
  via POST /move) — documented v1 semantics, not an error;
- ``force`` is a request mode, never persisted as a task field.

Store-level tests run on their own throwaway Store paths; API tests use
the shared conftest contour and age their tasks by rewriting created_at
in the session database (the store opens a fresh connection per call, so
external writes are visible).
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from server.seed import SEED_VERSION
from server.store import EDITABLE_FIELDS, EDIT_WINDOW_SECONDS, Store


# ---------------------------------------------------------------- helpers
def _age_task_db(path, task_id: str, *, hours: float = 25.0) -> None:
    """Rewrite created_at so the task looks ``hours`` old."""
    old = (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat(
        timespec="seconds")
    db = sqlite3.connect(path)
    db.execute("UPDATE tasks SET created_at=? WHERE id=?", (old, task_id))
    db.commit()
    db.close()


def _make_pre_be12_db(path, tasks: list[dict]) -> None:
    """Create a database with the BE-11b-era tasks schema (status,
    archived and archived_from present; priority absent) and plant rows."""
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE board_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
            archived_from TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE events (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            ts       TEXT NOT NULL,
            kind     TEXT NOT NULL,
            task_id  TEXT,
            payload  TEXT NOT NULL DEFAULT '{}'
        );
        """
    )
    db.execute("INSERT INTO board_meta (key, value) VALUES ('seed_version', ?)",
               (SEED_VERSION,))
    for pos, t in enumerate(tasks):
        db.execute(
            "INSERT INTO tasks (id, col, position, title, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?)",
            (t["id"], t["col"], pos, t["title"], "2026-01-01T00:00:00+00:00",
             "2026-01-01T00:00:00+00:00"),
        )
    db.commit()
    db.close()


# --------------------------------------------------------------- migration
class TestPriorityMigration:
    def test_old_db_gains_priority_no_wipe(self, tmp_path):
        path = tmp_path / "board.db"
        planted = [
            {"id": "old-1", "col": "open", "title": "legacy open"},
            {"id": "old-2", "col": "done", "title": "legacy done"},
        ]
        _make_pre_be12_db(path, planted)

        store = Store(path)  # runs _migrate; must NOT wipe

        # raw connection has no Row factory: PRAGMA table_info name is index 1
        cols = {r[1] for r in sqlite3.connect(path).execute(
            "PRAGMA table_info(tasks)").fetchall()}
        assert "priority" in cols
        for planted_task in planted:
            task = store.task(planted_task["id"])
            assert task is not None, "migration must not lose tasks"
            assert task["title"] == planted_task["title"]
            # column DEFAULT covers pre-migration rows — no backfill needed
            assert task["priority"] == "normal"

    def test_migration_does_not_bump_seed_version(self, tmp_path):
        """Column additions must not ride the destructive seed-version path."""
        path = tmp_path / "board.db"
        _make_pre_be12_db(path, [{"id": "old-1", "col": "open", "title": "x"}])
        Store(path)
        row = sqlite3.connect(path).execute(
            "SELECT value FROM board_meta WHERE key='seed_version'").fetchone()
        assert row[0] == SEED_VERSION

    def test_fresh_store_seeds_priority_normal(self, tmp_path):
        store = Store(tmp_path / "board.db")
        assert all(t["priority"] == "normal" for t in store.board()["tasks"])


# ------------------------------------------------------- priority: create
class TestCreatePriority:
    def test_default_priority_is_normal(self, client, auth, make_task):
        task = make_task(title="be12-prio-default")
        assert task["priority"] == "normal"

    def test_explicit_priority_honored(self, client, auth, make_task):
        task = make_task(title="be12-prio-explicit", priority="critical")
        assert task["priority"] == "critical"

    @pytest.mark.parametrize("bad", ["urgent", "", "HIGH", "top"])
    def test_invalid_priority_422(self, client, auth, bad):
        r = client.post("/api/tasks",
                        json={"title": "be12-prio-bad", "priority": bad},
                        headers=auth)
        assert r.status_code == 422
        assert "invalid priority" in r.text


# ----------------------------------------------- priority: patch + board
class TestPatchAndBoardPriority:
    def test_patch_priority_and_event(self, client, auth, make_task,
                                      app_module):
        task = make_task(title="be12-prio-patch")
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"priority": "high"}, headers=auth)
        assert r.status_code == 200
        assert r.json()["priority"] == "high"
        update_events = [e for e in app_module.store.task_events(task["id"])
                         if e["kind"] == "task.updated"]
        assert update_events, "priority edit must be audited"
        assert "priority" in update_events[0]["payload"]["fields"]

    def test_patch_priority_garbage_422(self, client, auth, make_task):
        task = make_task(title="be12-prio-patch-bad")
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"priority": "asap"}, headers=auth)
        assert r.status_code == 422
        assert "invalid priority" in r.text

    def test_board_tasks_carry_priority(self, client, auth, make_task):
        task = make_task(title="be12-board-prio", priority="low")
        board = client.get("/api/board").json()
        mine = next(t for t in board["tasks"] if t["id"] == task["id"])
        assert mine["priority"] == "low"


# ---------------------------------------------------------- 24h edit window
class TestEditWindow:
    def test_content_fields_are_the_locked_set(self):
        """Pin the documented window scope: workflow machinery (status, col,
        position, archived, id, created_at) is never window-guarded."""
        assert EDITABLE_FIELDS == frozenset({
            "title", "summary", "spec", "project", "env", "priority",
            "agents", "specialists", "memory_ids", "mnemos_tags",
        })
        assert EDIT_WINDOW_SECONDS == 86400

    def test_old_task_content_edit_423(self, client, auth, make_task,
                                       data_dir):
        task = make_task(title="be12-old", summary="before")
        _age_task_db(data_dir / "board.db", task["id"], hours=25)
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"summary": "after"}, headers=auth)
        assert r.status_code == 423
        assert r.json()["detail"] == (
            "задача старше 24ч — редактирование заблокировано "
            "(force=true для принудительной правки)")
        # nothing was written
        board_task = next(t for t in client.get("/api/board").json()["tasks"]
                          if t["id"] == task["id"])
        assert board_task["summary"] == "before"

    def test_old_task_edit_with_force_succeeds(self, client, auth, make_task,
                                               data_dir):
        task = make_task(title="be12-forced", summary="before")
        _age_task_db(data_dir / "board.db", task["id"], hours=25)
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"summary": "after", "force": True},
                         headers=auth)
        assert r.status_code == 200
        body = r.json()
        assert body["summary"] == "after"
        assert body["forced"] is True

    def test_young_task_edit_needs_no_force(self, client, auth, make_task):
        task = make_task(title="be12-young")
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"summary": "fresh edit"}, headers=auth)
        assert r.status_code == 200
        assert "forced" not in r.json(), \
            "forced flag only appears on an actual force=true request"
        assert r.json()["summary"] == "fresh edit"

    def test_force_is_never_persisted_as_a_task_field(self, client, auth,
                                                      make_task):
        task = make_task(title="be12-force-mode")
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"title": "renamed", "force": True},
                         headers=auth)
        assert r.status_code == 200
        assert "force" not in r.json()
        board_task = next(t for t in client.get("/api/board").json()["tasks"]
                          if t["id"] == task["id"])
        assert board_task["title"] == "renamed"
        assert "force" not in board_task

    def test_status_patch_free_at_any_age(self, client, auth, make_task,
                                          data_dir):
        """UI-8 «Вернуть в работу»: PATCH status is a workflow transition,
        not a content edit — the 24h window never applies to it."""
        task = make_task(title="be12-status-free")
        _age_task_db(data_dir / "board.db", task["id"], hours=48)
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"status": "in-progress"}, headers=auth)
        assert r.status_code == 200
        assert r.json()["status"] == "in-progress"

    def test_col_patch_silently_ignored(self, client, auth, make_task):
        """Documented v1 semantics: ``col`` is not in the store allow-list
        (columns move via POST /move) — a PATCH carrying it is a no-op for
        that key (200 + unchanged col), NOT a 422."""
        task = make_task(title="be12-col-ignored")
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"col": "done", "summary": "kept"},
                         headers=auth)
        assert r.status_code == 200
        assert r.json()["col"] == "open", "col must not change via PATCH"
        assert r.json()["summary"] == "kept", "editable keys still apply"

    def test_project_is_editable(self, client, auth, make_task):
        """Allow-list confirmation: project editing stays available (and is
        window-guarded like every other content field)."""
        task = make_task(title="be12-project", project="mnemos-eyes")
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"project": "mnemos-mesh"}, headers=auth)
        assert r.status_code == 200
        assert r.json()["project"] == "mnemos-mesh"


# ---------------------------------------------------- store-level window
class TestStoreWindowSemantics:
    def test_locked_update_raises_and_force_overrides(self, tmp_path):
        path = tmp_path / "board.db"
        store = Store(path)
        task = store.create_task({"title": "store-window"})
        _age_task_db(path, task["id"], hours=25)

        with pytest.raises(Exception) as excinfo:
            store.update_task(task["id"], {"title": "late edit"})
        from server.store import TaskLockedError
        assert isinstance(excinfo.value, TaskLockedError)

        forced = store.update_task(task["id"], {"title": "late edit"},
                                   force=True)
        assert forced["title"] == "late edit"
        update_events = [e for e in store.task_events(task["id"])
                         if e["kind"] == "task.updated"]
        assert update_events[-1]["payload"].get("forced") is True
        assert "title" in update_events[-1]["payload"]["fields"]

    def test_status_only_patch_bypasses_window(self, tmp_path):
        path = tmp_path / "board.db"
        store = Store(path)
        task = store.create_task({"title": "store-status"})
        _age_task_db(path, task["id"], hours=48)
        updated = store.update_task(task["id"], {"status": "withdrawn"})
        assert updated["status"] == "withdrawn"

    def test_nonforced_event_payload_has_no_forced_key(self, tmp_path):
        path = tmp_path / "board.db"
        store = Store(path)
        task = store.create_task({"title": "store-plain"})
        store.update_task(task["id"], {"summary": "plain"})
        update_events = [e for e in store.task_events(task["id"])
                         if e["kind"] == "task.updated"]
        assert "forced" not in update_events[-1]["payload"]
