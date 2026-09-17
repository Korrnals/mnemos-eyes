"""One-shot idempotent backfill of final reports for closed tasks
(BE-7 owner-feedback wave). Pinned here:

- exactly one kind="final" report (agent="history-backfill") per closed
  task; done AND resolved columns; archived tasks covered via
  archived_from/col; open/in-progress/blocked tasks untouched;
- body is an honest summary of the audit trail (creation ts, move chain,
  linked-memory count);
- created_at is the task's LAST event ts, never "now";
- idempotency: second run creates nothing (board_meta flag), tasks with
  existing reports are never touched even with the flag cleared;
- the app boots the backfill only under VESMARO_BACKFILL_REPORTS=1
  (lifespan hook).
"""

from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from server.store import Store

DB = "board.db"


def _reports(db_path, task_id: str) -> list[dict]:
    db = sqlite3.connect(db_path)
    db.row_factory = sqlite3.Row
    rows = [dict(r) for r in db.execute(
        "SELECT id, task_id, kind, agent, body, superseded, created_at "
        "FROM task_reports WHERE task_id=? ORDER BY id", (task_id,)).fetchall()]
    db.close()
    return rows


def _close(store: Store, task_id: str, *cols: str) -> None:
    for col in cols:
        assert store.move_task(task_id, col) is not None


class TestBackfillStore:
    def test_creates_single_final_for_done_and_resolved(self, tmp_path):
        store = Store(tmp_path / DB)
        done = store.create_task({"title": "closed-done"})
        _close(store, done["id"], "in-progress", "done")
        resolved = store.create_task({"title": "closed-resolved"})
        _close(store, resolved["id"], "resolved")
        untouched = store.create_task({"title": "still-open"})

        created = store.backfill_reports()

        assert created == 2
        for tid in (done["id"], resolved["id"]):
            reps = _reports(tmp_path / DB, tid)
            assert len(reps) == 1
            rep = reps[0]
            assert rep["kind"] == "final"
            assert rep["agent"] == "history-backfill"
            assert rep["superseded"] == 0
            assert rep["body"].startswith("Автоотчёт из истории событий (бэкфилл ")
        assert _reports(tmp_path / DB, untouched["id"]) == []

    def test_move_chain_and_memory_count_in_body(self, tmp_path):
        store = Store(tmp_path / DB)
        task = store.create_task({"title": "chain", "memory_ids": ["m1", "m2"]})
        _close(store, task["id"], "in-progress", "done")

        assert store.backfill_reports() == 1
        body = _reports(tmp_path / DB, task["id"])[0]["body"]
        assert "создана " in body
        assert "перемещена open → in-progress → done (последняя " in body
        assert "связанных памятей: 2" in body

    def test_no_moves_documented_in_body(self, tmp_path):
        store = Store(tmp_path / DB)
        task = store.create_task({"title": "never-moved", "col": "done"})
        store.backfill_reports()
        body = _reports(tmp_path / DB, task["id"])[0]["body"]
        assert "перемещений не зафиксировано" in body

    def test_created_at_from_last_event_not_now(self, tmp_path):
        store = Store(tmp_path / DB)
        task = store.create_task({"title": "old-work"})
        _close(store, task["id"], "done")
        # pin the task's whole audit trail to a fixed past moment: the real
        # board holds months-old closures and the report must carry that date
        db = sqlite3.connect(tmp_path / DB)
        db.execute("UPDATE events SET ts=? WHERE task_id=?",
                   ("2026-03-01T12:00:00+00:00", task["id"]))
        db.commit()
        db.close()

        store.backfill_reports()

        rep = _reports(tmp_path / DB, task["id"])[0]
        assert rep["created_at"] == "2026-03-01T12:00:00+00:00"
        assert "создана 2026-03-01T12:00:00+00:00" in rep["body"]

    def test_double_run_creates_nothing_new(self, tmp_path):
        store = Store(tmp_path / DB)
        task = store.create_task({"title": "idem"})
        _close(store, task["id"], "done")

        assert store.backfill_reports() == 1
        assert store.backfill_reports() == 0  # flag armed -> no-op
        assert store.backfill_reports() == 0
        assert len(_reports(tmp_path / DB, task["id"])) == 1
        assert store.get_meta(Store.BACKFILL_META_KEY) == "1"

    def test_tasks_with_reports_never_touched_even_without_flag(self, tmp_path):
        store = Store(tmp_path / DB)
        task = store.create_task({"title": "guarded"})
        _close(store, task["id"], "done")
        assert store.backfill_reports() == 1
        backfilled = _reports(tmp_path / DB, task["id"])

        store.set_meta(Store.BACKFILL_META_KEY, "0")  # operator cleared it
        manual, _superseded = store.add_report(task["id"], "human final",
                                               "final", "zcode")
        assert store.backfill_reports() == 0

        # exactly the two pre-existing reports: nothing appended, no body
        # rewritten
        reps = _reports(tmp_path / DB, task["id"])
        assert [r["id"] for r in reps] == [backfilled[0]["id"], manual["id"]]
        assert reps[0]["body"] == backfilled[0]["body"]
        assert reps[1]["body"] == "human final"

    def test_archived_closed_task_covered(self, tmp_path):
        store = Store(tmp_path / DB)
        task = store.create_task({"title": "archived-done"})
        _close(store, task["id"], "done")
        assert store.archive_task(task["id"])
        # gone from the board projection, still a backfill candidate
        assert all(t["id"] != task["id"] for t in store.board()["tasks"])

        assert store.backfill_reports() == 1
        assert len(_reports(tmp_path / DB, task["id"])) == 1

    def test_archived_via_archived_from_column(self, tmp_path):
        """A task archived while sitting in a done/resolved column is matched
        through archived_from even if its col was later rewritten."""
        store = Store(tmp_path / DB)
        task = store.create_task({"title": "arch-from"})
        _close(store, task["id"], "resolved")
        assert store.archive_task(task["id"])
        db = sqlite3.connect(tmp_path / DB)
        db.execute("UPDATE tasks SET col='open' WHERE id=?", (task["id"],))
        db.commit()
        db.close()

        assert store.backfill_reports() == 1

    def test_meta_helpers_roundtrip(self, tmp_path):
        store = Store(tmp_path / DB)
        assert store.get_meta("missing") is None
        store.set_meta("k", "v1")
        store.set_meta("k", "v2")  # upsert, not insert
        assert store.get_meta("k") == "v2"


class TestStartupHook:
    def test_lifespan_backfill_only_under_env_flag(self, client, auth,
                                                   make_task, app_module,
                                                   monkeypatch):
        task = make_task(title="boot-backfill")
        assert client.post(f"/api/tasks/{task['id']}/move",
                           json={"col": "done"}, headers=auth).status_code == 200
        # order-independent: clear a possibly armed flag from earlier tests
        app_module.store.set_meta(Store.BACKFILL_META_KEY, "0")

        # plain boot (no env): no report may appear
        with TestClient(app_module.app):
            pass
        assert client.get(f"/api/tasks/{task['id']}/reports").json()["count"] == 0

        # flagged boot: exactly one backfill report; a second flagged boot
        # is a no-op
        monkeypatch.setenv("VESMARO_BACKFILL_REPORTS", "1")
        with TestClient(app_module.app):
            pass
        items = client.get(f"/api/tasks/{task['id']}/reports").json()["items"]
        assert len(items) == 1
        assert items[0]["agent"] == "history-backfill"
        with TestClient(app_module.app):
            pass
        assert client.get(f"/api/tasks/{task['id']}/reports").json()["count"] == 1
