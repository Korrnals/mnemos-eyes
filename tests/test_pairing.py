"""CV-7 (ADR 0012): QR pairing + device tokens — the QA matrix §11.

Pinned contract (each test names its matrix line):
- state machine: legal transitions honored, illegal ones → 4xx;
- TTL boundary → 410 (wall-clock stamps are moved IN THE DB — the house
  time-travel pattern, no clock injection);
- single-use: repeat exchange after issued → 410; exactly one winner
  among competing exchanges (store-level thread race + API-level race);
- bounded attempts → 429 (creation 3/10 min, confirm 3/10 min, exchange
  5/10 min per pairing);
- source-IP binding: a second client IP → 403 + security notification;
- device-token revoke → 401 on the next request;
- sliding TTL uniform for every device (30 d, §A.7 owner override —
  the scope-differentiated 7 d control clock is retired) /
  hard 90 d;
- 6th device → 409 with NO auto-eviction (oldest stays active; freeing a
  slot manually lets the pending exchange succeed);
- device token outside its scope → 403, never 401 (scope middleware stands
  before _guard_write); the full v1 scope matrix: test_device_scope_v1.py
- the DB stores ONLY hashes (code_hash / token_hash introspection);
- mnd_ is masked in logs from day one (SEC-2 lesson);
- pairing surface fail-closed 503 without a configured ui token;
- repeat confirm → 200 idempotent; repeat exchange in scanned → 202 with
  NO duplicate SSE;
- payload audit: no code / verify digits / device_token in any pairing.*
  SSE event or stored notification — ever.

Poller compatibility (the blocking constraint): the legacy prefix-less
board token keeps passing the existing guards — pinned at the bottom.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from conftest import BOARD_TOKEN, DATA_DIR

DB_PATH = DATA_DIR / "board.db"


# ------------------------------------------------------------------ helpers
def _db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def _pairing_row(pairing_id: str) -> dict:
    with _db() as db:
        row = db.execute(
            "SELECT * FROM pairing_requests WHERE id=?",
            (pairing_id,)).fetchone()
    assert row is not None
    return dict(row)


def _device_row(device_id: str) -> dict:
    with _db() as db:
        row = db.execute(
            "SELECT * FROM device_sessions WHERE id=?",
            (device_id,)).fetchone()
    assert row is not None
    return dict(row)


def _past_iso(seconds: float = 1.0) -> str:
    return (datetime.now(timezone.utc)
            - timedelta(seconds=seconds)).isoformat(timespec="seconds")


def _future_iso(seconds: float) -> str:
    return (datetime.now(timezone.utc)
            + timedelta(seconds=seconds)).isoformat(timespec="seconds")


def _create(client, ui_auth, device_name: str = "") -> dict:
    r = client.post("/api/pairing", json={"device_name": device_name},
                    headers=ui_auth)
    assert r.status_code == 201, r.text
    return r.json()


def _exchange(client, code: str, device_name: str = "qa-device"):
    return client.post("/api/pairing/exchange",
                       json={"code": code, "device_name": device_name})


def _confirm(client, ui_auth, pairing_id: str, allow: bool = True):
    return client.post(f"/api/pairing/{pairing_id}/confirm",
                       json={"allow": allow}, headers=ui_auth)


def _pair_to_scanned(client, ui_auth, device_name: str = "qa-device") -> dict:
    """create + first exchange → the pairing sits in `scanned`."""
    p = _create(client, ui_auth)
    r = _exchange(client, p["code"], device_name)
    assert r.status_code == 202, r.text
    return p


def _pair_to_confirmed(client, ui_auth, device_name: str = "qa-device") -> dict:
    p = _pair_to_scanned(client, ui_auth, device_name)
    r = _confirm(client, ui_auth, p["pairing_id"])
    assert r.status_code == 200, r.text
    return p


def _paired_device(client, ui_auth, device_name: str = "qa-device") -> dict:
    """Full legal flow → {pairing_id, code, device_id, device_token, ...}."""
    p = _pair_to_confirmed(client, ui_auth, device_name)
    r = _exchange(client, p["code"], device_name)
    assert r.status_code == 200, r.text
    out = r.json()
    out["pairing_id"] = p["pairing_id"]
    out["code"] = p["code"]
    return out


def _device_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _exchange_from_ip(app, ip: str, code: str, device_name: str = "device"):
    """One exchange request presenting a DIFFERENT source IP (the ASGI
    scope client tuple). ASGITransport is async-only, so this runs a
    single-request asyncio loop."""
    async def call() -> httpx.Response:
        transport = httpx.ASGITransport(app=app, client=(ip, 44000))
        async with httpx.AsyncClient(transport=transport,
                                     base_url="http://t") as ac:
            return await ac.post("/api/pairing/exchange",
                                 json={"code": code,
                                       "device_name": device_name})
    return asyncio.run(call())


@pytest.fixture(autouse=True)
def fresh_pairing_limiters(app_module, monkeypatch):
    """Fresh per-test rate limiters — the app-level ones are module
    globals keyed on the (single) TestClient IP; without a reset the
    3/10-min budgets would bleed across the whole module."""
    from server.security import RateLimiter
    for attr, limit, window in (
        ("_pairing_create_limiter",
         app_module._PAIRING_CREATE_RATE_LIMIT,
         app_module._PAIRING_CREATE_RATE_WINDOW),
        ("_pairing_confirm_limiter",
         app_module._PAIRING_CONFIRM_RATE_LIMIT,
         app_module._PAIRING_CONFIRM_RATE_WINDOW),
        ("_pairing_exchange_limiter",
         app_module._PAIRING_EXCHANGE_RATE_LIMIT,
         app_module._PAIRING_EXCHANGE_RATE_WINDOW),
        ("_pairing_ip_limiter",
         app_module._PAIRING_IP_RATE_LIMIT,
         app_module._PAIRING_IP_RATE_WINDOW),
    ):
        monkeypatch.setattr(
            app_module, attr, RateLimiter(limit=limit, window=window))


@pytest.fixture(autouse=True)
def pairing_db_cleanup():
    """Tests share the session DB — drop the pairing/device rows this test
    created so the ≤5-active quota never bleeds between tests."""
    with _db() as db:
        before_pairings = {r["id"] for r in db.execute(
            "SELECT id FROM pairing_requests").fetchall()}
        before_devices = {r["id"] for r in db.execute(
            "SELECT id FROM device_sessions").fetchall()}
    yield
    with _db() as db:
        for table, before in (("pairing_requests", before_pairings),
                              ("device_sessions", before_devices)):
            for row in db.execute(f"SELECT id FROM {table}").fetchall():
                if row["id"] not in before:
                    db.execute(f"DELETE FROM {table} WHERE id=?",
                               (row["id"],))


@pytest.fixture()
def capture_sse(app_module, monkeypatch):
    """Collect every broadcast event (tests assert payloads afterwards)."""
    events: list[dict] = []
    monkeypatch.setattr(app_module, "_broadcast", events.append)
    return events


@pytest.fixture()
def fresh_report_limiter(app_module, monkeypatch):
    """Isolated report rate limiter for the poller-compat leg (the app
    one is a module global exhausted by earlier test files)."""
    from server.security import RateLimiter
    limiter = RateLimiter(limit=app_module._REPORT_RATE_LIMIT,
                          window=app_module._REPORT_RATE_WINDOW)
    monkeypatch.setattr(app_module, "_report_limiter", limiter)
    return limiter


def _pairing_events(events: list[dict]) -> list[dict]:
    return [e for e in events if str(e.get("kind", "")).startswith("pairing.")]


# ---------------------------------------------------- state machine (legal)
class TestStateMachineLegal:
    def test_created_to_scanned_to_confirmed_to_issued(self, client, ui_auth):
        p = _pair_to_scanned(client, ui_auth)
        assert _pairing_row(p["pairing_id"])["state"] == "scanned"
        r = _confirm(client, ui_auth, p["pairing_id"])
        assert r.status_code == 200
        assert r.json()["state"] == "confirmed"
        r = _exchange(client, p["code"])
        assert r.status_code == 200
        assert r.json()["device_token"].startswith("mnd_")
        assert _pairing_row(p["pairing_id"])["state"] == "issued"

    def test_confirm_deny_revokes(self, client, ui_auth):
        p = _pair_to_scanned(client, ui_auth)
        r = _confirm(client, ui_auth, p["pairing_id"], allow=False)
        assert r.status_code == 200
        assert r.json()["state"] == "revoked"

    def test_cancel_from_created_scanned_confirmed(self, client, ui_auth):
        for maker in (
            lambda: _create(client, ui_auth),
            lambda: _pair_to_scanned(client, ui_auth),
            lambda: _pair_to_confirmed(client, ui_auth),
        ):
            p = maker()
            r = client.delete(f"/api/pairing/{p['pairing_id']}",
                              headers=ui_auth)
            assert r.status_code == 200, r.text
            assert _pairing_row(p["pairing_id"])["state"] == "revoked"

    def test_cancel_revoked_is_idempotent_200(self, client, ui_auth):
        p = _pair_to_scanned(client, ui_auth)
        assert client.delete(
            f"/api/pairing/{p['pairing_id']}", headers=ui_auth).status_code == 200
        r = client.delete(f"/api/pairing/{p['pairing_id']}", headers=ui_auth)
        assert r.status_code == 200

    def test_status_reports_effective_expired_before_sweep(self, client, ui_auth):
        p = _pair_to_scanned(client, ui_auth)
        with _db() as db:
            db.execute("UPDATE pairing_requests SET expires_at=? WHERE id=?",
                       (_past_iso(), p["pairing_id"]))
        r = client.get(f"/api/pairing/{p['pairing_id']}", headers=ui_auth)
        assert r.status_code == 200
        assert r.json()["state"] == "expired"

    def test_create_time_device_name_is_overwritten_by_scan(self, client, ui_auth):
        p = _create(client, ui_auth, device_name="owner-label")
        r = _exchange(client, p["code"], "device-claims")
        assert r.status_code == 202
        row = _pairing_row(p["pairing_id"])
        assert row["device_name"] == "device-claims"

    def test_issuance_cannot_rewrite_scan_time_name(self, client, ui_auth):
        """Review P2 (consent integrity): the owner confirmed the SCAN-time
        name — a device presenting a different name on the issuance
        exchange gets its token under the scan-time name regardless."""
        p = _create(client, ui_auth)
        assert _exchange(client, p["code"], "Pixel-9").status_code == 202
        assert _confirm(client, ui_auth, p["pairing_id"]).status_code == 200
        r = _exchange(client, p["code"], "Bank-Validator")
        assert r.status_code == 200, r.text  # issued — one-shot, same IP
        device_id = r.json()["device_id"]
        devices = client.get("/api/devices", headers=ui_auth).json()["items"]
        mine = [d for d in devices if d["id"] == device_id]
        assert mine and mine[0]["name"] == "Pixel-9"


# -------------------------------------------------- state machine (illegal)
class TestStateMachineIllegal:
    def test_confirm_before_scan_409(self, client, ui_auth):
        p = _create(client, ui_auth)
        r = _confirm(client, ui_auth, p["pairing_id"])
        assert r.status_code == 409

    def test_delete_issued_pairing_409(self, client, ui_auth):
        dev = _paired_device(client, ui_auth)
        r = client.delete(f"/api/pairing/{dev['pairing_id']}",
                          headers=ui_auth)
        assert r.status_code == 409

    def test_exchange_unknown_code_404(self, client):
        r = _exchange(client, "mnd_never_minted_code")
        assert r.status_code == 404

    def test_exchange_after_cancel_410(self, client, ui_auth):
        p = _pair_to_scanned(client, ui_auth)
        assert client.delete(
            f"/api/pairing/{p['pairing_id']}", headers=ui_auth).status_code == 200
        assert _exchange(client, p["code"]).status_code == 410

    def test_exchange_after_deny_410(self, client, ui_auth):
        p = _pair_to_scanned(client, ui_auth)
        _confirm(client, ui_auth, p["pairing_id"], allow=False)
        assert _exchange(client, p["code"]).status_code == 410

    def test_unknown_pairing_404s(self, client, ui_auth):
        assert client.get("/api/pairing/pr-doesnotexist",
                          headers=ui_auth).status_code == 404
        assert _confirm(client, ui_auth, "pr-doesnotexist").status_code == 404
        assert client.delete("/api/pairing/pr-doesnotexist",
                             headers=ui_auth).status_code == 404
        assert client.delete("/api/devices/dev-doesnotexist",
                             headers=ui_auth).status_code == 404

    def test_device_name_over_64_chars_422(self, client, ui_auth):
        r = client.post("/api/pairing",
                        json={"device_name": "x" * 65}, headers=ui_auth)
        assert r.status_code == 422
        p = _create(client, ui_auth)
        r = _exchange(client, p["code"], "y" * 65)
        assert r.status_code == 422

    def test_confirm_body_requires_allow(self, client, ui_auth):
        p = _pair_to_scanned(client, ui_auth)
        r = client.post(f"/api/pairing/{p['pairing_id']}/confirm",
                        json={}, headers=ui_auth)
        assert r.status_code == 422


# ---------------------------------------------------------------- TTL → 410
class TestTtl:
    def test_expired_pairing_exchange_410(self, client, ui_auth):
        p = _pair_to_scanned(client, ui_auth)
        with _db() as db:
            db.execute("UPDATE pairing_requests SET expires_at=? WHERE id=?",
                       (_past_iso(), p["pairing_id"]))
        assert _exchange(client, p["code"]).status_code == 410

    def test_expired_pairing_confirm_410(self, client, ui_auth):
        p = _pair_to_scanned(client, ui_auth)
        with _db() as db:
            db.execute("UPDATE pairing_requests SET expires_at=? WHERE id=?",
                       (_past_iso(), p["pairing_id"]))
        assert _confirm(client, ui_auth, p["pairing_id"]).status_code == 410

    def test_expired_pairing_delete_410(self, client, ui_auth):
        p = _pair_to_scanned(client, ui_auth)
        with _db() as db:
            db.execute("UPDATE pairing_requests SET expires_at=? WHERE id=?",
                       (_past_iso(), p["pairing_id"]))
        assert client.delete(f"/api/pairing/{p['pairing_id']}",
                             headers=ui_auth).status_code == 410

    def test_sweep_expires_and_emits_once(self, client, ui_auth, app_module,
                                          capture_sse):
        p = _pair_to_scanned(client, ui_auth)
        with _db() as db:
            db.execute("UPDATE pairing_requests SET expires_at=? WHERE id=?",
                       (_past_iso(), p["pairing_id"]))
        counts = app_module._pairing_sweep_once()
        assert counts["pairings_expired"] >= 1
        assert _pairing_row(p["pairing_id"])["state"] == "expired"
        expired = [e for e in _pairing_events(capture_sse)
                   if e["kind"] == "pairing.expired"]
        assert any(e["pairing_id"] == p["pairing_id"] for e in expired)
        # second pass: nothing left to flip (idempotent sweep)
        before = len(capture_sse)
        assert app_module._pairing_sweep_once()["pairings_expired"] == 0
        assert len(capture_sse) == before


# ------------------------------------------------------- single-use issuance
class TestSingleUse:
    def test_repeat_exchange_after_issued_410(self, client, ui_auth):
        dev = _paired_device(client, ui_auth)
        assert _exchange(client, dev["code"]).status_code == 410

    def test_store_issue_race_exactly_one_token(self, client, ui_auth,
                                                app_module):
        """The matrix race, store level: N threads issue the SAME confirmed
        pairing — the CAS lets exactly one through, the rest raise."""
        p = _pair_to_confirmed(client, ui_auth)
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(app_module.store.issue_device_session,
                                   p["pairing_id"])
                       for _ in range(8)]
            results = []
            for f in futures:
                try:
                    results.append(f.result())
                except Exception as exc:  # noqa — the losers' refusals
                    results.append(exc)
        issued = [r for r in results if not isinstance(r, Exception)]
        refused = [r for r in results if isinstance(r, Exception)]
        assert len(issued) == 1
        assert len(refused) == 7
        assert _pairing_row(p["pairing_id"])["state"] == "issued"

    def test_api_competing_exchanges_one_issued(self, client, ui_auth,
                                                app_module):
        """The matrix race, API level: two concurrent exchange requests —
        exactly one 200 with a token, the loser 410. The transport carries
        the same source IP the TestClient bound the pairing to."""
        p = _pair_to_confirmed(client, ui_auth)

        async def race() -> tuple:
            transport = httpx.ASGITransport(
                app=app_module.app, client=("testclient", 50000))
            async with httpx.AsyncClient(transport=transport,
                                         base_url="http://t") as ac:
                return await asyncio.gather(
                    ac.post("/api/pairing/exchange",
                            json={"code": p["code"], "device_name": "a"}),
                    ac.post("/api/pairing/exchange",
                            json={"code": p["code"], "device_name": "b"}))

        r1, r2 = asyncio.run(race())
        codes = sorted((r1.status_code, r2.status_code))
        assert codes == [200, 410]
        winner = r1 if r1.status_code == 200 else r2
        assert winner.json()["device_token"].startswith("mnd_")


# ---------------------------------------------------------- bounded attempts
class TestRateLimits:
    def test_creation_4th_in_window_429(self, client, ui_auth):
        for _ in range(3):
            assert _create(client, ui_auth)["state"] == "created"
        r = client.post("/api/pairing", json={}, headers=ui_auth)
        assert r.status_code == 429

    def test_exchange_6th_per_pairing_429(self, client, ui_auth):
        p = _create(client, ui_auth)
        for _ in range(5):  # budget exactly 5/10 min per pairing
            assert _exchange(client, p["code"]).status_code == 202
        assert _exchange(client, p["code"]).status_code == 429

    def test_confirm_4th_in_window_429(self, client, ui_auth):
        p = _pair_to_scanned(client, ui_auth)
        for _ in range(3):  # idempotent repeats still consume budget
            assert _confirm(client, ui_auth,
                            p["pairing_id"]).status_code == 200
        assert _confirm(client, ui_auth, p["pairing_id"]).status_code == 429

    def test_garbage_codes_do_not_consume_pairing_budget(self, client,
                                                         ui_auth):
        """Memory-DoS guard (§3.4): the pairing-keyed limiter engages only
        AFTER a valid code lookup — garbage never grows its key space, and
        a real pairing keeps its full 5-exchange budget afterwards."""
        for _ in range(10):
            assert _exchange(client, "garbage-code").status_code == 404
        p = _create(client, ui_auth)
        for _ in range(5):
            assert _exchange(client, p["code"]).status_code == 202


# ------------------------------------------------------------ IP binding §3.1
class TestIpBinding:
    def test_second_ip_403_and_notification(self, client, ui_auth, app_module,
                                            capture_sse):
        p = _create(client, ui_auth)
        assert _exchange(client, p["code"]).status_code == 202  # binds IP
        r = _exchange_from_ip(app_module.app, "10.99.0.7", p["code"], "evil")
        assert r.status_code == 403
        # the security fact rides a system notification (fact only — no
        # digits, no code; the §11 dictionary has no dedicated kind)
        notes = app_module.store.notifications(limit=50)
        assert any("чужого IP" in n["title"] for n in notes)

    def test_original_ip_still_polls_after_rejected_foreign(self, client,
                                                            ui_auth):
        p = _pair_to_scanned(client, ui_auth)
        assert _exchange(client, p["code"]).status_code == 202

    def test_binding_survives_until_issuance(self, client, ui_auth, app_module):
        p = _pair_to_confirmed(client, ui_auth)
        r = _exchange_from_ip(app_module.app, "10.99.0.8", p["code"])
        assert r.status_code == 403  # even with confirm in place
        assert _exchange(client, p["code"]).status_code == 200


# ------------------------------------------------------- device-token lifecycle
class TestDeviceTokens:
    def test_revoke_then_401_on_next_request(self, client, ui_auth):
        dev = _paired_device(client, ui_auth)
        assert client.get("/api/health",
                          headers=_device_headers(dev["device_token"])
                          ).status_code == 200
        r = client.delete(f"/api/devices/{dev['device_id']}", headers=ui_auth)
        assert r.status_code == 200
        r = client.get("/api/health", headers=_device_headers(dev["device_token"]))
        assert r.status_code == 401

    def test_revoke_emits_sse_with_device_id(self, client, ui_auth, capture_sse):
        dev = _paired_device(client, ui_auth)
        capture_sse.clear()
        assert client.delete(f"/api/devices/{dev['device_id']}",
                             headers=ui_auth).status_code == 200
        revoked = [e for e in _pairing_events(capture_sse)
                   if e["kind"] == "pairing.revoked"]
        assert any(e.get("device_id") == dev["device_id"] for e in revoked)

    def test_devices_list_has_no_token_material(self, client, ui_auth):
        dev = _paired_device(client, ui_auth)
        r = client.get("/api/devices", headers=ui_auth)
        assert r.status_code == 200
        body = json.dumps(r.json())
        assert "token_hash" not in body
        assert dev["device_token"] not in body

    def test_invalid_mnd_token_401(self, client):
        r = client.get("/api/health", headers=_device_headers("mnd_forged"))
        assert r.status_code == 401

    def test_sliding_ttl_lapse_401(self, client, ui_auth):
        dev = _paired_device(client, ui_auth)
        with _db() as db:
            db.execute("UPDATE device_sessions SET expires_at=? WHERE id=?",
                       (_past_iso(), dev["device_id"]))
        assert client.get("/api/health",
                          headers=_device_headers(
                              dev["device_token"])).status_code == 401
        assert _device_row(dev["device_id"])["state"] == "expired"

    def test_hard_ttl_wins_over_activity_401(self, client, ui_auth):
        dev = _paired_device(client, ui_auth)
        with _db() as db:
            db.execute(
                "UPDATE device_sessions SET expires_at=?, hard_expires_at=? "
                "WHERE id=?",
                (_future_iso(40 * 86400), _past_iso(), dev["device_id"]))
        assert client.get("/api/health",
                          headers=_device_headers(
                              dev["device_token"])).status_code == 401

    def test_sliding_window_refreshes_on_use(self, client, ui_auth):
        dev = _paired_device(client, ui_auth)
        first = _device_row(dev["device_id"])["expires_at"]
        # §A.7 owner override: ONE sliding window for every device — 30 d
        # of inactivity; activity must push it out to ~now+30d
        assert dev["scope"] == "control"
        with _db() as db:
            db.execute("UPDATE device_sessions SET expires_at=? WHERE id=?",
                       (_future_iso(86400), dev["device_id"]))
        assert client.get("/api/health",
                          headers=_device_headers(
                              dev["device_token"])).status_code == 200
        refreshed = _device_row(dev["device_id"])["expires_at"]
        refreshed_dt = datetime.fromisoformat(refreshed)
        assert refreshed_dt > datetime.fromisoformat(_future_iso(29 * 86400))
        assert refreshed_dt < datetime.fromisoformat(_future_iso(31 * 86400))
        assert first  # (sanity: the original window existed)

    def test_sweep_expires_lapsed_devices(self, client, ui_auth, app_module):
        dev = _paired_device(client, ui_auth)
        with _db() as db:
            db.execute("UPDATE device_sessions SET expires_at=? WHERE id=?",
                       (_past_iso(), dev["device_id"]))
        counts = app_module._pairing_sweep_once()
        assert counts["devices_expired"] >= 1
        assert _device_row(dev["device_id"])["state"] == "expired"


# --------------------------------------------------------- ≤5 active devices
def _seed_device(store, name: str) -> dict:
    """Register an active device at STORE level (create→scan→confirm→
    issue) — keeps the HTTP create-limiter (3/10 min) out of the quota
    test's way; the limiter value itself is pinned by TestRateLimits."""
    row, code = store.create_pairing_request(device_name=name)
    store.scan_pairing(row["id"], device_name=name, source_ip="testclient")
    store.confirm_pairing(row["id"], allow=True)
    device, _token = store.issue_device_session(row["id"])
    return device


class TestDeviceQuota:
    def test_sixth_device_409_no_auto_eviction(self, client, ui_auth,
                                               app_module):
        seeded = [_seed_device(app_module.store, f"quota-dev-{i}")
                  for i in range(5)]
        # the 6th pairing issues nothing — 409 at the final exchange
        p = _pair_to_confirmed(client, ui_auth, "dev-6")
        r = _exchange(client, p["code"], "dev-6")
        assert r.status_code == 409
        # NO auto-eviction: every earlier device stays active (ADR §5)
        with _db() as db:
            states = [dict(row) for row in db.execute(
                "SELECT id, state FROM device_sessions WHERE id IN "
                f"({','.join('?' * len(seeded))})",
                [d["id"] for d in seeded]).fetchall()]
        assert len(states) == 5
        assert all(s["state"] == "active" for s in states)
        # the pairing stays confirmed — freeing a slot makes it work
        assert _pairing_row(p["pairing_id"])["state"] == "confirmed"
        assert client.delete(
            f"/api/devices/{seeded[0]['id']}",
            headers=ui_auth).status_code == 200
        r = _exchange(client, p["code"], "dev-6")
        assert r.status_code == 200
        assert r.json()["device_id"]


# ------------------------------------------------ scope middleware ordering
# Scope v1 (ADR 0012 Amendment): new pairings default to `control`, so the
# mutation/read pins below use a READ-scope device (the store mints one at
# store level, bypassing the HTTP create limiter). The full v1 matrix lives
# in test_device_scope_v1.py.
def _seed_read_scope_device(store, name: str = "read-scope-dev") -> dict:
    """Issue a device session with the EXPLICIT scope='read' (v0 shape)."""
    row, code = store.create_pairing_request(scope="read", device_name=name)
    store.scan_pairing(row["id"], device_name=name, source_ip="testclient")
    store.confirm_pairing(row["id"], allow=True)
    device, token = store.issue_device_session(row["id"])
    return {**device, "device_token": token}


class TestScopeMiddleware:
    def test_device_token_mutation_403_not_401(self, client, ui_auth,
                                               app_module):
        """Scope answers before _guard_write: a VALID device token on a
        route outside its scope is 403 (rights), where the write guard
        would say 401 (or let it through)."""
        dev = _seed_read_scope_device(app_module.store)
        r = client.post("/api/tasks", json={"title": "from device"},
                        headers=_device_headers(dev["device_token"]))
        assert r.status_code == 403

    def test_device_token_read_outside_table_403(self, client, ui_auth):
        dev = _paired_device(client, ui_auth)  # control — reads still bound
        for path in ("/api/pairing/x1", "/api/devices",
                     "/api/memories/servers", "/api/automation/schedules"):
            r = client.get(path, headers=_device_headers(dev["device_token"]))
            assert r.status_code == 403, path

    def test_device_token_reads_in_table_200(self, client, ui_auth):
        dev = _paired_device(client, ui_auth)
        headers = _device_headers(dev["device_token"])
        assert client.get("/api/health", headers=headers).status_code == 200
        assert client.get("/api/tasks/inbox",
                          headers=headers).status_code == 200
        # v1 reads-добавка (archcom 2026-09-23): the read-gap closes
        assert client.get("/api/board", headers=headers).status_code == 200
        assert client.get("/api/tags", headers=headers).status_code == 200
        # ...while memory-server CONFIG stays hard-denied (v0 read-gap)
        assert client.get("/api/memories/servers",
                          headers=headers).status_code == 403

    def test_middleware_answers_carry_security_headers(self, client, ui_auth,
                                                       app_module):
        dev = _seed_read_scope_device(app_module.store)
        r = client.post("/api/tasks", json={"title": "x"},
                        headers=_device_headers(dev["device_token"]))
        assert r.status_code == 403
        assert "content-security-policy" in r.headers
        assert r.headers["x-content-type-options"] == "nosniff"


# ---------------------------------------------------- hash-only persistence
class TestHashOnlyStorage:
    def test_db_stores_code_hash_not_code(self, client, ui_auth):
        p = _create(client, ui_auth)
        row = _pairing_row(p["pairing_id"])
        assert row["code_hash"] == hashlib.sha256(
            p["code"].encode()).hexdigest()
        with _db() as db:
            values = [str(v) for r in db.execute(
                "SELECT * FROM pairing_requests").fetchall()
                for v in tuple(r)]
        assert p["code"] not in values

    def test_db_stores_token_hash_not_token(self, client, ui_auth):
        dev = _paired_device(client, ui_auth)
        row = _device_row(dev["device_id"])
        assert row["token_hash"] == hashlib.sha256(
            dev["device_token"].encode()).hexdigest()
        with _db() as db:
            values = [str(v) for r in db.execute(
                "SELECT * FROM device_sessions").fetchall()
                for v in tuple(r)]
        assert dev["device_token"] not in values


# ------------------------------------------------------------- log masking
class TestMasking:
    def test_mnd_masked_from_day_one(self):
        from server.security import mask_secrets
        assert mask_secrets("token mnd_Ab12-x_yZ9 leak") == \
            "token mnd_<redacted> leak"

    def test_mnk_still_masked(self):
        from server.security import mask_secrets
        assert mask_secrets("k mnk_deadbeef v") == "k mnk_<redacted> v"


# ------------------------------------------------------- fail-closed (503)
class TestFailClosed:
    def test_pairing_surface_503_without_ui_token(self, client, ui_auth,
                                                  no_board_token):
        p_ids = ["pr-x", "dev-x"]
        assert client.post("/api/pairing", json={},
                           headers=ui_auth).status_code == 503
        assert client.get(f"/api/pairing/{p_ids[0]}",
                          headers=ui_auth).status_code == 503
        assert client.post(f"/api/pairing/{p_ids[0]}/confirm",
                           json={"allow": True},
                           headers=ui_auth).status_code == 503
        assert client.delete(f"/api/pairing/{p_ids[0]}",
                             headers=ui_auth).status_code == 503
        # the unauthenticated exchange leg is gated too — a tokenless
        # board must not pair devices at all
        r = client.post("/api/pairing/exchange",
                        json={"code": "anything", "device_name": "x"})
        assert r.status_code == 503
        assert client.get("/api/devices", headers=ui_auth).status_code == 503
        assert client.delete(f"/api/devices/{p_ids[1]}",
                             headers=ui_auth).status_code == 503


# ---------------------------------------------------- idempotency (§4) + SSE
class TestIdempotencyAndSse:
    def test_repeat_confirm_200_idempotent(self, client, ui_auth):
        p = _pair_to_scanned(client, ui_auth)
        assert _confirm(client, ui_auth, p["pairing_id"]).status_code == 200
        r = _confirm(client, ui_auth, p["pairing_id"])
        assert r.status_code == 200
        assert r.json()["outcome"] == "idempotent"

    def test_repeat_exchange_in_scanned_202_no_duplicate_sse(
            self, client, ui_auth, capture_sse):
        p = _pair_to_scanned(client, ui_auth)
        capture_sse.clear()  # the created→scanned event already fired once
        for _ in range(3):
            r = _exchange(client, p["code"])
            assert r.status_code == 202
            assert r.json()["status"] == "awaiting_confirmation"
        # repeats are silent: no pairing.requested duplicate (§4)
        assert _pairing_events(capture_sse) == []

    def test_first_exchange_emits_pairing_requested(self, client, ui_auth,
                                                    capture_sse):
        p = _create(client, ui_auth, device_name="")
        capture_sse.clear()
        assert _exchange(client, p["code"], "Pixel-9").status_code == 202
        events = _pairing_events(capture_sse)
        assert len(events) == 1
        assert events[0]["kind"] == "pairing.requested"
        assert events[0]["pairing_id"] == p["pairing_id"]
        assert events[0]["device_name"] == "Pixel-9"
        assert "notification" in events[0]

    def test_confirm_emits_pairing_confirmed(self, client, ui_auth,
                                             capture_sse):
        p = _pair_to_scanned(client, ui_auth)
        capture_sse.clear()
        assert _confirm(client, ui_auth, p["pairing_id"]).status_code == 200
        kinds = [e["kind"] for e in _pairing_events(capture_sse)]
        assert kinds == ["pairing.confirmed"]
        # the idempotent repeat emits NOTHING
        capture_sse.clear()
        assert _confirm(client, ui_auth, p["pairing_id"]).status_code == 200
        assert _pairing_events(capture_sse) == []

    def test_payload_audit_no_secrets_in_sse_or_notifications(
            self, client, ui_auth, app_module, capture_sse):
        """§3.3 blocking invariant: code / verify digits / device_token
        never appear in any pairing.* payload or stored notification."""
        dev = _paired_device(client, ui_auth, "audit-device")
        secrets = {dev["code"], dev["device_token"]}
        # the pairing's verify digits come from the status endpoint
        status = client.get(f"/api/pairing/{dev['pairing_id']}",
                            headers=ui_auth).json()
        secrets.add(status["verify"])
        for event in _pairing_events(capture_sse):
            blob = json.dumps(event, ensure_ascii=False)
            for secret in secrets:
                assert secret not in blob, (event["kind"], secret)
        # §3.3 scopes the notification invariant to pairing notifications.
        # The 4 verify digits are short enough to occur by chance inside ANY
        # unrelated notification's digits (timestamps, hex ids) — the session
        # accumulates hundreds of them, so checking the whole tail made this
        # test randomly order-dependent (~1 full-suite run in 3).
        notes = [n for n in app_module.store.notifications(limit=100)
                 if "пейринг" in f"{n['title']} {n['message']}".lower()]
        assert notes, "the pairing flow must leave a notification trail"
        for note in notes:
            blob = json.dumps(note, ensure_ascii=False)
            for secret in secrets:
                assert secret not in blob, (note["title"], secret)

    def test_verify_only_via_status_and_exchange(self, client, ui_auth):
        p = _create(client, ui_auth)
        status = client.get(f"/api/pairing/{p['pairing_id']}",
                            headers=ui_auth).json()
        assert status["verify"] == p["verify"]
        assert len(p["verify"]) == 4 and p["verify"].isdigit()
        r = _exchange(client, p["code"])
        assert r.json()["verify"] == p["verify"]


# ----------------------------------------------------------- auth classes
class TestAuthClasses:
    def test_pairing_requires_ui_token(self, client):
        assert client.post("/api/pairing", json={}).status_code == 401
        assert client.post("/api/pairing", json={}, headers={
            "Authorization": "Bearer wrong"}).status_code == 401
        assert client.get("/api/devices").status_code == 401

    def test_machine_token_refused_in_split_mode(self, client, split_tokens):
        r = client.post("/api/pairing", json={}, headers={
            "Authorization": f"Bearer {BOARD_TOKEN}"})
        assert r.status_code == 401

    def test_ui_token_works_in_split_mode(self, client, split_tokens,
                                          ui_auth):
        assert _create(client, ui_auth)["state"] == "created"


# ------------------------------------------- poller compatibility (blocking)
class TestPollerCompatibility:
    def test_legacy_board_token_rides_existing_guards(self, client, auth,
                                                      fresh_report_limiter):
        """The deployed systemd poller sends a prefix-less board token —
        the scope middleware must be invisible to it: reads open, ui-fallback
        mutations and reports still pass (transition mode)."""
        assert client.get("/api/board").status_code == 200
        r = client.post("/api/tasks", json={"title": "poller-compat"},
                        headers=auth)
        assert r.status_code == 201, r.text
        task_id = r.json()["id"]
        try:
            r = client.post(f"/api/tasks/{task_id}/reports",
                            json={"body": "ok", "kind": "intermediate",
                                  "agent": "poller"}, headers=auth)
            assert r.status_code == 201, r.text
        finally:
            client.delete(f"/api/tasks/{task_id}", headers=auth)

    def test_device_token_never_passes_machine_guard(self, client, ui_auth):
        """A device bearer on a machine-class route: scope answers 403
        (class has no rights) — it must NOT leak into the machine leg."""
        dev = _paired_device(client, ui_auth)
        r = client.post("/api/assignments/1/claim",
                        json={"claimed_by": "x"},
                        headers=_device_headers(dev["device_token"]))
        assert r.status_code == 403
