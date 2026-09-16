"""Store layer (SQLite): schema, seed, migration idempotency, archive,
notifications, server_log secret masking.

Every test builds its own throwaway ``Store`` on a tmp path — no app
import, no network, no shared state.

CAUTION pinned here deliberately: ``_migrate`` WIPES all tasks whenever
the stored seed_version differs from ``server.seed.SEED_VERSION`` (a seed
layout bump re-seeds from fixtures and destroys user data). The
idempotency test proves a normal reopen does NOT wipe; the bump test
documents the destructive path so a future seed change is a conscious,
test-visible decision.
"""

from __future__ import annotations

import sqlite3

import pytest

from server.store import COLUMNS, VALID_ENVS, VALID_STATUSES, Store

EXPECTED_TABLES = {
    "board_meta", "tasks", "events", "memory_servers", "memory_groups",
    "notifications", "group_log", "server_log", "profile_cache",
}


def _tables(path) -> set[str]:
    db = sqlite3.connect(path)
    rows = db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    db.close()
    return {r[0] for r in rows}


# ------------------------------------------------------------------- schema
class TestSchema:
    def test_all_tables_created(self, tmp_path):
        Store(tmp_path / "board.db")
        assert EXPECTED_TABLES - _tables(tmp_path / "board.db") == set()

    def test_board_shape(self, tmp_path):
        board = Store(tmp_path / "board.db").board()
        assert board["columns"] == list(COLUMNS)
        assert set(board["counts"].keys()) == set(COLUMNS)
        assert isinstance(board["tasks"], list)


# --------------------------------------------------------------------- seed
class TestSeed:
    def test_fresh_store_seeds_tasks(self, tmp_path):
        tasks = Store(tmp_path / "board.db").board()["tasks"]
        assert tasks, "fresh store must seed the shipped fixtures"
        ids = [t["id"] for t in tasks]
        assert len(ids) == len(set(ids)), "seed ids must be unique"
        for t in tasks:
            assert t["col"] in VALID_STATUSES
            assert t["env"] in VALID_ENVS

    def test_reopen_is_idempotent_no_wipe(self, tmp_path):
        """Opening the same DB again must NOT reseed or erase anything."""
        path = tmp_path / "board.db"
        s1 = Store(path)
        mine = s1.create_task({"title": "user task", "env": "laptop"})
        before = s1.board()["tasks"]

        s2 = Store(path)  # reopen: same seed_version -> no migration
        after = s2.board()["tasks"]

        assert [t["id"] for t in after] == [t["id"] for t in before]
        assert s2.task(mine["id"]) is not None
        assert Store(path).task(mine["id"]) is not None  # third open, same

    def test_seed_version_bump_wipes_user_tasks(self, tmp_path, monkeypatch):
        """Documents the destructive migration: a SEED_VERSION change wipes
        user tasks and reseeds from fixtures. If this test starts failing
        because the behavior changed, update it consciously."""
        import server.seed as seed_module

        path = tmp_path / "board.db"
        s1 = Store(path)
        mine = s1.create_task({"title": "precious user data"})

        monkeypatch.setattr(seed_module, "SEED_VERSION", "qa-bumped-version")
        s2 = Store(path)

        assert s2.task(mine["id"]) is None, "bump must wipe user tasks"
        reseeded = {t["id"] for t in s2.board()["tasks"]}
        assert reseeded, "bump reseeds from shipped fixtures"


# --------------------------------------------------------------------- CRUD
class TestTaskCrud:
    def test_create_read_back_defaults(self, tmp_path):
        store = Store(tmp_path / "board.db")
        task = store.create_task({"title": "t1"})
        assert task["title"] == "t1"
        assert task["col"] == "open"
        assert task["env"] == "unknown"
        assert task["agents"] == [] and task["specialists"] == []
        assert task["position"] >= 0
        assert task["created_at"] and task["updated_at"]

    def test_create_positions_increment_within_column(self, tmp_path):
        store = Store(tmp_path / "board.db")
        # explicit ids: default ids carry a random suffix besides the
        # millisecond timestamp
        a = store.create_task({"id": "qa-a", "title": "a", "col": "done"})
        b = store.create_task({"id": "qa-b", "title": "b", "col": "done"})
        assert b["position"] > a["position"]

    def test_rapid_creates_do_not_collide(self, tmp_path, monkeypatch):
        """Regression (QA-1): with the clock frozen, two creates used to
        derive the same millisecond id and hit the tasks.id UNIQUE
        constraint (sqlite3.IntegrityError -> HTTP 500). The random suffix
        in create_task must keep the second create working."""
        import types
        monkeypatch.setattr("server.store.time",
                            types.SimpleNamespace(time=lambda: 1234567890.123))
        store = Store(tmp_path / "board.db")
        a = store.create_task({"title": "a"})
        b = store.create_task({"title": "b"})
        assert a["id"] != b["id"]

    def test_create_rejects_bad_env_and_col(self, tmp_path):
        store = Store(tmp_path / "board.db")
        with pytest.raises(ValueError, match="invalid env"):
            store.create_task({"title": "x", "env": "staging"})
        with pytest.raises(ValueError, match="invalid col"):
            store.create_task({"title": "x", "col": "backlog"})

    def test_move_task(self, tmp_path):
        store = Store(tmp_path / "board.db")
        task = store.create_task({"title": "mover", "col": "open"})
        moved = store.move_task(task["id"], "done")
        assert moved is not None and moved["col"] == "done"
        kinds = [e["kind"] for e in store.task_events(task["id"])]
        assert "task.moved" in kinds

    def test_move_rejects_bad_col_and_unknown_id(self, tmp_path):
        store = Store(tmp_path / "board.db")
        task = store.create_task({"title": "x"})
        with pytest.raises(ValueError, match="invalid col"):
            store.move_task(task["id"], "nowhere")
        assert store.move_task("no-such-id", "done") is None

    def test_update_fields_env_validation_and_allowlist(self, tmp_path):
        store = Store(tmp_path / "board.db")
        task = store.create_task({"title": "u", "env": "local"})
        updated = store.update_task(task["id"], {
            "summary": "sum", "env": "cluster", "col": "done",  # col not writable
        })
        assert updated["summary"] == "sum"
        assert updated["env"] == "cluster"
        assert updated["col"] == "open", "col is not patch-updatable"
        with pytest.raises(ValueError, match="invalid env"):
            store.update_task(task["id"], {"env": "prod"})
        assert store.update_task("no-such-id", {"title": "n"}) is None

    def test_delete_task(self, tmp_path):
        store = Store(tmp_path / "board.db")
        task = store.create_task({"title": "gone"})
        assert store.delete_task(task["id"]) is True
        assert store.delete_task(task["id"]) is False
        assert store.task(task["id"]) is None


# ------------------------------------------------------------------ archive
class TestArchive:
    def test_archive_unarchive_roundtrip(self, tmp_path):
        store = Store(tmp_path / "board.db")
        task = store.create_task({"title": "arch"})

        assert store.archive_task(task["id"]) is True
        assert task["id"] not in [t["id"] for t in store.board()["tasks"]]
        assert task["id"] in [t["id"] for t in store.archived_tasks()]
        assert store.archive_task(task["id"]) is False, "double archive"

        assert store.unarchive_task(task["id"]) is True
        assert task["id"] in [t["id"] for t in store.board()["tasks"]]
        assert store.unarchive_task(task["id"]) is False, "double unarchive"


# ------------------------------------------------------------ notifications
class TestNotifications:
    def test_notify_unread_mark_read(self, tmp_path):
        store = Store(tmp_path / "board.db")
        n1 = store.notify("work", "first", task_id="t-1")
        n2 = store.notify("system", "second")
        assert store.unread_count() == 2

        items = store.notifications()
        assert {n1["id"], n2["id"]} <= {i["id"] for i in items}

        assert store.mark_read(n1["id"]) is True
        assert store.unread_count() == 1
        assert [i["id"] for i in store.notifications(unread_only=True)] == [n2["id"]]

        store.mark_read(None)  # None = mark ALL
        assert store.unread_count() == 0

    def test_notify_rejects_unknown_category(self, tmp_path):
        store = Store(tmp_path / "board.db")
        n = store.notify("bogus", "x")  # coerced, not raised
        stored = store.notifications()[0]
        assert n["id"] == stored["id"]
        assert stored["category"] in ("system", "work")


# --------------------------------------------- server_log secret masking (SEC-2)
class TestServerLogMasking:
    def test_log_write_masks_secret_shapes(self, tmp_path):
        store = Store(tmp_path / "board.db")
        store.log_server_action(
            "srv", "test",
            "echo plain:supersecret Bearer abc123 mnk_xyz")
        history = store.server_history("srv")
        assert history, "log row must exist"
        assert history[0]["detail"] == (
            "echo plain:<redacted> Bearer <redacted> mnk_<redacted>"
        )

    def test_masked_detail_truncated_to_500(self, tmp_path):
        store = Store(tmp_path / "board.db")
        store.log_server_action("srv", "test", "x" * 900)
        assert len(store.server_history("srv")[0]["detail"]) == 500


# -------------------------------------------------- memory_servers upsert
class TestUpsertServer:
    def test_upsert_preserves_token_ref_on_empty(self, tmp_path):
        """Empty token_ref on update must NOT clear a provisioned ref."""
        store = Store(tmp_path / "board.db")
        store.upsert_server({"name": "s", "url": "http://h", "token_ref": "env:T"})
        store.upsert_server({"name": "s", "url": "http://h2", "token_ref": ""})
        assert store.get_server("s")["token_ref"] == "env:T"

    def test_upsert_update_keeps_enabled_flag(self, tmp_path):
        store = Store(tmp_path / "board.db")
        store.upsert_server({"name": "s", "url": "http://h"})
        store.set_server_enabled("s", False)
        store.upsert_server({"name": "s", "url": "http://h2"})
        assert store.get_server("s")["enabled"] in (0, False)
