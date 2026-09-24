"""ARCH-9 (ADR 0009 Amendment 2): executor registry — the third entity.

Coverage map (AC):
- registration L0: machine-token POST creates PENDING + mints
  executor_secret (shown once, only sha256 in the DB); duplicate name →
  409; unknown harness/transport → 422; machine-token class only;
- registry lifecycle: ui-token PATCH approve / capabilities / name /
  enabled with audit old→new; revoked is terminal (kill-switch); DELETE
  leaves active assignments untouched;
- executor-token class: heartbeat ticks presence; wrong-id heartbeat →
  403; revoked → 403; pending may tick; unknown bearer → 401;
- presence (two-clock discipline): computed on read (online ≤ 120 s /
  stale 2–10 min / offline > 10 min, thresholds in GET meta); the
  background sweeper detects TRANSITIONS only, emits executor.online /
  executor.offline with {executor, prev_state, state, last_seen_at},
  never mutates rows, stale corridor is silent;
- routing chain (computed per GET, stored nowhere): explicit pin →
  assignment.specialist caps → task.specialists caps → project default →
  global default → auto best-match (approved+enabled+online+local-poll) →
  unmatched;
- explicit-claim enforcement: pinned assignment + board token → 409,
  another executor's token → 403, the pinned executor's token → 200 with
  token-backed claimed_by_executor; declared executor_id contradicting
  the token → 403;
- settings: GET/PUT /api/settings/execution (ui-token; Amd 2 §5 gates:
  approved + enabled + live + local-poll), audit default.changed
  old→new, project scope reserved in board_meta;
- topics: denormalized from task.mnemos_tags (+ project:<slug>) at
  assignment creation, metadata tier;
- PR #13 review P3: partial unique active-task index (structural 409),
  assignment-heartbeat rate budget separate from the machine budget,
  claim of a task archived after creation → 422;
- identity_mismatch: executor-token report whose declared agent string
  references neither the executor name nor its harness is flagged in the
  task.report audit event (Amd 2 §7 spoofing signal).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from server.security import RateLimiter


# ----------------------------------------------------------------- fixtures
@pytest.fixture(autouse=True)
def fresh_executor_state(app_module, monkeypatch):
    """Per-test isolation for everything ARCH-9 keeps in module/DB state:
    fresh rate limiters (module globals accumulate across the
    session-scoped client), a clean presence-emission baseline, a wiped
    executor registry (the routing chain scans ALL rows — leftover
    executors from sibling tests would resolve the auto/unmatched tiers),
    and no default-executor board_meta leftovers. Assignment rows carry
    no FK into executors, so the wipe never dangles."""
    for name in ("_executor_register_limiter",
                 "_executor_heartbeat_limiter",
                 "_assignment_heartbeat_limiter",
                 "_assignment_limiter", "_assignment_ui_limiter",
                 "_report_limiter"):
        limiter = getattr(app_module, name)
        monkeypatch.setattr(
            app_module, name,
            RateLimiter(limit=limiter.limit, window=limiter.window))
    app_module._presence_emitted.clear()
    with app_module.store._lock, app_module.store._conn() as db:
        db.execute("DELETE FROM executors")
        db.execute(
            "DELETE FROM board_meta WHERE key LIKE 'default_executor%'")
    yield
    app_module._presence_emitted.clear()
    with app_module.store._lock, app_module.store._conn() as db:
        db.execute("DELETE FROM executors")
        db.execute(
            "DELETE FROM board_meta WHERE key LIKE 'default_executor%'")


# ----------------------------------------------------------------- helpers
def _register(client, headers, name: str, **extra) -> tuple[dict, str]:
    payload = {"name": name, "harness": "zcode"} | extra
    r = client.post("/api/executors", json=payload, headers=headers)
    assert r.status_code == 201, r.text
    body = r.json()
    return body["executor"], body["executor_secret"]


def _approve(client, headers, executor_id: str, **patch) -> dict:
    r = client.patch(f"/api/executors/{executor_id}",
                     json={"state": "approved", **patch}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["executor"]


def _ex_headers(secret: str) -> dict:
    return {"Authorization": f"Bearer {secret}"}


def _make_executor(client, auth, name: str, *, caps: list[str] | None = None,
                   online: bool = False, transport: str = "local-poll",
                   ) -> tuple[dict, str]:
    """register → approve + enable (+capabilities) → optional presence
    tick. Approval and enabled are two separate owner switches (AC1:
    routing considers approved+enabled); this helper flips both."""
    executor, secret = _register(client, auth, name, transport=transport)
    patch: dict = {"state": "approved", "enabled": True}
    if caps is not None:
        patch["capabilities"] = caps
    if online:
        r = client.post(f"/api/executors/{executor['id']}/heartbeat",
                        headers=_ex_headers(secret))
        assert r.status_code == 200, r.text
    r = client.patch(f"/api/executors/{executor['id']}", json=patch,
                     headers=auth)
    assert r.status_code == 200, r.text
    return r.json()["executor"], secret


def _age_last_seen(app_module, executor_id: str, seconds: float) -> None:
    """Rewrite an executor's presence clock (test-only time travel)."""
    ts = (datetime.now(timezone.utc)
          - timedelta(seconds=seconds)).isoformat(timespec="seconds")
    with app_module.store._lock, app_module.store._conn() as db:
        db.execute("UPDATE executors SET last_seen=? WHERE id=?",
                   (ts, executor_id))


def _board_events(app_module, kind: str) -> list[dict]:
    return [e for e in app_module.store.events(limit=1000) if e["kind"] == kind]


def _assignment_routing(client, assignment_id: int) -> dict:
    items = client.get("/api/assignments").json()["items"]
    return next(i["routing"] for i in items if i["id"] == assignment_id)


class TestRegistration:
    """AC1-3: machine-token bootstrap, pending state, secret mint."""

    def test_register_creates_pending_and_shows_secret_once(
            self, client, auth):
        executor, secret = _register(client, auth, "laptop-poller-a1")
        assert executor["state"] == "pending"
        assert executor["enabled"] is False
        assert executor["capabilities"] == []
        assert executor["transport"] == "local-poll"
        assert executor["presence"] == "offline"   # never heartbeated
        assert len(secret) == 48 and int(secret, 16) >= 0  # token_hex(24)

        listed = client.get("/api/executors").json()
        item = next(e for e in listed["items"] if e["id"] == executor["id"])
        assert "executor_secret" not in item
        assert "secret_hash" not in item

    def test_secret_stored_as_sha256_only(self, client, auth, app_module):
        executor, secret = _register(client, auth, "hashcheck-a2")
        with app_module.store._lock, app_module.store._conn() as db:
            row = db.execute(
                "SELECT * FROM executors WHERE id=?",
                (executor["id"],)).fetchone()
        assert row["secret_hash"] == hashlib.sha256(
            secret.encode()).hexdigest()
        # plaintext never persists: the whole row is secret-free
        assert secret not in json.dumps(dict(row))

    def test_register_is_machine_token_class(
            self, client, auth, app_module, monkeypatch):
        r = client.post("/api/executors",
                        json={"name": "noauth-a3", "harness": "zcode"})
        assert r.status_code == 401
        monkeypatch.setattr(app_module, "UI_WRITE_TOKEN", "qa-ui-token")
        r = client.post("/api/executors",
                        json={"name": "uiauth-a3", "harness": "zcode"},
                        headers={"Authorization": "Bearer qa-ui-token"})
        assert r.status_code == 401   # ui token must not mint executors

    def test_register_validation(self, client, auth):
        assert client.post("/api/executors", headers=auth,
                           json={"name": "badh-a4", "harness": "no-such"}
                           ).status_code == 422
        assert client.post("/api/executors", headers=auth,
                           json={"name": "badt-a4", "harness": "zcode",
                                 "transport": "carrier-pigeon"}
                           ).status_code == 422
        assert client.post("/api/executors", headers=auth,
                           json={"name": "", "harness": "zcode"}
                           ).status_code == 422
        _register(client, auth, "dup-a4")
        r = client.post("/api/executors", headers=auth,
                        json={"name": "dup-a4", "harness": "zcode"})
        assert r.status_code == 409

    def test_list_is_open_and_documents_thresholds(self, client):
        listed = client.get("/api/executors")
        assert listed.status_code == 200
        body = listed.json()
        assert body["ok"] is True and body["count"] == len(body["items"])
        # server-owned constants (АРХКОМ-4): clients read, never hardcode
        assert body["meta"]["presence"] == {
            "online_max_age_s": 120, "stale_max_age_s": 600}
        assert body["meta"]["sweeper_interval_s"] == 60


class TestGetSingle:
    """GET /api/executors/{executor_id} (AGW-6, executor settings card):
    open read like the list, same _executor_public projection (no secret
    material), 404 unknown, and the literal enrollment route keeps winning
    the match order over the parametric id."""

    def test_found_same_projection_as_list(self, client, auth):
        executor, secret = _make_executor(
            client, auth, "single-g1", caps=["researcher"], online=True)
        r = client.get(f"/api/executors/{executor['id']}")
        assert r.status_code == 200, r.text
        body = r.json()
        listed = client.get("/api/executors").json()["items"]
        expected = next(i for i in listed if i["id"] == executor["id"])
        assert body == expected  # one projection, two reads
        assert body["presence"] == "online"
        assert "secret_hash" not in body
        assert "executor_secret" not in body

    def test_unknown_404(self, client):
        r = client.get("/api/executors/no-such-executor")
        assert r.status_code == 404
        assert "no-such-executor" in r.json()["detail"]

    def test_enrollment_literal_not_shadowed(self, client, auth):
        # match-order guard: GET /api/executors/enrollment must stay the
        # token list (ui-token class), never resolve as executor id 404/200.
        r = client.get("/api/executors/enrollment", headers=auth)
        assert r.status_code == 200
        assert "items" in r.json()



class TestExecutorToken:
    """AC2-3: third bearer class — presence heartbeat semantics."""

    def test_heartbeat_ticks_presence(self, client, auth):
        executor, secret = _register(client, auth, "beat-b1")
        r = client.post(f"/api/executors/{executor['id']}/heartbeat",
                        headers=_ex_headers(secret))
        assert r.status_code == 200, r.text
        out = r.json()["executor"]
        assert out["last_seen"] != ""
        assert out["presence"] == "online"

    def test_heartbeat_requires_own_token(self, client, auth):
        executor, secret = _register(client, auth, "beat-b2")
        other, other_secret = _register(client, auth, "beat-b2-other")
        assert client.post(
            f"/api/executors/{executor['id']}/heartbeat").status_code == 401
        assert client.post(
            f"/api/executors/{executor['id']}/heartbeat",
            headers=_ex_headers("not-a-real-secret")).status_code == 401
        # another executor's token is an identity error (403, not 404)
        assert client.post(
            f"/api/executors/{executor['id']}/heartbeat",
            headers=_ex_headers(other_secret)).status_code == 403
        assert client.post(
            f"/api/executors/{other['id']}/heartbeat",
            headers=_ex_headers(secret)).status_code == 403

    def test_pending_may_tick_revoked_may_not(self, client, auth):
        executor, secret = _register(client, auth, "gate-b3")
        # pending: the owner sees liveness before approving
        assert client.post(
            f"/api/executors/{executor['id']}/heartbeat",
            headers=_ex_headers(secret)).status_code == 200
        _approve(client, auth, executor["id"])
        assert client.post(
            f"/api/executors/{executor['id']}/heartbeat",
            headers=_ex_headers(secret)).status_code == 200
        r = client.patch(f"/api/executors/{executor['id']}",
                         json={"state": "revoked"}, headers=auth)
        assert r.status_code == 200
        assert client.post(
            f"/api/executors/{executor['id']}/heartbeat",
            headers=_ex_headers(secret)).status_code == 403


class TestRegistryLifecycle:
    """AC3+AC7: ui-token PATCH/DELETE with audit old→new."""

    def test_approve_audits_old_to_new(self, client, auth, app_module):
        executor, _ = _register(client, auth, "appr-c1")
        out = _approve(client, auth, executor["id"])
        assert out["state"] == "approved"
        events = _board_events(app_module, "executor.approved")
        ev = next(e for e in events
                  if e["payload"]["executor_id"] == executor["id"])
        assert ev["payload"]["approver"] == "owner"
        assert ev["payload"]["changes"]["state"] == ["pending", "approved"]

    def test_patch_capabilities_name_enabled_audit(self, client, auth,
                                                   app_module):
        executor, _ = _make_executor(client, auth, "patch-c2",
                                     caps=["gcw-tech-lead"])
        r = client.patch(f"/api/executors/{executor['id']}", headers=auth,
                         json={"capabilities": ["gcw-tech-lead",
                                                "gcw-senior-dba"],
                               "name": "patch-c2-renamed",
                               "enabled": False})
        assert r.status_code == 200, r.text
        out = r.json()["executor"]
        assert out["capabilities"] == ["gcw-tech-lead", "gcw-senior-dba"]
        assert out["enabled"] is False
        ev = _board_events(app_module, "executor.updated")[-1]
        assert ev["payload"]["changes"]["capabilities"] == [
            ["gcw-tech-lead"], ["gcw-tech-lead", "gcw-senior-dba"]]
        assert ev["payload"]["changes"]["name"] == [
            "patch-c2", "patch-c2-renamed"]
        assert ev["payload"]["changes"]["enabled"] == [True, False]
        assert "secret_hash" not in json.dumps(ev["payload"])

    def test_patch_is_ui_token_class(self, client, auth, app_module,
                                     monkeypatch):
        executor, secret = _register(client, auth, "uiauth-c3")
        monkeypatch.setattr(app_module, "UI_WRITE_TOKEN", "qa-ui-token")
        # board (machine) token refused in split mode; executor never
        r = client.patch(f"/api/executors/{executor['id']}",
                         json={"state": "approved"}, headers=auth)
        assert r.status_code == 401
        r = client.patch(f"/api/executors/{executor['id']}",
                         json={"state": "approved"},
                         headers=_ex_headers(secret))
        assert r.status_code == 401
        r = client.patch(f"/api/executors/{executor['id']}",
                         json={"state": "approved"},
                         headers={"Authorization": "Bearer qa-ui-token"})
        assert r.status_code == 200

    def test_revoked_is_terminal(self, client, auth):
        executor, _ = _make_executor(client, auth, "revoke-c4")
        r = client.patch(f"/api/executors/{executor['id']}",
                         json={"state": "revoked"}, headers=auth)
        assert r.status_code == 200
        # resurrection attempt → 409 (a revoked secret must stay dead)
        r = client.patch(f"/api/executors/{executor['id']}",
                         json={"state": "approved"}, headers=auth)
        assert r.status_code == 409
        # pending is not a patchable target at all → 422
        assert client.patch(f"/api/executors/{executor['id']}",
                            json={"state": "pending"},
                            headers=auth).status_code == 422
        # pending is not a patchable target even from approved
        executor2, _ = _make_executor(client, auth, "pend-c4")
        assert client.patch(f"/api/executors/{executor2['id']}",
                            json={"state": "pending"},
                            headers=auth).status_code == 422

    def test_duplicate_rename_409_and_unknown_404(self, client, auth):
        _make_executor(client, auth, "name1-c5")
        executor2, _ = _make_executor(client, auth, "name2-c5")
        r = client.patch(f"/api/executors/{executor2['id']}",
                         json={"name": "name1-c5"}, headers=auth)
        assert r.status_code == 409
        assert client.patch("/api/executors/ex-nosuch",
                            json={"state": "approved"},
                            headers=auth).status_code == 404

    def test_idempotent_patch_emits_nothing(self, client, auth, app_module):
        executor, _ = _make_executor(client, auth, "idem-c6")
        before = len(app_module.store.events(limit=1000))
        r = client.patch(f"/api/executors/{executor['id']}",
                         json={"state": "approved"}, headers=auth)
        assert r.status_code == 200
        assert len(app_module.store.events(limit=1000)) == before

    def test_delete_keeps_active_assignment_attribution(
            self, client, auth, make_task, app_module):
        task = make_task(title="del-c7")
        r = client.post("/api/assignments", headers=auth,
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead"})
        assert r.status_code == 201
        aid = r.json()["assignment"]["id"]
        executor, _ = _make_executor(client, auth, "del-c7-exec")
        r = client.post(f"/api/assignments/{aid}/claim", headers=auth,
                        json={"claimed_by": "poller",
                              "executor_id": executor["id"]})
        assert r.status_code == 200
        assert r.json()["assignment"]["claimed_by_executor"] == executor["id"]

        r = client.delete(f"/api/executors/{executor['id']}", headers=auth)
        assert r.status_code == 200
        assert client.delete(f"/api/executors/{executor['id']}",
                             headers=auth).status_code == 404
        # the live assignment keeps its attribution verbatim
        item = next(i for i in client.get("/api/assignments").json()["items"]
                    if i["id"] == aid)
        assert item["claimed_by_executor"] == executor["id"]
        assert item["state"] == "claimed"
        assert _board_events(app_module, "executor.deleted")


class TestPresenceSweeper:
    """AC4: transitions only, SSE payload, no row mutation."""

    def test_first_sweep_seeds_baseline_silently(self, client, auth,
                                                 app_module):
        executor, secret = _register(client, auth, "seed-d1")
        client.post(f"/api/executors/{executor['id']}/heartbeat",
                    headers=_ex_headers(secret))
        assert app_module._presence_sweep_once() == []

    def test_offline_transition_emits_and_never_mutates(
            self, client, auth, app_module):
        executor, secret = _register(client, auth, "off-d2")
        client.post(f"/api/executors/{executor['id']}/heartbeat",
                    headers=_ex_headers(secret))
        app_module._presence_sweep_once()          # baseline: online
        _age_last_seen(app_module, executor["id"], 700)   # > 10 min

        queue: asyncio.Queue = asyncio.Queue()
        app_module._subscribers.add(queue)
        try:
            emitted = app_module._presence_sweep_once()
        finally:
            app_module._subscribers.discard(queue)
        assert len(emitted) == 1
        event = emitted[0]
        assert event["kind"] == "executor.offline"
        assert event["prev_state"] == "online"
        assert event["state"] == "offline"
        assert event["last_seen_at"] == event["executor"]["last_seen"]
        assert event["executor"]["id"] == executor["id"]
        # real SSE wiring: the broadcast reached the subscriber queue
        assert queue.get_nowait() == event
        # two-clock discipline: the sweeper READ the clock, never wrote it
        with app_module.store._lock, app_module.store._conn() as db:
            row = db.execute("SELECT last_seen FROM executors WHERE id=?",
                             (executor["id"],)).fetchone()
        assert row["last_seen"] == event["last_seen_at"]
        # idempotent: re-sweep without change emits nothing
        assert app_module._presence_sweep_once() == []

    def test_stale_corridor_is_silent(self, client, auth, app_module):
        executor, secret = _register(client, auth, "stale-d3")
        client.post(f"/api/executors/{executor['id']}/heartbeat",
                    headers=_ex_headers(secret))
        app_module._presence_sweep_once()          # baseline: online
        _age_last_seen(app_module, executor["id"], 300)   # 2–10 min
        assert app_module._presence_sweep_once() == []
        # computed presence still reports the corridor on read
        item = next(e for e in client.get("/api/executors").json()["items"]
                    if e["id"] == executor["id"])
        assert item["presence"] == "stale"

    def test_back_online_transition(self, client, auth, app_module):
        executor, secret = _register(client, auth, "back-d4")
        app_module._presence_sweep_once()          # baseline: offline
        client.post(f"/api/executors/{executor['id']}/heartbeat",
                    headers=_ex_headers(secret))
        emitted = app_module._presence_sweep_once()
        assert [e["kind"] for e in emitted] == ["executor.online"]
        assert emitted[0]["prev_state"] == "offline"
        assert emitted[0]["state"] == "online"

    def test_presence_computed_on_read(self, client, auth, app_module):
        executor, secret = _register(client, auth, "read-d5")
        by_id = {e["id"]: e for e in client.get("/api/executors").json()["items"]}
        assert by_id[executor["id"]]["presence"] == "offline"
        client.post(f"/api/executors/{executor['id']}/heartbeat",
                    headers=_ex_headers(secret))
        by_id = {e["id"]: e for e in client.get("/api/executors").json()["items"]}
        assert by_id[executor["id"]]["presence"] == "online"
        _age_last_seen(app_module, executor["id"], 700)
        by_id = {e["id"]: e for e in client.get("/api/executors").json()["items"]}
        assert by_id[executor["id"]]["presence"] == "offline"


class TestExplicitClaimEnforcement:
    """AC5: spoofing gate on pinned assignments (CWE-290)."""

    def test_pinned_claim_matrix(self, client, auth, make_task):
        task = make_task(title="pin-e1")
        ex, ex_secret = _make_executor(client, auth, "pin-e1-x")
        other, other_secret = _make_executor(client, auth, "pin-e1-y")
        r = client.post("/api/assignments", headers=auth,
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead",
                              "executor_id": ex["id"]})
        assert r.status_code == 201
        aid = r.json()["assignment"]["id"]

        # board (machine) token: state-гейт класс → 409
        r = client.post(f"/api/assignments/{aid}/claim", headers=auth,
                        json={"claimed_by": "poller"})
        assert r.status_code == 409
        # another executor's token → 403
        r = client.post(f"/api/assignments/{aid}/claim",
                        headers=_ex_headers(other_secret),
                        json={"claimed_by": "poller-y"})
        assert r.status_code == 403
        # the pinned executor's own token → 200, token identity recorded
        r = client.post(f"/api/assignments/{aid}/claim",
                        headers=_ex_headers(ex_secret),
                        json={"claimed_by": "poller-x"})
        assert r.status_code == 200, r.text
        assert r.json()["assignment"]["claimed_by_executor"] == ex["id"]
        assert other["id"] != ex["id"]

    def test_declared_executor_id_must_match_token(self, client, auth,
                                                   make_task):
        task = make_task(title="decl-e2")
        ex, ex_secret = _make_executor(client, auth, "decl-e2-x")
        other, _ = _make_executor(client, auth, "decl-e2-y")
        r = client.post("/api/assignments", headers=auth,
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead"})
        aid = r.json()["assignment"]["id"]
        r = client.post(f"/api/assignments/{aid}/claim",
                        headers=_ex_headers(ex_secret),
                        json={"claimed_by": "poller",
                              "executor_id": other["id"]})
        assert r.status_code == 403

    def test_unpinned_claim_keeps_f1_semantics(self, client, auth,
                                               make_task):
        task = make_task(title="unpin-e3")
        r = client.post("/api/assignments", headers=auth,
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead"})
        aid = r.json()["assignment"]["id"]
        # board token + declared executor_id (Ф1 behavior, verbatim)
        r = client.post(f"/api/assignments/{aid}/claim", headers=auth,
                        json={"claimed_by": "poller",
                              "executor_id": "exec-declared"})
        assert r.status_code == 200
        assert r.json()["assignment"]["claimed_by_executor"] == "exec-declared"

    def test_executor_token_claim_unpinned(self, client, auth, make_task):
        task = make_task(title="unpin-e4")
        ex, ex_secret = _make_executor(client, auth, "unpin-e4-x")
        r = client.post("/api/assignments", headers=auth,
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead"})
        aid = r.json()["assignment"]["id"]
        r = client.post(f"/api/assignments/{aid}/claim",
                        headers=_ex_headers(ex_secret),
                        json={"claimed_by": "poller"})
        assert r.status_code == 200
        assert r.json()["assignment"]["claimed_by_executor"] == ex["id"]

    def test_pending_executor_token_cannot_claim(self, client, auth,
                                                 make_task):
        task = make_task(title="pend-e5")
        _, secret = _register(client, auth, "pend-e5-x")   # stays pending
        r = client.post("/api/assignments", headers=auth,
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead"})
        aid = r.json()["assignment"]["id"]
        r = client.post(f"/api/assignments/{aid}/claim",
                        headers=_ex_headers(secret),
                        json={"claimed_by": "poller"})
        assert r.status_code == 403

    def test_assignment_heartbeat_piggybacks_presence(
            self, client, auth, make_task, app_module):
        task = make_task(title="piggy-e6")
        ex, ex_secret = _make_executor(client, auth, "piggy-e6-x")
        r = client.post("/api/assignments", headers=auth,
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead"})
        aid = r.json()["assignment"]["id"]
        claim = client.post(f"/api/assignments/{aid}/claim",
                            headers=_ex_headers(ex_secret),
                            json={"claimed_by": "poller"}).json()
        start = client.post(f"/api/assignments/{aid}/start",
                            headers=_ex_headers(ex_secret),
                            json={"claim_token": claim["claim_token"]})
        assert start.status_code == 200, start.text
        _age_last_seen(app_module, ex["id"], 700)
        r = client.post(f"/api/assignments/{aid}/heartbeat",
                        headers=_ex_headers(ex_secret),
                        json={"claim_token": claim["claim_token"]})
        assert r.status_code == 200, r.text
        item = next(e for e in client.get("/api/executors").json()["items"]
                    if e["id"] == ex["id"])
        assert item["presence"] == "online"   # ticked by the assignment hb

    def test_poll_get_with_executor_id_ticks_presence(
            self, client, auth, make_task, app_module):
        task = make_task(title="poll-e7")
        ex, ex_secret = _make_executor(client, auth, "poll-e7-x")
        client.post("/api/assignments", headers=auth,
                    json={"task_id": task["id"],
                          "specialist": "gcw-tech-lead"})
        _age_last_seen(app_module, ex["id"], 700)
        # unauthenticated poll: legal read, NO presence tick
        client.get("/api/assignments",
                   params={"executor_id": ex["id"]})
        item = next(e for e in client.get("/api/executors").json()["items"]
                    if e["id"] == ex["id"])
        assert item["presence"] == "offline"
        # own-token poll: ticks
        client.get("/api/assignments", params={"executor_id": ex["id"]},
                   headers=_ex_headers(ex_secret))
        item = next(e for e in client.get("/api/executors").json()["items"]
                    if e["id"] == ex["id"])
        assert item["presence"] == "online"


class TestRoutingChain:
    """AC6: resolution tiers computed per GET, stored nowhere."""

    def test_explicit_pin_tier(self, client, auth, make_task):
        task = make_task(title="rt-f1")
        ex, _ = _make_executor(client, auth, "rt-f1-x")
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "gcw-tech-lead",
            "executor_id": ex["id"]}).json()["assignment"]["id"]
        assert _assignment_routing(client, aid) == {
            "resolved": ex["id"], "reason": "explicit"}

    def test_specialist_tier_prefers_online_candidate(self, client, auth,
                                                      make_task):
        task = make_task(title="rt-f2", specialists=["spec-f2"])
        on, _ = _make_executor(client, auth, "rt-f2-on",
                               caps=["spec-f2"], online=True)
        off, _ = _make_executor(client, auth, "rt-f2-off", caps=["spec-f2"])
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "spec-f2"}
            ).json()["assignment"]["id"]
        routing = _assignment_routing(client, aid)
        assert routing == {"resolved": on["id"], "reason": "specialist"}
        assert routing["resolved"] != off["id"]

    def test_task_specialists_tier(self, client, auth, make_task):
        task = make_task(title="rt-f3", specialists=["spec-f3-task"])
        ex, _ = _make_executor(client, auth, "rt-f3-x",
                               caps=["spec-f3-task"])
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "spec-f3-assign"}
            ).json()["assignment"]["id"]
        assert _assignment_routing(client, aid) == {
            "resolved": ex["id"], "reason": "task-specialists"}

    def test_routing_considers_approved_enabled_only(
            self, client, auth, make_task):
        task = make_task(title="rt-f4", specialists=["spec-f4"])
        pending, _ = _register(client, auth, "rt-f4-pend")
        client.patch(f"/api/executors/{pending['id']}",
                     json={"capabilities": ["spec-f4"]}, headers=auth)
        revoked, _ = _make_executor(client, auth, "rt-f4-rev",
                                    caps=["spec-f4"])
        client.patch(f"/api/executors/{revoked['id']}",
                     json={"state": "revoked"}, headers=auth)
        disabled, _ = _make_executor(client, auth, "rt-f4-dis",
                                     caps=["spec-f4"], online=True)
        client.patch(f"/api/executors/{disabled['id']}",
                     json={"enabled": False}, headers=auth)
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "spec-f4"}
            ).json()["assignment"]["id"]
        assert _assignment_routing(client, aid)["resolved"] is None

    def test_project_default_tier(self, client, auth, make_task):
        task = make_task(title="rt-f5", project="proj-f5",
                         specialists=["spec-f5"])
        ex, _ = _make_executor(client, auth, "rt-f5-x", online=True)
        r = client.put("/api/settings/execution", headers=auth, json={
            "default_executor": ex["id"], "scope": "project:proj-f5"})
        assert r.status_code == 200, r.text
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "spec-f5"}
            ).json()["assignment"]["id"]
        assert _assignment_routing(client, aid) == {
            "resolved": ex["id"], "reason": "project-default"}

    def test_global_default_tier_and_revoked_fallthrough(
            self, client, auth, make_task):
        task = make_task(title="rt-f6", project="proj-f6",
                         specialists=["spec-f6"])
        revoked, _ = _make_executor(client, auth, "rt-f6-rev", online=True)
        client.patch(f"/api/executors/{revoked['id']}",
                     json={"state": "revoked"}, headers=auth)
        client.put("/api/settings/execution", headers=auth, json={
            "default_executor": revoked["id"], "scope": "project:proj-f6"})
        glob, _ = _make_executor(client, auth, "rt-f6-glob", online=True)
        client.put("/api/settings/execution", headers=auth, json={
            "default_executor": glob["id"]})
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "spec-f6"}
            ).json()["assignment"]["id"]
        # revoked project default falls through to the global tier
        assert _assignment_routing(client, aid) == {
            "resolved": glob["id"], "reason": "global-default"}

    def test_auto_tier_live_local_worker(self, client, auth, make_task):
        """Auto = generic live-worker fallback (caps-free): the nomination
        tiers above are presence-agnostic, so a caps-gated auto tier would
        be structurally unreachable — see the _routing_annotation design
        note. Eligibility: approved+enabled+online+local-poll."""
        task = make_task(title="rt-f7", specialists=["spec-f7"])
        # a competent-but-OFFLINE executor is still the nomination route
        # (no silent substitution) — auto never overrides it
        off, _ = _make_executor(client, auth, "rt-f7-off", caps=["spec-f7"])
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "spec-f7"}
            ).json()["assignment"]["id"]
        assert _assignment_routing(client, aid) == {
            "resolved": off["id"], "reason": "specialist"}

        # no caps anywhere: only a remote (mesh-r4) live worker → auto
        # cannot point at it (remote ineligible until R4) → unmatched
        task2 = make_task(title="rt-f7b", specialists=["spec-f7b"])
        _make_executor(client, auth, "rt-f7-mesh", online=True,
                       transport="mesh-r4")
        aid2 = client.post("/api/assignments", headers=auth, json={
            "task_id": task2["id"], "specialist": "spec-f7b"}
            ).json()["assignment"]["id"]
        assert _assignment_routing(client, aid2) == {
            "resolved": None, "reason": "unmatched"}
        # an offline local worker without caps does not qualify either
        _make_executor(client, auth, "rt-f7-dead")
        assert _assignment_routing(client, aid2) == {
            "resolved": None, "reason": "unmatched"}
        # a live local worker (no caps — the laptop-poller bootstrap
        # shape) resolves the auto tier; deterministic min-id pick
        on1, _ = _make_executor(client, auth, "rt-f7-on1", online=True)
        on2, _ = _make_executor(client, auth, "rt-f7-on2", online=True)
        routing = _assignment_routing(client, aid2)
        assert routing == {"resolved": min(on1["id"], on2["id"]),
                           "reason": "auto"}

    def test_unmatched_and_no_storage(self, client, auth, make_task,
                                      app_module):
        task = make_task(title="rt-f8", specialists=["spec-f8"])
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "spec-f8"}
            ).json()["assignment"]["id"]
        assert _assignment_routing(client, aid) == {
            "resolved": None, "reason": "unmatched"}
        # computed per GET, never stored: the raw row has no routing key
        with app_module.store._lock, app_module.store._conn() as db:
            row = db.execute(
                "SELECT * FROM task_assignments WHERE id=?",
                (aid,)).fetchone()
        assert "routing" not in dict(row)


class TestExecutionSettings:
    """AC6+AC7: default/fallback gates + default.changed audit."""

    def test_put_requires_ui_token(self, client, auth, app_module,
                                    monkeypatch):
        monkeypatch.setattr(app_module, "UI_WRITE_TOKEN", "qa-ui-token")
        assert client.put("/api/settings/execution", headers=auth,
                          json={"default_executor": "ex-x"}
                          ).status_code == 401
        assert client.put(
            "/api/settings/execution",
            headers={"Authorization": "Bearer qa-ui-token"},
            json={"default_executor": ""}).status_code == 200

    def test_put_gates(self, client, auth):
        unknown = client.put("/api/settings/execution", headers=auth,
                             json={"default_executor": "ex-nosuch"})
        assert unknown.status_code == 422
        pending, _ = _register(client, auth, "set-g2-pend")
        assert client.put("/api/settings/execution", headers=auth, json={
            "default_executor": pending["id"]}).status_code == 422
        disabled, _ = _make_executor(client, auth, "set-g2-dis", online=True)
        client.patch(f"/api/executors/{disabled['id']}",
                     json={"enabled": False}, headers=auth)
        assert client.put("/api/settings/execution", headers=auth, json={
            "default_executor": disabled["id"]}).status_code == 422
        offline, _ = _make_executor(client, auth, "set-g2-off")
        assert client.put("/api/settings/execution", headers=auth, json={
            "default_executor": offline["id"]}).status_code == 422
        remote, _ = _make_executor(client, auth, "set-g2-remote",
                                   online=True, transport="mesh-r4")
        assert client.put("/api/settings/execution", headers=auth, json={
            "default_executor": remote["id"]}).status_code == 422

    def test_put_audit_old_to_new(self, client, auth, app_module):
        ex, _ = _make_executor(client, auth, "set-g3", online=True)
        r = client.put("/api/settings/execution", headers=auth,
                       json={"default_executor": ex["id"],
                             "fallback_executor": ex["id"]})
        assert r.status_code == 200, r.text
        got = client.get("/api/settings/execution").json()
        assert got["default_executor"] == ex["id"]
        assert got["fallback_executor"] == ex["id"]
        ev = _board_events(app_module, "default.changed")
        assert ev[-1]["payload"]["changes"]["default_executor"] == [
            "", ex["id"]]
        assert ev[-1]["payload"]["changes"]["fallback_executor"] == [
            "", ex["id"]]
        # idempotent PUT (full replace — omitted slots would clear): no
        # second audit event
        n = len(_board_events(app_module, "default.changed"))
        client.put("/api/settings/execution", headers=auth,
                   json={"default_executor": ex["id"],
                         "fallback_executor": ex["id"]})
        assert len(_board_events(app_module, "default.changed")) == n

    def test_project_scope_reserved_in_board_meta(
            self, client, auth, app_module):
        ex, _ = _make_executor(client, auth, "set-g4", online=True)
        r = client.put("/api/settings/execution", headers=auth, json={
            "default_executor": ex["id"], "scope": "project:proj-g4"})
        assert r.status_code == 200, r.text
        assert app_module.store.get_meta(
            "default_executor:project:proj-g4") == ex["id"]
        assert (app_module.store.get_meta("default_executor") or "") == ""
        # garbage scope and project-scoped fallback are refused
        assert client.put("/api/settings/execution", headers=auth, json={
            "default_executor": ex["id"], "scope": "team:foo"}
            ).status_code == 422
        assert client.put("/api/settings/execution", headers=auth, json={
            "default_executor": ex["id"], "fallback_executor": ex["id"],
            "scope": "project:proj-g4"}).status_code == 422


class TestTopics:
    """AC8: denormalized project/domain tags (metadata tier)."""

    def test_topics_from_mnemos_tags_plus_project(
            self, client, auth, make_task):
        task = make_task(title="top-h1", project="beta",
                         mnemos_tags=["project:alpha", "domain:d1",
                                      "noise-tag"])
        r = client.post("/api/assignments", headers=auth,
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead"})
        a = r.json()["assignment"]
        assert a["topics"] == ["project:beta", "project:alpha", "domain:d1"]

    def test_no_duplicate_project_topic(self, client, auth, make_task):
        task = make_task(title="top-h2", project="gamma",
                         mnemos_tags=["project:gamma", "domain:d2"])
        r = client.post("/api/assignments", headers=auth,
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead"})
        assert r.json()["assignment"]["topics"] == [
            "project:gamma", "domain:d2"]

    def test_topics_in_listing(self, client, auth, make_task):
        task = make_task(title="top-h3", mnemos_tags=["domain:d3"])
        aid = client.post("/api/assignments", headers=auth,
                          json={"task_id": task["id"],
                                "specialist": "gcw-tech-lead"}
                          ).json()["assignment"]["id"]
        item = next(i for i in client.get("/api/assignments").json()["items"]
                    if i["id"] == aid)
        assert item["topics"] == ["domain:d3"]


class TestP3Fixes:
    """AC9: PR #13 review tails."""

    def test_partial_unique_index_structural(self, client, auth, make_task,
                                             app_module):
        task = make_task(title="p3a-i1")
        r = client.post("/api/assignments", headers=auth,
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead"})
        assert r.status_code == 201
        # API-level guard: second active assignment → 409
        r = client.post("/api/assignments", headers=auth,
                        json={"task_id": task["id"],
                              "specialist": "gcw-tech-lead"})
        assert r.status_code == 409
        # structural backstop: even a direct row insert bounces off the
        # partial unique index
        with pytest.raises(sqlite3.IntegrityError):
            with app_module.store._lock, app_module.store._conn() as db:
                db.execute(
                    "INSERT INTO task_assignments "
                    "(task_id, specialist, harness, state, created_by, "
                    " spec_snapshot, spec_hash, created_at) "
                    "VALUES (?,?,?,'queued','sneak','','',?)",
                    (task["id"], "x", "zcode", "2026-01-01T00:00:00+00:00"))

    def test_assignment_heartbeat_own_budget(self, client, auth, make_task,
                                             app_module):
        task = make_task(title="p3b-i2")
        task2 = make_task(title="p3b-i2b")
        ex, ex_secret = _make_executor(client, auth, "p3b-i2-x")
        claim = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "gcw-tech-lead",
            }).json()["assignment"]
        aid = claim["id"]
        aid2 = client.post("/api/assignments", headers=auth, json={
            "task_id": task2["id"], "specialist": "gcw-tech-lead"}
            ).json()["assignment"]["id"]
        claimed = client.post(f"/api/assignments/{aid}/claim",
                              headers=_ex_headers(ex_secret),
                              json={"claimed_by": "poller"}).json()
        client.post(f"/api/assignments/{aid}/start",
                    headers=_ex_headers(ex_secret),
                    json={"claim_token": claimed["claim_token"]})
        # saturate the SHARED machine budget (30/60s) for THIS client —
        # the routes key the limiter by request.client.host
        client_ip = "testclient"
        for _ in range(app_module._ASSIGNMENT_RATE_LIMIT):
            app_module._assignment_limiter.acquire(client_ip)
        assert not app_module._assignment_limiter.acquire(client_ip)
        # the assignment heartbeat still ticks on its own budget
        r = client.post(f"/api/assignments/{aid}/heartbeat",
                        headers=_ex_headers(ex_secret),
                        json={"claim_token": claimed["claim_token"]})
        assert r.status_code == 200, r.text
        # while a machine-budget action (claim) is now rate-limited
        r = client.post(f"/api/assignments/{aid2}/claim", headers=auth,
                        json={"claimed_by": "poller"})
        assert r.status_code == 429

    def test_claim_after_archive_422(self, client, auth, make_task):
        task = make_task(title="p3c-i3")
        aid = client.post("/api/assignments", headers=auth,
                          json={"task_id": task["id"],
                                "specialist": "gcw-tech-lead"}
                          ).json()["assignment"]["id"]
        r = client.post(f"/api/tasks/{task['id']}/archive", headers=auth)
        assert r.status_code == 200, r.text
        r = client.post(f"/api/assignments/{aid}/claim", headers=auth,
                        json={"claimed_by": "poller"})
        assert r.status_code == 422


class TestIdentityMismatch:
    """AC7: report agent-string vs token-backed executor (spoof signal)."""

    def test_mismatch_flagged_in_audit(self, client, auth, make_task,
                                       app_module):
        task = make_task(title="idm-j1")
        ex, ex_secret = _make_executor(client, auth, "idm-j1-x")
        r = client.post(f"/api/tasks/{task['id']}/reports",
                        headers=_ex_headers(ex_secret),
                        json={"kind": "intermediate", "body": "progress",
                              "agent": "someone-entirely-else"})
        assert r.status_code == 201, r.text
        ev = [e for e in app_module.store.events(limit=1000)
              if e["kind"] == "task.report"
              and e["task_id"] == task["id"]][-1]
        assert ev["payload"]["identity_mismatch"] is True

    def test_consistent_agent_not_flagged(self, client, auth, make_task,
                                          app_module):
        task = make_task(title="idm-j2")
        ex, ex_secret = _make_executor(client, auth, "idm-j2-x")
        for agent in ("idm-j2-x", "zcode-session-7"):   # name / harness
            r = client.post(f"/api/tasks/{task['id']}/reports",
                            headers=_ex_headers(ex_secret),
                            json={"kind": "intermediate", "body": "progress",
                                  "agent": agent})
            assert r.status_code == 201
        evs = [e for e in app_module.store.events(limit=1000)
               if e["kind"] == "task.report" and e["task_id"] == task["id"]]
        assert len(evs) == 2
        assert all("identity_mismatch" not in e["payload"] for e in evs)

    def test_board_token_reports_never_flagged(self, client, auth, make_task,
                                               app_module):
        task = make_task(title="idm-j3")
        r = client.post(f"/api/tasks/{task['id']}/reports", headers=auth,
                        json={"kind": "intermediate", "body": "progress",
                              "agent": "whoever"})
        assert r.status_code == 201
        ev = [e for e in app_module.store.events(limit=1000)
              if e["kind"] == "task.report"
              and e["task_id"] == task["id"]][-1]
        assert "identity_mismatch" not in ev["payload"]


class TestSecurityReviewPR18:
    """PR #18 security-review fixes: F1 (fail identity gates, blocker),
    F3 (token-boundary identity_mismatch + final report), F5 (pending
    quota + notification spam guard), F6b (transport on assignment
    audit events)."""

    # ------------------------------------------------------------- F1
    def test_f1_foreign_executor_cannot_fail_by_declared_name(
            self, client, auth, make_task):
        """BLOCKER regression: claimed_by is self-asserted and openly
        readable — an approved executor must not fail a foreign claimed
        assignment by declaring the victim's name (no claim_token, wrong
        token identity → 403)."""
        task = make_task(title="f1-k1")
        victim, victim_secret = _make_executor(client, auth, "f1-k1-victim")
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "gcw-tech-lead"}
            ).json()["assignment"]["id"]
        claimed = client.post(
            f"/api/assignments/{aid}/claim", headers=_ex_headers(victim_secret),
            json={"claimed_by": "victim-poller"}).json()
        assert claimed["assignment"]["claimed_by"] == "victim-poller"

        attacker, attacker_secret = _make_executor(client, auth, "f1-k1-attacker")
        r = client.post(f"/api/assignments/{aid}/fail",
                        headers=_ex_headers(attacker_secret),
                        json={"reason": "hostile",
                              "claimed_by": "victim-poller"})
        assert r.status_code == 403, r.text
        # the assignment is intact
        item = next(i for i in client.get("/api/assignments").json()["items"]
                    if i["id"] == aid)
        assert item["state"] == "claimed"
        assert victim["id"] != attacker["id"]

    def test_f1_board_class_claimed_by_recovery_still_works(
            self, client, auth, make_task):
        """Recovery leg: the board-token poller sweep fails its own
        claimed records by claimed_by match after a restart (claim_token
        gone) — board-class trust keeps the string fallback."""
        task = make_task(title="f1-k2")
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "gcw-tech-lead"}
            ).json()["assignment"]["id"]
        client.post(f"/api/assignments/{aid}/claim", headers=auth,
                    json={"claimed_by": "laptop-poller"})
        r = client.post(f"/api/assignments/{aid}/fail", headers=auth,
                        json={"reason": "recovery sweep: no live process",
                              "claimed_by": "laptop-poller"})
        assert r.status_code == 200, r.text
        assert r.json()["assignment"]["state"] == "failed"

    def test_f1_own_executor_token_recovery_leg(
            self, client, auth, make_task):
        """Mesh-leg recovery: the claiming executor lost its claim_token
        but still holds its secret — token identity == claimed_by_executor
        authorizes the fail."""
        task = make_task(title="f1-k3")
        ex, ex_secret = _make_executor(client, auth, "f1-k3-x")
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "gcw-tech-lead"}
            ).json()["assignment"]["id"]
        client.post(f"/api/assignments/{aid}/claim",
                    headers=_ex_headers(ex_secret),
                    json={"claimed_by": "mesh-poller"})
        r = client.post(f"/api/assignments/{aid}/fail",
                        headers=_ex_headers(ex_secret),
                        json={"reason": "executor restart, token lost"})
        assert r.status_code == 200, r.text
        assert r.json()["assignment"]["state"] == "failed"

    def test_f1_correct_claim_token_still_fails(
            self, client, auth, make_task):
        """(a) survives: a matching claim_token fails regardless of class."""
        task = make_task(title="f1-k4")
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "gcw-tech-lead"}
            ).json()["assignment"]["id"]
        claimed = client.post(f"/api/assignments/{aid}/claim", headers=auth,
                              json={"claimed_by": "p"}).json()
        r = client.post(f"/api/assignments/{aid}/fail", headers=auth,
                        json={"reason": "boom",
                              "claim_token": claimed["claim_token"]})
        assert r.status_code == 200, r.text

    # ------------------------------------------------------------- F3
    def test_f3_token_boundary_and_casefold(self, client, auth, make_task,
                                            app_module):
        task = make_task(title="f3-k1")
        # harness 'pi': substring 'pi' inside 'copilot' must NOT count
        ex, ex_secret = _register(client, auth, "f3-k1-x", harness="pi")
        _approve(client, auth, ex["id"])
        r = client.post(f"/api/tasks/{task['id']}/reports",
                        headers=_ex_headers(ex_secret),
                        json={"kind": "intermediate", "body": "b",
                              "agent": "copilot"})
        assert r.status_code == 201
        ev = [e for e in app_module.store.events(limit=1000)
              if e["kind"] == "task.report"
              and e["task_id"] == task["id"]][-1]
        assert ev["payload"]["identity_mismatch"] is True
        # casefold: the executor name in any case covers the declaration
        task2 = make_task(title="f3-k1b")
        r = client.post(f"/api/tasks/{task2['id']}/reports",
                        headers=_ex_headers(ex_secret),
                        json={"kind": "intermediate", "body": "b",
                              "agent": "F3-K1-X session"})
        assert r.status_code == 201
        ev = [e for e in app_module.store.events(limit=1000)
              if e["kind"] == "task.report"
              and e["task_id"] == task2["id"]][-1]
        assert "identity_mismatch" not in ev["payload"]

    def test_f3_final_report_in_complete_checked(self, client, auth,
                                                 make_task, app_module):
        task = make_task(title="f3-k2")
        ex, ex_secret = _make_executor(client, auth, "f3-k2-x")
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "gcw-tech-lead"}
            ).json()["assignment"]["id"]
        claimed = client.post(f"/api/assignments/{aid}/claim",
                              headers=_ex_headers(ex_secret),
                              json={"claimed_by": "not-the-executor-name"}
                              ).json()
        client.post(f"/api/assignments/{aid}/start",
                    headers=_ex_headers(ex_secret),
                    json={"claim_token": claimed["claim_token"]})
        r = client.post(f"/api/assignments/{aid}/complete",
                        headers=_ex_headers(ex_secret),
                        json={"claim_token": claimed["claim_token"],
                              "final_report": "done"})
        assert r.status_code == 200, r.text
        ev = [e for e in app_module.store.events(limit=1000)
              if e["kind"] == "task.report"
              and e["task_id"] == task["id"]][-1]
        assert ev["payload"]["kind"] == "final"
        assert ev["payload"]["identity_mismatch"] is True

    def test_f3_final_report_consistent_not_flagged(self, client, auth,
                                                    make_task, app_module):
        task = make_task(title="f3-k3")
        ex, ex_secret = _make_executor(client, auth, "f3-k3-x")
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "gcw-tech-lead"}
            ).json()["assignment"]["id"]
        claimed = client.post(f"/api/assignments/{aid}/claim",
                              headers=_ex_headers(ex_secret),
                              json={"claimed_by": "f3-k3-x"}).json()
        client.post(f"/api/assignments/{aid}/start",
                    headers=_ex_headers(ex_secret),
                    json={"claim_token": claimed["claim_token"]})
        r = client.post(f"/api/assignments/{aid}/complete",
                        headers=_ex_headers(ex_secret),
                        json={"claim_token": claimed["claim_token"],
                              "final_report": "done"})
        assert r.status_code == 200
        ev = [e for e in app_module.store.events(limit=1000)
              if e["kind"] == "task.report"
              and e["task_id"] == task["id"]][-1]
        assert "identity_mismatch" not in ev["payload"]

    # ------------------------------------------------------------- F5
    def test_f5_pending_cap(self, client, auth, app_module, monkeypatch):
        from server.store import EXECUTOR_PENDING_CAP
        # pace limiter must not shadow the quota in this test
        monkeypatch.setattr(
            app_module, "_executor_register_limiter",
            RateLimiter(limit=1000, window=60.0))
        made = []
        for i in range(EXECUTOR_PENDING_CAP):
            r = client.post("/api/executors", headers=auth,
                            json={"name": f"f5-cap-{i}", "harness": "zcode"})
            assert r.status_code == 201, r.text
            made.append(r.json()["executor"]["id"])
        r = client.post("/api/executors", headers=auth,
                        json={"name": "f5-cap-over", "harness": "zcode"})
        assert r.status_code == 429
        assert "capped" in r.json()["detail"]
        # approving one frees quota
        _approve(client, auth, made[0])
        r = client.post("/api/executors", headers=auth,
                        json={"name": "f5-cap-free", "harness": "zcode"})
        assert r.status_code == 201, r.text

    def test_f5_notification_first_pending_per_host(self, client, auth):
        def _register_with_host(name: str, host: str):
            r = client.post("/api/executors", headers=auth,
                            json={"name": name, "harness": "zcode",
                                  "host": host})
            assert r.status_code == 201, r.text
            return r.json()["executor"]

        # notifications persist across the session client — count only
        # the ones this test mints
        before = client.get("/api/notifications", params={"limit": 1}
                            ).json()["items"]
        after_id = before[0]["id"] if before else 0
        _register_with_host("f5-n1", "host-a")
        _register_with_host("f5-n2", "host-a")
        _register_with_host("f5-n3", "host-a")
        _register_with_host("f5-n4", "host-b")
        notes = client.get("/api/notifications",
                           params={"after_id": after_id, "limit": 100}
                           ).json()["items"]
        registered = [n for n in notes
                      if "зарегистрирован" in n["title"]]
        names = {n["title"].split()[1] for n in registered}
        # one notification per host (first pending only), audit always
        assert names == {"f5-n1", "f5-n4"}, names

    # ------------------------------------------------------------ F6b
    def test_f6b_transport_in_assignment_audit(self, client, auth, make_task,
                                               app_module):
        task = make_task(title="f6b-m1")
        ex, ex_secret = _make_executor(client, auth, "f6b-m1-x",
                                       transport="mesh-r4")
        aid = client.post("/api/assignments", headers=auth, json={
            "task_id": task["id"], "specialist": "gcw-tech-lead"}
            ).json()["assignment"]["id"]
        claimed = client.post(f"/api/assignments/{aid}/claim",
                              headers=_ex_headers(ex_secret),
                              json={"claimed_by": "mesh-poller"}).json()
        ev = [e for e in app_module.store.events(limit=1000)
              if e["kind"] == "assignment.claimed"
              and e["payload"]["assignment_id"] == aid][-1]
        assert ev["payload"]["executor_id"] == ex["id"]
        assert ev["payload"]["transport"] == "mesh-r4"   # Amd 2 §7
        client.post(f"/api/assignments/{aid}/start",
                    headers=_ex_headers(ex_secret),
                    json={"claim_token": claimed["claim_token"]})
        client.post(f"/api/assignments/{aid}/fail",
                    headers=_ex_headers(ex_secret),
                    json={"reason": "done", "claim_token":
                          claimed["claim_token"]})
        ev = [e for e in app_module.store.events(limit=1000)
              if e["kind"] == "assignment.failed"
              and e["payload"]["assignment_id"] == aid][-1]
        assert ev["payload"]["executor_id"] == ex["id"]
        assert ev["payload"]["transport"] == "mesh-r4"
