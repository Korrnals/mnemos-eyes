"""CV-6 (Wave 1b): cross-task agent-report feed — GET /api/reports — and
the uniform ``actor`` field on kind:"report" SSE events. Pinned here:

- open read (no auth), house shape {ok, count, items}, freshest first
  across tasks (id DESC);
- filters: task_id exact (an unknown task → 200 count 0, NOT 404 — the
  task is a filter value here, not an addressed entity; the per-task GET
  keeps its 404), kind (intermediate|final; 422 on garbage);
- limit: default 50, hard cap 200 silently clamped (board convention,
  NOT a 422) with truncated=true on the clamped response (uniform cursor
  canon); a NON-POSITIVE limit is a 422 (ge=1, as /api/memories);
- cursor before_id: strictly-below paging → stable pages, no duplicates;
- superseded finals excluded from the live feed by default;
  include_superseded=1 restores them flagged superseded=true;
- the kind:"report" SSE frame carries actor (declared identity) beside
  the pre-existing kind/task_id/report fields (additive — the poller and
  the UI consumers must not break).

The contour shares one session DB, so feed tests never assert global
exact counts: they read top-of-feed windows or scope by their own task.
"""

from __future__ import annotations

import asyncio

import httpx
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


@pytest.fixture()
def wide_report_limiter(app_module, monkeypatch):
    """Uncapped limiter for the bulk-insert clamp tests (205 posts)."""
    from server.security import RateLimiter
    limiter = RateLimiter(limit=10_000, window=60.0)
    monkeypatch.setattr(app_module, "_report_limiter", limiter)
    return limiter


def _post(client, auth, task_id, **overrides):
    payload = {"body": "feed probe", "kind": "intermediate", "agent": ""
               } | overrides
    r = client.post(f"/api/tasks/{task_id}/reports",
                    json=payload, headers=auth)
    assert r.status_code == 201, r.text
    return r.json()["report"]


def _feed(client, **params):
    return client.get("/api/reports", params=params)


class TestFeedContract:
    def test_open_read_and_row_shape(self, client, auth, make_task):
        task = make_task(title="zfeed-shape")
        _post(client, auth, task["id"], agent="zfeed-a")
        r = _feed(client)  # no Authorization header — open read
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["ok"] is True
        assert isinstance(out["count"], int) and out["count"] >= 1
        first = out["items"][0]
        for key in ("id", "task_id", "kind", "agent", "body", "superseded",
                    "created_at"):
            assert key in first
        assert first["task_id"] == task["id"]
        assert first["agent"] == "zfeed-a"

    def test_empty_page_200_count_0(self, client, auth, make_task):
        # before_id=0: no row id is below it → deterministic empty page
        r = _feed(client, before_id=0)
        assert r.status_code == 200
        assert r.json() == {"ok": True, "count": 0, "items": [],
                            "truncated": False}
        # a live task with no reports → also an empty page, not an error
        task = make_task(title="zfeed-empty")
        r = _feed(client, task_id=task["id"])
        assert r.status_code == 200
        assert r.json()["count"] == 0


class TestCrossTaskOrdering:
    def test_interleaved_freshest_first(self, client, auth, make_task):
        ta = make_task(title="zfeed-order-a")
        tb = make_task(title="zfeed-order-b")
        _post(client, auth, ta["id"], body="A1")
        _post(client, auth, tb["id"], body="B1")
        _post(client, auth, ta["id"], body="A2")
        _post(client, auth, tb["id"], body="B2")
        # top of the global feed is exactly the four just-written rows
        out = _feed(client, limit=4).json()
        assert [(i["body"], i["task_id"]) for i in out["items"]] == [
            ("B2", tb["id"]), ("A2", ta["id"]),
            ("B1", tb["id"]), ("A1", ta["id"]),
        ]
        ids = [i["id"] for i in out["items"]]
        assert ids == sorted(ids, reverse=True)


class TestFeedFilters:
    def test_task_filter_scopes_feed(self, client, auth, make_task):
        ta = make_task(title="zfilter-a")
        tb = make_task(title="zfilter-b")
        _post(client, auth, ta["id"], body="only-a")
        _post(client, auth, tb["id"], body="not-a")
        out = _feed(client, task_id=ta["id"]).json()
        assert out["count"] == 1
        assert [i["body"] for i in out["items"]] == ["only-a"]

    def test_unknown_task_filter_is_empty_200(self, client):
        # filter value, not an addressed resource — no 404 on the feed
        r = _feed(client, task_id="no-such-task")
        assert r.status_code == 200
        assert r.json() == {"ok": True, "count": 0, "items": [],
                            "truncated": False}

    def test_kind_filter_final_only(self, client, auth, make_task):
        task = make_task(title="zfilter-kind")
        _post(client, auth, task["id"], body="step")
        _post(client, auth, task["id"], body="done", kind="final")
        out = _feed(client, task_id=task["id"], kind="final").json()
        assert [i["body"] for i in out["items"]] == ["done"]
        out = _feed(client, task_id=task["id"], kind="intermediate").json()
        assert [i["body"] for i in out["items"]] == ["step"]

    def test_kind_garbage_422(self, client):
        assert _feed(client, kind="summary").status_code == 422


class TestCursorPagination:
    def test_before_id_pages_without_duplicates(self, client, auth, make_task):
        task = make_task(title="zfeed-cursor")
        for n in range(1, 6):
            _post(client, auth, task["id"], body=f"r{n}")
        seen: list[str] = []
        cursor = None
        while True:
            params = {"task_id": task["id"], "limit": 2}
            if cursor is not None:
                params["before_id"] = cursor
            out = _feed(client, **params).json()
            page = [i["body"] for i in out["items"]]
            if not page:
                break
            seen.extend(page)
            cursor = out["items"][-1]["id"]
        assert seen == ["r5", "r4", "r3", "r2", "r1"]
        assert len(set(seen)) == 5  # no duplicates across pages


class TestLimitClamp:
    def test_default_50_and_silent_cap_at_200(self, client, auth, make_task,
                                              wide_report_limiter):
        task = make_task(title="zfeed-clamp")
        for n in range(205):
            _post(client, auth, task["id"], body=f"n{n}")
        # default page — not clamped, no truncation flag
        out = _feed(client, task_id=task["id"]).json()
        assert out["count"] == 50
        assert out["truncated"] is False
        # an aggressive client asking for everything gets the cap, not 422;
        # the clamped response says so (uniform cursor canon §11)
        r = _feed(client, task_id=task["id"], limit=1000)
        assert r.status_code == 200
        out = r.json()
        assert out["count"] == 200
        assert out["truncated"] is True
        ids = [i["id"] for i in out["items"]]
        assert ids == sorted(ids, reverse=True)
        assert out["items"][0]["body"] == "n204"
        assert "n0" not in {i["body"] for i in out["items"]}  # oldest dropped
        # the unscoped feed clamps the same way (≥205 rows exist by now)
        assert _feed(client, limit=1000).json()["count"] == 200

    @pytest.mark.parametrize("bad", [0, -5])
    def test_non_positive_limit_422(self, client, bad):
        # numeric validation, as /api/memories (test_non_positive_limit_422)
        assert _feed(client, limit=bad).status_code == 422


class TestSupersededSemantics:
    def test_live_feed_hides_superseded_finals(self, client, auth, make_task):
        task = make_task(title="zfeed-superseded")
        _post(client, auth, task["id"], body="step")           # intermediate
        _post(client, auth, task["id"], body="final v1", kind="final")
        _post(client, auth, task["id"], body="final v2", kind="final")
        # default: one live final per task — v1 is hidden, not deleted
        out = _feed(client, task_id=task["id"]).json()
        assert [i["body"] for i in out["items"]] == ["final v2", "step"]
        # include_superseded=1 restores history with the flag
        out = _feed(client, task_id=task["id"], include_superseded=1).json()
        assert [i["body"] for i in out["items"]] == [
            "final v2", "final v1", "step"]
        by_body = {i["body"]: i for i in out["items"]}
        assert by_body["final v1"]["superseded"] is True
        assert by_body["final v2"]["superseded"] is False
        assert by_body["step"]["superseded"] is False


class TestReportSseActor:
    def test_report_event_carries_actor(self, app_module, client, auth,
                                        make_task):
        """Agents spec §5 p.7: the kind:"report" frame gains the uniform
        ``actor`` field (declared identity, ADR 0009 §8) — additive; the
        pre-existing kind/task_id/report payload keeps riding along. Raw-ASGI
        pattern (the TestClient buffers streaming responses); the POST runs
        on the same loop via ASGITransport so the broadcast reaches the
        subscriber."""
        task = make_task(title="zfeed-sse-actor")

        async def run() -> bytes:
            frames: list[dict] = []
            hello = asyncio.Event()
            done = asyncio.Event()
            never = asyncio.Event()  # a real EventSource never disconnects

            async def sse_receive():
                await never.wait()
                return {"type": "http.disconnect"}  # pragma: no cover

            async def sse_send(message):
                frames.append(message)
                body = message.get("body", b"")
                if b'"hello"' in body:
                    hello.set()
                if b'"kind": "report"' in body:
                    done.set()

            sse_scope = {
                "type": "http", "asgi": {"version": "3.0"},
                "http_version": "1.1", "method": "GET", "scheme": "http",
                "path": "/api/events", "raw_path": b"/api/events",
                "query_string": b"", "root_path": "",
                "headers": [(b"host", b"testserver")],
                "client": ("127.0.0.1", 12345), "server": ("127.0.0.1", 80),
            }
            sse_task = asyncio.create_task(
                app_module.app(sse_scope, sse_receive, sse_send))
            await asyncio.wait_for(hello.wait(), timeout=5)
            async with httpx.AsyncClient(
                    transport=httpx.ASGITransport(app=app_module.app),
                    base_url="http://testserver") as ac:
                r = await ac.post(
                    f"/api/tasks/{task['id']}/reports",
                    json={"body": "sse actor probe", "kind": "intermediate",
                          "agent": "zfeed-agent"},
                    headers=auth)
                assert r.status_code == 201, r.text
            await asyncio.wait_for(done.wait(), timeout=5)
            sse_task.cancel()
            try:
                await sse_task
            except asyncio.CancelledError:
                pass
            return b"".join(m.get("body", b"") for m in frames
                            if m["type"] == "http.response.body")

        stream = asyncio.run(run())
        assert b'"kind": "report"' in stream
        assert b'"actor": "zfeed-agent"' in stream  # uniform declared identity
        assert b'"task_id"' in stream               # discriminator kept
        assert b'"report"' in stream                # payload kept
        assert b'"notification"' in stream          # rides the event (§11)
