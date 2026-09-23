"""AGG-1 task inbox: mirror upsert/stale semantics, task:queue scan engine
(GET /memories?tags=... listing primitive), dedup against native tasks'
memory_ids, adopt flow (201 / 409 / 404) and the refresh endpoint contract
(guard_write, 5/60s rate limit, per-server error isolation).

Store-level tests run against a fresh tmp-path Store; API-level tests use
the session client with a per-test ``qa-inbox`` registry row wired to a
FakeMnemos (lifespan is off, so only explicit refreshes scan).
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs

import pytest

from server.store import Store
from server.task_inbox import record_from_memory

# Listing primitive contract (prod 1.3.1 root cause): GET /memories with a
# tags query-param is a true listing — parsed back for the request-shape test
LISTING_QUERY = {"tags": ["task:queue"], "limit": ["200"]}


def hit(memory_id: str, title: str = "queue item", content: str = "body",
        tags: list[str] | None = None,
        created: str = "2026-09-01T00:00:00+00:00") -> dict:
    """One mnemos /memories listing record shaped like a task:queue memory."""
    return {"id": memory_id, "title": title, "content": content,
            "tags": tags or [], "created_at": created}


def _ts_ago(seconds: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)) \
        .isoformat(timespec="seconds")


@pytest.fixture(autouse=True)
def fresh_refresh_limiter(app_module, monkeypatch):
    """Fresh per-test refresh rate limiter (module-global in the app)."""
    from server.security import RateLimiter
    limiter = RateLimiter(limit=app_module._INBOX_REFRESH_RATE_LIMIT,
                          window=app_module._INBOX_REFRESH_RATE_WINDOW)
    monkeypatch.setattr(app_module, "_inbox_refresh_limiter", limiter)
    return limiter


@pytest.fixture()
def inbox_env(client, auth, fake_mnemos, allow_hosts, app_module):
    """One active memory server ``qa-inbox`` pointed at this test's
    FakeMnemos. The scan is global by design (every active server), so the
    fixture pins the registry: other servers (leftovers from other test
    modules in the shared session DB) are disabled for the duration and
    restored afterwards. Teardown also wipes mirror rows, scan markers and
    any task the adopt flow created (task-queue-import tag)."""
    allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
    saved_states: dict[str, tuple[bool, str]] = {}
    for s in app_module.registry.servers():
        if s["name"] != "qa-inbox":
            saved_states[s["name"]] = (bool(s["enabled"]), s.get("state", "idle"))
            app_module.registry.set_enabled(s["name"], False)
    app_module.store.upsert_server({
        "name": "qa-inbox", "url": fake_mnemos.url, "group_name": "default",
        "description": "", "token_ref": "",
    })
    app_module.registry.set_enabled("qa-inbox", True)
    app_module.registry.set_state("qa-inbox", "idle")
    yield app_module
    app_module.store.delete_server("qa-inbox")
    for name, (enabled, state) in saved_states.items():
        app_module.registry.set_enabled(name, enabled)
        app_module.registry.set_state(name, state)
    for t in app_module.store.board()["tasks"]:
        if "task-queue-import" in (t.get("mnemos_tags") or []):
            app_module.store.delete_task(t["id"])
    import sqlite3
    with sqlite3.connect(app_module.store._path) as db:  # noqa: SLF001
        db.execute("DELETE FROM task_inbox")
        db.execute("DELETE FROM board_meta WHERE key LIKE 'task_inbox%'")


# ------------------------------------------------------------- store mirror
class TestMirror:
    def test_upsert_idempotent(self, tmp_path):
        store = Store(tmp_path / "board.db")
        recs = [{"memory_id": "m1", "server": "s1", "title": "t"},
                {"memory_id": "m2", "server": "s1", "title": "t2"}]
        assert store.upsert_inbox_records(recs, "2026-09-17T00:00:00+00:00") == (2, 2)
        assert store.upsert_inbox_records(recs, "2026-09-17T01:00:00+00:00") == (2, 0)
        items = store.list_inbox()
        assert len(items) == 2
        assert all(i["last_seen"] == "2026-09-17T01:00:00+00:00" for i in items)

    def test_upsert_refreshes_content_keeps_adoption(self, tmp_path):
        store = Store(tmp_path / "board.db")
        store.upsert_inbox_records(
            [{"memory_id": "m1", "server": "s1", "title": "old"}], "x")
        assert store.mark_inbox_adopted("m1", "t-42") is True
        store.upsert_inbox_records(
            [{"memory_id": "m1", "server": "s1", "title": "new"}], "y")
        rec = store.get_inbox_item("m1")
        assert rec["title"] == "new"
        assert rec["last_seen"] == "y"
        assert rec["adopted_task_id"] == "t-42"

    def test_stale_flag_ages_out(self, tmp_path):
        store = Store(tmp_path / "board.db")
        store.upsert_inbox_records(
            [{"memory_id": "m-old", "server": "s1", "title": "t"}],
            _ts_ago(2 * 3600))
        store.upsert_inbox_records(
            [{"memory_id": "m-fresh", "server": "s1", "title": "t"}],
            _ts_ago(60))
        by_id = {i["memory_id"]: i for i in store.list_inbox()}
        assert by_id["m-old"]["stale"] is True
        assert by_id["m-fresh"]["stale"] is False

    def test_dedup_excludes_native_task_memory_ids(self, tmp_path):
        store = Store(tmp_path / "board.db")
        store.upsert_inbox_records(
            [{"memory_id": "m-linked", "server": "s1", "title": "t"},
             {"memory_id": "m-free", "server": "s1", "title": "t"}], "x")
        store.create_task({"title": "native", "memory_ids": ["m-linked"]})
        ids = [i["memory_id"] for i in store.list_inbox()]
        assert ids == ["m-free"]  # bulk-import scenario: linked never leaks
        assert [i["memory_id"] for i in store.list_inbox(include_adopted=True)] \
            == ["m-free"]  # dedup is unconditional, include_adopted is not a bypass

    def test_list_inbox_filters(self, tmp_path):
        store = Store(tmp_path / "board.db")
        store.upsert_inbox_records([
            {"memory_id": "a1", "server": "srv-a", "project": "p1", "title": "t"},
            {"memory_id": "a2", "server": "srv-b", "project": "p2", "title": "t"},
        ], "x")
        store.mark_inbox_adopted("a2", "t-1")
        assert [i["memory_id"] for i in store.list_inbox(scope="srv-a")] == ["a1"]
        assert store.list_inbox(scope="srv-b") == []  # adopted hidden by default
        assert [i["memory_id"] for i in
                store.list_inbox(scope="srv-b", include_adopted=True)] == ["a2"]
        assert [i["memory_id"] for i in store.list_inbox(project="p1")] == ["a1"]
        assert [i["memory_id"] for i in store.list_inbox(project="p2",
                                                         include_adopted=True)] == ["a2"]

    def test_unknown_memory_404_shape(self, tmp_path):
        store = Store(tmp_path / "board.db")
        assert store.get_inbox_item("nope") is None
        assert store.mark_inbox_adopted("nope", "t-x") is False


# ----------------------------------------- listing hit shape (defensive parse)
class TestHitShape:
    """Prod 1.3.0/1.3.1 regressions: hits may arrive without ``created_at``
    or with it null, and with an ``excerpt`` field but no full ``content``.
    The mirror must still take the record."""

    def test_hit_without_created_at_is_mirrored(self):
        rec = record_from_memory("srv", {
            "id": "4d20edbf-4f22-4fdc-aabd-5f1c1b584a2e",
            "title": "queue probe", "tags": ["task:queue", "severity:high"],
        })
        assert rec is not None
        assert rec["source_created_at"] == ""  # absent -> '', never a reject
        assert rec["priority"] == "high"
        assert rec["excerpt"] == ""

    def test_hit_created_at_null_is_mirrored(self):
        rec = record_from_memory("srv", {"id": "m1", "created_at": None,
                                         "tags": ["task:queue"]})
        assert rec is not None
        assert rec["source_created_at"] == ""

    def test_excerpt_field_preferred_over_content(self):
        rec = record_from_memory("srv", {
            "id": "m1", "excerpt": "short preview",
            "content": "z" * 500, "tags": ["task:queue"],
        })
        assert rec["excerpt"] == "short preview"

    def test_excerpt_falls_back_to_content_capped(self):
        rec = record_from_memory("srv", {
            "id": "m1", "content": "c" * 500, "tags": ["task:queue"]})
        assert rec["excerpt"] == "c" * 300

    def test_title_falls_back_to_content(self):
        rec = record_from_memory("srv", {"id": "m1",
                                         "content": "title here",
                                         "tags": ["task:queue"]})
        assert rec["title"] == "title here"

    def test_hit_without_id_is_rejected(self):
        assert record_from_memory("srv", {"title": "no id"}) is None


# ------------------------------------------------------------ scan + GET API
class TestScanEngine:
    def test_refresh_counters_and_query_shape(self, inbox_env, client, auth,
                                              fake_mnemos):
        fake_mnemos.listing_results = [
            hit("m1"), hit("m2", tags=["project:mnemos"]),
        ]
        r = client.post("/api/tasks/inbox/refresh", headers=auth)
        assert r.status_code == 200, r.text
        assert r.json() == {"scanned_servers": 1, "found": 2, "new": 2,
                            "errors": []}
        # second scan: same records, no new mirror rows (idempotent)
        r2 = client.post("/api/tasks/inbox/refresh", headers=auth)
        assert r2.json()["new"] == 0
        assert r2.json()["found"] == 2
        # listing primitive (prod 1.3.1 root cause): GET /memories?tags=...
        assert parse_qs(fake_mnemos.listing_requests()[-1]) == LISTING_QUERY

    def test_full_backlog_listed_beyond_search_cap(self, inbox_env, client,
                                                   auth, fake_mnemos):
        """Root-cause regression (prod 1.3.1): the WHOLE task:queue backlog
        must arrive. The old POST /search primitive returned 1 arbitrary hit
        of 38; the listing returns all — N=38 > the old 25 cap proves it."""
        fake_mnemos.listing_results = [
            hit(f"m-{i:02d}", title=f"queue item {i}", tags=["task:queue"])
            for i in range(38)
        ]
        r = client.post("/api/tasks/inbox/refresh", headers=auth)
        assert r.json() == {"scanned_servers": 1, "found": 38, "new": 38,
                            "errors": []}
        assert client.get("/api/tasks/inbox").json()["count"] == 38

    def test_field_mapping_and_excerpt_cap(self, inbox_env, client, auth,
                                           fake_mnemos):
        fake_mnemos.listing_results = [hit(
            "m1", content="x" * 500,
            tags=["project:mnemos", "severity:high",
                  "owner:gcw-tech-lead", "task:queue"],
        )]
        assert client.post("/api/tasks/inbox/refresh", headers=auth).status_code == 200
        r = client.get("/api/tasks/inbox")
        item = r.json()["items"][0]
        assert item["memory_id"] == "m1"
        assert item["server"] == "qa-inbox"
        assert item["project"] == "mnemos"
        assert item["priority"] == "high"          # severity:high → high
        assert item["specialist"] == "@GCW: Tech Lead"  # owner slug → canonical
        assert item["tags"] == ["project:mnemos", "severity:high",
                                "owner:gcw-tech-lead", "task:queue"]
        assert item["excerpt"] == "x" * 300        # SEC-4: excerpt only, capped
        assert item["created_at"] == "2026-09-01T00:00:00+00:00"
        assert item["stale"] is False
        assert item["adopted"] is False
        assert item["adopted_task_id"] is None

    def test_owner_slug_mapping_fallbacks(self, inbox_env, client, auth,
                                          fake_mnemos):
        fake_mnemos.listing_results = [
            hit("m-known", tags=["owner:gcw-sre-devops"]),
            hit("m-unknown", tags=["owner:custom-agent"]),
            hit("m-noowner"),
        ]
        client.post("/api/tasks/inbox/refresh", headers=auth)
        by_id = {i["memory_id"]: i for i in
                 client.get("/api/tasks/inbox").json()["items"]}
        assert by_id["m-known"]["specialist"] == "@GCW: SRE/DevOps"
        assert by_id["m-unknown"]["specialist"] == "@custom-agent"
        assert by_id["m-noowner"]["specialist"] == ""

    def test_one_failing_server_does_not_break_scan(self, inbox_env, client,
                                                    auth, fake_mnemos):
        # port 9: nothing listens there -> unreachable slice, isolated error
        inbox_env.store.upsert_server({
            "name": "qa-dead", "url": "http://127.0.0.1:9",
            "group_name": "default", "description": "", "token_ref": "",
        })
        inbox_env.registry.set_enabled("qa-dead", True)
        try:
            fake_mnemos.listing_results = [hit("m1")]
            r = client.post("/api/tasks/inbox/refresh", headers=auth)
            assert r.status_code == 200
            body = r.json()
            assert body["scanned_servers"] == 1
            assert body["found"] == 1
            assert [e["server"] for e in body["errors"]] == ["qa-dead"]
        finally:
            inbox_env.store.delete_server("qa-dead")

    def test_refreshed_at_stamped(self, inbox_env, client, auth):
        assert client.get("/api/tasks/inbox").json()["refreshed_at"] == ""
        client.post("/api/tasks/inbox/refresh", headers=auth)
        r = client.get("/api/tasks/inbox").json()["refreshed_at"]
        assert r == inbox_env.store.inbox_refreshed_at() != ""

    def test_refresh_engine_direct_async(self, tmp_path):
        """refresh_inbox is a plain awaitable: counters without any HTTP."""
        from server.task_inbox import refresh_inbox

        class _Reg:
            @staticmethod
            def active_servers():
                return []

        store = Store(tmp_path / "board.db")
        result = asyncio.run(refresh_inbox(_Reg(), store))
        assert result == {"scanned_servers": 0, "found": 0, "new": 0,
                          "errors": []}
        assert store.inbox_refreshed_at() != ""

    def test_edge_form_hits_are_mirrored(self, inbox_env, client, auth,
                                         fake_mnemos):
        """Prod 1.3.0 regression: hits without created_at, with excerpt —
        still mirrored, counters honest."""
        fake_mnemos.listing_results = [{
            "id": "4d20edbf-4f22-4fdc-aabd-5f1c1b584a2e",
            "title": "cluster probe", "tags": ["task:queue", "severity:high"],
            "excerpt": "probe body", "created_at": None,
        }]
        r = client.post("/api/tasks/inbox/refresh", headers=auth)
        assert r.json() == {"scanned_servers": 1, "found": 1, "new": 1,
                            "errors": []}
        item = client.get("/api/tasks/inbox").json()["items"][0]
        assert item["memory_id"] == "4d20edbf-4f22-4fdc-aabd-5f1c1b584a2e"
        assert item["excerpt"] == "probe body"
        assert item["created_at"] == ""
        assert item["priority"] == "high"
        # re-scan: same record, no duplicate mirror row
        r2 = client.post("/api/tasks/inbox/refresh", headers=auth)
        assert r2.json()["found"] == 1 and r2.json()["new"] == 0

    def test_e2e_refresh_inbox_adopt_conflict(self, inbox_env, client, auth,
                                              fake_mnemos):
        """Full path: one new record -> refresh -> inbox 1 -> adopt ->
        re-adopt 409 with the same task_id + record deduped out of inbox."""
        fake_mnemos.listing_results = [hit(
            "m-e2e", title="e2e work", content="full description",
            tags=["task:queue", "project:mnemos", "severity:high"],
        )]
        assert client.post("/api/tasks/inbox/refresh",
                           headers=auth).status_code == 200
        assert client.get("/api/tasks/inbox").json()["count"] == 1
        first = client.post("/api/tasks/inbox/m-e2e/adopt", headers=auth)
        assert first.status_code == 201
        task_id = first.json()["id"]
        # re-adopt: 409 naming the native task
        second = client.post("/api/tasks/inbox/m-e2e/adopt", headers=auth)
        assert second.status_code == 409
        assert second.json()["task_id"] == task_id
        # dedup: the adopted record never shows up in the inbox again
        assert client.get("/api/tasks/inbox").json()["count"] == 0


class TestInboxGet:
    def test_response_contract_shape(self, inbox_env, client):
        inbox_env.store.upsert_inbox_records(
            [{"memory_id": "m1", "server": "qa-inbox", "project": "p",
              "title": "t", "excerpt": "e",
              "tags": ["task:queue"], "priority": "high",
              "specialist": "@GCW: Tech Lead",
              "source_created_at": "2026-09-01T00:00:00+00:00"}], "x")
        r = client.get("/api/tasks/inbox")  # read: no auth required
        assert r.status_code == 200
        body = r.json()
        assert body["count"] == 1
        item = body["items"][0]
        assert set(item) == {
            "memory_id", "server", "project", "title", "excerpt", "tags",
            "priority", "specialist", "created_at", "last_seen", "stale",
            "adopted", "adopted_task_id", "edits",
        }
        assert item["edits"] is None  # UI-25: unedited rows carry no overlay
        assert item["created_at"] == "2026-09-01T00:00:00+00:00"

    def test_scope_filter_by_server(self, inbox_env, client):
        inbox_env.store.upsert_inbox_records(
            [{"memory_id": "m1", "server": "qa-inbox", "title": "t"}], "x")
        assert client.get("/api/tasks/inbox?scope=qa-inbox").json()["count"] == 1
        assert client.get("/api/tasks/inbox?scope=no-such").json()["count"] == 0
        assert client.get("/api/tasks/inbox").json()["count"] == 1  # scope=all

    def test_dedup_hides_bulk_imported_records(self, inbox_env, client, auth,
                                               make_task):
        """The 38-task import: a native task linking the memory id removes
        the record from the inbox without touching the mirror row."""
        inbox_env.store.upsert_inbox_records(
            [{"memory_id": "m-imported", "server": "qa-inbox",
              "title": "imported"}], "x")
        assert client.get("/api/tasks/inbox").json()["count"] == 1
        make_task(memory_ids=["m-imported"])
        assert client.get("/api/tasks/inbox").json()["count"] == 0
        assert inbox_env.store.get_inbox_item("m-imported") is not None


# ------------------------------------------------------------------- adopt
class TestAdopt:
    def _seed(self, app_module, memory_id="m-adopt"):
        app_module.store.upsert_inbox_records([{
            "memory_id": memory_id, "server": "qa-inbox", "project": "mnemos",
            "title": "queue work item", "tags": ["task:queue"],
            "priority": "high", "specialist": "@GCW: SRE/DevOps",
            "source_created_at": "2026-09-01T00:00:00+00:00",
        }], "x")
        return memory_id

    def test_adopt_happy_creates_native_task(self, inbox_env, client, auth):
        mid = self._seed(inbox_env)
        r = client.post(f"/api/tasks/inbox/{mid}/adopt", headers=auth)
        assert r.status_code == 201, r.text
        task = r.json()
        assert task["title"] == "queue work item"
        assert task["project"] == "mnemos"
        assert task["priority"] == "high"
        assert task["env"] == "laptop"
        assert task["agents"] == ["zcode"]
        assert task["specialists"] == ["@GCW: SRE/DevOps"]
        assert task["memory_ids"] == [mid]
        assert task["mnemos_tags"] == ["task-queue-import"]
        assert mid[:8] in task["summary"]
        assert "qa-inbox" in task["summary"]
        rec = inbox_env.store.get_inbox_item(mid)
        assert rec["adopted_task_id"] == task["id"]
        assert client.get("/api/tasks/inbox").json()["count"] == 0  # dedup

    def test_adopt_twice_conflicts_with_task_id(self, inbox_env, client, auth):
        mid = self._seed(inbox_env)
        first = client.post(f"/api/tasks/inbox/{mid}/adopt", headers=auth)
        assert first.status_code == 201
        second = client.post(f"/api/tasks/inbox/{mid}/adopt", headers=auth)
        assert second.status_code == 409
        assert second.json()["task_id"] == first.json()["id"]

    def test_adopt_unknown_memory_404(self, inbox_env, client, auth):
        r = client.post("/api/tasks/inbox/no-such-memory/adopt", headers=auth)
        assert r.status_code == 404

    def test_adopt_and_refresh_guard_write(self, inbox_env, client,
                                           no_board_token):
        """Mutations fail closed without the board token (SEC-3)."""
        assert client.post("/api/tasks/inbox/refresh").status_code == 503
        assert client.post(
            "/api/tasks/inbox/whatever/adopt").status_code == 503

    def test_refresh_rate_limited(self, inbox_env, client, auth, app_module,
                                  monkeypatch):
        from server.security import RateLimiter
        monkeypatch.setattr(app_module, "_inbox_refresh_limiter",
                            RateLimiter(limit=1, window=60.0))
        assert client.post("/api/tasks/inbox/refresh",
                           headers=auth).status_code == 200
        r = client.post("/api/tasks/inbox/refresh", headers=auth)
        assert r.status_code == 429
        assert "rate limit" in r.json()["detail"]


# ------------------------------------------- edit before adopt (UI-25)
class TestInboxEdit:
    def _seed(self, app_module, memory_id="m-edit"):
        app_module.store.upsert_inbox_records([{
            "memory_id": memory_id, "server": "qa-inbox", "project": "hysteria",
            "title": "queue work item", "excerpt": "base excerpt",
            "tags": ["task:queue", "project:hysteria", "severity:low"],
            "priority": "low", "specialist": "@GCW: SRE/DevOps",
            "source_created_at": "2026-09-01T00:00:00+00:00",
        }], "x")
        return memory_id

    def test_patch_stores_overlay_and_get_projects_effective(
            self, inbox_env, client, auth):
        mid = self._seed(inbox_env)
        r = client.patch(f"/api/tasks/inbox/{mid}", headers=auth,
                         json={"title": "edited title", "priority": "high"})
        assert r.status_code == 200, r.text
        item = r.json()
        assert item["title"] == "edited title"        # effective
        assert item["priority"] == "high"             # effective
        assert item["project"] == "hysteria"          # base untouched
        assert item["excerpt"] == "base excerpt"      # base untouched
        assert item["edits"] == {"title": "edited title", "priority": "high"}
        # the projection (GET) carries the same overlay
        listed = client.get("/api/tasks/inbox").json()["items"][0]
        assert listed["title"] == "edited title"
        assert listed["priority"] == "high"
        assert listed["edits"]["title"] == "edited title"

    def test_patch_partial_merges_over_previous_edits(
            self, inbox_env, client, auth):
        mid = self._seed(inbox_env)
        assert client.patch(f"/api/tasks/inbox/{mid}", headers=auth,
                            json={"title": "v2"}).status_code == 200
        r = client.patch(f"/api/tasks/inbox/{mid}", headers=auth,
                         json={"project": "mnemos"})
        assert r.status_code == 200, r.text
        assert r.json()["edits"] == {"title": "v2", "project": "mnemos"}

    def test_patch_summary_flows_into_excerpt_projection(
            self, inbox_env, client, auth):
        mid = self._seed(inbox_env)
        r = client.patch(f"/api/tasks/inbox/{mid}", headers=auth,
                         json={"summary": "owner spec text"})
        assert r.status_code == 200, r.text
        assert r.json()["excerpt"] == "owner spec text"

    def test_patch_clearing_project_is_meaningful(self, inbox_env, client,
                                                  auth):
        """Empty string = the owner CLEARED the field (not 'no edit'): the
        projection drops the project and the chip hides."""
        mid = self._seed(inbox_env)
        r = client.patch(f"/api/tasks/inbox/{mid}", headers=auth,
                         json={"project": ""})
        assert r.status_code == 200, r.text
        assert r.json()["project"] == ""
        assert r.json()["edits"] == {"project": ""}

    def test_patch_unknown_404(self, inbox_env, client, auth):
        r = client.patch("/api/tasks/inbox/no-such", headers=auth,
                         json={"title": "x"})
        assert r.status_code == 404

    def test_patch_adopted_409(self, inbox_env, client, auth):
        mid = self._seed(inbox_env)
        first = client.post(f"/api/tasks/inbox/{mid}/adopt", headers=auth)
        assert first.status_code == 201
        r = client.patch(f"/api/tasks/inbox/{mid}", headers=auth,
                         json={"title": "late edit"})
        assert r.status_code == 409

    def test_patch_empty_body_422(self, inbox_env, client, auth):
        mid = self._seed(inbox_env)
        r = client.patch(f"/api/tasks/inbox/{mid}", headers=auth, json={})
        assert r.status_code == 422

    def test_patch_bad_priority_422(self, inbox_env, client, auth):
        mid = self._seed(inbox_env)
        r = client.patch(f"/api/tasks/inbox/{mid}", headers=auth,
                         json={"priority": "urgent"})
        assert r.status_code == 422

    def test_patch_title_cap_422(self, inbox_env, client, auth):
        mid = self._seed(inbox_env)
        r = client.patch(f"/api/tasks/inbox/{mid}", headers=auth,
                         json={"title": "x" * 201})
        assert r.status_code == 422

    def test_patch_requires_ui_token(self, inbox_env, client, no_board_token):
        assert client.patch("/api/tasks/inbox/whatever",
                            json={"title": "x"}).status_code == 503

    def test_edits_survive_rescan(self, inbox_env, client, auth,
                                  fake_mnemos):
        """Re-scan refreshes the BASE fields but never clobbers the owner
        overlay (same survival contract as adopted_task_id)."""
        mid = self._seed(inbox_env)
        assert client.patch(f"/api/tasks/inbox/{mid}", headers=auth,
                            json={"title": "edited"}).status_code == 200
        fake_mnemos.listing_results = [
            hit(mid, title="source renamed", tags=["task:queue",
                                                   "severity:low"])]
        assert client.post("/api/tasks/inbox/refresh",
                           headers=auth).status_code == 200
        item = client.get("/api/tasks/inbox").json()["items"][0]
        assert item["title"] == "edited"      # overlay wins over new base
        assert item["edits"] == {"title": "edited"}


class TestAdoptWithEdits:
    def _seed(self, app_module, memory_id="m-edit-adopt"):
        app_module.store.upsert_inbox_records([{
            "memory_id": memory_id, "server": "qa-inbox",
            "project": "hysteria", "title": "base title",
            "excerpt": "base excerpt",
            "tags": ["task:queue", "project:hysteria", "severity:low",
                     "owner:gcw-sre-devops"],
            "priority": "low", "specialist": "@GCW: SRE/DevOps",
            "source_created_at": "2026-09-01T00:00:00+00:00",
        }], "x")
        return memory_id

    def test_adopt_uses_edited_fields_and_writes_revision(
            self, inbox_env, client, auth, fake_mnemos):
        mid = self._seed(inbox_env)
        assert client.patch(
            f"/api/tasks/inbox/{mid}", headers=auth,
            json={"title": "edited title", "summary": "edited spec",
                  "priority": "high", "project": "mnemos"},
        ).status_code == 200
        r = client.post(f"/api/tasks/inbox/{mid}/adopt", headers=auth)
        assert r.status_code == 201, r.text
        task = r.json()
        assert task["title"] == "edited title"
        assert task["summary"] == "edited spec"
        assert task["project"] == "mnemos"
        assert task["priority"] == "high"
        assert task["specialists"] == ["@GCW: SRE/DevOps"]
        # SEC-4 links: the source memory AND the edited revision
        assert task["memory_ids"] == [mid, "fake-mem-1"]
        # sync-back: exactly one revision POST, supersedes the original
        bodies = fake_mnemos.memories_bodies()
        assert len(bodies) == 1
        body = bodies[0]
        assert body["title"] == "edited title"
        assert body["content"] == "edited spec"
        assert body["metadata"]["supersedes"] == mid
        assert "task:edit" in body["tags"]
        assert "task:queue" in body["tags"]          # queue semantics kept
        assert "project:mnemos" in body["tags"]      # edited project tag
        assert "severity:high" in body["tags"]       # reverse-mapped priority
        assert "project:hysteria" not in body["tags"]
        assert "severity:low" not in body["tags"]
        assert "owner:gcw-sre-devops" in body["tags"]  # untouched tags ride
        # bookkeeping rides the edits JSON
        import json as _json
        edits = _json.loads(inbox_env.store.get_inbox_item(mid)["edits"])
        assert edits["revision_memory_id"] == "fake-mem-1"

    def test_adopt_without_edits_keeps_legacy_behavior(
            self, inbox_env, client, auth, fake_mnemos):
        """No edits → no mnemos write at all: adopt is byte-identical to the
        pre-UI-25 contract (link-only, standard summary)."""
        mid = self._seed(inbox_env)
        r = client.post(f"/api/tasks/inbox/{mid}/adopt", headers=auth)
        assert r.status_code == 201, r.text
        task = r.json()
        assert task["title"] == "base title"
        assert task["project"] == "hysteria"
        assert task["priority"] == "low"
        assert task["memory_ids"] == [mid]
        assert fake_mnemos.memories_bodies() == []
        assert mid[:8] in task["summary"]

    def test_adopt_with_edits_survives_mnemos_failure(
            self, inbox_env, client, auth, fake_mnemos):
        """Revision write fails → adopt STILL succeeds (the board task is
        primary); the failure is recorded in the edits JSON bookkeeping."""
        mid = self._seed(inbox_env)
        assert client.patch(f"/api/tasks/inbox/{mid}", headers=auth,
                            json={"title": "edited"}).status_code == 200
        fake_mnemos.fail_memories = True
        r = client.post(f"/api/tasks/inbox/{mid}/adopt", headers=auth)
        assert r.status_code == 201, r.text
        task = r.json()
        assert task["title"] == "edited"
        assert task["memory_ids"] == [mid]           # no revision to link
        import json as _json
        edits = _json.loads(inbox_env.store.get_inbox_item(mid)["edits"])
        assert "intentional failure" in edits["revision_error"]
        assert "revision_memory_id" not in edits
