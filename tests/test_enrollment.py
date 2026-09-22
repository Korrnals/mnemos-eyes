"""Enrollment of REMOTE executors (ADR 0009 Amd 2 §4 supplement, 2026-09-22).

QA matrix (each test names its line):
- create leg (ui): 201 with the mne_ token shown EXACTLY once; token_hash
  never leaves the store; rate 3/10 min; live-token quota 3 → 409 with NO
  auto-revoke (freeing a slot lets creation succeed); unknown
  harness_hint → 422; fail-closed 503 without a configured ui token;
  split mode: the machine token must NOT mint enrollment tokens;
- registration leg (mne_ or machine): valid token → PENDING executor with
  empty capabilities and registered_via='enrollment:<id>'; unknown token →
  401 (never 404 — a guarded mutation answers 401 for a bad credential);
  spent (used) → 410; expired → 410 (DB time-travel, house pattern) and
  the TTL sweep persists expired + SSE; revoked → 410; duplicate-name
  409 NEVER burns the token (CAS rides the registration transaction);
  single-use race: two competing registrations → exactly one 201;
  machine leg keeps registered_via='' (poller compat, pinned);
- revoke leg (ui): live → revoked + SSE; repeat → 200 idempotent; used →
  409 (kill the EXECUTOR, not the row); unknown → 404;
- guard classes: an mne_ token opens NOTHING else — heartbeat, assignment
  claim and ui PATCH all refuse it;
- hygiene: mne_ masked from day one (SEC-2 lesson); payload audit of every
  enrollment.* SSE carries no token material; audit events carry token_id
  (hash tail) + used_ip;
- E2E-lite: enroll → register → approve+enable → pinned assignment →
  claim/start/heartbeat/complete with the executor's OWN secret → done.
"""

from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest

from conftest import BOARD_TOKEN, DATA_DIR
from server.security import RateLimiter

DB_PATH = DATA_DIR / "board.db"


# ------------------------------------------------------------------ helpers
def _db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def _enrollment_row(enrollment_id: str) -> dict:
    with _db() as db:
        row = db.execute(
            "SELECT * FROM enrollment_tokens WHERE id=?",
            (enrollment_id,)).fetchone()
    assert row is not None
    return dict(row)


def _past_iso(seconds: float = 1.0) -> str:
    return (datetime.now(timezone.utc)
            - timedelta(seconds=seconds)).isoformat(timespec="seconds")


def _create(client, ui_auth, **body) -> dict:
    r = client.post("/api/executors/enrollment",
                    json=body or {"label": "vps-1"}, headers=ui_auth)
    assert r.status_code == 201, r.text
    return r.json()


def _register(client, token: str, name: str, **extra):
    return client.post(
        "/api/executors",
        json={"name": name, "harness": "zcode"} | extra,
        headers={"Authorization": f"Bearer {token}"})


@pytest.fixture(autouse=True)
def fresh_enrollment_state(app_module, monkeypatch):
    """Per-test isolation: fresh rate limiters (module globals accumulate
    across the session-scoped client), a wiped enrollment table and a
    wiped executor registry (mirror of the test_api_executors fixture)."""
    for name in ("_enrollment_create_limiter", "_enrollment_revoke_limiter",
                 "_executor_register_limiter"):
        limiter = getattr(app_module, name)
        monkeypatch.setattr(
            app_module, name,
            RateLimiter(limit=limiter.limit, window=limiter.window))
    with app_module.store._lock, app_module.store._conn() as db:
        db.execute("DELETE FROM enrollment_tokens")
        db.execute("DELETE FROM executors")
    yield
    with app_module.store._lock, app_module.store._conn() as db:
        db.execute("DELETE FROM enrollment_tokens")
        db.execute("DELETE FROM executors")


@pytest.fixture()
def capture_sse(app_module, monkeypatch):
    """Collect every broadcast event (tests assert payloads afterwards)."""
    events: list[dict] = []
    monkeypatch.setattr(app_module, "_broadcast", events.append)
    return events


def _enrollment_events(events: list[dict]) -> list[dict]:
    return [e for e in events
            if str(e.get("kind", "")).startswith("enrollment.")]


def _board_events(app_module, kind: str) -> list[dict]:
    """Audit events of ONE kind, direct SQL — store.events(limit=N) reads
    the FIRST N rows ascending, which silently drops recent events once a
    session's events table outgrows the window (observed at 78% of the
    full suite). Volume-independent by construction."""
    with app_module.store._lock, app_module.store._conn() as db:
        rows = db.execute(
            "SELECT id, ts, kind, task_id, payload FROM events "
            "WHERE kind=? ORDER BY id ASC", (kind,)).fetchall()
    out = []
    for r in rows:
        e = dict(r)
        e["payload"] = json.loads(e["payload"])
        out.append(e)
    return out


# --------------------------------------------------------------- create leg
class TestCreateLeg:
    def test_created_token_shown_once(self, client, ui_auth):
        out = _create(client, ui_auth, label="vps-1", harness_hint="zcode",
                      name_hint="vps-1")
        token = out["token"]
        assert token.startswith("mne_") and len(token) > 20
        assert out["enrollment"]["state"] == "created"
        ttl = (datetime.fromisoformat(out["enrollment"]["expires_at"])
               - datetime.now(timezone.utc)).total_seconds()
        assert 14 * 60 < ttl <= 15 * 60          # 15-min TTL constant
        # hash-only: no material and no hash in ANY public shape
        assert "token_hash" not in out["enrollment"]
        listed = client.get("/api/executors/enrollment",
                            headers=ui_auth).json()
        assert listed["count"] == 1
        item = listed["items"][0]
        assert item["enrollment_id"] == out["enrollment"]["enrollment_id"]
        assert "token" not in item and "token_hash" not in item
        with _db() as db:                        # the store keeps ONLY the hash
            row = db.execute(
                "SELECT token_hash FROM enrollment_tokens WHERE id=?",
                (out["enrollment"]["enrollment_id"],)).fetchone()
        assert row["token_hash"] != token
        assert len(row["token_hash"]) == 64      # sha256 hex

    def test_split_mode_machine_token_cannot_mint(self, client, app_module,
                                                  split_tokens):
        # headers resolved AFTER split_tokens applied (fixture order) —
        # the current effective ui token, not the machine one
        effective = app_module.UI_WRITE_TOKEN or app_module.BOARD_WRITE_TOKEN
        ui = {"Authorization": f"Bearer {effective}"}
        r = client.post("/api/executors/enrollment", json={"label": "x"},
                        headers={"Authorization": f"Bearer {BOARD_TOKEN}"})
        assert r.status_code == 401
        assert client.post("/api/executors/enrollment", json={"label": "x"},
                           headers=ui).status_code == 201

    def test_fail_closed_503_without_ui_token(self, client, no_board_token):
        r = client.post("/api/executors/enrollment", json={"label": "x"})
        assert r.status_code == 503
        assert "fail-closed" in r.json()["detail"]

    def test_create_rate_limit_429(self, client, ui_auth):
        for i in range(3):
            assert _create(client, ui_auth, label=f"vps-{i}") is not None
        r = client.post("/api/executors/enrollment", json={"label": "vps-4"},
                        headers=ui_auth)
        assert r.status_code == 429
        assert "3 per 600s" in r.json()["detail"]

    def test_live_quota_3_no_auto_revoke(self, client, ui_auth, app_module,
                                         monkeypatch):
        ids = [_create(client, ui_auth, label=f"vps-{i}")
               ["enrollment"]["enrollment_id"] for i in range(3)]
        # the 3/10-min creation limiter is spent — refresh it so THIS test
        # exercises the volume quota (409), not the pace limit (429)
        monkeypatch.setattr(
            app_module, "_enrollment_create_limiter",
            RateLimiter(limit=app_module._ENROLLMENT_CREATE_RATE_LIMIT,
                        window=app_module._ENROLLMENT_CREATE_RATE_WINDOW))
        r = client.post("/api/executors/enrollment", json={"label": "vps-4"},
                        headers=ui_auth)
        assert r.status_code == 409
        assert "capped at 3" in r.json()["detail"]
        # NO auto-eviction: all three live tokens are untouched
        states = {i: _enrollment_row(i)["state"] for i in ids}
        assert set(states.values()) == {"created"}
        # freeing a slot manually lets the next creation succeed
        assert client.delete(f"/api/executors/enrollment/{ids[0]}",
                             headers=ui_auth).status_code == 200
        assert client.post("/api/executors/enrollment", json={"label": "v"},
                           headers=ui_auth).status_code == 201

    def test_unknown_harness_hint_422(self, client, ui_auth):
        r = client.post("/api/executors/enrollment",
                        json={"label": "x", "harness_hint": "bogus"},
                        headers=ui_auth)
        assert r.status_code == 422


# ---------------------------------------------------------- registration leg
class TestRegisterLeg:
    def test_register_creates_pending_with_origin(
            self, client, ui_auth, app_module):
        out = _create(client, ui_auth, label="vps-1", harness_hint="zcode")
        r = _register(client, out["token"], "vps-1-exec", host="vps-1")
        assert r.status_code == 201, r.text
        executor = r.json()["executor"]
        assert executor["state"] == "pending"
        assert executor["capabilities"] == []     # owner-declared, never self
        assert executor["registered_via"] == \
            f"enrollment:{out['enrollment']['enrollment_id']}"
        secret = r.json()["executor_secret"]
        assert secret and secret != out["token"]
        # pending may tick presence (owner sees liveness before approving)
        r = client.post(f"/api/executors/{executor['id']}/heartbeat",
                        headers={"Authorization": f"Bearer {secret}"})
        assert r.status_code == 200
        # the token row records the spend for the owner's approve review
        row = _enrollment_row(out["enrollment"]["enrollment_id"])
        assert row["state"] == "used"
        assert row["executor_id"] == executor["id"]
        assert row["used_at"] and row["used_ip"]

    def test_unknown_token_401_never_404(self, client):
        r = _register(client, "mne_never_minted", "ghost")
        assert r.status_code == 401
        assert r.json()["detail"] == "enrollment token required or invalid"

    def test_token_single_use_410(self, client, ui_auth):
        out = _create(client, ui_auth)
        assert _register(client, out["token"], "first").status_code == 201
        r = _register(client, out["token"], "second")
        assert r.status_code == 410
        assert r.json()["detail"] == "enrollment token already used"
        names = [e["name"] for e in
                 client.get("/api/executors").json()["items"]]
        assert names == ["first"]

    def test_expired_410_then_sweep_persists(self, client, ui_auth,
                                             app_module, capture_sse):
        out = _create(client, ui_auth)
        with _db() as db:                        # house time-travel: move TTL
            db.execute(
                "UPDATE enrollment_tokens SET expires_at=? WHERE id=?",
                (_past_iso(), out["enrollment"]["enrollment_id"]))
        r = _register(client, out["token"], "late")
        assert r.status_code == 410
        assert "expired" in r.json()["detail"]
        result = app_module._pairing_sweep_once()
        assert result["enrollments_expired"] == 1
        assert _enrollment_row(
            out["enrollment"]["enrollment_id"])["state"] == "expired"
        kinds = [e["kind"] for e in _enrollment_events(capture_sse)]
        assert kinds.count("enrollment.expired") == 1
        assert "enrollment.created" in kinds

    def test_revoked_410(self, client, ui_auth):
        out = _create(client, ui_auth)
        assert client.delete(
            f"/api/executors/enrollment/{out['enrollment']['enrollment_id']}",
            headers=ui_auth).status_code == 200
        r = _register(client, out["token"], "blocked")
        assert r.status_code == 410
        assert r.json()["detail"] == "enrollment token revoked"

    def test_duplicate_name_rolls_back_without_burning_token(
            self, client, ui_auth):
        """CAS rides the registration transaction: a 409 (duplicate name)
        must leave the token CREATED — the retry with a new name succeeds."""
        _register(client, BOARD_TOKEN, "taken")   # occupy the name (machine leg)
        out = _create(client, ui_auth)
        r = _register(client, out["token"], "taken")
        assert r.status_code == 409
        assert _enrollment_row(
            out["enrollment"]["enrollment_id"])["state"] == "created"
        assert _register(client, out["token"], "free-name").status_code == 201

    def test_single_use_race_exactly_one_winner(self, client, ui_auth):
        out = _create(client, ui_auth)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(_register, client, out["token"], name)
                       for name in ("race-a", "race-b")]
            statuses = sorted(f.result().status_code for f in futures)
        assert statuses == [201, 410]            # one winner, honest loser
        assert len(client.get("/api/executors").json()["items"]) == 1

    def test_machine_leg_keeps_registered_via_empty(self, client, auth):
        r = client.post("/api/executors",
                        json={"name": "legacy", "harness": "zcode"},
                        headers=auth)
        assert r.status_code == 201
        assert r.json()["executor"]["registered_via"] == ""


# --------------------------------------------------------------- revoke leg
class TestRevokeLeg:
    def test_revoke_lifecycle(self, client, ui_auth, capture_sse):
        out = _create(client, ui_auth)
        eid = out["enrollment"]["enrollment_id"]
        r = client.delete(f"/api/executors/enrollment/{eid}", headers=ui_auth)
        assert r.status_code == 200
        assert r.json()["enrollment"]["state"] == "revoked"
        assert "enrollment.revoked" in [
            e["kind"] for e in _enrollment_events(capture_sse)]
        # repeat revoke → 200 idempotent (pairing-cancel pattern)
        assert client.delete(f"/api/executors/enrollment/{eid}",
                             headers=ui_auth).status_code == 200
        # used → 409: the executor exists — kill it via the registry
        out2 = _create(client, ui_auth)
        assert _register(client, out2["token"], "user").status_code == 201
        r = client.delete(
            f"/api/executors/enrollment/{out2['enrollment']['enrollment_id']}",
            headers=ui_auth)
        assert r.status_code == 409
        assert "used" in r.json()["detail"]
        # unknown → 404
        assert client.delete("/api/executors/enrollment/enr-nosuch",
                             headers=ui_auth).status_code == 404


# ------------------------------------------------------------- guard classes
class TestGuardClasses:
    def test_mne_token_opens_nothing_else(self, client, ui_auth, auth,
                                          make_task):
        """Scope = registration ONLY: heartbeat, assignment claim and ui
        PATCH all refuse an mne_ bearer."""
        out = _create(client, ui_auth)
        mne = {"Authorization": f"Bearer {out['token']}"}
        # executor presence tick → not an executor secret
        r = client.post("/api/executors/ex-whatever/heartbeat", headers=mne)
        assert r.status_code == 401
        # assignment claim → not a board token, not an approved executor
        task = make_task(title="guard-enroll")
        r = client.post("/api/assignments", headers=auth,
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead"})
        aid = r.json()["assignment"]["id"]
        r = client.post(f"/api/assignments/{aid}/claim", headers=mne,
                        json={"claimed_by": "thief"})
        assert r.status_code == 401
        # owner PATCH → not a ui token (constant-time compare misses)
        assert client.patch("/api/executors/enrollment", json={},
                            headers=mne).status_code in (401, 405)


# ------------------------------------------------------------------- hygiene
class TestHygiene:
    def test_mne_masked_from_day_one(self):
        from server.security import mask_secrets
        assert mask_secrets("token mne_Ab12-x_yZ9 leak") == \
            "token mne_<redacted> leak"
        assert mask_secrets("Bearer mne_secret1 and mne_secret2") == \
            "Bearer <redacted> and mne_<redacted>"

    def test_payload_audit_never_carries_token_material(
            self, client, ui_auth, capture_sse):
        out = _create(client, ui_auth, label="vps-audit")
        token = out["token"]
        assert _register(client, token, "audit-exec").status_code == 201
        client.delete(
            f"/api/executors/enrollment/{out['enrollment']['enrollment_id']}",
            headers=ui_auth)
        for event in _enrollment_events(capture_sse):
            raw = json.dumps(event, ensure_ascii=False)
            assert token not in raw
            assert "token_hash" not in raw
            assert token[-8:] not in raw or "token_id" in raw

    def test_audit_events_written_with_token_id(
            self, client, ui_auth, app_module):
        out = _create(client, ui_auth, label="vps-audit2")
        assert _register(client, out["token"], "audit2").status_code == 201
        created = _board_events(app_module, "enrollment.created")
        used = _board_events(app_module, "enrollment.used")
        expected_id = _enrollment_row(
            out["enrollment"]["enrollment_id"])["token_hash"][-8:]
        assert created and created[-1]["payload"]["token_id"] == expected_id
        assert used and used[-1]["payload"]["token_id"] == expected_id
        assert used[-1]["payload"]["used_ip"]
        assert used[-1]["payload"]["executor_name"] == "audit2"
        assert "mne_" not in json.dumps(created[-1]) + json.dumps(used[-1])


# ------------------------------------------------------------------- E2E-lite
class TestEnrolledExecutorEndToEnd:
    def test_enroll_to_done_full_chain(self, client, ui_auth, auth,
                                       make_task):
        """enroll → register → approve+enable → pinned assignment →
        claim/start/heartbeat/complete WITH THE EXECUTOR'S OWN SECRET."""
        out = _create(client, ui_auth, label="vps-e2e", harness_hint="zcode")
        r = _register(client, out["token"], "vps-e2e-exec", host="vps-e2e")
        executor, secret = (r.json()["executor"],
                            r.json()["executor_secret"])
        r = client.patch(f"/api/executors/{executor['id']}",
                         json={"state": "approved", "enabled": True,
                               "capabilities": ["backend"]},
                         headers=auth)
        assert r.status_code == 200
        task = make_task(title="e2e-enroll")
        r = client.post("/api/assignments", headers=auth,
                        json={"task_id": task["id"],
                              "specialist": "gcw-senior-system-engineer",
                              "executor_id": executor["id"]})
        assert r.status_code == 201, r.text
        aid = r.json()["assignment"]["id"]
        # the enrolled executor claims with ITS secret — never the board token
        ex = {"Authorization": f"Bearer {secret}"}
        claim = client.post(f"/api/assignments/{aid}/claim", headers=ex,
                            json={"claimed_by": "vps-poller",
                                  "executor_id": executor["id"]})
        assert claim.status_code == 200, claim.text
        assert claim.json()["assignment"]["claimed_by_executor"] == \
            executor["id"]
        token = claim.json()["claim_token"]
        assert client.post(f"/api/assignments/{aid}/start",
                           json={"claim_token": token},
                           headers=ex).status_code == 200
        assert client.post(f"/api/assignments/{aid}/heartbeat",
                           json={"claim_token": token, "note": "tick"},
                           headers=ex).status_code == 200
        done = client.post(f"/api/assignments/{aid}/complete",
                           json={"claim_token": token,
                                 "final_report": "готово на VPS"},
                           headers=ex)
        assert done.status_code == 200
        assert done.json()["assignment"]["state"] == "done"
        assert done.json()["task"]["col"] == "resolved"
