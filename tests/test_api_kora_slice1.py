"""Kora slice-1 API tests (ADR 0019 — GET /api/kora/sessions + ingest).

Three layers:

1. CONTRACT vs docs/kora/openapi.yaml — the frozen week-0 shapes the
   served JSON must satisfy (field-for-field: KoraSessionsOut envelope,
   KoraSessionOut required fields/enums, coverage block, preview ≤160
   and redacted, cursor-free slice-1 surface).
2. INGEST semantics — scanner push upserts, drop_missing (full-listing
   authority), identity binding (executor token 403 mismatch), machine
   class, rate budget, idempotent replay.
3. CHOKE-POINT on the serving path — a secret planted in a stored
   preview NEVER reaches the response body masked-less.

Ingest auth uses the executor-token leg (the poller family): a pending
executor mints via register → approve → scan. ``auth``/``machine_auth``
(the board token) ride the same machine class.
"""

from __future__ import annotations

import pytest
import yaml
from fastapi.testclient import TestClient
from pathlib import Path
from conftest import BOARD_TOKEN, UI_TOKEN

SPEC_PATH = Path(__file__).resolve().parent.parent / "docs" / "kora" / "openapi.yaml"


@pytest.fixture(scope="module")
def kora_spec() -> dict:
    loaded = yaml.safe_load(SPEC_PATH.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def _register_executor(client: TestClient, auth: dict, name: str) -> tuple[str, str]:
    """Register + approve an executor; returns (id, secret).

    Registration is rate-limited (10/min per client — the real gate). The
    module registers a bounded set of executors; tests that need MANY
    distinct ones reuse ``_reuse_executor`` below.
    """
    resp = client.post(
        "/api/executors", headers=auth,
        json={"name": name, "harness": "zcode", "host": "laptop-1"})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    executor_id = body["executor"]["id"]
    resp = client.patch(
        f"/api/executors/{executor_id}", headers=auth,
        json={"state": "approved"})
    assert resp.status_code == 200, resp.text
    return executor_id, body["executor_secret"]


def _scan_body(sessions: list[dict], drop_missing: bool = True) -> dict:
    return {"sessions": sessions, "drop_missing": drop_missing}


def _sample_rows(n: int = 2) -> list[dict]:
    rows = []
    for i in range(n):
        rows.append({
            "native_id": f"sess_{i:04x}",
            "harness": "zcode",
            "project": f"proj-{i}",
            "cwd": f"/proj/dir-{i}",
            "state": "idle",
            "origin": "local",
            "steerable": False,
            "started_at": "2026-09-20T10:00:00+00:00",
            "last_activity_at": "2026-09-24T18:00:00+00:00",
            "preview": f"превью сессии {i}",
        })
    return rows


_EXECUTOR_CACHE: dict[str, tuple[str, dict]] = {}


@pytest.fixture()
def one_executor(client: TestClient, auth: dict) -> tuple[str, dict]:
    """One approved executor for the ingest suite (the registration
    limiter — 10/min per client — forbids one fresh executor per test;
    the ingest itself is idempotent, tests use distinct native_ids).
    Module-level cache: the FIRST test pays the registration, later
    tests reuse the same (id, token) pair."""
    if "exec" in _EXECUTOR_CACHE:
        return _EXECUTOR_CACHE["exec"]
    executor_id, secret = _register_executor(client, auth, "kora-ingest-1")
    _EXECUTOR_CACHE["exec"] = (
        executor_id, {"Authorization": f"Bearer {secret}"})
    return _EXECUTOR_CACHE["exec"]



@pytest.fixture(autouse=True)
def fresh_kora_limiters(app_module, monkeypatch):
    """Per-test limiter resets (conftest fresh_reflect_limiter pattern):
    module-global budgets must not leak between tests, and the REGISTRATION
    budget must not be shared with other suites' registrations (the
    executor-register limiter is per client-IP — the whole QA suite rides
    one TestClient, so 10/60s is a cross-suite constraint this module
    must not depend on)."""
    from server.security import RateLimiter
    scan = RateLimiter(limit=app_module._KORA_SCAN_RATE_LIMIT,
                       window=app_module._KORA_SCAN_RATE_WINDOW)
    monkeypatch.setattr(app_module, "_kora_scan_limiter", scan)
    register = RateLimiter(limit=app_module._EXECUTOR_REGISTER_RATE_LIMIT,
                           window=app_module._EXECUTOR_REGISTER_RATE_WINDOW)
    monkeypatch.setattr(app_module, "_executor_register_limiter", register)
    return scan


def _list_sessions(client: TestClient, headers: dict | None = None) -> dict:
    """GET /api/kora/sessions as the OWNER (ui class). Post-guard the
    listing is owner/device-only — every contract test reads it logged
    in; the authless legs have their own dedicated tests below. The
    bearer is the EFFECTIVE ui token (app module global — the transition
    env falls back to the board token, ui_auth fixture discipline)."""
    if headers is None:
        from conftest import get_app_module
        effective_ui = get_app_module().UI_WRITE_TOKEN \
            or get_app_module().BOARD_WRITE_TOKEN
        headers = {"Authorization": f"Bearer {effective_ui}"}
    resp = client.get("/api/kora/sessions", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


class TestListContract:
    """Served JSON vs the frozen artifact (slice-1 surface)."""

    def test_envelope_matches_frozen_shape(self, client: TestClient,
                                           kora_spec: dict):
        body = _list_sessions(client)
        schema = kora_spec["components"]["schemas"]["KoraSessionsOut"]
        assert set(body.keys()) == set(schema["required"]), (
            "KoraSessionsOut keys drift: the contract freezes "
            f"{schema['required']}")
        assert body["ok"] is True
        assert body["count"] == len(body["items"])
        assert body["meta"]["generated_at"]
        # coverage block shape
        coverage = body["coverage"]
        cov_schema = kora_spec["components"]["schemas"]["KoraCoverageOut"]
        assert set(coverage.keys()) == set(cov_schema["required"])
        assert isinstance(coverage["harnesses"], list)
        assert isinstance(coverage["gaps"], list)
        for row in coverage["harnesses"]:
            assert {"harness", "support"} <= set(row.keys())

    def test_session_item_frozen_fields(self, client: TestClient, auth: dict,
                                       kora_spec: dict):
        executor_id, secret = _register_executor(
            client, auth, "kora-ct-executor")
        resp = client.post(
            f"/api/executors/{executor_id}/kora-scan",
            headers={"Authorization": f"Bearer {secret}"},
            json=_scan_body(_sample_rows(1)))
        assert resp.status_code == 200, resp.text
        body = _list_sessions(client)
        assert body["count"] >= 1
        item = body["items"][0]
        schema = kora_spec["components"]["schemas"]["KoraSessionOut"]
        assert set(schema["required"]) <= set(item.keys()), (
            "required KoraSessionOut fields missing")
        assert item["harness"] in ("zcode", "vscode", "pi")
        assert item["state"] in ("live", "idle", "dead")
        assert item["origin"] in ("relay", "local")
        assert isinstance(item["steerable"], bool)
        assert isinstance(item["age_seconds"], int) and item["age_seconds"] >= 0
        # opaque id carries the registry PK pair (stable handle)
        assert item["id"] == f"{item['executor_id']}:{item['native_id']}"

    def test_preview_clamped_160_and_redacted(self, client: TestClient,
                                             auth: dict):
        executor_id, secret = _register_executor(
            client, auth, "kora-ct-clamp")
        secret_preview = (
            "текст " + "a" * 100
            + " ghp_AbCdEf1234567890aBcDeF1234567890" + "b" * 200)
        resp = client.post(
            f"/api/executors/{executor_id}/kora-scan",
            headers={"Authorization": f"Bearer {secret}"},
            json=_scan_body([{
                "native_id": "sess_preview", "harness": "zcode",
                "preview": secret_preview,
            }]))
        assert resp.status_code == 200, resp.text
        body = _list_sessions(client)
        item = next(s for s in body["items"]
                    if s["native_id"] == "sess_preview")
        assert len(item["last_line_preview"]) <= 160
        assert "ghp_AbCdEf" not in item["last_line_preview"]
        assert "gh*_<redacted>" in item["last_line_preview"]

    def test_null_preview_for_empty(self, client: TestClient, auth: dict):
        executor_id, secret = _register_executor(
            client, auth, "kora-ct-null")
        client.post(
            f"/api/executors/{executor_id}/kora-scan",
            headers={"Authorization": f"Bearer {secret}"},
            json=_scan_body([{"native_id": "sess_noprev",
                              "harness": "zcode"}]))
        body = _list_sessions(client)
        item = next(s for s in body["items"]
                    if s["native_id"] == "sess_noprev")
        assert item["last_line_preview"] is None
        assert item["project"] is None
        assert item["cwd"] is None

    def test_filters_dictionary_validated(self, client: TestClient):
        from conftest import get_app_module as _gam
        _eff = _gam().UI_WRITE_TOKEN or _gam().BOARD_WRITE_TOKEN
        auth_headers = {"Authorization": f"Bearer {_eff}"}
        assert client.get("/api/kora/sessions?harness=bogus",
                          headers=auth_headers).status_code == 422
        assert client.get("/api/kora/sessions?state=bogus",
                          headers=auth_headers).status_code == 422
        ok = client.get("/api/kora/sessions?harness=zcode&state=live",
                        headers=auth_headers)
        assert ok.status_code == 200

    def test_harness_filter_narrows(self, client: TestClient, auth: dict):
        executor_id, secret = _register_executor(
            client, auth, "kora-ct-filter")
        client.post(
            f"/api/executors/{executor_id}/kora-scan",
            headers={"Authorization": f"Bearer {secret}"},
            json=_scan_body([
                {"native_id": "s1", "harness": "zcode"},
                {"native_id": "s2", "harness": "pi"},
            ]))
        from conftest import get_app_module as _gam
        _eff = _gam().UI_WRITE_TOKEN or _gam().BOARD_WRITE_TOKEN
        auth_headers = {"Authorization": f"Bearer {_eff}"}
        body = client.get("/api/kora/sessions?harness=pi",
                          headers=auth_headers).json()
        assert body["count"] == 1
        assert body["items"][0]["harness"] == "pi"


class TestIngest:
    def test_executor_token_binds_identity(self, client: TestClient,
                                          auth: dict, one_executor):
        executor_id, h = one_executor
        other_id, _ = _register_executor(client, auth, "kora-ig-other")
        # pushing under ANOTHER executor's id with my token → 403
        resp = client.post(
            f"/api/executors/{other_id}/kora-scan",
            headers=h, json=_scan_body([{"native_id": "bind-1",
                                         "harness": "zcode"}]))
        assert resp.status_code == 403
        # own id → 200
        resp = client.post(
            f"/api/executors/{executor_id}/kora-scan",
            headers=h, json=_scan_body([{"native_id": "bind-2",
                                        "harness": "zcode"}]))
        assert resp.status_code == 200
        verdict = resp.json()
        assert verdict["scanned"] == 1 and verdict["upserted"] == 1

    def test_machine_token_ingest(self, client: TestClient, machine_auth: dict):
        resp = client.post(
            "/api/executors/ex-machine-leg/kora-scan",
            headers=machine_auth, json=_scan_body(_sample_rows(1)))
        assert resp.status_code == 200
        assert _list_sessions(client)["count"] >= 1

    def test_no_token_401(self, client: TestClient):
        resp = client.post("/api/executors/ex-x/kora-scan",
                           json=_scan_body(_sample_rows(1)))
        assert resp.status_code == 401

    def test_unknown_harness_422(self, client: TestClient, one_executor):
        executor_id, h = one_executor
        resp = client.post(
            f"/api/executors/{executor_id}/kora-scan",
            headers=h,
            json=_scan_body([{"native_id": "u422", "harness": "bogus"}]))
        assert resp.status_code == 422

    def test_drop_missing_full_listing_authority(self, client: TestClient,
                                                 one_executor):
        executor_id, h = one_executor
        base = f"/api/executors/{executor_id}/kora-scan"
        # first full listing: 3 sessions
        client.post(base, headers=h, json=_scan_body(_sample_rows(3)))
        assert _list_sessions(client)["count"] >= 3
        # second full listing: only 1 survives → 2 dropped
        resp = client.post(base, headers=h, json=_scan_body(_sample_rows(1)))
        assert resp.status_code == 200
        verdict = resp.json()
        assert verdict["dropped"] == 2
        # delta push (keep missing): count unchanged
        resp = client.post(base, headers=h,
                           json=_scan_body(_sample_rows(1),
                                           drop_missing=False))
        assert resp.json()["dropped"] == 0

    def test_replay_is_idempotent(self, client: TestClient, one_executor):
        executor_id, h = one_executor
        body = _scan_body([{"native_id": f"idem-{i}", "harness": "zcode"}
                            for i in range(2)])
        first = client.post(
            f"/api/executors/{executor_id}/kora-scan",
            headers=h, json=body).json()
        second = client.post(
            f"/api/executors/{executor_id}/kora-scan",
            headers=h, json=body).json()
        assert first["listed"] == 2
        assert second["listed"] == 0      # no new identities on replay
        assert second["upserted"] == 2    # same values re-written, no dupes
        items = [s for s in _list_sessions(client)["items"]
                 if s["executor_id"] == executor_id]
        assert len(items) == 2

    def test_scan_ticks_executor_presence(self, client: TestClient,
                                          auth: dict):
        executor_id, secret = _register_executor(client, auth, "kora-ig-pres")
        before = client.get(f"/api/executors/{executor_id}").json()
        assert before["last_seen"] == ""   # never heartbeated (flat row)
        client.post(f"/api/executors/{executor_id}/kora-scan",
                    headers={"Authorization": f"Bearer {secret}"},
                    json=_scan_body(_sample_rows(1)))
        after = client.get(f"/api/executors/{executor_id}").json()
        assert after["last_seen"] != ""

    def test_revoked_executor_refused(self, client: TestClient, auth: dict):
        """``revoked`` is TERMINAL (the kill-switch — no un-revoke), so
        this test owns a FRESH executor: the shared one must never be
        sacrificed to a terminal state."""
        executor_id, secret = _register_executor(client, auth, "kora-ig-rev")
        h = {"Authorization": f"Bearer {secret}"}
        client.patch(f"/api/executors/{executor_id}", headers=auth,
                     json={"state": "revoked"})
        resp = client.post(
            f"/api/executors/{executor_id}/kora-scan",
            headers=h,
            json=_scan_body([{"native_id": "rev-1", "harness": "zcode"}]))
        assert resp.status_code == 403

    def test_rate_limit_429(self, client: TestClient, one_executor):
        """12/min: a runaway scanner loop must be throttled (the limiter
        is per client IP — one burst burns the budget)."""
        executor_id, h = one_executor
        base = f"/api/executors/{executor_id}/kora-scan"
        statuses = [client.post(base, headers=h,
                               json=_scan_body([])).status_code
                    for _ in range(15)]
        assert 429 in statuses
        assert statuses[-1] == 429
        assert statuses[0] == 200

    def test_extra_fields_rejected(self, client: TestClient, one_executor):
        executor_id, h = one_executor
        row = {"native_id": "extra-1", "harness": "zcode",
               "rogue_field": "x"}
        resp = client.post(
            f"/api/executors/{executor_id}/kora-scan",
            headers=h, json=_scan_body([row]))
        assert resp.status_code == 422



    def test_coverage_plate_honest_slice1(self, client: TestClient):
        """P5 (slice-1 review): `full` lied — slice 1 serves LISTS only;
        the plate must say lists-only and the gaps must name the
        transcript boundary explicitly."""
        body = _list_sessions(client)
        zcode = next(h for h in body["coverage"]["harnesses"]
                     if h["harness"] == "zcode")
        assert zcode["support"] == "lists-only", (
            "slice 1 has no transcript route — `full` overpromises")
        assert any("транскрипт" in g for g in body["coverage"]["gaps"])
        for row in body["coverage"]["harnesses"]:
            assert row["support"] in (
                "full", "lists-only", "metadata-only", "absent")


class TestSseGrammar:
    """P4 (slice-1 review): the SSE dictionary speaks the FROZEN grammar
    — per-session ``session.listed`` frames (KoraSessionListedEvent),
    metadata only, no grouped ``kind`` aggregates."""

    def test_session_listed_frames_match_frozen_schema(
            self, client: TestClient, app_module, one_executor):
        events: list[dict] = []
        original = app_module._broadcast

        def capture(event: dict) -> None:
            events.append(event)
            original(event)

        app_module._broadcast = capture
        try:
            executor_id, h = one_executor
            client.post(
                f"/api/executors/{executor_id}/kora-scan", headers=h,
                json=_scan_body([{"native_id": "sse-1", "harness": "zcode",
                                  "project": "p1"}]))
        finally:
            app_module._broadcast = original
        frames = [e for e in events if e.get("event") == "session.listed"]
        assert len(frames) == 1, "one new session — one frame, not grouped"
        frame = frames[0]
        assert set(frame) == {"event", "session_id", "executor_id",
                              "native_id", "harness", "project", "at"}
        assert frame["session_id"] == f"{executor_id}:sse-1"
        assert frame["project"] == "p1"
        assert frame["at"]
        # no preview/content rides the event (metadata-only dictionary)
        assert not any("preview" in e or "content" in e
                       for e in frames)

    def test_no_kind_aggregate_drift(self, client: TestClient,
                                     app_module, one_executor):
        """The old grouped shape (kind=kora.sessions.listed) must be
        GONE — the frozen vocabulary names `session.listed`."""
        events: list[dict] = []
        original = app_module._broadcast

        def capture(event: dict) -> None:
            events.append(event)

        app_module._broadcast = capture
        try:
            executor_id, h = one_executor
            client.post(
                f"/api/executors/{executor_id}/kora-scan", headers=h,
                json=_scan_body([{"native_id": "sse-2", "harness": "zcode"}]))
        finally:
            app_module._broadcast = original
        assert not any("kind" in e and "kora" in str(e.get("kind"))
                       for e in events)


class TestListingAccessGuard:
    """Owner decision on the slice-1 review: the listing is AUTHED —
    ui class (header or cookie leg) OR mnd_ device class (metadata tier,
    previews already choke-point masked). Anonymous → 401; the machine
    bearer is NOT a listing class (Kora surfaces the owner's personal
    sessions; the scanner has its own ingest route)."""

    _created_devices: list[str] = []

    @classmethod
    def _paired_device(cls, app_module, name="kora-phone"):
        """Store-level pairing double (test_device_scope_v1 pattern):
        returns the device row + its plaintext mnd_ token. The created
        session is registered for teardown — the ≤5-ACTIVE device quota
        is BOARD-GLOBAL; leaking sessions here 409s the later pairing
        suites in a full run (found the hard way, 2026-09-25)."""
        store = app_module.store
        row, _code = store.create_pairing_request(device_name=name)
        store.scan_pairing(row["id"], device_name=name,
                           source_ip="testclient")
        store.confirm_pairing(row["id"], allow=True)
        device, token = store.issue_device_session(row["id"])
        cls._created_devices.append(device["id"])
        return device, token

    @pytest.fixture(autouse=True)
    def _delete_guard_devices(self, app_module):
        """Teardown: DELETE every device row this class paired (the
        device_scope_v1 discipline — revoking is NOT enough, the row
        itself counts toward the pairing suites' expectations)."""
        yield
        import sqlite3
        from conftest import DATA_DIR
        with sqlite3.connect(DATA_DIR / "board.db") as db:
            for device_id in self._created_devices:
                db.execute("DELETE FROM device_sessions WHERE id=?",
                           (device_id,))
        self._created_devices.clear()

    def test_anonymous_401(self, client: TestClient):
        resp = client.get("/api/kora/sessions")
        assert resp.status_code == 401
        assert "owner session" in resp.json()["detail"]

    def test_ui_bearer_reads(self, client: TestClient):
        body = _list_sessions(client)
        assert body["ok"] is True

    def test_ui_cookie_leg_reads(self, client: TestClient, app_module):
        """Headerless owner request: the vesmaro_ui cookie IS the owner
        session (ADR 0014 Ф2) — the listing opens for it."""
        client.cookies.set(
            app_module._UI_COOKIE_NAME,
            app_module.UI_WRITE_TOKEN or app_module.BOARD_WRITE_TOKEN)
        resp = client.get("/api/kora/sessions")
        assert resp.status_code == 200, resp.text
        client.cookies.clear()

    def test_device_token_reads_the_list(self, client: TestClient,
                                        app_module):
        """mnd_ metadata tier: a VALID paired device sees the LIST
        (previews pass the choke-point; transcripts stay ui-only from
        slice 2). Invalid mnd_ → 401 from the scope middleware (validate
        first, QA matrix v1)."""
        device, token = self._paired_device(app_module)
        resp = client.get("/api/kora/sessions",
                          headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["ok"] is True
        assert "coverage" in body

    def test_device_sees_masked_previews(self, client: TestClient,
                                         app_module, one_executor):
        """P0 edge (review recipe): mnd_ metadata tier reads the LIST —
        and the previews it sees are the CHOKE-POINT's output (clamped,
        redacted), never raw store text. A secret planted in a preview
        must not survive to the device leg."""
        executor_id, h = one_executor
        secret_preview = ("нормальный текст " + "ghp_AbCdEf1234567890aBcDeF"
                          + " хвост")
        client.post(
            f"/api/executors/{executor_id}/kora-scan", headers=h,
            json=_scan_body([{"native_id": "mnd-prev-1", "harness": "zcode",
                              "preview": secret_preview}]))
        device, token = self._paired_device(app_module,
                                            name="kora-phone-prev")
        resp = client.get("/api/kora/sessions",
                          headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200, resp.text
        item = next(s for s in resp.json()["items"]
                    if s["native_id"] == "mnd-prev-1")
        assert "ghp_AbCdEf" not in (item["last_line_preview"] or "")
        assert "gh*_<redacted>" in item["last_line_preview"]

    def test_invalid_device_token_401(self, client: TestClient):
        resp = client.get("/api/kora/sessions",
                          headers={"Authorization": "Bearer mnd_bogus"})
        assert resp.status_code == 401

    def test_machine_bearer_is_not_a_listing_class(self, client: TestClient,
                                                    machine_auth: dict):
        """The owner decision names ui + mnd_ ONLY: a machine bearer that
        is NOT the effective ui token answers 401 on the listing (Kora is
        an owner surface, not a cluster-internal one). In the transition
        env the board token IS the effective ui token (legacy single-token
        mode) — the bearer then legitimately reads; the split env pins the
        refusal (see split_tokens usage elsewhere for the pattern)."""
        from conftest import get_app_module
        resp = client.get("/api/kora/sessions", headers=machine_auth)
        effective_ui = (get_app_module().UI_WRITE_TOKEN
                        or get_app_module().BOARD_WRITE_TOKEN)
        expected = 200 if machine_auth["Authorization"] == (
            f"Bearer {effective_ui}") else 401
        assert resp.status_code == expected

    def test_executor_token_is_not_a_listing_class(self, client: TestClient,
                                                   one_executor):
        """Executor tokens open the SCAN ingest, never the listing."""
        executor_id, h = one_executor
        resp = client.get("/api/kora/sessions", headers=h)
        assert resp.status_code == 401


class TestLiveScanPipeline:
    def test_reader_to_registry_to_api(self, client: TestClient, auth: dict,
                                       one_executor, monkeypatch):
        """The slice-1 pipeline against a SYNTHETIC store: the real reader
        (scan_zcode_store) → the real ingest → the real serving path."""
        import sqlite3
        import tempfile
        from server.kora.zcode_reader import scan_zcode_store
        tmp = tempfile.mkdtemp(prefix="kora-pipe-")
        db = Path(tmp) / "db.sqlite"
        con = sqlite3.connect(db)
        con.executescript("""
        CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT,
            directory TEXT NOT NULL, title TEXT NOT NULL,
            time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
            time_archived INTEGER);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL,
            session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
            data TEXT NOT NULL);
        """)
        import time as _time
        now_ms = int(_time.time() * 1000)
        con.execute("INSERT INTO session VALUES (?,?,?,?,?,?,NULL)",
                    ("sess_pipeline", None, "/proj/kora", "Пайплайн",
                     now_ms - 7200000, now_ms - 60000))
        con.execute("INSERT INTO part VALUES (?,?,?,?,?)",
                    ("p1", "m1", "sess_pipeline", now_ms - 30000,
                     '{"type": "text", "text": "пайплайн живой, токен '
                     'ghp_AbCdEf1234567890aBcDeF1234 не утечёт"}'))
        con.commit()
        con.close()

        scan = scan_zcode_store(db, now=_time.time())
        assert len(scan.sessions) == 1
        executor_id, h = one_executor
        resp = client.post(
            f"/api/executors/{executor_id}/kora-scan",
            headers=h,
            json={"sessions": scan.sessions, "drop_missing": True})
        assert resp.status_code == 200
        body = _list_sessions(client)
        item = next(s for s in body["items"]
                    if s["native_id"] == "sess_pipeline")
        assert item["state"] == "live"
        assert item["project"] == "kora"
        assert "ghp_AbCdEf" not in (item["last_line_preview"] or "")