"""BE-11a: agent reports on a task.

Contract: POST /api/tasks/{task_id}/reports {body, kind, agent?} and
GET /api/tasks/{task_id}/reports (chronological). Pinned here:

- mutation guard (SEC-3): 503 fail-closed / 401 wrong token;
- per-client rate limit (same pattern as task-drafts): 429;
- 404 on unknown task (POST and GET — an empty history must not be
  indistinguishable from a missing task);
- 422 on unknown kind and on an empty body; 16K body cap (pydantic);
- final-supersede semantics: a new kind="final" supersedes previous LIVE
  finals (history kept, flagged superseded=true); intermediates are never
  touched;
- each report lands in the notification center (category work);
- reports do not outlive their task (delete cascades).
"""

from __future__ import annotations

import pytest


@pytest.fixture()
def fresh_report_limiter(app_module, monkeypatch):
    """Fresh per-test rate limiter (the app-level one is a module global)."""
    from server.security import RateLimiter
    limiter = RateLimiter(limit=app_module._REPORT_RATE_LIMIT,
                          window=app_module._REPORT_RATE_WINDOW)
    monkeypatch.setattr(app_module, "_report_limiter", limiter)
    return limiter


@pytest.fixture(autouse=True)
def _fresh_limiter(fresh_report_limiter):
    """Reports rate limiting is a module global — reset per test."""


def _post(client, auth, task_id, **overrides):
    payload = {"body": "progress: done half of the work",
               "kind": "intermediate", "agent": ""} | overrides
    return client.post(f"/api/tasks/{task_id}/reports",
                       json=payload, headers=auth)


class TestReportContract:
    def test_post_201_shape(self, client, auth, make_task):
        task = make_task(title="rpt-shape")
        r = _post(client, auth, task["id"], kind="final", agent="zcode")
        assert r.status_code == 201, r.text
        out = r.json()
        assert out["ok"] is True
        assert out["superseded"] == []
        rep = out["report"]
        for key in ("id", "task_id", "kind", "agent", "body", "superseded",
                    "created_at"):
            assert key in rep
        assert rep["task_id"] == task["id"]
        assert rep["kind"] == "final"
        assert rep["agent"] == "zcode"
        assert rep["superseded"] is False

    def test_get_chronological(self, client, auth, make_task):
        task = make_task(title="rpt-order")
        _post(client, auth, task["id"], body="first")
        _post(client, auth, task["id"], body="second")
        r = client.get(f"/api/tasks/{task['id']}/reports")
        assert r.status_code == 200
        out = r.json()
        assert out["ok"] is True
        assert out["task_id"] == task["id"]
        assert out["count"] == 2
        assert [i["body"] for i in out["items"]] == ["first", "second"]

    def test_unknown_task_404_post_and_get(self, client, auth):
        assert _post(client, auth, "no-such-task").status_code == 404
        assert client.get("/api/tasks/no-such-task/reports").status_code == 404

    def test_reports_do_not_outlive_task(self, client, auth, make_task):
        task = make_task(title="rpt-cascade")
        assert _post(client, auth, task["id"]).status_code == 201
        assert client.delete(f"/api/tasks/{task['id']}",
                             headers=auth).status_code == 200
        assert client.get(f"/api/tasks/{task['id']}/reports").status_code == 404

    def test_notification_recorded(self, client, auth, make_task,
                                   app_module):
        task = make_task(title="rpt-notify")
        assert _post(client, auth, task["id"], kind="final").status_code == 201
        latest = app_module.store.notifications()[0]
        assert latest["category"] == "work"
        assert latest["task_id"] == task["id"]
        assert "отчёт" in latest["title"]


class TestReportValidation:
    def test_unknown_kind_422(self, client, auth, make_task):
        task = make_task(title="rpt-kind")
        r = _post(client, auth, task["id"], kind="summary")
        assert r.status_code == 422
        assert "kind" in r.text

    @pytest.mark.parametrize("body", ["", "   \n\t "])
    def test_empty_body_422(self, client, auth, make_task, body):
        task = make_task(title="rpt-empty")
        assert _post(client, auth, task["id"], body=body).status_code == 422

    def test_body_over_16k_422(self, client, auth, make_task):
        task = make_task(title="rpt-big")
        r = _post(client, auth, task["id"], body="x" * 16385)
        assert r.status_code == 422

    def test_body_exactly_16k_201(self, client, auth, make_task):
        task = make_task(title="rpt-16k-ok")
        r = _post(client, auth, task["id"], body="x" * 16384)
        assert r.status_code == 201, r.text


class TestFinalSupersedesPreviousFinals:
    def test_second_final_supersedes_first(self, client, auth, make_task):
        task = make_task(title="rpt-supersede")
        r1 = _post(client, auth, task["id"], kind="final", body="final v1")
        assert r1.status_code == 201
        first_id = r1.json()["report"]["id"]

        r2 = _post(client, auth, task["id"], kind="final", body="final v2")
        assert r2.status_code == 201
        out = r2.json()
        assert out["superseded"] == [first_id]

        items = client.get(f"/api/tasks/{task['id']}/reports").json()["items"]
        by_id = {i["id"]: i for i in items}
        assert by_id[first_id]["superseded"] is True
        assert by_id[out["report"]["id"]]["superseded"] is False

    def test_intermediates_untouched_by_final(self, client, auth, make_task):
        task = make_task(title="rpt-intermediates")
        _post(client, auth, task["id"], body="step 1")
        r_final = _post(client, auth, task["id"], kind="final",
                        body="final")
        _post(client, auth, task["id"], body="step 2")  # after the final
        items = client.get(f"/api/tasks/{task['id']}/reports").json()["items"]
        # intermediates (before and after the final) are never flagged
        assert all(not i["superseded"] for i in items
                   if i["kind"] == "intermediate")
        # exactly one final, and it is the live one
        finals = [i for i in items if i["kind"] == "final"]
        assert len(finals) == 1
        assert finals[0]["id"] == r_final.json()["report"]["id"]
        assert finals[0]["superseded"] is False

    def test_superseded_final_stays_in_history(self, client, auth, make_task):
        task = make_task(title="rpt-history")
        _post(client, auth, task["id"], kind="final", body="v1")
        _post(client, auth, task["id"], kind="final", body="v2")
        items = client.get(f"/api/tasks/{task['id']}/reports").json()["items"]
        assert [i["body"] for i in items] == ["v1", "v2"]
        assert items[0]["superseded"] is True


class TestReportGuardAndRateLimit:
    def test_missing_token_503(self, client, no_board_token):
        # fail-closed guard fires before any task lookup: no task needed
        assert _post(client, {}, "any-task").status_code == 503

    def test_wrong_token_401(self, client, make_task):
        task = make_task(title="rpt-guard-401")
        r = client.post(f"/api/tasks/{task['id']}/reports",
                        json={"body": "x", "kind": "intermediate"},
                        headers={"Authorization": "Bearer wrong"})
        assert r.status_code == 401

    def test_rate_limit_429(self, client, auth, make_task):
        task = make_task(title="rpt-rate")
        statuses = [_post(client, auth, task["id"], body=f"n{i}").status_code
                    for i in range(32)]
        assert statuses[0] == 201
        assert 429 in statuses
        assert statuses[-1] == 429
        # only the first 30 reports may reach the store
        stored = client.get(f"/api/tasks/{task['id']}/reports").json()
        assert stored["count"] == 30
