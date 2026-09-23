"""Device scope v1 (ADR 0012 Amendment, archcom 2026-09-23) — QA matrix.

Pinned contract (each test names its matrix line):
- control scope: paired device mutates the board — create/patch/move/
  archive/unarchive tasks, reports (4th auth leg), inbox refresh/adopt,
  notifications read → 2xx; task history carries the `device:<id> <name>`
  actor on device-driven mutations;
- hard-deny: EVERY closed route answers 403 — never 401, never 5xx —
  including GET /api/devices, DELETE /api/devices/{id}, the whole agent
  loop, automation (+ its reads), memory-server config, mesh, PUT
  settings, DELETE /api/tasks/{id}, board-reflect, specialists/refresh-all;
- legacy read scope (explicit scope='read' pairing or forced row): reads
  (incl. the v1 reads-добавка) → 200, mutations → 403;
- validation order: invalid / revoked mnd_ → 401 on ANY route (v0 answered
  403 on mutations first — inverted, fixed in v1);
- TTL: control slides 7 d, read slides 30 d, hard 90 d for both; the
  sliding UPDATE never rewrites the scope column;
- migration: active+read → control in place on boot; revoked/expired keep
  their historical scope; idempotent (second boot writes nothing);
- new pairings default to scope='control' (store layer; DB default stays
  'read' as the fail-safe);
- middleware 401/403 answers carry the security headers (CSP/nosniff/
  no-store);
- fail-closed: with no token classes configured a device mutation is 503
  (the device leg rides AFTER the 503 in _guard_write).
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from conftest import DATA_DIR

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


def _past_iso(seconds: float = 1.0) -> str:
    return (datetime.now(timezone.utc)
            - timedelta(seconds=seconds)).isoformat(timespec="seconds")


def _future_iso(seconds: float) -> str:
    return (datetime.now(timezone.utc)
            + timedelta(seconds=seconds)).isoformat(timespec="seconds")


def _device_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _paired_control_device(store, name: str = "control-dev") -> dict:
    """Full legal pairing at STORE level (default scope=control)."""
    row, code = store.create_pairing_request(device_name=name)
    store.scan_pairing(row["id"], device_name=name, source_ip="testclient")
    store.confirm_pairing(row["id"], allow=True)
    device, token = store.issue_device_session(row["id"])
    assert device["scope"] == "control"
    return {**device, "device_token": token}


def _paired_read_device(store, name: str = "read-dev") -> dict:
    """Explicit scope='read' pairing (the v0 shape, still available)."""
    row, code = store.create_pairing_request(scope="read", device_name=name)
    store.scan_pairing(row["id"], device_name=name, source_ip="testclient")
    store.confirm_pairing(row["id"], allow=True)
    device, token = store.issue_device_session(row["id"])
    assert device["scope"] == "read"
    return {**device, "device_token": token}


@pytest.fixture(name="control_dev")
def control_dev_fixture(app_module):
    """A paired control-scope device; its session row is removed after the
    test (the shared session DB must not leak rows into the ≤5 quota)."""
    dev = _paired_control_device(app_module.store)
    yield dev
    with _db() as db:
        db.execute("DELETE FROM device_sessions WHERE id=?", (dev["id"],))


@pytest.fixture(name="read_dev")
def read_dev_fixture(app_module):
    dev = _paired_read_device(app_module.store)
    yield dev
    with _db() as db:
        db.execute("DELETE FROM device_sessions WHERE id=?", (dev["id"],))


@pytest.fixture()
def fresh_pairing_limiters(app_module, monkeypatch):
    """Fresh pairing rate limiters (the app-level ones are module globals
    exhausted by earlier files; same fixture as test_pairing's)."""
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


# --------------------------------------------------- control: mutations open
class TestControlMutations:
    def test_create_task_201(self, client, control_dev):
        r = client.post("/api/tasks", json={"title": "from the phone"},
                        headers=_device_headers(control_dev["device_token"]))
        assert r.status_code == 201, r.text
        task = r.json()
        # the task-history actor names the device (attribution contract)
        r = client.get(f"/api/tasks/{task['id']}/history")
        assert r.status_code == 200
        created = [e for e in r.json()["events"]
                   if e["title"] == "task.created"]
        assert created
        with _db() as db:
            row = db.execute(
                "SELECT payload FROM events WHERE kind='task.created' "
                "AND task_id=? ORDER BY id DESC LIMIT 1", (task["id"],)
            ).fetchone()
        actor = json.loads(row["payload"]).get("actor")
        assert actor == (f"device:{control_dev['id']} "
                         f"{control_dev['name']}")

    def test_patch_move_archive_unarchive_200(self, client, control_dev):
        headers = _device_headers(control_dev["device_token"])
        r = client.post("/api/tasks", json={"title": "scope v1"},
                        headers=headers)
        assert r.status_code == 201, r.text
        task_id = r.json()["id"]
        assert client.patch(f"/api/tasks/{task_id}",
                            json={"summary": "patched from device"},
                            headers=headers).status_code == 200
        assert client.post(f"/api/tasks/{task_id}/move",
                           json={"col": "in-progress"},
                           headers=headers).status_code == 200
        assert client.post(f"/api/tasks/{task_id}/archive",
                           headers=headers).status_code == 200
        r = client.post(f"/api/tasks/{task_id}/unarchive", headers=headers)
        assert r.status_code == 200
        # unarchive returns the task to its PRE-ARCHIVE column (BE-11b)
        assert r.json()["task"]["col"] == "in-progress"

    def test_report_201_on_device_leg(self, client, control_dev,
                                      fresh_report_limiter):
        """Reports: the mnd_ leg is the 4th leg of the composition."""
        r = client.post("/api/tasks", json={"title": "report target"},
                        headers=_device_headers(control_dev["device_token"]))
        task_id = r.json()["id"]
        r = client.post(
            f"/api/tasks/{task_id}/reports",
            json={"body": "done from the device", "kind": "intermediate",
                  "agent": "device-owner"},
            headers=_device_headers(control_dev["device_token"]))
        assert r.status_code == 201, r.text
        assert r.json()["report"]["agent"] == "device-owner"

    def test_inbox_adopt_201(self, client, control_dev, app_module):
        """Adopt a mirrored task:queue record from the device."""
        app_module.store.upsert_inbox_records([{
            "memory_id": "mem-scope-v1", "server": "legacy1",
            "project": "", "title": "queued work", "excerpt": "",
            "tags": [], "priority": "normal", "specialist": "",
            "source_created_at": "",
        }], _future_iso(600))
        r = client.post("/api/tasks/inbox/mem-scope-v1/adopt",
                        headers=_device_headers(control_dev["device_token"]))
        assert r.status_code == 201, r.text
        with _db() as db:
            row = db.execute(
                "SELECT payload FROM events WHERE kind='task.created' "
                "AND task_id=? ORDER BY id DESC LIMIT 1",
                (r.json()["id"],)).fetchone()
        assert json.loads(row["payload"]).get("actor", "").startswith(
            f"device:{control_dev['id']} ")

    def test_notifications_read_200(self, client, control_dev):
        r = client.post("/api/notifications/read", json=None,
                        headers=_device_headers(control_dev["device_token"]))
        assert r.status_code == 200, r.text
        assert r.json()["ok"] is True

    def test_reads_addition_open_for_control_too(self, client, control_dev):
        headers = _device_headers(control_dev["device_token"])
        for path in ("/api/board", "/api/tags", "/api/archive",
                     "/api/notifications", "/api/assignments",
                     "/api/health", "/api/tasks/inbox"):
            assert client.get(path, headers=headers).status_code == 200, path


# ------------------------------------------------------- control: hard-deny
class TestControlHardDeny:
    CASES = [
        # pairing / devices / auth management — owner-only, always
        ("POST", "/api/pairing", {}),
        ("GET", "/api/pairing/pr-x", None),
        ("POST", "/api/pairing/pr-x/confirm", {"allow": True}),
        ("DELETE", "/api/pairing/pr-x", None),
        ("GET", "/api/devices", None),
        ("DELETE", "/api/devices/dev-x", None),
        ("POST", "/api/auth/ui-token", {"token": "x"}),
        ("DELETE", "/api/auth/ui-token", None),
        # agent loop
        ("POST", "/api/assignments", {}),
        ("POST", "/api/assignments/1/claim", {"claimed_by": "x"}),
        ("POST", "/api/assignments/1/complete", {"summary": "x"}),
        ("POST", "/api/executors", {}),
        ("GET", "/api/executors", None),
        ("DELETE", "/api/executors/ex-x", None),
        ("POST", "/api/executors/enrollment", {}),
        ("GET", "/api/harnesses", None),
        ("POST", "/api/harnesses", {"name": "x"}),
        ("DELETE", "/api/harnesses/zcode", None),
        # automation — mutations AND reads (Security hard-deny)
        ("GET", "/api/automation/schedules", None),
        ("POST", "/api/automation/schedules", {}),
        ("POST", "/api/automation/schedules/r-1/run", None),
        ("PUT", "/api/automation/settings", {}),
        # memory-server config / mesh
        ("GET", "/api/memories/servers", None),
        ("POST", "/api/memories/servers", {}),
        ("PATCH", "/api/memories/servers/legacy1", {}),
        ("DELETE", "/api/memories/servers/legacy1", None),
        ("POST", "/api/memories/groups", {"name": "x"}),
        ("DELETE", "/api/memories/groups/x", None),
        ("GET", "/api/mesh/nodes", None),
        ("POST", "/api/mesh/nodes", {}),
        # launch-adjacent + irreversible + v1-not-needed
        ("PUT", "/api/settings/execution", {}),
        ("DELETE", "/api/tasks/t-nope", None),
        ("POST", "/api/board-reflect", {}),
        ("POST", "/api/specialists/refresh-all", None),
    ]

    def test_closed_routes_403_never_401(self, client, control_dev):
        """Every hard-deny row: 403 (rights), not 401 (the token is VALID —
        QA matrix v1) and not 5xx."""
        headers = _device_headers(control_dev["device_token"])
        for method, path, body in self.CASES:
            r = (client.request(method, path, json=body, headers=headers)
                 if body is not None or method in ("POST", "PUT", "PATCH")
                 else client.request(method, path, headers=headers))
            assert r.status_code == 403, (method, path, r.status_code)

    def test_closed_route_403_not_401_detail(self, client, control_dev):
        """The 403 detail names the scope — the honest verdict, opposite of
        the 401 the inner guard would have produced for an mnd_ bearer."""
        r = client.get("/api/devices",
                       headers=_device_headers(control_dev["device_token"]))
        assert r.status_code == 403
        assert "control" in r.json()["detail"]


# ----------------------------------------------------- legacy read scope
class TestReadScope:
    def test_reads_200_incl_addition(self, client, read_dev):
        headers = _device_headers(read_dev["device_token"])
        for path in ("/api/board", "/api/tags", "/api/archive",
                     "/api/notifications", "/api/assignments",
                     "/api/health", "/api/tasks/inbox"):
            assert client.get(path, headers=headers).status_code == 200, path

    def test_mutations_403(self, client, read_dev):
        """scope=read on every control-only mutation → 403, never 401."""
        headers = _device_headers(read_dev["device_token"])
        assert client.post("/api/tasks", json={"title": "x"},
                           headers=headers).status_code == 403
        assert client.post("/api/tasks/t-x/move", json={"col": "open"},
                           headers=headers).status_code == 403
        assert client.post("/api/tasks/t-x/reports",
                           json={"body": "x", "kind": "intermediate"},
                           headers=headers).status_code == 403
        assert client.post("/api/tasks/inbox/refresh",
                           headers=headers).status_code == 403
        assert client.post("/api/notifications/read", headers=headers,
                           json=None).status_code == 403
        assert client.patch("/api/tasks/t-x", json={"title": "y"},
                            headers=headers).status_code == 403

    def test_read_reports_never_leak_into_machine_leg(self, client, read_dev):
        """A read-scope report POST is refused by the SCOPE (403) — it must
        not reach the reports composition and fall into the machine leg's
        401 (the v0 bug shape)."""
        r = client.post(
            "/api/tasks/t-x/reports",
            json={"body": "x", "kind": "intermediate", "agent": "a"},
            headers=_device_headers(read_dev["device_token"]))
        assert r.status_code == 403


# --------------------------------------------------- validation order (401)
class TestValidationOrder:
    def test_invalid_token_401_on_any_route(self, client):
        """QA matrix v1: an INVALID device token answers 401 everywhere —
        reads AND mutations (v0 answered 403 first on mutations)."""
        headers = _device_headers("mnd_forged")
        assert client.get("/api/board", headers=headers).status_code == 401
        assert client.get("/api/health", headers=headers).status_code == 401
        assert client.post("/api/tasks", json={"title": "x"},
                           headers=headers).status_code == 401
        assert client.get("/api/devices", headers=headers).status_code == 401

    def test_revoked_token_401_on_open_and_closed_routes(
            self, client, ui_auth, app_module):
        dev = _paired_control_device(app_module.store)
        with _db() as db:
            db.execute("DELETE FROM device_sessions WHERE id=?", (dev["id"],))
        # (removed rows are the kill-switch equivalent for this matrix row;
        # the explicit revoke pin lives in test_pairing.py)
        headers = _device_headers(dev["device_token"])
        assert client.get("/api/health", headers=headers).status_code == 401
        assert client.post("/api/tasks", json={"title": "x"},
                           headers=headers).status_code == 401

    def test_middleware_answers_carry_security_headers(self, client,
                                                       control_dev):
        r = client.get("/api/devices",
                       headers=_device_headers(control_dev["device_token"]))
        assert r.status_code == 403
        assert "content-security-policy" in r.headers
        assert r.headers["x-content-type-options"] == "nosniff"
        assert r.headers["cache-control"] == "no-store"
        r = client.get("/api/board",
                       headers=_device_headers("mnd_forged"))
        assert r.status_code == 401
        assert "content-security-policy" in r.headers
        assert r.headers["x-content-type-options"] == "nosniff"


# ------------------------------------------------------------------- TTL
class TestScopeTtl:
    def test_control_slides_7d_read_slides_30d(self, app_module):
        control = _paired_control_device(app_module.store)
        read = _paired_read_device(app_module.store)
        try:
            c_exp = datetime.fromisoformat(_device_row(control["id"])["expires_at"])
            r_exp = datetime.fromisoformat(_device_row(read["id"])["expires_at"])
            now = datetime.now(timezone.utc)
            assert timedelta(days=6) < c_exp - now < timedelta(days=8)
            assert timedelta(days=29) < r_exp - now < timedelta(days=31)
            # hard cap is unchanged for BOTH scopes: 90 d from creation
            for dev in (control, read):
                hard = datetime.fromisoformat(
                    _device_row(dev["id"])["hard_expires_at"])
                assert timedelta(days=89) < hard - now < timedelta(days=91)
        finally:
            with _db() as db:
                db.executemany("DELETE FROM device_sessions WHERE id=?",
                               [(control["id"],), (read["id"],)])

    def test_sliding_refresh_keeps_control_window(self, client, control_dev):
        """Мок времени (the house pattern): squeeze expires_at into the
        future, use the token — the refresh lands at ~now+7d, NOT +30d, and
        the scope column survives the UPDATE untouched."""
        with _db() as db:
            db.execute("UPDATE device_sessions SET expires_at=? WHERE id=?",
                       (_future_iso(86400), control_dev["id"]))
        assert client.get(
            "/api/health",
            headers=_device_headers(control_dev["device_token"]),
        ).status_code == 200
        row = _device_row(control_dev["id"])
        refreshed = datetime.fromisoformat(row["expires_at"])
        now = datetime.now(timezone.utc)
        assert timedelta(days=6) < refreshed - now < timedelta(days=8)
        assert row["scope"] == "control"

    def test_control_lapses_after_7d_idle(self, client, control_dev):
        with _db() as db:
            db.execute("UPDATE device_sessions SET expires_at=? WHERE id=?",
                       (_past_iso(), control_dev["id"]))
        r = client.get("/api/health",
                       headers=_device_headers(control_dev["device_token"]))
        assert r.status_code == 401
        assert _device_row(control_dev["id"])["state"] == "expired"


# --------------------------------------------------------------- migration
class TestScopeMigrationV1:
    def test_active_read_flips_to_control_revoked_untouched(self,
                                                            tmp_path):
        """The boot migration: active+read → control IN PLACE (no re-pair,
        no re-issue); revoked keeps its historical scope (audit truth)."""
        from server.store import Store
        path = tmp_path / "board.db"
        Store(path)  # create schema
        with sqlite3.connect(path) as db:
            db.execute(
                """INSERT INTO device_sessions
                       (id, name, scope, token_hash, created_at,
                        hard_expires_at, state)
                   VALUES ('dev-live', 'phone', 'read', 'h1', '2026-09-01',
                           '2027-01-01', 'active')""")
            db.execute(
                """INSERT INTO device_sessions
                       (id, name, scope, token_hash, created_at,
                        hard_expires_at, state)
                   VALUES ('dev-dead', 'old', 'read', 'h2', '2026-09-01',
                           '2027-01-01', 'revoked')""")
        Store(path)  # boot #1 → migration runs
        with sqlite3.connect(path) as db:
            db.row_factory = sqlite3.Row
            live = dict(db.execute(
                "SELECT * FROM device_sessions WHERE id='dev-live'"
            ).fetchone())
            dead = dict(db.execute(
                "SELECT * FROM device_sessions WHERE id='dev-dead'"
            ).fetchone())
        assert live["scope"] == "control"
        assert dead["scope"] == "read"
        # the migration is audited once
        with sqlite3.connect(path) as db:
            payloads = [r[0] for r in db.execute(
                "SELECT payload FROM events WHERE "
                "kind='device.scope-migrated'").fetchall()]
        assert len(payloads) == 1
        assert json.loads(payloads[0])["migrated"] == 1

    def test_migration_idempotent(self, tmp_path):
        """Second boot: nothing left to flip — no duplicate audit, control
        rows stay control."""
        from server.store import Store
        path = tmp_path / "board.db"
        Store(path)
        with sqlite3.connect(path) as db:
            db.execute(
                """INSERT INTO device_sessions
                       (id, name, scope, token_hash, created_at,
                        hard_expires_at, state)
                   VALUES ('dev-1', 'phone', 'read', 'h1', '2026-09-01',
                           '2027-01-01', 'active')""")
        Store(path)
        Store(path)  # boot #2 — idempotent
        with sqlite3.connect(path) as db:
            scope = db.execute(
                "SELECT scope FROM device_sessions WHERE id='dev-1'"
            ).fetchone()[0]
            logs = db.execute(
                "SELECT COUNT(*) FROM events WHERE "
                "kind='device.scope-migrated'").fetchone()[0]
        assert scope == "control"
        assert logs == 1

    def test_no_seed_version_bump(self):
        """The migration rides the additive path — the seed check must stay
        untouched (a bump WIPES tasks). The 1.22.1 value is pinned."""
        from server.seed import SEED_VERSION
        assert SEED_VERSION == "3"


# ------------------------------------------------- new pairings default control
class TestNewPairingsDefaultControl:
    def test_store_default_is_control(self, app_module):
        row, _code = app_module.store.create_pairing_request()
        try:
            assert row["scope"] == "control"
        finally:
            with _db() as db:
                db.execute("DELETE FROM pairing_requests WHERE id=?",
                           (row["id"],))

    def test_http_pairing_creates_control_and_exchange_carries_it(
            self, client, ui_auth, fresh_pairing_limiters):
        """Full legal flow over HTTP: the pairing row, the exchange 200 and
        the issued device session all carry scope='control'."""
        r = client.post("/api/pairing", json={"device_name": "phone"},
                        headers=ui_auth)
        assert r.status_code == 201, r.text
        pairing_id = r.json()["pairing_id"]
        code = r.json()["code"]
        try:
            assert client.post(
                "/api/pairing/exchange",
                json={"code": code, "device_name": "phone"},
            ).status_code == 202
            assert client.post(
                f"/api/pairing/{pairing_id}/confirm", json={"allow": True},
                headers=ui_auth).status_code == 200
            r = client.post("/api/pairing/exchange",
                            json={"code": code, "device_name": "phone"})
            assert r.status_code == 200, r.text
            assert r.json()["scope"] == "control"
            device_id = r.json()["device_id"]
            with _db() as db:
                db.row_factory = sqlite3.Row
                pairing = dict(db.execute(
                    "SELECT * FROM pairing_requests WHERE id=?",
                    (pairing_id,)).fetchone())
                session = dict(db.execute(
                    "SELECT * FROM device_sessions WHERE id=?",
                    (device_id,)).fetchone())
            assert pairing["scope"] == "control"
            assert session["scope"] == "control"
        finally:
            with _db() as db:
                db.execute("DELETE FROM pairing_requests WHERE id=?",
                           (pairing_id,))
                db.execute(
                    "DELETE FROM device_sessions WHERE name='phone'")

    def test_db_column_default_stays_read(self):
        """Fail-safe: the SCHEMA default remains 'read' — only the store
        layer upgrades new pairings (the archcom decision, verbatim)."""
        with _db() as db:
            row = db.execute(
                "SELECT sql FROM sqlite_master WHERE name='pairing_requests'"
            ).fetchone()
        assert "DEFAULT 'read'" in row["sql"]
