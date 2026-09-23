"""ADR 0014 (owner session): server-verified login + the stateless
``vesmaro_ui`` cookie leg inside the ui guards.

Pinned contract:
- POST /api/auth/ui-token verifies the pasted value at the door:
  200 {ok, token_class} for the ui token (and the board token in legacy
  mode, honestly reported as "legacy"); 401 class-aware — a machine token
  pasted at login says WHICH class arrived; 429 on the flat limiters
  (per-IP 10/60s, global 60/60s); 503 fail-closed while no class is
  configured; 422 outside 1..512;
- the token is NEVER echoed in a response body nor logged (not even
  truncated);
- success sets ``vesmaro_ui``: HttpOnly, SameSite=strict, Path=/,
  Max-Age=21600, Secure only when the request is https (compose deploy is
  plain http 8090 — an unconditional Secure would silently loop login);
- DELETE /api/auth/ui-token is the server-side logout (no guard by
  design): Max-Age=0 + 204, after which the probe answers 401;
- GET /api/auth/ui-token is the boot probe: 204 live / 401 none / 503
  fail-closed;
- the cookie leg lives INSIDE the guards: a ui mutation with a valid
  cookie and NO Authorization header passes (including the
  _guard_ui_write pattern and the both-classes reports route); a machine
  route never reads the cookie; header present → header leg ONLY (the
  cross-class 401 detail proves no fallback);
- sliding idle TTL: a cookie-leg mutation reissues the cookie with a
  fresh Max-Age, throttled to one Set-Cookie per IP per 5 min; a
  header-leg mutation never reissues.
"""

from __future__ import annotations

import pytest
from conftest import BOARD_TOKEN, UI_TOKEN
from fastapi.testclient import TestClient
from server.security import RateLimiter


# ------------------------------------------------------------------ helpers
@pytest.fixture(autouse=True)
def fresh_auth_limiters(app_module, monkeypatch, client):
    """Isolated verify limiters + empty reissue table per test: the
    module-level RateLimiters key on the client IP (TestClient shares one)
    and the throttle would otherwise leak Set-Cookie state between tests.
    The session-scoped TestClient's cookie jar is wiped before AND after —
    a ``vesmaro_ui`` left behind would hydrate the guards of every later
    test file (the client is session-scoped)."""
    monkeypatch.setattr(
        app_module, "_auth_verify_ip_limiter",
        RateLimiter(limit=app_module._AUTH_VERIFY_RATE_LIMIT,
                    window=app_module._AUTH_VERIFY_RATE_WINDOW))
    monkeypatch.setattr(
        app_module, "_auth_verify_global_limiter",
        RateLimiter(limit=app_module._AUTH_VERIFY_GLOBAL_RATE_LIMIT,
                    window=app_module._AUTH_VERIFY_GLOBAL_WINDOW))
    app_module._ui_reissue_last.clear()
    client.cookies.clear()
    yield
    client.cookies.clear()


@pytest.fixture()
def fresh_report_limiter(app_module, monkeypatch):
    from server.security import RateLimiter as RL
    limiter = RL(limit=app_module._REPORT_RATE_LIMIT,
                 window=app_module._REPORT_RATE_WINDOW)
    monkeypatch.setattr(app_module, "_report_limiter", limiter)
    return limiter


def _verify(client, token: str):
    return client.post("/api/auth/ui-token", json={"token": token})


def _make_task(client, title="auth-cookie"):
    r = client.post("/api/tasks", json={"title": title})
    assert r.status_code == 201, r.text
    return r.json()


def _set_cookie_header(response) -> str:
    return response.headers.get("set-cookie", "")


# ------------------------------------------------------------ Ф1: verify
class TestVerify:
    def test_valid_ui_token_200_ui_class(self, client, split_tokens):
        r = _verify(client, UI_TOKEN)
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True, "token_class": "ui"}

    def test_legacy_board_token_200_legacy_class(self, client):
        """Transition env: no VESMARO_UI_TOKEN, the ui class is served by
        the board token — the login must say "legacy", not pretend "ui"."""
        r = _verify(client, BOARD_TOKEN)
        assert r.status_code == 200, r.text
        assert r.json() == {"ok": True, "token_class": "legacy"}

    def test_machine_token_401_class_aware(self, client, split_tokens):
        """The paste-the-board-token mistake (the incident's root #3): the
        detail names the arrived class and the required env."""
        r = _verify(client, BOARD_TOKEN)
        assert r.status_code == 401
        detail = r.json()["detail"]
        assert "machine-class token" in detail
        assert "VESMARO_UI_TOKEN" in detail

    def test_garbage_401_neutral_detail(self, client, split_tokens):
        r = _verify(client, "not-a-token")
        assert r.status_code == 401
        assert r.json()["detail"] == (
            "invalid ui token — this login requires VESMARO_UI_TOKEN")

    def test_503_fail_closed_without_tokens(self, client, no_board_token):
        r = _verify(client, UI_TOKEN)
        assert r.status_code == 503
        assert "VESMARO_UI_TOKEN" in r.json()["detail"]

    def test_422_body_bounds(self, client, split_tokens):
        assert _verify(client, "x" * 513).status_code == 422
        assert _verify(client, "").status_code == 422

    def test_429_after_per_ip_exhaustion(self, client, split_tokens):
        for _ in range(10):
            assert _verify(client, "wrong").status_code == 401
        r = _verify(client, "wrong")
        assert r.status_code == 429
        assert "per client" in r.json()["detail"]

    def test_429_global_budget(self, client, split_tokens, app_module,
                               monkeypatch):
        monkeypatch.setattr(
            app_module, "_auth_verify_global_limiter", RateLimiter(2, 60.0))
        assert _verify(client, "wrong").status_code == 401
        assert _verify(client, "wrong").status_code == 401
        r = _verify(client, "wrong")
        assert r.status_code == 429
        assert "board-wide" in r.json()["detail"]

    def test_token_never_echoed_or_logged(self, client, split_tokens, caplog):
        junk = "qa-reject-value-0f31c7"
        with caplog.at_level("DEBUG"):
            rejected = _verify(client, junk)
            accepted = _verify(client, UI_TOKEN)
        assert rejected.status_code == 401
        assert accepted.status_code == 200
        # The values ride ONLY in the Set-Cookie header (the accepted one) —
        # never a response body, never the log (not even truncated).
        assert junk not in rejected.text
        assert junk not in accepted.text
        assert junk not in accepted.headers.get("set-cookie", "")
        assert junk not in caplog.text
        assert UI_TOKEN not in accepted.text
        assert UI_TOKEN not in caplog.text


# ------------------------------------------------------- Ф2: the cookie
class TestCookieLifecycle:
    def test_set_cookie_parameters_http(self, client, split_tokens):
        r = _verify(client, UI_TOKEN)
        header = _set_cookie_header(r).lower()
        assert f"vesmaro_ui={UI_TOKEN.lower()}" in header
        assert "httponly" in header
        assert "samesite=strict" in header
        assert "path=/" in header
        assert "max-age=21600" in header
        assert "secure" not in header  # http deploy: Secure must be ABSENT

    def test_set_cookie_secure_by_scheme(self, app_module, split_tokens):
        """https request → Secure present (the reverse proxy case)."""
        https = TestClient(app_module.app, base_url="https://testserver")
        r = _verify(https, UI_TOKEN)
        assert "secure" in _set_cookie_header(r).lower()

    def test_delete_is_the_server_side_logout(self, client, split_tokens):
        assert _verify(client, UI_TOKEN).status_code == 200
        assert client.get("/api/auth/ui-token").status_code == 204
        r = client.delete("/api/auth/ui-token")
        assert r.status_code == 204
        assert "max-age=0" in _set_cookie_header(r).lower()
        # The browser dropped the cookie → the probe and the cookie leg
        # both turn 401 again.
        assert client.get("/api/auth/ui-token").status_code == 401
        assert client.post("/api/tasks",
                           json={"title": "after-logout"}).status_code == 401


class TestBootProbe:
    def test_204_with_live_cookie(self, client, split_tokens):
        assert _verify(client, UI_TOKEN).status_code == 200
        assert client.get("/api/auth/ui-token").status_code == 204

    def test_401_without_cookie(self, client, split_tokens):
        assert client.get("/api/auth/ui-token").status_code == 401

    def test_503_fail_closed(self, client, no_board_token):
        assert client.get("/api/auth/ui-token").status_code == 503


# ------------------------------------------- Ф2: the cookie leg in guards
class TestCookieLegGuards:
    """Determinism table (ADR 0014 Ф2): header absent + cookie valid →
    ui-class access; machine routes never consult the cookie; header
    present → header leg ONLY."""

    def test_ui_mutation_cookie_only_201(self, client, split_tokens):
        assert _verify(client, UI_TOKEN).status_code == 200
        assert _make_task(client, "cookie-task")["title"] == "cookie-task"

    def test_guard_ui_write_route_cookie_only(self, client, split_tokens):
        """POST /api/pairing is the _guard_ui_write pattern — the cookie
        must open it exactly like the header bearer does."""
        assert _verify(client, UI_TOKEN).status_code == 200
        r = client.post("/api/pairing", json={"device_name": "qa-cookie"})
        assert r.status_code == 201, r.text

    def test_reports_cookie_only_201(self, client, split_tokens,
                                     fresh_report_limiter):
        """The both-classes route must pick the ui leg for a cookie-only
        request (else it falls into the machine guard → 401)."""
        assert _verify(client, UI_TOKEN).status_code == 200
        task = _make_task(client, "cookie-reports")
        r = client.post(f"/api/tasks/{task['id']}/reports",
                        json={"body": "from the owner", "kind": "intermediate",
                              "agent": "owner"})
        assert r.status_code == 201, r.text

    def test_machine_route_cookie_401(self, client, split_tokens):
        """The cookie must NOT open the machine class (assignment claim,
        a machine route: the guard fires before the unknown-id 404)."""
        assert _verify(client, UI_TOKEN).status_code == 200
        r = client.post("/api/assignments/99999/claim",
                        json={"claimed_by": "cookie-ghost"})
        assert r.status_code == 401
        assert r.json()["detail"] == "board write token required"

    def test_header_present_ignores_cookie(self, client, split_tokens,
                                           machine_auth):
        """Wrong-class bearer + VALID session cookie → 401 on the header
        leg with the cross-class detail. No cookie fallback, ever."""
        assert _verify(client, UI_TOKEN).status_code == 200
        r = client.post("/api/tasks", json={"title": "det"},
                        headers=machine_auth)
        assert r.status_code == 401
        detail = r.json()["detail"]
        assert "machine-class token" in detail
        assert "VESMARO_UI_TOKEN" in detail

    def test_wrong_cookie_401_session_detail(self, client, split_tokens):
        client.cookies.set("vesmaro_ui", "stale-or-forged")
        r = client.post("/api/tasks", json={"title": "stale"})
        assert r.status_code == 401
        assert "ui session missing or expired" in r.json()["detail"]

    def test_cookie_leg_unconfigured_503(self, client, no_board_token):
        client.cookies.set("vesmaro_ui", BOARD_TOKEN)
        # Fail-closed preserved: 503 (no class configured), not 401.
        assert client.post("/api/tasks",
                           json={"title": "closed"}).status_code == 503


# --------------------------------------------------- Ф2: sliding idle TTL
class TestSlidingReissue:
    def test_cookie_mutation_reissues_with_fresh_max_age(self, client,
                                                         split_tokens):
        assert _verify(client, UI_TOKEN).status_code == 200
        r = client.post("/api/tasks", json={"title": "slide-1"})
        assert r.status_code == 201
        assert "max-age=21600" in _set_cookie_header(r).lower()

    def test_reissue_throttled_to_one_per_5min(self, client, split_tokens,
                                               app_module):
        assert _verify(client, UI_TOKEN).status_code == 200
        first = client.post("/api/tasks", json={"title": "slide-2a"})
        second = client.post("/api/tasks", json={"title": "slide-2b"})
        assert first.status_code == second.status_code == 201
        assert "set-cookie" in first.headers          # fresh Max-Age
        assert "set-cookie" not in second.headers     # throttled (< 5 min)

    def test_header_leg_reissues_throttled(self, client, split_tokens, ui_auth):
        """Review P1: the dialog flow keeps the token in sessionStorage —
        its mutations ride the HEADER leg and MUST extend the sliding
        session too, or the cookie dies 6h after login regardless of
        activity (the owner's amendment defeated in its main flow)."""
        assert _verify(client, UI_TOKEN).status_code == 200
        r = client.post("/api/tasks", json={"title": "slide-3"},
                        headers=ui_auth)
        assert r.status_code == 201
        assert "set-cookie" in r.headers          # header leg slides too
        r2 = client.post("/api/tasks", json={"title": "slide-4"},
                         headers=ui_auth)
        assert r2.status_code == 201
        assert "set-cookie" not in r2.headers     # throttled (< 5 min)

    def test_machine_header_leg_never_reissues(self, client, split_tokens,
                                               ui_auth, machine_auth,
                                               fresh_report_limiter):
        """The reports composite with a machine bearer must NOT touch the
        owner session (only ui possession slides it)."""
        assert _verify(client, UI_TOKEN).status_code == 200
        task = client.post("/api/tasks", json={"title": "slide-mchn"},
                           headers=ui_auth).json()
        r = client.post(f"/api/tasks/{task['id']}/reports",
                        json={"body": "ok", "kind": "intermediate",
                              "agent": "qa"},
                        headers=machine_auth)
        assert r.status_code == 201
        assert "set-cookie" not in r.headers


# --------------------------------------------- review gap tests (wave 2)
class TestReviewGaps:
    def test_machine_header_plus_valid_cookie_401(self, client, split_tokens,
                                                  ui_auth, machine_auth):
        """Determinism combo: a VALID machine header must not fall back to a
        valid cookie — fail-closed 401, never an обход."""
        assert _verify(client, UI_TOKEN).status_code == 200
        r = client.post("/api/tasks", json={"title": "gap-combo"},
                        headers=machine_auth)
        assert r.status_code == 401

    def test_legacy_verify_then_cookie_leg_mutates(self, client, auth):
        """Legacy single-token mode: verify answers legacy, and the issued
        cookie opens the ui leg afterwards (header absent)."""
        r = _verify(client, BOARD_TOKEN)
        assert r.status_code == 200
        assert r.json()["token_class"] == "legacy"
        r2 = client.post("/api/tasks", json={"title": "gap-legacy"})
        assert r2.status_code == 201

    def test_get_probe_does_not_set_cookie(self, client, split_tokens):
        """The boot probe must never slide the session (read-only oracle):
        a valid cookie answers 204 withOUT a fresh Set-Cookie."""
        assert _verify(client, UI_TOKEN).status_code == 200  # cookie issued
        r = client.get("/api/auth/ui-token")                 # cookie rides
        assert r.status_code == 204
        assert "set-cookie" not in r.headers

    def test_device_token_plus_cookie_on_closed_mutation_403(self, client,
                                                             split_tokens,
                                                             ui_auth):
        """mnd_ priority on a CLOSED route (scope v1, ADR 0012 Amendment):
        the device scope middleware 403s BEFORE any leg — a live owner
        cookie in the jar cannot lend the device rights its scope does not
        hold. (On scope-ALLOWED routes the device needs no lending: its own
        token carries the mutation — the control matrix in
        test_device_scope_v1.py.)"""
        assert _verify(client, UI_TOKEN).status_code == 200
        p = client.post("/api/pairing", json={"device_name": "gap-mnd"},
                        headers=ui_auth).json()
        client.post("/api/pairing/exchange",
                    json={"code": p["code"], "device_name": "gap-mnd"})
        client.post(f"/api/pairing/{p['pairing_id']}/confirm",
                    json={"allow": True}, headers=ui_auth)
        issued = client.post("/api/pairing/exchange",
                             json={"code": p["code"], "device_name": "gap-mnd"})
        mnd = issued.json()["device_token"]
        # agent-loop mutation: hard-deny for EVERY device scope; the
        # owner cookie rides along in the jar and must stay irrelevant
        r = client.post("/api/assignments", json={},
                        headers={"Authorization": f"Bearer {mnd}"})
        assert r.status_code == 403
        # Cleanup: the issued device must not soak a quota slot for the
        # pairing suite (shared session store).
        device_id = issued.json()["device_id"]
        assert client.delete(f"/api/devices/{device_id}",
                             headers=ui_auth).status_code == 200
