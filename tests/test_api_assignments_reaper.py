"""ARCH-7 (ADR 0009 phase 3): assignment reaper.

Coverage map (AC, ADR 0009 §10):
- restart-safe catch-up: rows backdated directly in the DB (simulating
  server downtime) are caught by ONE tick — wall-clock on stored
  timestamps, no in-memory first-seen state;
- claimed without a start > 10 min → expired (task → blocked, work
  notification, audit event, SSE assignment.expired per ui-contract §11);
- running without a heartbeat > 30 min → expired;
- heartbeat on an expired assignment → 409 with the VALID claim_token
  (the poller kill signal); a wrong token stays 403 (token gate first);
- queued > 30 min → exactly ONE stagnation notification per assignment
  (dedup across ticks, persisted-notification match — survives restarts);
- live assignments (fresh queue entry / claim / heartbeat) untouched.

The tick is tested by calling the inner sync function directly — no
sleeps, no lifespan (the conftest client deliberately never starts it,
see conftest.py ``client``).
"""

from __future__ import annotations

import asyncio
import logging
import sqlite3
import time
from datetime import datetime, timedelta, timezone

import pytest

from fastapi.testclient import TestClient

from server.security import RateLimiter
from server.store import Store


@pytest.fixture(autouse=True)
def fresh_reaper_limiters(app_module, monkeypatch):
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


def _iso_minutes_ago(minutes: float) -> str:
    """Store-timestamp format (UTC, seconds) N minutes in the past."""
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)
            ).isoformat(timespec="seconds")


def _backdate(data_dir, assignment_id: int, **columns: float) -> None:
    """Rewind assignment timestamp columns by N minutes — simulates the
    server being down while the assignment sat in its state (the Ф1 test
    contour pattern: direct sqlite3 on the same DB file, test_archive_v2)."""
    db = sqlite3.connect(data_dir / "board.db")
    try:
        for col, minutes in columns.items():
            db.execute(f"UPDATE task_assignments SET {col}=? WHERE id=?",
                       (_iso_minutes_ago(minutes), assignment_id))
        db.commit()
    finally:
        db.close()


def _create(client, headers, task_id: str, **extra):
    return client.post("/api/assignments",
                       json={"task_id": task_id,
                             "specialist": "gcw-tech-lead", **extra},
                       headers=headers)


def _claim(client, headers, assignment_id: int, claimed_by: str = "poller-1"):
    r = client.post(f"/api/assignments/{assignment_id}/claim",
                    json={"claimed_by": claimed_by}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _board_col(client, task_id: str) -> str:
    tasks = {t["id"]: t for t in client.get("/api/board").json()["tasks"]}
    return tasks[task_id]["col"]


def _assignment(client, assignment_id: int) -> dict:
    items = client.get("/api/assignments").json()["items"]
    return next(x for x in items if x["id"] == assignment_id)


def _task_notifications(client, task_id: str, title_part: str) -> list[dict]:
    items = client.get("/api/notifications", params={"limit": 200}
                       ).json()["items"]
    return [n for n in items
            if n["task_id"] == task_id and title_part in n["title"]]


class TestReaperExpiry:
    def test_claimed_without_start_expired_after_downtime(
            self, client, auth, make_task, app_module, data_dir):
        """Restart-safe catch-up: the claim happened '40 min ago' (server
        down ever since); the first tick after boot must expire it."""
        task = make_task(title="reaper claimed")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        _claim(client, auth, aid)
        assert _board_col(client, task["id"]) == "in-progress"
        _backdate(data_dir, aid, claimed_at=40)

        result = app_module._assignment_reaper_tick()
        assert result["expired"] == 1
        assert result["stagnation_notified"] == 0

        a = _assignment(client, aid)
        assert a["state"] == "expired"
        assert "reaper" in a["note"] and "start" in a["note"]
        assert a["finished_at"]                      # terminal transition ran
        # ADR 0009 §3: expired maps in-progress → blocked
        assert _board_col(client, task["id"]) == "blocked"

        notes = _task_notifications(client, task["id"], "истекло")
        assert len(notes) == 1
        assert notes[0]["category"] == "work"
        assert "10 мин" in notes[0]["message"]

        hist = client.get(f"/api/tasks/{task['id']}/history").json()
        assert "assignment.expired" in {e["title"] for e in hist["events"]}

        # blocked is not terminal: the owner can re-take immediately
        assert _create(client, auth, task["id"]).status_code == 201

    def test_running_without_heartbeat_expired(
            self, client, auth, make_task, app_module, data_dir):
        task = make_task(title="reaper running")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        claim = _claim(client, auth, aid)
        started = client.post(f"/api/assignments/{aid}/start",
                              json={"claim_token": claim["claim_token"]},
                              headers=auth)
        assert started.status_code == 200
        _backdate(data_dir, aid, heartbeat_at=45, started_at=45)

        result = app_module._assignment_reaper_tick()
        assert result["expired"] == 1
        assert _assignment(client, aid)["state"] == "expired"
        assert _board_col(client, task["id"]) == "blocked"
        notes = _task_notifications(client, task["id"], "истекло")
        assert len(notes) == 1 and "heartbeat" in notes[0]["message"]

    def test_idempotent_second_tick_changes_nothing(
            self, client, auth, make_task, app_module, data_dir):
        """A second tick must not double-notify or touch the terminal row."""
        task = make_task(title="reaper idempotent")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        _claim(client, auth, aid)
        _backdate(data_dir, aid, claimed_at=40)
        first = app_module._assignment_reaper_tick()
        second = app_module._assignment_reaper_tick()
        assert first["expired"] == 1 and second["expired"] == 0
        assert len(_task_notifications(client, task["id"], "истекло")) == 1

    def test_live_assignments_untouched(self, client, auth, make_task,
                                        app_module):
        """Fresh queue entry / claim / heartbeat — none is stale, nothing
        expires, nothing is notified, task stays in-progress."""
        t_queued = make_task(title="live queued")
        _create(client, auth, t_queued["id"])
        t_claimed = make_task(title="live claimed")
        aid_c = _create(client, auth, t_claimed["id"]).json()["assignment"]["id"]
        _claim(client, auth, aid_c)
        t_running = make_task(title="live running")
        aid_r = _create(client, auth, t_running["id"]).json()["assignment"]["id"]
        claim = _claim(client, auth, aid_r)
        client.post(f"/api/assignments/{aid_r}/start",
                    json={"claim_token": claim["claim_token"]}, headers=auth)

        result = app_module._assignment_reaper_tick()
        assert result == {"expired": 0, "stagnation_notified": 0}
        assert _assignment(client, aid_c)["state"] == "claimed"
        assert _assignment(client, aid_r)["state"] == "running"
        assert _board_col(client, t_running["id"]) == "in-progress"


class TestHeartbeatOnExpired:
    def test_heartbeat_409_is_the_kill_signal(
            self, client, auth, make_task, app_module, data_dir):
        """ADR 0009 §10: a heartbeat against an expired assignment answers
        409 with the valid token (the poller's kill signal). A wrong token
        stays 403 — the token gate precedes the state gate (pinned in Ф1)."""
        task = make_task(title="kill signal")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        claim = _claim(client, auth, aid)
        token = claim["claim_token"]
        client.post(f"/api/assignments/{aid}/start",
                    json={"claim_token": token}, headers=auth)
        _backdate(data_dir, aid, heartbeat_at=45)
        app_module._assignment_reaper_tick()

        r = client.post(f"/api/assignments/{aid}/heartbeat",
                        json={"claim_token": token}, headers=auth)
        assert r.status_code == 409
        assert "expired" in r.json()["detail"]
        wrong = client.post(f"/api/assignments/{aid}/heartbeat",
                            json={"claim_token": "f" * 32}, headers=auth)
        assert wrong.status_code == 403


class TestReaperSse:
    def test_assignment_expired_sse(self, app_module, client, auth, make_task,
                                    data_dir):
        """ui-contract §11: reaper expiry emits task.moved (in-progress →
        blocked) + assignment.expired with {assignment, task_id} +
        notification; claim_token/spec_snapshot never appear in frames.
        Raw-ASGI pattern — the TestClient buffers streaming responses."""
        task = make_task(title="reaper sse")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        claim = _claim(client, auth, aid)
        client.post(f"/api/assignments/{aid}/start",
                    json={"claim_token": claim["claim_token"]}, headers=auth)
        _backdate(data_dir, aid, heartbeat_at=45)

        async def run() -> bytes:
            frames: list[dict] = []
            hello = asyncio.Event()
            done = asyncio.Event()
            never = asyncio.Event()   # a real EventSource never disconnects

            async def sse_receive():
                await never.wait()
                return {"type": "http.disconnect"}  # pragma: no cover

            async def sse_send(message):
                frames.append(message)
                body = message.get("body", b"")
                if b'"hello"' in body:
                    hello.set()
                if b"assignment.expired" in body:
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
            # the tick is sync — same loop, same thread as the subscriber
            app_module._assignment_reaper_tick()
            await asyncio.wait_for(done.wait(), timeout=5)
            sse_task.cancel()
            try:
                await sse_task
            except asyncio.CancelledError:
                pass
            return b"".join(m.get("body", b"") for m in frames
                            if m["type"] == "http.response.body")

        stream = asyncio.run(run())
        assert b'"kind": "assignment.expired"' in stream
        assert b'"kind": "task.moved"' in stream       # in-progress → blocked
        assert b'"state": "expired"' in stream         # payload assignment
        assert b'"task_id"' in stream                  # discriminator
        assert b"notification" in stream               # rides the event (§11)
        assert b"claim_token" not in stream
        assert b"spec_snapshot" not in stream


class TestReaperLoopWiring:
    def test_lifespan_loop_expires_automatically(
            self, app_module, client, auth, make_task, data_dir, monkeypatch):
        """The loop itself (not the manual tick): with the stagger and
        interval patched to 50 ms, entering the lifespan context must
        expire a stale assignment without any explicit call — proves the
        create_task wiring in lifespan (AC-1)."""
        monkeypatch.setattr(app_module, "_REAPER_START_STAGGER_S", 0.05)
        monkeypatch.setattr(app_module, "_REAPER_INTERVAL_S", 0.05)
        task = make_task(title="loop wiring")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        claim = _claim(client, auth, aid)
        client.post(f"/api/assignments/{aid}/start",
                    json={"claim_token": claim["claim_token"]}, headers=auth)
        _backdate(data_dir, aid, heartbeat_at=45)

        with TestClient(app_module.app):   # lifespan starts (and stops)
            deadline = time.monotonic() + 5.0
            while time.monotonic() < deadline:
                if _assignment(client, aid)["state"] == "expired":
                    break
                time.sleep(0.05)
        assert _assignment(client, aid)["state"] == "expired"
        assert _board_col(client, task["id"]) == "blocked"


class TestReaperRobustness:
    def test_race_with_api_transition_skips_row(
            self, app_module, client, auth, make_task, monkeypatch):
        """A row that went terminal between the scan and the finish must be
        skipped quietly (AssignmentError), not crash the tick."""
        task = make_task(title="reaper race")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        claim = _claim(client, auth, aid)
        client.post(f"/api/assignments/{aid}/start",
                    json={"claim_token": claim["claim_token"]}, headers=auth)
        client.post(f"/api/assignments/{aid}/complete",
                    json={"claim_token": claim["claim_token"]}, headers=auth)
        # the scan returns a row that is ALREADY done — as if the poller
        # completed it right after the reaper's SELECT
        monkeypatch.setattr(
            app_module.store, "stale_assignments",
            lambda: [{"id": aid, "task_id": task["id"],
                      "reap_reason": "reaper: race"}])
        result = app_module._assignment_reaper_tick()
        assert result["expired"] == 0
        assert _assignment(client, aid)["state"] == "done"   # untouched

    def test_tick_failure_never_kills_loop(self, app_module, monkeypatch,
                                           caplog):
        """АРХКОМ-5: a crashing tick is logged with the traceback
        (log.exception, never except-pass) and the loop keeps ticking."""
        monkeypatch.setattr(app_module, "_REAPER_START_STAGGER_S", 0.01)
        monkeypatch.setattr(app_module, "_REAPER_INTERVAL_S", 0.01)
        calls = {"n": 0}

        def boom() -> dict:
            calls["n"] += 1
            raise RuntimeError("db exploded")

        monkeypatch.setattr(app_module, "_assignment_reaper_tick", boom)

        async def run() -> None:
            loop_task = asyncio.create_task(app_module._assignment_reaper())
            await asyncio.sleep(0.1)
            loop_task.cancel()
            try:
                await loop_task
            except asyncio.CancelledError:
                pass

        with caplog.at_level(logging.ERROR, logger="vesmaro.reaper"):
            asyncio.run(run())
        assert calls["n"] >= 2                       # survived the first crash
        assert any("assignment reaper tick failed" in r.getMessage()
                   for r in caplog.records)
        assert any(r.exc_info for r in caplog.records)  # traceback attached


class TestQueuedStagnation:
    def test_stagnation_notification_once_per_assignment(
            self, client, auth, make_task, app_module, data_dir):
        """queued > 30 мин → ONE work notification; every later tick is a
        no-op (dedup). A NEW assignment on the same task still gets its own
        notice — the dedup key carries the assignment id."""
        task = make_task(title="stagnation")
        aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
        _backdate(data_dir, aid, created_at=40)

        first = app_module._assignment_reaper_tick()
        second = app_module._assignment_reaper_tick()
        assert first["stagnation_notified"] == 1 and first["expired"] == 0
        assert second["stagnation_notified"] == 0

        notes = _task_notifications(client, task["id"], "зависло")
        assert len(notes) == 1
        assert notes[0]["category"] == "work"
        assert f"#{aid}" in notes[0]["message"]
        assert _assignment(client, aid)["state"] == "queued"  # untouched

        # the stagnant attempt is cancelled (owner's call) → a fresh attempt
        # that also stagnates must NOT be silenced by the old notification
        cancelled = client.post(f"/api/assignments/{aid}/cancel", json={},
                                headers=auth)
        assert cancelled.status_code == 200
        aid2 = _create(client, auth, task["id"]).json()["assignment"]["id"]
        _backdate(data_dir, aid2, created_at=40)
        third = app_module._assignment_reaper_tick()
        assert third["stagnation_notified"] == 1
        assert len(_task_notifications(client, task["id"], "зависло")) == 2

    def test_fresh_queued_not_stagnant(self, client, auth, make_task,
                                       app_module):
        make_task(title="fresh queue")
        # created seconds ago — covered by the shared live-assignments
        # test; here: an empty-ish board tick stays silent
        result = app_module._assignment_reaper_tick()
        assert result["stagnation_notified"] == 0


class TestScanBoundaries:
    """Store-level unit boundaries of the wall-clock scan (throwaway
    Store per test — the test_store.py pattern)."""

    def _claimed_assignment(self, store: Store) -> int:
        task = store.create_task({"title": "boundary"})
        a = store.create_assignment(task["id"], "gcw-tech-lead")
        assignment, _token, _task, _moved = store.claim_assignment(
            a["id"], "poller-1")
        return int(assignment["id"])

    @staticmethod
    def _set(path, assignment_id: int, col: str, value: str | None) -> None:
        db = sqlite3.connect(path)
        db.execute(f"UPDATE task_assignments SET {col}=? WHERE id=?",
                   (value, assignment_id))
        db.commit()
        db.close()

    def test_claim_deadline_boundary(self, tmp_path):
        store = Store(tmp_path / "b.db")
        aid = self._claimed_assignment(store)
        self._set(tmp_path / "b.db", aid, "claimed_at",
                  _iso_minutes_ago(9.5))
        assert store.stale_assignments() == []
        self._set(tmp_path / "b.db", aid, "claimed_at",
                  _iso_minutes_ago(10.5))
        stale = store.stale_assignments()
        assert len(stale) == 1
        assert stale[0]["reap_reason"].startswith("reaper: claimed")

    def test_heartbeat_deadline_boundary(self, tmp_path):
        store = Store(tmp_path / "b.db")
        live = self._claimed_assignment(store)   # stays claimed → never stale
        task2 = store.create_task({"title": "boundary2"})
        a2 = store.create_assignment(task2["id"], "gcw-tech-lead")
        _assign2, token2, _t2, _m2 = store.claim_assignment(a2["id"], "p")
        assert store.start_assignment(a2["id"], token2)["state"] == "running"
        self._set(tmp_path / "b.db", a2["id"], "heartbeat_at",
                  _iso_minutes_ago(29.5))
        self._set(tmp_path / "b.db", a2["id"], "started_at",
                  _iso_minutes_ago(29.5))
        assert store.stale_assignments() == []
        self._set(tmp_path / "b.db", a2["id"], "heartbeat_at",
                  _iso_minutes_ago(30.5))
        stale = store.stale_assignments()
        assert len(stale) == 1
        assert stale[0]["reap_reason"].startswith("reaper: running")
        assert [a["id"] for a in stale] == [a2["id"]]   # live claim excluded

    def test_undatable_rows_never_reaped(self, tmp_path):
        """NULL timestamps (hand-migrated garbage) are invisible to the
        reaper — it must not destroy what it cannot date. (created_at is
        NOT NULL by schema, so only the claimed/running columns apply.)"""
        store = Store(tmp_path / "b.db")
        aid = self._claimed_assignment(store)
        self._set(tmp_path / "b.db", aid, "heartbeat_at", None)
        self._set(tmp_path / "b.db", aid, "started_at", None)
        self._set(tmp_path / "b.db", aid, "claimed_at", None)
        assert store.stale_assignments() == []

    def test_notification_exists_exact_match(self, tmp_path):
        store = Store(tmp_path / "b.db")
        assert not store.notification_exists("t-1", "msg")
        assert not store.notification_exists(None, "msg")
        store.notify("work", "title", "msg", "t-1")
        assert store.notification_exists("t-1", "msg")
        assert not store.notification_exists("t-1", "other")
        assert not store.notification_exists("t-2", "msg")
        store.notify("work", "title", "msg", None)
        assert store.notification_exists(None, "msg")


def test_expire_guard_never_kills_live_assignment(client, auth, make_task, app_module):
    """Review P2: a heartbeat landing in the scan→UPDATE window must not
    let finish_assignment('expired') reap a live assignment; ditto for
    empty-string (hand-migrated) timestamps — undatable, never reaped."""
    store = app_module.store
    task = make_task(title="expire-guard")
    aid = _create(client, auth, task["id"]).json()["assignment"]["id"]
    claim = _claim(client, auth, aid)
    client.post(f"/api/assignments/{aid}/start",
                json={"claim_token": claim["claim_token"]}, headers=auth)
    client.post(f"/api/assignments/{aid}/heartbeat",
                json={}, headers=auth)  # fresh liveness, right now
    import pytest
    from server.store import AssignmentConflictError
    with pytest.raises(AssignmentConflictError):
        store.finish_assignment(aid, "expired")
    with store._lock, store._conn() as db:  # P3: undatable rows never reaped
        db.execute("UPDATE task_assignments SET claimed_at='', heartbeat_at='' "
                   "WHERE id=?", (aid,))
    assert store.stale_assignments() == []
    with pytest.raises(AssignmentConflictError):
        store.finish_assignment(aid, "expired")
    # still running — nothing terminal happened through the guarded path
    assert client.get("/api/assignments",
                      params={"task_id": task["id"]}).json()["items"][0][
                          "state"] == "running"
