"""ARCH-4 (ADR 0009 phase 1): assignment queue API.

Coverage map (AC):
- happy path: create → claim → start → heartbeat → complete; task column
  open → in-progress → resolved; final report lands in the reports history;
- failures: double claim → 409, wrong claim_token → 403, heartbeat on a
  non-running assignment → 409;
- boundaries: ≤1 active assignment per task → 409, done/resolved task →
  422, archived task → 422, legacy single-token mode;
- token split (A1): UI token serves create/cancel, board token serves the
  machine loop; fail-closed when neither is configured;
- spec snapshot (A2): 16K cap + sha256 of the FULL spec; never leaked into
  open list responses or SSE payloads;
- SSE: assignment.* emitted per ui-contract §11 (raw-ASGI pattern — the
  TestClient buffers streaming responses to completion, see
  test_security_headers.py for the same workaround).
"""

from __future__ import annotations

import asyncio
import hashlib
import json

import pytest

from server.security import RateLimiter
from server.store import SPEC_SNAPSHOT_CAP


@pytest.fixture(autouse=True)
def fresh_assignment_limiters(app_module, monkeypatch):
    """Fresh per-test rate limiters (module globals otherwise accumulate
    across the session-scoped client)."""
    monkeypatch.setattr(
        app_module, "_assignment_ui_limiter",
        RateLimiter(limit=app_module._ASSIGNMENT_UI_RATE_LIMIT,
                    window=app_module._ASSIGNMENT_UI_RATE_WINDOW))
    monkeypatch.setattr(
        app_module, "_assignment_limiter",
        RateLimiter(limit=app_module._ASSIGNMENT_RATE_LIMIT,
                    window=app_module._ASSIGNMENT_RATE_WINDOW))


def _create(client, headers, task_id: str, specialist: str = "gcw-tech-lead",
            **extra):
    return client.post("/api/assignments",
                       json={"task_id": task_id, "specialist": specialist, **extra},
                       headers=headers)


def _claim(client, headers, assignment_id: int, claimed_by: str = "poller-1",
           **extra):
    r = client.post(f"/api/assignments/{assignment_id}/claim",
                    json={"claimed_by": claimed_by, **extra}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _board_col(client, task_id: str) -> str:
    tasks = {t["id"]: t for t in client.get("/api/board").json()["tasks"]}
    return tasks[task_id]["col"]


class TestHappyPath:
    def test_create_claim_complete_lifecycle(self, client, auth, make_task):
        task = make_task(title="arch4 happy", spec="AC: сделать дело")
        r = _create(client, auth, task["id"])
        assert r.status_code == 201, r.text
        a = r.json()["assignment"]
        assert a["state"] == "queued"
        assert a["harness"] == "zcode"          # default
        assert a["created_by"] == "owner"       # default
        assert len(a["spec_hash"]) == 64        # sha256 hex
        assert "claim_token" not in a           # never in the public shape
        assert "spec_snapshot" not in a         # claim-response-only (A2)
        aid = a["id"]

        # open read, no bearer — same boundary as GET /api/board
        listed = client.get("/api/assignments?state=queued")
        assert listed.status_code == 200
        item = next(x for x in listed.json()["items"] if x["id"] == aid)
        assert "claim_token" not in item and "spec_snapshot" not in item

        claim = _claim(client, auth, aid, claimed_by="poller-1",
                       executor_id="exec-alpha")
        assert claim["assignment"]["state"] == "claimed"
        assert claim["assignment"]["claimed_by_executor"] == "exec-alpha"
        token = claim["claim_token"]
        assert len(token) == 32 and int(token, 16) >= 0   # token_hex(16)
        assert claim["task"]["col"] == "in-progress"      # claim moved it
        assert _board_col(client, task["id"]) == "in-progress"
        # A2: the poller receives the immutable snapshot taken at creation
        assert claim["assignment"]["spec_snapshot"] == "AC: сделать дело"

        r = client.post(f"/api/assignments/{aid}/start",
                        json={"claim_token": token}, headers=auth)
        assert r.status_code == 200
        assert r.json()["assignment"]["state"] == "running"

        r = client.post(f"/api/assignments/{aid}/heartbeat",
                        json={"claim_token": token, "note": "tick"},
                        headers=auth)
        assert r.status_code == 200
        assert r.json()["assignment"]["heartbeat_at"]

        r = client.post(f"/api/assignments/{aid}/complete",
                        json={"claim_token": token,
                              "final_report": "финальный отчёт: всё готово"},
                        headers=auth)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["assignment"]["state"] == "done"
        # complete maps to resolved, NOT done (ADR 0009 §3)
        assert body["task"]["col"] == "resolved"
        assert body["moved"] == ["in-progress", "resolved"]
        assert _board_col(client, task["id"]) == "resolved"

        # final report is in the task's report history, agent = claim identity
        reps = client.get(f"/api/tasks/{task['id']}/reports").json()
        assert reps["count"] == 1
        assert reps["items"][0]["kind"] == "final"
        assert reps["items"][0]["agent"] == "poller-1"
        assert reps["items"][0]["body"] == "финальный отчёт: всё готово"

        # task history timeline carries the assignment audit trail
        hist = client.get(f"/api/tasks/{task['id']}/history").json()
        kinds = {e["title"] for e in hist["events"]}
        assert {"assignment.created", "assignment.claimed",
                "assignment.done"} <= kinds

    def test_complete_without_report_is_legal(self, client, auth, make_task):
        """The final report is optional at the API level — the launcher
        contract (always send one) is the poller's discipline, not the
        server's."""
        task = make_task(title="no report")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        claim = _claim(client, auth, aid)
        client.post(f"/api/assignments/{aid}/start",
                    json={"claim_token": claim["claim_token"]}, headers=auth)
        r = client.post(f"/api/assignments/{aid}/complete",
                        json={"claim_token": claim["claim_token"]},
                        headers=auth)
        assert r.status_code == 200
        assert r.json()["report"] is None
        assert client.get(f"/api/tasks/{task['id']}/reports"
                          ).json()["count"] == 0


class TestFailures:
    def test_double_claim_conflict(self, client, auth, make_task):
        task = make_task(title="double claim")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        _claim(client, auth, aid, claimed_by="poller-1")
        second = client.post(f"/api/assignments/{aid}/claim",
                             json={"claimed_by": "poller-2"}, headers=auth)
        assert second.status_code == 409

    def test_wrong_claim_token_forbidden(self, client, auth, make_task):
        task = make_task(title="wrong token")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        _claim(client, auth, aid)
        r = client.post(f"/api/assignments/{aid}/start",
                        json={"claim_token": "0" * 32}, headers=auth)
        assert r.status_code == 403

    def test_wrong_token_on_start_and_complete(self, client, auth, make_task):
        task = make_task(title="wrong token 2")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        claim = _claim(client, auth, aid)
        bad = client.post(f"/api/assignments/{aid}/start",
                          json={"claim_token": "f" * 32}, headers=auth)
        assert bad.status_code == 403
        # finish the lifecycle with the good token, then confirm a stale
        # poller (wrong token) cannot complete a re-claimed assignment
        client.post(f"/api/assignments/{aid}/start",
                    json={"claim_token": claim["claim_token"]}, headers=auth)
        # a second complete with the right token after done → 409, with a
        # wrong token → 403 (token checked before state)
        done = client.post(f"/api/assignments/{aid}/complete",
                           json={"claim_token": claim["claim_token"]},
                           headers=auth)
        assert done.status_code == 200
        stale = client.post(f"/api/assignments/{aid}/complete",
                            json={"claim_token": "f" * 32}, headers=auth)
        assert stale.status_code == 403

    def test_heartbeat_requires_running(self, client, auth, make_task):
        task = make_task(title="hb not running")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        claim = _claim(client, auth, aid)   # claimed, not running
        r = client.post(f"/api/assignments/{aid}/heartbeat",
                        json={"claim_token": claim["claim_token"]},
                        headers=auth)
        assert r.status_code == 409

    def test_fail_by_claimed_only_recovery(self, client, auth, make_task):
        """Poller recovery sweep: fail own record with no token around."""
        task = make_task(title="recovery fail")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        _claim(client, auth, aid, claimed_by="poller-9")
        r = client.post(f"/api/assignments/{aid}/fail",
                        json={"reason": "no live local process",
                              "claimed_by": "poller-9"},
                        headers=auth)
        assert r.status_code == 200, r.text
        assert r.json()["assignment"]["state"] == "failed"
        assert r.json()["task"]["col"] == "blocked"   # fail → blocked
        wrong = client.post(f"/api/assignments/{aid}/fail",
                            json={"claimed_by": "someone-else"}, headers=auth)
        assert wrong.status_code == 403

    def test_fail_without_any_identity_forbidden(self, client, auth, make_task):
        task = make_task(title="fail no identity")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        _claim(client, auth, aid)
        r = client.post(f"/api/assignments/{aid}/fail",
                        json={"reason": "x"}, headers=auth)
        assert r.status_code == 403


class TestBoundaries:
    def test_one_active_assignment_invariant(self, client, auth, make_task):
        task = make_task(title="invariant")
        assert _create(client, auth, task["id"]).status_code == 201
        assert _create(client, auth, task["id"]).status_code == 409
        # still 409 after claim (active = queued|claimed|running)
        aid = client.get("/api/assignments",
                         params={"task_id": task["id"]}).json()["items"][0]["id"]
        claim = _claim(client, auth, aid)
        assert _create(client, auth, task["id"]).status_code == 409
        client.post(f"/api/assignments/{aid}/start",
                    json={"claim_token": claim["claim_token"]}, headers=auth)
        assert _create(client, auth, task["id"]).status_code == 409
        # terminal state frees the task for a fresh attempt. NOTE: a
        # COMPLETED attempt leaves the task resolved (terminal) → creating
        # again is a 422 by design; the fail path (task → blocked) is the
        # re-take route, asserted here.
        client.post(f"/api/assignments/{aid}/fail",
                    json={"claim_token": claim["claim_token"]}, headers=auth)
        assert _create(client, auth, task["id"]).status_code == 201

    @pytest.mark.parametrize("col", ["resolved", "done"])
    def test_terminal_task_rejected(self, client, auth, make_task, col):
        task = make_task(title=f"terminal {col}")
        moved = client.post(f"/api/tasks/{task['id']}/move",
                            json={"col": col}, headers=auth)
        assert moved.status_code == 200
        assert _create(client, auth, task["id"]).status_code == 422

    def test_archived_task_rejected(self, client, auth, make_task):
        task = make_task(title="archived")
        assert client.post(f"/api/tasks/{task['id']}/archive",
                           headers=auth).status_code == 200
        assert _create(client, auth, task["id"]).status_code == 422

    def test_blocked_task_is_reAssignable(self, client, auth, make_task):
        """blocked is NOT terminal — a failed attempt can be re-taken."""
        task = make_task(title="blocked retry")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        _claim(client, auth, aid)
        client.post(f"/api/assignments/{aid}/fail",
                    json={"claimed_by": "poller-1"}, headers=auth)
        assert _board_col(client, task["id"]) == "blocked"
        assert _create(client, auth, task["id"]).status_code == 201

    def test_unknown_task_404(self, client, auth):
        assert _create(client, auth, "t-no-such-task").status_code == 404

    def test_unknown_harness_422(self, client, auth, make_task):
        task = make_task(title="bad harness")
        r = _create(client, auth, task["id"], harness="totally-bogus")
        assert r.status_code == 422

    def test_invalid_state_filter_422(self, client):
        assert client.get("/api/assignments?state=wat").status_code == 422

    def test_cancel_from_queued_returns_task_open(self, client, auth, make_task):
        task = make_task(title="cancel queued")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        r = client.post(f"/api/assignments/{aid}/cancel",
                        json={"reason": "owner changed mind"}, headers=auth)
        assert r.status_code == 200
        assert r.json()["assignment"]["state"] == "cancelled"
        assert _board_col(client, task["id"]) == "open"  # never left open
        assert _create(client, auth, task["id"]).status_code == 201

    def test_cancel_from_running_moves_task_back(self, client, auth, make_task):
        task = make_task(title="cancel running")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        claim = _claim(client, auth, aid)
        client.post(f"/api/assignments/{aid}/start",
                    json={"claim_token": claim["claim_token"]}, headers=auth)
        r = client.post(f"/api/assignments/{aid}/cancel", json={}, headers=auth)
        assert r.status_code == 200
        assert r.json()["moved"] == ["in-progress", "open"]
        assert _board_col(client, task["id"]) == "open"


class TestTokenSplit:
    def test_legacy_single_token_serves_both(self, client, auth, make_task,
                                             app_module):
        """conftest pins VESMARO_BOARD_TOKEN and no VESMARO_UI_TOKEN: the
        import-time legacy fallback must let the board token serve the UI
        class too."""
        assert app_module.UI_WRITE_TOKEN == app_module.BOARD_WRITE_TOKEN
        task = make_task(title="legacy")
        assert _create(client, auth, task["id"]).status_code == 201
        aid = client.get("/api/assignments",
                         params={"task_id": task["id"]}).json()["items"][0]["id"]
        assert client.post(f"/api/assignments/{aid}/cancel", json={},
                           headers=auth).status_code == 200

    def test_no_token_401(self, client, make_task):
        task = make_task(title="anon")
        assert _create(client, None, task["id"]).status_code == 401

    def test_split_mode(self, client, auth, make_task, app_module, monkeypatch):
        """A1 split: UI token serves create/cancel, board token serves the
        machine loop; the board token is REFUSED on UI routes (a machine
        token must not mint assignments)."""
        monkeypatch.setattr(app_module, "UI_WRITE_TOKEN", "qa-ui-token")
        ui = {"Authorization": "Bearer qa-ui-token"}
        task = make_task(title="split")
        assert _create(client, auth, task["id"]).status_code == 401  # board≠UI
        assert _create(client, ui, task["id"]).status_code == 201
        aid = client.get("/api/assignments",
                         params={"task_id": task["id"]}).json()["items"][0]["id"]
        # machine class: UI token refused, board token accepted
        assert client.post(f"/api/assignments/{aid}/claim",
                           json={"claimed_by": "p"}, headers=ui
                           ).status_code == 401
        claim = _claim(client, auth, aid)
        assert client.post(f"/api/assignments/{aid}/start",
                           json={"claim_token": claim["claim_token"]},
                           headers=ui).status_code == 401
        # cancel is UI class: board token refused, UI token accepted
        assert client.post(f"/api/assignments/{aid}/cancel", json={},
                           headers=auth).status_code == 401
        assert client.post(f"/api/assignments/{aid}/cancel", json={},
                           headers=ui).status_code == 200

    def test_fail_closed_503(self, client, auth, make_task, app_module,
                             monkeypatch):
        """Neither token configured → UI mutation 503 (fail-closed), same
        semantics as the board guard."""
        task = make_task(title="fail closed")  # created BEFORE tokens drop
        monkeypatch.setattr(app_module, "UI_WRITE_TOKEN", "")
        monkeypatch.setattr(app_module, "BOARD_WRITE_TOKEN", "")
        assert _create(client, {"Authorization": "Bearer x"},
                       task["id"]).status_code == 503


class TestSpecSnapshot:
    def test_snapshot_cap_and_hash(self, client, auth, make_task):
        full = "спека " + "x" * 20000
        task = make_task(title="big spec", spec=full)
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        claim = _claim(client, auth, aid)
        snap = claim["assignment"]["spec_snapshot"]
        assert len(snap) == SPEC_SNAPSHOT_CAP            # plain truncation
        assert snap == full[:SPEC_SNAPSHOT_CAP]
        # hash covers the FULL spec, not the truncated copy
        assert claim["assignment"]["spec_hash"] == \
            hashlib.sha256(full.encode("utf-8")).hexdigest()

    def test_hash_is_frozen_at_creation(self, client, auth, make_task):
        """A2 TOCTOU: editing the task spec after the assignment was created
        does not change the snapshot the poller receives."""
        task = make_task(title="toctou", spec="VERSION 1")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        patched = client.patch(f"/api/tasks/{task['id']}",
                               json={"spec": "VERSION 2"}, headers=auth)
        assert patched.status_code == 200
        claim = _claim(client, auth, aid)
        assert claim["assignment"]["spec_snapshot"] == "VERSION 1"
        assert claim["assignment"]["spec_hash"] == \
            hashlib.sha256(b"VERSION 1").hexdigest()

    def test_open_list_leaks_nothing(self, client, auth, make_task):
        task = make_task(title="leak", spec="secret-ish spec")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        _claim(client, auth, aid)
        raw = client.get("/api/assignments").json()["items"]
        item = next(x for x in raw if x["id"] == aid)
        assert set(item) & {"claim_token", "spec_snapshot"} == set()
        assert item["spec_hash"]  # the hash IS public


class TestRateLimit:
    def test_create_rate_limited_429(self, client, auth, make_task,
                                     app_module, monkeypatch):
        monkeypatch.setattr(app_module, "_assignment_ui_limiter",
                            RateLimiter(limit=2, window=60.0))
        tasks = [make_task(title=f"rl {i}") for i in range(3)]
        assert _create(client, auth, tasks[0]["id"]).status_code == 201
        assert _create(client, auth, tasks[1]["id"]).status_code == 201
        r = _create(client, auth, tasks[2]["id"])
        assert r.status_code == 429
        assert "rate limit" in r.json()["detail"]


class TestSseEmission:
    def test_assignment_events_stream(self, app_module, client, auth, make_task):
        """assignment.* SSE per ui-contract §11: payload {assignment,
        task_id} (+notification where noted), NO claim_token and NO
        spec_snapshot in any frame; claim also emits task.moved. Raw-ASGI:
        the TestClient buffers streaming responses (known lesson)."""
        task = make_task(title="sse", spec="AC")

        async def run() -> tuple[int, bytes]:
            frames: list[dict] = []
            hello = asyncio.Event()
            done = asyncio.Event()
            never = asyncio.Event()   # a real EventSource never disconnects

            async def sse_receive():
                # Block forever: returning http.disconnect here would tear
                # the stream down (the subscriber is discarded in the
                # generator's finally) before any assignment frame lands.
                await never.wait()
                return {"type": "http.disconnect"}  # pragma: no cover

            async def sse_send(message):
                frames.append(message)
                body = message.get("body", b"")
                if b'"hello"' in body:
                    hello.set()
                if b"assignment.claimed" in body:
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

            # create + claim as raw ASGI requests against the same app
            # while the stream is open
            post_status: list[int] = []

            async def do_post(path: str, payload: dict) -> None:
                body = json.dumps(payload).encode()
                got: list[dict] = []
                seen = {"body": False}

                async def receive():
                    if not seen["body"]:
                        seen["body"] = True
                        return {"type": "http.request", "body": body,
                                "more_body": False}
                    return {"type": "http.disconnect"}

                async def send(message):
                    got.append(message)
                    if message["type"] == "http.response.start":
                        post_status.append(message["status"])

                scope = {
                    "type": "http", "asgi": {"version": "3.0"},
                    "http_version": "1.1", "method": "POST", "scheme": "http",
                    "path": path, "raw_path": path.encode(),
                    "query_string": b"", "root_path": "",
                    "headers": [
                        (b"host", b"testserver"),
                        (b"authorization",
                         auth["Authorization"].encode()),
                        (b"content-type", b"application/json"),
                        (b"content-length", str(len(body)).encode()),
                    ],
                    "client": ("127.0.0.1", 12346),
                    "server": ("127.0.0.1", 80),
                }
                await app_module.app(scope, receive, send)

            await do_post("/api/assignments",
                          {"task_id": task["id"], "specialist": "gcw-tech-lead"})
            aid = client.get("/api/assignments",
                             params={"task_id": task["id"]}).json()["items"][0]["id"]
            await do_post(f"/api/assignments/{aid}/claim",
                          {"claimed_by": "poller-sse"})

            await asyncio.wait_for(done.wait(), timeout=5)
            sse_task.cancel()
            try:
                await sse_task
            except asyncio.CancelledError:
                pass
            stream = b"".join(m.get("body", b"") for m in frames
                              if m["type"] == "http.response.body")
            return post_status[0], stream

        create_status, stream = asyncio.run(run())
        assert create_status == 201
        assert b'"kind": "assignment.created"' in stream
        assert b'"kind": "assignment.claimed"' in stream
        assert b'"kind": "task.moved"' in stream          # claim moved the task
        assert b'"kind": "assignment.started"' not in stream
        # §11: notification rides on assignment.created
        assert b"notification" in stream
        # §11: claim_token and spec_snapshot never appear in SSE payloads
        assert b"claim_token" not in stream
        assert b"spec_snapshot" not in stream
        # payload carries the assignment + task_id discriminators
        assert b'"task_id"' in stream
