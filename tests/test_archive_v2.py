"""BE-11b: archive v2 — filters, pagination, total, archived_from.

GET /api/archive extended: q (LIKE on title/summary), status/col exact,
agent (member of the agents array), project exact, limit/offset pages,
total (= legacy count) over the FULL matching set. The per-project
grouping also covers the full matching set so v1 SPA teaser counts stay
stable under pagination.

unarchive returns the task to its pre-archive column (archived_from,
recorded at archive time); rows archived before the column existed fall
back to 'open' (documented legacy fallback). Status re-syncs to the
restored column.

Tasks are tagged with per-test unique projects so the shared
session-persistent DB never leaks rows between assertions.
"""

from __future__ import annotations

import sqlite3
import uuid


def _proj() -> str:
    return f"qa-arch-{uuid.uuid4().hex[:8]}"


def _make_archived(make_task, client, auth, *, title, col="open",
                   project="", agents=None, status=None, summary=""):
    task = make_task(title=title, col=col, project=project,
                     agents=agents or [], summary=summary)
    if status is not None:
        r = client.patch(f"/api/tasks/{task['id']}",
                         json={"status": status}, headers=auth)
        assert r.status_code == 200, r.text
    r = client.post(f"/api/tasks/{task['id']}/archive", headers=auth)
    assert r.status_code == 200, r.text
    return task


class TestArchiveV2Filters:
    def test_q_matches_title_and_summary(self, client, auth, make_task):
        p = _proj()
        hit_title = _make_archived(make_task, client, auth,
                                   title="перепрошить термостат xyzzz",
                                   project=p)
        hit_summary = _make_archived(make_task, client, auth,
                                     title="скучное имя",
                                     summary="тут спрятано qqkeyword",
                                     project=p)
        _make_archived(make_task, client, auth, title="ничего такого",
                       project=p)

        by_title = client.get("/api/archive",
                              params={"q": "xyzzz", "project": p}).json()
        assert [t["id"] for t in by_title["items"]] == [hit_title["id"]]

        by_summary = client.get("/api/archive",
                                params={"q": "qqkeyword", "project": p}).json()
        assert [t["id"] for t in by_summary["items"]] == [hit_summary["id"]]

    def test_col_and_status_filters(self, client, auth, make_task):
        p = _proj()
        done_task = _make_archived(make_task, client, auth, title="d1",
                                   col="done", project=p)
        _make_archived(make_task, client, auth, title="o1", col="open",
                       project=p, status="withdrawn")

        by_col = client.get("/api/archive",
                            params={"col": "done", "project": p}).json()
        assert [t["id"] for t in by_col["items"]] == [done_task["id"]]

        by_status = client.get("/api/archive",
                               params={"status": "withdrawn",
                                       "project": p}).json()
        assert by_status["total"] == 1
        assert all(t["status"] == "withdrawn" for t in by_status["items"])

    def test_agent_and_project_filters(self, client, auth, make_task):
        p, p_other = _proj(), _proj()
        zcoded = _make_archived(make_task, client, auth, title="with agent",
                                project=p, agents=["zcode"])
        _make_archived(make_task, client, auth, title="no agent", project=p)
        _make_archived(make_task, client, auth, title="other project",
                       project=p_other, agents=["zcode"])

        r = client.get("/api/archive",
                       params={"agent": "zcode", "project": p}).json()
        assert [t["id"] for t in r["items"]] == [zcoded["id"]]

        r = client.get("/api/archive", params={"project": p_other}).json()
        assert r["total"] == 1
        assert r["items"][0]["project"] == p_other

    def test_validation_422(self, client):
        assert client.get("/api/archive",
                          params={"status": "junk"}).status_code == 422
        # WF-1: 'backlog' is a valid column now — garbage only
        assert client.get("/api/archive",
                          params={"col": "junk"}).status_code == 422


class TestArchiveV2Pagination:
    def test_limit_offset_and_total(self, client, auth, make_task):
        p = _proj()
        for n in range(3):
            _make_archived(make_task, client, auth, title=f"page-{n}",
                           project=p)

        page1 = client.get("/api/archive",
                           params={"project": p, "limit": 2}).json()
        assert page1["total"] == 3
        assert page1["count"] == 3, "legacy count = full matching set"
        assert len(page1["items"]) == 2
        assert page1["limit"] == 2 and page1["offset"] == 0

        page2 = client.get("/api/archive",
                           params={"project": p, "limit": 2, "offset": 2}).json()
        assert len(page2["items"]) == 1
        assert page2["total"] == 3
        # full coverage without duplicates:
        all_ids = ([t["id"] for t in page1["items"]] +
                   [t["id"] for t in page2["items"]])
        assert len(all_ids) == 3 and len(set(all_ids)) == 3

    def test_projects_group_covers_full_set_not_page(self, client, auth,
                                                     make_task):
        p = _proj()
        for n in range(3):
            _make_archived(make_task, client, auth, title=f"grp-{n}",
                           project=p)
        r = client.get("/api/archive",
                       params={"project": p, "limit": 1}).json()
        assert len(r["items"]) == 1
        assert sum(len(v) for v in r["projects"].values()) == 3
        assert len(r["projects"][p]) == 3

    def test_combined_filters_stack(self, client, auth, make_task):
        p = _proj()
        hit = _make_archived(make_task, client, auth, title="stack needle",
                             col="done", project=p, agents=["hermes"])
        _make_archived(make_task, client, auth, title="stack decoy",
                       col="open", project=p, agents=["hermes"])
        r = client.get("/api/archive",
                       params={"project": p, "q": "needle", "col": "done",
                               "agent": "hermes"}).json()
        assert r["total"] == 1
        assert r["items"][0]["id"] == hit["id"]


class TestArchivedFromAndUnarchive:
    def test_archived_from_recorded_and_restored(self, client, auth,
                                                 make_task):
        p = _proj()
        task = _make_archived(make_task, client, auth, title="restore-me",
                              col="in-progress", project=p)

        listed = client.get("/api/archive",
                            params={"project": p}).json()["items"][0]
        assert listed["archived_from"] == "in-progress"

        r = client.post(f"/api/tasks/{task['id']}/unarchive", headers=auth)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["ok"] is True
        assert out["task"]["id"] == task["id"]

        board = client.get("/api/board").json()
        mine = next(t for t in board["tasks"] if t["id"] == task["id"])
        assert mine["col"] == "in-progress"
        assert mine["status"] == "in-progress", "status re-syncs on restore"
        assert mine["archived"] == 0

    def test_legacy_archived_without_from_falls_back_to_open(self, client,
                                                             auth, make_task,
                                                             data_dir):
        """Rows archived before BE-11b have archived_from='' — unarchive
        must land them in 'open', not lose the column."""
        p = _proj()
        task = _make_archived(make_task, client, auth, title="pre-be11",
                              col="blocked", project=p)

        # simulate the legacy row (archived before archived_from existed)
        db = sqlite3.connect(data_dir / "board.db")
        db.execute("UPDATE tasks SET archived_from='' WHERE id=?",
                   (task["id"],))
        db.commit()
        db.close()

        r = client.post(f"/api/tasks/{task['id']}/unarchive", headers=auth)
        assert r.status_code == 200, r.text
        assert r.json()["task"]["col"] == "open"

        board = client.get("/api/board").json()
        mine = next(t for t in board["tasks"] if t["id"] == task["id"])
        assert mine["col"] == "open"
        assert mine["status"] == "open"

    def test_unarchive_errors(self, client, auth, make_task):
        assert client.post("/api/tasks/no-such-id/unarchive",
                           headers=auth).status_code == 404
        task = make_task(title="never-archived")
        assert client.post(f"/api/tasks/{task['id']}/unarchive",
                           headers=auth).status_code == 404

    def test_archive_unknown_task_404_unchanged(self, client, auth):
        r = client.post("/api/tasks/no-such-id/archive", headers=auth)
        assert r.status_code == 404
