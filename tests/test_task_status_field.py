"""BE-10: per-task workflow status field.

Dictionary = mnemos workflow state machine (open/in-progress/blocked/
resolved/done/withdrawn). Covered here:

- migration: pre-BE-10 databases gain the status + archived_from columns
  via additive ALTER TABLE with a col->status backfill; NO task loss and
  NO SEED_VERSION bump (the seed-version check wipes tasks — the known
  trap, workflow-lifecycle-proposal §7);
- create: status derives from col, explicit status honored, garbage 422;
- PATCH: dictionary validation incl. `withdrawn` (no board column);
- move: synchronously re-derives status from the column (v1 semantics —
  a manually PATCHed status lives until the next move);
- GET /api/board: status on every task + ?status= filter (422 on garbage).

Store-level tests run on their own throwaway Store paths; API tests use
the shared conftest contour and tag their tasks with unique prefixes so
they never collide with the session-persistent DB.
"""

from __future__ import annotations

import sqlite3

import pytest

from server.seed import SEED_VERSION
from server.store import Store


# --------------------------------------------------------------- migration
def _make_pre_be10_db(path, tasks: list[dict]) -> None:
    """Create a database with the pre-BE-10 tasks schema (no status, no
    archived_from; archived already present as on main) and plant rows."""
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
            archived     INTEGER NOT NULL DEFAULT 0
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


class TestMigrationPreservesTasks:
    def test_old_db_gains_status_backfilled_no_wipe(self, tmp_path):
        path = tmp_path / "board.db"
        planted = [
            {"id": "old-1", "col": "open", "title": "legacy open"},
            {"id": "old-2", "col": "in-progress", "title": "legacy wip"},
            {"id": "old-3", "col": "done", "title": "legacy done"},
        ]
        _make_pre_be10_db(path, planted)

        store = Store(path)  # runs _migrate; must NOT wipe

        # raw connection has no Row factory: PRAGMA table_info columns are
        # (cid, name, type, ...), so the name lives at index 1
        cols = {r[1] for r in sqlite3.connect(path).execute(
            "PRAGMA table_info(tasks)").fetchall()}
        assert {"status", "archived_from"} <= cols
        for planted_task in planted:
            task = store.task(planted_task["id"])
            assert task is not None, "migration must not lose tasks"
            assert task["title"] == planted_task["title"]
            # backfill: status equals the column it lived in
            assert task["status"] == planted_task["col"]
        assert store.task("old-2")["archived_from"] == ""

    def test_backfill_runs_exactly_once(self, tmp_path):
        """A PATCHed status must survive reopen (no re-backfill on boot)."""
        path = tmp_path / "board.db"
        _make_pre_be10_db(path, [{"id": "old-1", "col": "open",
                                  "title": "patched later"}])
        store = Store(path)
        store.update_task("old-1", {"status": "withdrawn"})
        assert store.task("old-1")["status"] == "withdrawn"

        Store(path).task("old-1")  # reopen
        assert Store(path).task("old-1")["status"] == "withdrawn"

    def test_seed_version_not_bumped(self, tmp_path):
        """Column additions must not ride the destructive seed-version path."""
        path = tmp_path / "board.db"
        _make_pre_be10_db(path, [{"id": "old-1", "col": "open", "title": "x"}])
        Store(path)
        row = sqlite3.connect(path).execute(
            "SELECT value FROM board_meta WHERE key='seed_version'").fetchone()
        assert row[0] == SEED_VERSION

    def test_fresh_store_seeds_status_from_col(self, tmp_path):
        store = Store(tmp_path / "board.db")
        for t in store.board()["tasks"]:
            assert t["status"] == t["col"]


# ------------------------------------------------------------------ create
class TestCreateDerivesStatus:
    def test_status_defaults_to_col(self, client, auth, make_task):
        task = make_task(title="be10-derive", col="done")
        assert task["status"] == "done"

    def test_explicit_status_honored(self, client, auth, make_task):
        task = make_task(title="be10-explicit", col="open", status="blocked")
        assert task["col"] == "open"
        assert task["status"] == "blocked"

    @pytest.mark.parametrize("bad", ["cancelled", "in progress", "OPEN", ""])
    def test_invalid_status_422(self, client, auth, bad):
        r = client.post("/api/tasks",
                        json={"title": "be10-bad", "status": bad},
                        headers=auth)
        assert r.status_code == 422

    def test_client_supplied_id_request_still_accepted(self, client, auth):
        """UI-7 v1.1.3-era clients may include an ``id`` in the create
        payload. Pinned contract: such a request is accepted (201) and
        returns a well-formed TaskOut — adding the status field must not
        start rejecting legacy extra keys. (Note: the API model has never
        honored client ids — the server-generated id is authoritative in
        the response.)"""
        r = client.post("/api/tasks",
                        json={"id": "be10-client-id-1", "title": "client id",
                              "col": "blocked"},
                        headers=auth)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["id"]  # server always returns a concrete task id
        assert body["title"] == "client id"
        assert body["col"] == "blocked"
        assert body["status"] == "blocked"
        client.delete(f"/api/tasks/{body['id']}", headers=auth)


# -------------------------------------------------------------------- patch
class TestPatchStatus:
    def test_patch_status_valid(self, client, auth, make_task):
        task = make_task(title="be10-patch")
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"status": "blocked"}, headers=auth)
        assert r.status_code == 200
        assert r.json()["status"] == "blocked"
        # col untouched — status is a separate dimension in v1
        assert r.json()["col"] == "open"

    def test_patch_status_withdrawn_allowed(self, client, auth, make_task):
        """`withdrawn` is in the workflow dictionary though it has no board
        column (cancelled tasks are archived, WF-1 §7)."""
        task = make_task(title="be10-withdrawn")
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"status": "withdrawn"}, headers=auth)
        assert r.status_code == 200
        assert r.json()["status"] == "withdrawn"
        assert r.json()["col"] == "open"

    def test_patch_status_garbage_422(self, client, auth, make_task):
        task = make_task(title="be10-patch-bad")
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"status": "finished"}, headers=auth)
        assert r.status_code == 422
        assert "invalid status" in r.text

    def test_move_overwrites_patched_status(self, client, auth, make_task):
        """Documented v1 semantics: move re-derives status from the column;
        a manual PATCH lives only until the next move (filter stays honest
        with the kanban state)."""
        task = make_task(title="be10-move-wins")
        client.patch(f"/api/tasks/{task['id']}",
                     json={"status": "blocked"}, headers=auth)
        r = client.post(f"/api/tasks/{task['id']}/move",
                        json={"col": "done"}, headers=auth)
        assert r.status_code == 200
        assert r.json()["col"] == "done"
        assert r.json()["status"] == "done"


# ------------------------------------------------------------------- board
class TestBoardStatusFieldAndFilter:
    def test_board_tasks_carry_status(self, client, auth, make_task):
        task = make_task(title="be10-board-shape")
        board = client.get("/api/board").json()
        mine = next(t for t in board["tasks"] if t["id"] == task["id"])
        assert mine["status"] == "open"

    def test_status_filter(self, client, auth, make_task):
        task = make_task(title="be10-filter-hit", status="blocked")
        r = client.get("/api/board", params={"status": "blocked"})
        assert r.status_code == 200
        ids = [t["id"] for t in r.json()["tasks"]]
        assert task["id"] in ids
        assert all(t["status"] == "blocked" for t in r.json()["tasks"])

    def test_status_filter_excludes_other_statuses(self, client, auth,
                                                   make_task):
        make_task(title="be10-filter-miss")  # status=open
        r = client.get("/api/board", params={"status": "withdrawn"})
        assert r.status_code == 200
        assert all(t["status"] == "withdrawn" for t in r.json()["tasks"])

    def test_status_filter_garbage_422(self, client):
        r = client.get("/api/board", params={"status": "nonsense"})
        assert r.status_code == 422

    def test_counts_not_affected_by_filter(self, client, auth, make_task):
        make_task(title="be10-counts")
        unfiltered = client.get("/api/board").json()["counts"]
        filtered = client.get("/api/board",
                              params={"status": "done"}).json()["counts"]
        assert filtered == unfiltered, "counts describe the whole board"
