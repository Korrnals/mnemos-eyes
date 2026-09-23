"""Device hardening §A.5 (ADR 0012 Amendment, board backlog
t-1790196252894-9b17): per-device mutation budget + actor in task.* SSE.

Pinned contract:
- mutation budget: the per-DEVICE flat budget (30/60s in production, the
  auth-throttling engine) exhausts to 429 + Retry-After (int seconds,
  1..window) with a detail that names the numbers; the sliding window
  releases the budget again; reads are NEVER counted; the ui class never
  enters the device middleware (unlimited by this limiter); the budget is
  shared across granules (the owner granted the device, not a component);
  ordering stays validate 401 → grants 403 → budget 429;
- task.* SSE actor (additive dictionary change): the device leg reuses
  the task-history attribution VERBATIM (``device:<id> <name>``, AUTH-2 —
  asserted equal to the store's history payload on the same mutation);
  the ui leg answers ``ui`` (header and transition-mode board token
  alike — the guard's classification is the source of truth); the
  machine leg answers ``machine:board`` / ``machine:<executor_id>``;
  server-internal mutators answer ``machine:reaper`` /
  ``machine:validation-sweep``. Old fields (kind/task/…) ride along
  unchanged — the frame key set is exactly old-keys + ``actor``.
"""

from __future__ import annotations

import sqlite3
import time
from datetime import datetime, timedelta, timezone

import pytest

from conftest import DATA_DIR, UI_TOKEN
from server.security import RateLimiter

DB_PATH = DATA_DIR / "board.db"


# ------------------------------------------------------------------ helpers
def _db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def _device_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _paired_control_device(store, name: str = "a5-dev") -> dict:
    """Full legal pairing at STORE level (default scope=control; the
    test_device_grants pattern — fixtures do not cross test modules).
    Carries ``pairing_row_id`` so teardown can lift both rows."""
    row, code = store.create_pairing_request(device_name=name)
    store.scan_pairing(row["id"], device_name=name, source_ip="testclient")
    store.confirm_pairing(row["id"], allow=True)
    device, token = store.issue_device_session(row["id"])
    return {**device, "device_token": token, "pairing_row_id": row["id"]}


@pytest.fixture()
def dev(app_module):
    """A paired control device (full granule set), cleaned after."""
    d = _paired_control_device(app_module.store)
    yield d
    with _db() as db:
        db.execute("DELETE FROM device_sessions WHERE id=?", (d["id"],))
        db.execute("DELETE FROM pairing_requests WHERE id=?",
                   (d["pairing_row_id"],))


@pytest.fixture()
def fresh_device_mutation_limiter(app_module, monkeypatch):
    """Fresh production-shaped limiter per test (module global otherwise
    accumulates across the session-scoped client)."""
    from server.app import _DEVICE_MUTATION_RATE_LIMIT as limit
    from server.app import _DEVICE_MUTATION_RATE_WINDOW as window
    limiter = RateLimiter(limit=limit, window=window)
    monkeypatch.setattr(app_module, "_device_mutation_limiter", limiter)
    return limiter


@pytest.fixture()
def tiny_device_mutation_limiter(app_module, monkeypatch):
    """1 mutation / 60s: budget tests that only need "one allowed, rest
    429" — keeps the HTTP volume down; the production numbers are pinned
    separately against the real limiter."""
    limiter = RateLimiter(limit=1, window=60.0)
    monkeypatch.setattr(app_module, "_device_mutation_limiter", limiter)
    return limiter


@pytest.fixture()
def capture_sse(app_module, monkeypatch):
    """Collect every broadcast event (the local-copy pattern — fixtures
    do not cross test modules)."""
    events: list[dict] = []
    monkeypatch.setattr(app_module, "_broadcast", events.append)
    return events


def _task_frames(events: list[dict], kind: str) -> list[dict]:
    return [e for e in events if e.get("kind") == kind]


# ------------------------------------------------- mutation budget (§A.5)
class TestDeviceMutationBudget:
    def test_production_budget_429_retry_after(
            self, client, app_module, dev, fresh_device_mutation_limiter):
        """The production numbers themselves: 30 device mutations in the
        minute pass, the 31st answers 429 + Retry-After; the detail names
        the numbers (owner-facing honesty, same style as the login 429)."""
        headers = _device_headers(dev["device_token"])
        ids = []
        for i in range(app_module._DEVICE_MUTATION_RATE_LIMIT):
            r = client.post("/api/tasks", json={"title": f"a5-{i}"},
                            headers=headers)
            assert r.status_code == 201, (i, r.text)
            ids.append(r.json()["id"])
        r = client.post("/api/tasks", json={"title": "a5-over"},
                        headers=headers)
        assert r.status_code == 429, r.text
        retry_after = r.headers["Retry-After"]
        assert retry_after.isdigit() and 1 <= int(retry_after) <= 60
        assert ("30 mutations per 60s per device" in r.json()["detail"])
        for task_id in ids:
            client.delete(f"/api/tasks/{task_id}",
                          headers=_device_headers(
                              app_module.UI_WRITE_TOKEN
                              or app_module.BOARD_WRITE_TOKEN))

    def test_window_release(self, client, app_module, dev, monkeypatch):
        """A spent budget comes back: with a 2/1s limiter the third
        mutation 429s, one window later the device may write again
        (sliding-window engine, Retry-After is advice not a lease)."""
        monkeypatch.setattr(app_module, "_device_mutation_limiter",
                            RateLimiter(limit=2, window=1.0))
        headers = _device_headers(dev["device_token"])
        ids = []
        for i in range(2):
            r = client.post("/api/tasks", json={"title": f"w-{i}"},
                            headers=headers)
            assert r.status_code == 201, r.text
            ids.append(r.json()["id"])
        assert client.post("/api/tasks", json={"title": "w-2"},
                           headers=headers).status_code == 429
        time.sleep(1.05)  # one window — both events age out
        r = client.post("/api/tasks", json={"title": "w-3"}, headers=headers)
        assert r.status_code == 201, r.text
        ids.append(r.json()["id"])
        eff = app_module.UI_WRITE_TOKEN or app_module.BOARD_WRITE_TOKEN
        for task_id in ids:
            client.delete(f"/api/tasks/{task_id}",
                          headers=_device_headers(eff))

    def test_reads_never_counted(self, client, dev,
                                 tiny_device_mutation_limiter):
        """Global reads stay open and budget-free: after the single
        mutation spends the 1-slot budget, reads still answer 200 (and a
        further mutation still 429s — reads bought nothing back)."""
        headers = _device_headers(dev["device_token"])
        assert client.post("/api/tasks", json={"title": "r-1"},
                           headers=headers).status_code == 201
        for _ in range(5):
            assert client.get("/api/board", headers=headers).status_code == 200
        assert client.get("/api/health", headers=headers).status_code == 200
        assert client.post("/api/tasks", json={"title": "r-2"},
                           headers=headers).status_code == 429

    def test_budget_shared_across_granules(self, client, dev,
                                           tiny_device_mutation_limiter):
        """One budget per DEVICE, not per granule (§A.7 granted the
        device): after the tasks write spends the 1-slot budget, a
        notifications write 429s too — a per-granule budget would have
        answered 200 there (fresh budget, untouched granule)."""
        headers = _device_headers(dev["device_token"])
        assert client.post("/api/tasks", json={"title": "g-1"},
                           headers=headers).status_code == 201
        assert client.post("/api/notifications/read", headers=headers
                           ).status_code == 429

    def test_ui_class_not_limited(self, client, app_module, split_tokens,
                                  tiny_device_mutation_limiter):
        """The ui class never enters the device middleware: with a
        1-slot device budget three ui mutations in a row all pass (a
        device would have drawn 429 on the second)."""
        headers = {"Authorization": f"Bearer {UI_TOKEN}"}
        ids = []
        for i in range(3):
            r = client.post("/api/tasks", json={"title": f"ui-{i}"},
                            headers=headers)
            assert r.status_code == 201, r.text
            ids.append(r.json()["id"])
        for task_id in ids:
            client.delete(f"/api/tasks/{task_id}", headers=headers)

    def test_ordering_401_then_403_then_429(self, client, app_module, dev,
                                            tiny_device_mutation_limiter):
        """Budget exhaustion cannot mask the honest codes: an uninvalid
        token is 401 and a non-granted mutation is 403 even when the
        device's budget is fully spent."""
        spent = _device_headers(dev["device_token"])
        assert client.post("/api/tasks", json={"title": "o-1"},
                           headers=spent).status_code == 201
        assert client.post("/api/tasks", json={"title": "o-2"},
                           headers=spent).status_code == 429
        # invalid device token: 401 on any route, budget or not
        assert client.post("/api/tasks", json={"title": "o-3"},
                           headers=_device_headers(
                               "mnd_not-a-real-token")).status_code == 401
        # valid token, mutation outside the granted granules: 403
        row, code = app_module.store.create_pairing_request(
            device_name="a5-empty")
        app_module.store.scan_pairing(row["id"], device_name="a5-empty",
                                      source_ip="testclient")
        app_module.store.confirm_pairing(row["id"], allow=True)
        device, token = app_module.store.issue_device_session(row["id"])
        try:
            app_module.store.set_device_grants(device["id"], [])
            r = client.post("/api/tasks", json={"title": "o-4"},
                            headers=_device_headers(token))
            assert r.status_code == 403, r.text
        finally:
            with _db() as db:
                db.execute("DELETE FROM device_sessions WHERE id=?",
                           (device["id"],))
                db.execute("DELETE FROM pairing_requests WHERE id=?",
                           (row["id"],))


# ------------------------------------------- task.* SSE actor (§A.5 additive)
class TestTaskSseActor:
    def test_device_actor_matches_history(
            self, app_module, client, dev, capture_sse):
        """The device mutation's task.created frame carries
        ``actor == device:<id> <name>`` — byte-identical to the AUTH-2
        attribution the store wrote into the task history (one format
        across audit trail and stream)."""
        headers = _device_headers(dev["device_token"])
        r = client.post("/api/tasks", json={"title": "a5-actor"},
                        headers=headers)
        assert r.status_code == 201, r.text
        task_id = r.json()["id"]
        expected = f"device:{dev['id']} {dev['name']}"
        (frame,) = _task_frames(capture_sse, "task.created")
        assert frame["actor"] == expected
        (event,) = [e for e in app_module.store.task_events(task_id)
                    if e["kind"] == "task.created"]
        assert event["payload"]["actor"] == expected
        client.delete(f"/api/tasks/{task_id}",
                      headers=_device_headers(
                          app_module.UI_WRITE_TOKEN
                          or app_module.BOARD_WRITE_TOKEN))

    def test_ui_actor_header_and_transition_token(
            self, app_module, client, monkeypatch, capture_sse):
        """The ui leg answers ``ui`` — the split-mode ui token AND the
        transition-mode board token alike (the guard counts both as the
        ui class; actor mirrors the guard's classification)."""
        split = {"Authorization": f"Bearer {UI_TOKEN}"}
        legacy = {"Authorization": f"Bearer {app_module.BOARD_WRITE_TOKEN}"}
        for headers in (split, legacy):
            monkeypatch.setattr(app_module, "UI_WRITE_TOKEN",
                                UI_TOKEN if headers is split else "")
            capture_sse.clear()
            r = client.post("/api/tasks", json={"title": "a5-ui"},
                            headers=headers)
            assert r.status_code == 201, r.text
            (frame,) = _task_frames(capture_sse, "task.created")
            assert frame["actor"] == "ui"
            client.delete(f"/api/tasks/{r.json()['id']}", headers=headers)

    def test_dictionary_pin_additive_only(
            self, app_module, client, dev, capture_sse):
        """Contract pin (§A.5): a task.* frame is exactly the pre-§A.5
        dictionary + ``actor`` — nothing removed, nothing renamed, old
        viewers keep working by ignoring the new key. (Sites via
        _notify_and_broadcast additionally carry ``notification`` — the
        pre-existing §11 ride-along, untouched.)"""
        headers = _device_headers(dev["device_token"])
        r = client.post("/api/tasks", json={"title": "a5-pin"},
                        headers=headers)
        assert r.status_code == 201, r.text
        (frame,) = _task_frames(capture_sse, "task.created")
        assert set(frame) == {"kind", "task", "notification", "actor"}
        assert frame["kind"] == "task.created"
        assert frame["task"]["id"] == r.json()["id"]
        client.delete(f"/api/tasks/{r.json()['id']}",
                      headers=_device_headers(
                          app_module.UI_WRITE_TOKEN
                          or app_module.BOARD_WRITE_TOKEN))

    def test_machine_actor_board_token(
            self, app_module, client, auth, make_task, capture_sse):
        """A board-token claim moving the task answers
        ``machine:board`` (no per-caller identity on that token)."""
        task = make_task(title="a5-claim")
        r = client.post("/api/assignments",
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead"},
                        headers=auth)
        assert r.status_code == 201, r.text
        aid = r.json()["assignment"]["id"]
        claim = client.post(f"/api/assignments/{aid}/claim",
                            json={"claimed_by": "a5-poller"},
                            headers=auth)
        assert claim.status_code == 200, claim.text
        (frame,) = [e for e in _task_frames(capture_sse, "task.moved")
                    if e["task"]["id"] == task["id"]]
        assert frame["actor"] == "machine:board"

    def test_machine_actor_executor_format(self, app_module):
        """Executor-backed machine leg: ``machine:<executor_id>`` — the
        registry id, same class:identity grammar (unit pin; the token
        gate itself is _guard_machine_write's contract)."""
        assert app_module._machine_actor({"id": "ex-1"}) == "machine:ex-1"
        assert app_module._machine_actor(None) == "machine:board"

    def test_reaper_actor(self, app_module, client, auth, make_task,
                          data_dir, capture_sse):
        """The reaper's expiry move names itself ``machine:reaper`` — a
        server-internal mutator with no request to classify (the
        test_api_assignments_reaper staging, minimal copy)."""
        task = make_task(title="a5-reaper")
        r = client.post("/api/assignments",
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead"},
                        headers=auth)
        aid = r.json()["assignment"]["id"]
        claim = client.post(f"/api/assignments/{aid}/claim",
                            json={"claimed_by": "a5-poller"},
                            headers=auth)
        client.post(f"/api/assignments/{aid}/start",
                    json={"claim_token": claim.json()["claim_token"]},
                    headers=auth)
        db = sqlite3.connect(data_dir / "board.db")
        try:
            past = (datetime.now(timezone.utc)
                    - timedelta(minutes=45)).isoformat(timespec="seconds")
            db.execute("UPDATE task_assignments SET heartbeat_at=? "
                       "WHERE id=?", (past, aid))
            db.commit()
        finally:
            db.close()
        capture_sse.clear()  # the claim's own task.moved must not pollute
        app_module._assignment_reaper_tick()
        (frame,) = [e for e in _task_frames(capture_sse, "task.moved")
                    if e["task"]["id"] == task["id"]]
        assert frame["actor"] == "machine:reaper"
