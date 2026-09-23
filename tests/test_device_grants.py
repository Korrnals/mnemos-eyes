"""Per-device grants (ADR 0012 Amendment §A.7, owner directive 2026-09-23
«пользователь-администратор сам определяет кому сколько и куда») — QA.

Pinned contract:
- granule routing: a granted granule opens EXACTLY its mutation family
  (tasks → POST/PATCH/move/archive 2xx while automation stays 403; reports
  / inbox / notifications likewise), global reads stay open to every valid
  device, and the hard-deny families stay closed regardless of grants;
- live application: PUT /api/devices/{id}/grants changes the device's
  rights on its VERY NEXT request — no re-pairing, no token re-issue;
- grant/revoke cycle: grant tasks → 201, revoke → 403 again (the owner's
  «давать и забирать» both work on a live session);
- endpoint: 200 full-replacement (idempotent repeat, no duplicate audit),
  404 unknown device, 409 non-active session, 422 unknown granule names;
  the audit event device.grants carries previous → grants;
- migration _migrate_device_grants_v1: active control + '' → full set
  (behavior of an already-paired phone unchanged), read stays '',
  owner-revoked '[]' survives reboots (revoke-all is NEVER re-granted),
  dead rows untouched, idempotent, no SEED_VERSION bump;
- TTL §A.7: control pairings START with the full granule set, read with
  '[]' (device_sessions.grants at issuance);
- revoke chain e2e: mutate 201 → DELETE /api/devices/{id} → next request
  401 → SSE pairing.revoked carries the device_id → the list shows the
  row revoked (the owner's kill-switch, verified END to END).
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from conftest import DATA_DIR
from server.store import DEVICE_GRANTS

DB_PATH = DATA_DIR / "board.db"


# ------------------------------------------------------------------ helpers
def _db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def _device_row(device_id: str) -> dict:
    with _db() as db:
        row = db.execute(
            "SELECT * FROM device_sessions WHERE id=?",
            (device_id,)).fetchone()
    assert row is not None
    return dict(row)


def _device_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _grant(store, device_id: str, grants: list[str]) -> dict:
    """Owner-side grant via the store (the wire shape the PUT endpoint
    drives; the endpoint's own HTTP contract is TestGrantsEndpoint)."""
    row, _changed = store.set_device_grants(device_id, grants)
    return row


def _paired_control_device(store, name: str = "grants-dev") -> dict:
    """Full legal pairing at STORE level (default scope=control)."""
    row, code = store.create_pairing_request(device_name=name)
    store.scan_pairing(row["id"], device_name=name, source_ip="testclient")
    store.confirm_pairing(row["id"], allow=True)
    device, token = store.issue_device_session(row["id"])
    assert device["scope"] == "control"
    return {**device, "device_token": token}


@pytest.fixture(name="dev")
def dev_fixture(app_module):
    """A paired control device with the FULL granule set, cleaned after."""
    d = _paired_control_device(app_module.store)
    yield d
    with _db() as db:
        db.execute("DELETE FROM device_sessions WHERE id=?", (d["id"],))


@pytest.fixture()
def fresh_pairing_limiters(app_module, monkeypatch):
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


@pytest.fixture()
def fresh_report_limiter(app_module, monkeypatch):
    from server.security import RateLimiter
    limiter = RateLimiter(limit=app_module._REPORT_RATE_LIMIT,
                          window=app_module._REPORT_RATE_WINDOW)
    monkeypatch.setattr(app_module, "_report_limiter", limiter)
    return limiter


@pytest.fixture()
def capture_sse(app_module, monkeypatch):
    """Collect every broadcast event (the test_pairing pattern, local copy —
    fixtures do not cross test modules)."""
    events: list[dict] = []
    monkeypatch.setattr(app_module, "_broadcast", events.append)
    return events


def _pairing_events(events: list[dict]) -> list[dict]:
    return [e for e in events if str(e.get("kind", "")).startswith("pairing.")]


# ------------------------------------------------------ granule routing (§A.7)
class TestGranuleRouting:
    def test_tasks_granted_mutations_201_automation_still_403(
            self, client, app_module, dev):
        """The owner grants ONLY tasks: task mutations open, automation
        (hard-deny family) stays closed — grants never punch through the
        always-closed list."""
        _grant(app_module.store, dev["id"], ["tasks"])
        headers = _device_headers(dev["device_token"])
        r = client.post("/api/tasks", json={"title": "from the phone"},
                        headers=headers)
        assert r.status_code == 201, r.text
        task_id = r.json()["id"]
        assert client.patch(f"/api/tasks/{task_id}",
                            json={"summary": "x"}, headers=headers
                            ).status_code == 200
        assert client.post(f"/api/tasks/{task_id}/move",
                           json={"col": "open"}, headers=headers
                           ).status_code == 200
        # reports is a DIFFERENT granule — still closed
        assert client.post(f"/api/tasks/{task_id}/reports",
                           json={"body": "x", "kind": "intermediate"},
                           headers=headers).status_code == 403
        # hard-deny: automation stays 403 with tasks granted
        assert client.get("/api/automation/schedules",
                          headers=headers).status_code == 403
        assert client.post("/api/automation/schedules", json={},
                           headers=headers).status_code == 403
        # global reads stay open
        assert client.get("/api/board", headers=headers).status_code == 200
        assert client.get("/api/health", headers=headers).status_code == 200

    def test_reports_grant_alone(self, client, app_module, dev):
        _grant(app_module.store, dev["id"], ["reports"])
        headers = _device_headers(dev["device_token"])
        r = client.post(f"/api/tasks/{_seed_task(app_module)}/reports",
                        json={"body": "device report",
                              "kind": "intermediate"},
                        headers=headers)
        assert r.status_code == 201, r.text
        # but task CREATE is another granule
        assert client.post("/api/tasks", json={"title": "x"},
                           headers=headers).status_code == 403

    def test_inbox_and_notifications_grants(self, client, app_module, dev):
        _grant(app_module.store, dev["id"], ["inbox", "notifications"])
        headers = _device_headers(dev["device_token"])
        app_module.store.upsert_inbox_records([{
            "memory_id": "mem-grants", "server": "legacy1", "project": "",
            "title": "queued", "excerpt": "", "tags": [],
            "priority": "normal", "specialist": "",
            "source_created_at": "",
        }], _future_iso(600))
        assert client.post("/api/tasks/inbox/refresh",
                           headers=headers).status_code in (200, 201)
        r = client.post("/api/tasks/inbox/mem-grants/adopt", headers=headers)
        assert r.status_code == 201, r.text
        r = client.post("/api/notifications/read", json=None, headers=headers)
        assert r.status_code == 200
        # tasks granule NOT granted → create stays closed
        assert client.post("/api/tasks", json={"title": "x"},
                           headers=headers).status_code == 403

    def test_revoke_tasks_again_403(self, client, app_module, dev):
        """The full «дать и забрать» cycle on a LIVE device: grant tasks →
        201; revoke (empty set) → 403 again — the very next request."""
        headers = _device_headers(dev["device_token"])
        _grant(app_module.store, dev["id"], ["tasks"])
        assert client.post("/api/tasks", json={"title": "granted"},
                           headers=headers).status_code == 201
        _grant(app_module.store, dev["id"], [])
        assert client.post("/api/tasks", json={"title": "revoked"},
                           headers=headers).status_code == 403
        # reads NEVER die with the grants
        assert client.get("/api/health", headers=headers).status_code == 200

    def test_granule_route_table_matches_dictionary(self):
        """Every route row maps to a granule that exists in DEVICE_GRANTS —
        appending a granule without routes (or vice versa) fails here."""
        from server.app import _DEVICE_GRANT_ROUTES
        assert set(_DEVICE_GRANT_ROUTES) == set(DEVICE_GRANTS)
        # each mutation family appears in EXACTLY one granule (no overlaps)
        seen: set[tuple[str, str]] = set()
        for rows in _DEVICE_GRANT_ROUTES.values():
            for row in rows:
                assert row not in seen, row
                seen.add(row)


# ---------------------------------------------------------- PUT /grants wire
class TestGrantsEndpoint:
    def test_put_replaces_and_echoes(self, client, ui_auth, app_module, dev):
        r = client.put(f"/api/devices/{dev['id']}/grants",
                       json={"grants": ["notifications", "tasks", "tasks"]},
                       headers=ui_auth)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        # canonical: dedup + DEVICE_GRANTS order
        assert body["device"]["grants"] == ["tasks", "notifications"]
        assert _device_row(dev["id"])["grants"] == json.dumps(
            ["tasks", "notifications"])

    def test_put_requires_ui_token(self, client, dev):
        r = client.put(f"/api/devices/{dev['id']}/grants",
                       json={"grants": []})
        assert r.status_code == 401

    def test_device_token_never_grants(self, client, dev):
        """A device cannot widen its own grants (devices* is hard-denied —
        the owner decides, never the phone)."""
        r = client.put(f"/api/devices/{dev['id']}/grants",
                       json={"grants": ["tasks"]},
                       headers=_device_headers(dev["device_token"]))
        assert r.status_code == 403

    def test_put_404_unknown_device(self, client, ui_auth):
        r = client.put("/api/devices/dev-nope/grants",
                       json={"grants": []}, headers=ui_auth)
        assert r.status_code == 404

    def test_put_422_unknown_granule(self, client, ui_auth, dev):
        r = client.put(f"/api/devices/{dev['id']}/grants",
                       json={"grants": ["tasks", "fortran"]},
                       headers=ui_auth)
        assert r.status_code == 422
        assert "fortran" in r.json()["detail"]

    def test_put_409_non_active(self, client, ui_auth, app_module, dev):
        app_module.store.revoke_device(dev["id"])
        r = client.put(f"/api/devices/{dev['id']}/grants",
                       json={"grants": ["tasks"]}, headers=ui_auth)
        assert r.status_code == 409
        assert "revoked" in r.json()["detail"]

    def test_idempotent_repeat_no_audit_spam(self, client, ui_auth,
                                             app_module, dev):
        first = client.put(f"/api/devices/{dev['id']}/grants",
                           json={"grants": ["tasks"]}, headers=ui_auth)
        assert first.status_code == 200
        with _db() as db:
            n = db.execute(
                "SELECT COUNT(*) FROM events WHERE kind='device.grants'"
            ).fetchone()[0]
        repeat = client.put(f"/api/devices/{dev['id']}/grants",
                            json={"grants": ["tasks"]}, headers=ui_auth)
        assert repeat.status_code == 200
        with _db() as db:
            n2 = db.execute(
                "SELECT COUNT(*) FROM events WHERE kind='device.grants'"
            ).fetchone()[0]
        assert n2 == n  # unchanged set → no second audit event

    def test_audit_carries_previous(self, client, ui_auth, app_module, dev):
        client.put(f"/api/devices/{dev['id']}/grants",
                   json={"grants": ["tasks"]}, headers=ui_auth)
        client.put(f"/api/devices/{dev['id']}/grants",
                   json={"grants": ["reports"]}, headers=ui_auth)
        with _db() as db:
            row = db.execute(
                "SELECT payload FROM events WHERE kind='device.grants' "
                "ORDER BY id DESC LIMIT 1").fetchone()
        payload = json.loads(row["payload"])
        assert payload["previous"] == ["tasks"]
        assert payload["grants"] == ["reports"]

    def test_devices_list_carries_grants(self, client, ui_auth):
        r = client.get("/api/devices", headers=ui_auth)
        assert r.status_code == 200
        for item in r.json()["items"]:
            assert isinstance(item["grants"], list)


# ----------------------------------------------------------------- issuance
class TestIssuanceGrants:
    def test_control_starts_full_read_starts_empty(self, app_module):
        control = _paired_control_device(app_module.store)
        row, code = app_module.store.create_pairing_request(
            scope="read", device_name="read-grants")
        app_module.store.scan_pairing(row["id"], device_name="read-grants",
                                      source_ip="testclient")
        app_module.store.confirm_pairing(row["id"], allow=True)
        read_dev, _token = app_module.store.issue_device_session(row["id"])
        try:
            assert control["grants"] == list(DEVICE_GRANTS)
            assert read_dev["grants"] == []
        finally:
            with _db() as db:
                db.executemany("DELETE FROM device_sessions WHERE id=?",
                               [(control["id"],), (read_dev["id"],)])


# ---------------------------------------------------------------- migration
class TestGrantsMigration:
    def test_control_active_unset_gains_full(self, tmp_path):
        """Composed boot order: the v1 scope migration flips active read
        rows to control FIRST, then the grants migration fills every
        active control row still on '' — an already-paired phone keeps
        byte-for-byte the rights it had (mutations open). A genuinely
        read-only ACTIVE row therefore cannot survive this boot pair; the
        read-only shape lives on in dead rows and explicit '[]'."""
        from server.store import Store
        path = tmp_path / "board.db"
        Store(path)  # create schema
        with sqlite3.connect(path) as db:
            db.execute(
                """INSERT INTO device_sessions
                       (id, name, scope, token_hash, created_at,
                        hard_expires_at, state)
                   VALUES ('dev-c', 'phone', 'control', 'h1', '2026-09-01',
                           '2027-01-01', 'active')""")
            db.execute(
                """INSERT INTO device_sessions
                       (id, name, scope, token_hash, created_at,
                        hard_expires_at, state)
                   VALUES ('dev-r', 'pad', 'read', 'h2', '2026-09-01',
                           '2027-01-01', 'active')""")
            db.execute(
                """INSERT INTO device_sessions
                       (id, name, scope, token_hash, created_at,
                        hard_expires_at, state)
                   VALUES ('dev-dead', 'old', 'read', 'h6', '2026-09-01',
                           '2027-01-01', 'revoked')""")
        Store(path)  # boot → scope migration + grants migration
        with sqlite3.connect(path) as db:
            db.row_factory = sqlite3.Row
            control = dict(db.execute(
                "SELECT * FROM device_sessions WHERE id='dev-c'").fetchone())
            read = dict(db.execute(
                "SELECT * FROM device_sessions WHERE id='dev-r'").fetchone())
            dead = dict(db.execute(
                "SELECT * FROM device_sessions WHERE id='dev-dead'").fetchone())
        assert json.loads(control["grants"]) == list(DEVICE_GRANTS)
        # flipped to control by the v1 scope migration → full grants too
        assert read["scope"] == "control"
        assert json.loads(read["grants"]) == list(DEVICE_GRANTS)
        # dead rows keep the unset sentinel (audit truth, no rewrite)
        assert dead["scope"] == "read"
        assert dead["grants"] == ""
        # audited once
        with sqlite3.connect(path) as db:
            payloads = [r[0] for r in db.execute(
                "SELECT payload FROM events WHERE "
                "kind='device.grants-migrated'").fetchall()]
        assert len(payloads) == 1
        assert json.loads(payloads[0])["migrated"] == 2

    def test_owner_revoked_all_survives_reboot(self, tmp_path):
        """The load-bearing '' vs '[]' distinction: an owner-revoked-empty
        control row is NEVER re-granted by the migration."""
        from server.store import Store
        path = tmp_path / "board.db"
        Store(path)
        with sqlite3.connect(path) as db:
            db.execute(
                """INSERT INTO device_sessions
                       (id, name, scope, grants, token_hash, created_at,
                        hard_expires_at, state)
                   VALUES ('dev-x', 'phone', 'control', '[]', 'h3',
                           '2026-09-01', '2027-01-01', 'active')""")
        Store(path)
        Store(path)
        with sqlite3.connect(path) as db:
            grants = db.execute(
                "SELECT grants FROM device_sessions WHERE id='dev-x'"
            ).fetchone()[0]
        assert grants == "[]"

    def test_idempotent_second_boot_no_audit(self, tmp_path):
        from server.store import Store
        path = tmp_path / "board.db"
        Store(path)
        with sqlite3.connect(path) as db:
            db.execute(
                """INSERT INTO device_sessions
                       (id, name, scope, token_hash, created_at,
                        hard_expires_at, state)
                   VALUES ('dev-1', 'phone', 'control', 'h4', '2026-09-01',
                           '2027-01-01', 'active')""")
        Store(path)
        Store(path)
        with sqlite3.connect(path) as db:
            n = db.execute(
                "SELECT COUNT(*) FROM events WHERE "
                "kind='device.grants-migrated'").fetchone()[0]
        assert n == 1

    def test_legacy_db_column_add(self, tmp_path):
        """A pre-grants database (the old device_sessions shape) gains the
        column via the additive ALTER and live control rows are filled —
        no SEED_VERSION bump (the seed check wipes tasks)."""
        from server.store import Store
        path = tmp_path / "board.db"
        db = sqlite3.connect(path)
        # the 1.24.0 shape: no grants column
        db.executescript("""
            CREATE TABLE board_meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE device_sessions (
                id              TEXT PRIMARY KEY,
                name            TEXT NOT NULL,
                scope           TEXT NOT NULL DEFAULT 'read',
                token_hash      TEXT NOT NULL,
                created_at      TEXT NOT NULL,
                last_seen_at    TEXT NOT NULL DEFAULT '',
                expires_at      TEXT NOT NULL DEFAULT '',
                hard_expires_at TEXT NOT NULL,
                state           TEXT NOT NULL DEFAULT 'active',
                ua              TEXT NOT NULL DEFAULT '',
                ip              TEXT NOT NULL DEFAULT '',
                last_seen       TEXT NOT NULL DEFAULT ''
            );
            INSERT INTO device_sessions
                (id, name, scope, token_hash, created_at,
                 hard_expires_at, state)
            VALUES ('dev-old', 'phone', 'control', 'h5', '2026-09-01',
                    '2027-01-01', 'active');
        """)
        db.commit()
        db.close()
        Store(path)  # boots the FULL current schema + migrations
        with sqlite3.connect(path) as db:
            cols = {r[1] for r in db.execute(
                "PRAGMA table_info(device_sessions)").fetchall()}
            grants = db.execute(
                "SELECT grants FROM device_sessions WHERE id='dev-old'"
            ).fetchone()[0]
        assert "grants" in cols
        assert json.loads(grants) == list(DEVICE_GRANTS)

    def test_no_seed_version_bump(self):
        from server.seed import SEED_VERSION
        assert SEED_VERSION == "3"


# ------------------------------------------------------ revoke chain (e2e)
class TestRevokeChainEndToEnd:
    def test_mutate_revoke_401_sse_list(self, client, ui_auth, app_module,
                                        fresh_pairing_limiters, capture_sse):
        """The owner's kill-switch, END to END over HTTP: a granted device
        mutates → DELETE /api/devices/{id} → the very next request 401 →
        SSE pairing.revoked carries the device_id → the owner list shows
        the row `revoked`."""
        # full legal pairing over HTTP (control → full grants)
        r = client.post("/api/pairing", json={"device_name": "chain-phone"},
                        headers=ui_auth)
        assert r.status_code == 201, r.text
        pairing_id, code = r.json()["pairing_id"], r.json()["code"]
        assert client.post(
            "/api/pairing/exchange",
            json={"code": code, "device_name": "chain-phone"},
        ).status_code == 202
        assert client.post(f"/api/pairing/{pairing_id}/confirm",
                           json={"allow": True},
                           headers=ui_auth).status_code == 200
        r = client.post("/api/pairing/exchange",
                        json={"code": code, "device_name": "chain-phone"})
        assert r.status_code == 200, r.text
        issued = r.json()
        device_id, token = issued["device_id"], issued["device_token"]
        assert issued["scope"] == "control"
        headers = _device_headers(token)
        try:
            # 1. the live device mutates
            assert client.post("/api/tasks", json={"title": "before revoke"},
                               headers=headers).status_code == 201
            # 2. the owner revokes
            capture_sse.clear()
            assert client.delete(f"/api/devices/{device_id}",
                                 headers=ui_auth).status_code == 200
            # 3. the next request is 401 — read AND mutation
            assert client.get("/api/health", headers=headers).status_code == 401
            assert client.post("/api/tasks", json={"title": "after"},
                               headers=headers).status_code == 401
            # 4. SSE carried the revocation with the device_id
            revoked = [e for e in _pairing_events(capture_sse)
                       if e["kind"] == "pairing.revoked"]
            assert any(e.get("device_id") == device_id for e in revoked)
            # 5. the owner list shows the row revoked
            items = client.get("/api/devices", headers=ui_auth).json()["items"]
            row = next(i for i in items if i["id"] == device_id)
            assert row["state"] == "revoked"
        finally:
            with _db() as db:
                db.execute("DELETE FROM device_sessions WHERE id=?",
                           (device_id,))
                db.execute("DELETE FROM pairing_requests WHERE id=?",
                           (pairing_id,))


# ------------------------------------------------------------------ helpers
def _future_iso(seconds: float) -> str:
    return (datetime.now(timezone.utc)
            + timedelta(seconds=seconds)).isoformat(timespec="seconds")


def _store_of(client):
    """The Store behind the shared TestClient app (import cycle-safe)."""
    from server.app import store
    return store


def _seed_task(app_module) -> str:
    """A ui-leg task to pin a report onto (reports granule test)."""
    task = app_module.store.create_task({"title": "reports target"})
    return task["id"]
