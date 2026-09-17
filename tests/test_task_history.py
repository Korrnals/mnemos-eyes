"""BE-7: GET /api/tasks/{task_id}/history — merged timeline for the task
modal ("История · Чекпоинты" tab). Contract pinned here:

- response shape {events: [{ts, title, detail?}], memories: [{ts, title,
  source?, detail?}]}; optional keys are absent when empty;
- 404 on unknown task;
- events come from the board audit trail (task_id match) with a
  human-readable detail digest of the stored payload;
- memories resolve through the same path as GET /api/tasks/{id}/memories
  (active servers, provenance via source); unresolved ids are silently
  dropped from the timeline; excerpts are capped at 200 chars;
- history stays available for archived tasks (archive modal).
"""

from __future__ import annotations

import pytest


@pytest.fixture()
def fake_server(app_module, fake_mnemos):
    """Register an enabled fake mnemos server for memory resolution;
    removed again on teardown (same pattern as test_api_memory_servers)."""
    name = "histfake"
    app_module.store.upsert_server({
        "name": name, "url": fake_mnemos.url, "group_name": "default",
        "description": "history test double", "token_ref": "", "enabled": True,
    })
    yield {"name": name, "fake": fake_mnemos}
    app_module.store.delete_server(name)


class TestHistoryContract:
    def test_shape_and_order(self, client, auth, make_task):
        task = make_task(title="hist-shape")
        r = client.post(f"/api/tasks/{task['id']}/move",
                        json={"col": "done"}, headers=auth)
        assert r.status_code == 200
        resp = client.get(f"/api/tasks/{task['id']}/history")
        assert resp.status_code == 200
        out = resp.json()
        assert set(out.keys()) >= {"events", "memories"}
        assert isinstance(out["events"], list)
        assert isinstance(out["memories"], list)
        for e in out["events"]:
            assert isinstance(e["ts"], str) and e["ts"]
            assert isinstance(e["title"], str) and e["title"]
        # newest first (the SPA re-sorts, the server pre-sorts defensively)
        ts_list = [e["ts"] for e in out["events"]]
        assert ts_list == sorted(ts_list, reverse=True)

    def test_unknown_task_404(self, client):
        assert client.get("/api/tasks/no-such-task/history").status_code == 404

    def test_fresh_task_has_created_event_only(self, client, auth, make_task):
        task = make_task(title="hist-empty")
        out = client.get(f"/api/tasks/{task['id']}/history").json()
        assert [e["title"] for e in out["events"]] == ["task.created"]
        assert out["memories"] == []


class TestEventDetailMapping:
    def test_move_update_created_details(self, client, auth, make_task):
        task = make_task(title="hist-detail")
        client.patch(f"/api/tasks/{task['id']}", json={"summary": "s"},
                     headers=auth)
        client.post(f"/api/tasks/{task['id']}/move",
                    json={"col": "in-progress"}, headers=auth)
        client.post(f"/api/tasks/{task['id']}/move",
                    json={"col": "resolved"}, headers=auth)
        events = client.get(f"/api/tasks/{task['id']}/history").json()["events"]
        by_kind: dict[str, list[str]] = {}
        for e in events:
            by_kind.setdefault(e["title"], []).append(e.get("detail", ""))
        assert by_kind["task.created"] == ["колонка open"]
        assert by_kind["task.updated"] == ["поля: summary"]
        # newest first: last move on top
        assert by_kind["task.moved"] == ["in-progress → resolved",
                                         "open → in-progress"]

    def test_archived_event_detail(self, client, auth, make_task):
        task = make_task(title="hist-archived")
        assert client.post(f"/api/tasks/{task['id']}/archive",
                           headers=auth).status_code == 200
        out = client.get(f"/api/tasks/{task['id']}/history")  # archived: still 200
        assert out.status_code == 200
        archived = next(e for e in out.json()["events"]
                        if e["title"] == "task.archived")
        assert archived["detail"] == "из колонки open"


class TestHistoryMemories:
    def test_memory_checkpoint_resolved(self, client, auth, make_task,
                                        fake_server):
        fake_server["fake"].memory_cards["mem-hist-1"] = {
            "id": "mem-hist-1",
            "title": "checkpoint: spec approved",
            "tags": ["project:demo"],
            "status": "active",
            "created_at": "2026-09-01T10:00:00+00:00",
            "content": "x" * 500,
        }
        task = make_task(title="hist-mem",
                         memory_ids=["mem-hist-1", "mem-missing"])
        resp = client.get(f"/api/tasks/{task['id']}/history")
        assert resp.status_code == 200
        memories = resp.json()["memories"]
        # unresolved id is dropped from the timeline
        assert len(memories) == 1
        m = memories[0]
        assert m["title"] == "checkpoint: spec approved"
        assert m["source"] == fake_server["name"]
        assert m["ts"] == "2026-09-01T10:00:00+00:00"
        assert len(m["detail"]) == 200, "excerpt must be capped at 200"

    def test_task_without_memories_has_empty_list(self, client, auth,
                                                  make_task, fake_server):
        task = make_task(title="hist-nomem")
        out = client.get(f"/api/tasks/{task['id']}/history").json()
        assert out["memories"] == []
