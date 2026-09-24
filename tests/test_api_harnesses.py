"""Harness dictionary — the owner-managed nomination registry (wave 3C,
design 2026-09-22 §C).

QA matrix (each test names its line):
- seed: a fresh Store boots with EXACTLY the 10 KNOWN_HARNESSES rows
  (added_via='seed'), alphabetical; re-boot is idempotent (no duplicates);
  a DELETED seed row stays deleted across restarts (seed fills an EMPTY
  table only);
- open read: GET /api/harnesses needs no bearer and carries
  meta.seed_min_count = 10;
- create leg (ui): 201 row added_via='owner'; 409 duplicate; 422 bad name
  (uppercase/space/leading dot/over-long); 422 dictionary cap (≤64, entry
  validation — the count returns to normal after deletions); 401/503 guard
  classes (machine token refused in split mode, fail-closed without any);
- delete leg (ui): 200 + row gone; 404 unknown; 409 while LIVE anywhere —
  a registered executor, a queued assignment, a schedule, a hook condition
  ({field:'harness', op:'eq', value:name}); terminal history (done
  assignment) does NOT block; 200 idempotence is NOT promised (second
  delete → 404);
- the SIXTH gate really reads the TABLE: after adding a custom harness —
  registration passes, enrollment harness_hint passes, assignment create
  passes, schedule create passes, the rule condition meta-dictionary lists
  it; after deleting it, all five refuse;
- SSE: harness.added / harness.removed frames on the dictionary mutations
  (additive ui-contract §11);
- audit: harness.added / harness.removed land in the board events with no
  secret material (there is none — the payload is the name).
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from conftest import BOARD_TOKEN, DATA_DIR
from server.security import RateLimiter
from server.store import Store

DB_PATH = DATA_DIR / "board.db"

CUSTOM = "myagent"


# ----------------------------------------------------------------- fixtures
@pytest.fixture(autouse=True)
def fresh_harness_state(app_module, monkeypatch):
    """Per-test isolation: fresh harness limiter (module globals accumulate
    across the session-scoped client) and a RESEEDED dictionary (wiped then
    refilled from the seed — sibling tests may have added/deleted rows)."""
    for name in ("_harness_write_limiter", "_automation_limiter"):
        limiter = getattr(app_module, name)
        monkeypatch.setattr(
            app_module, name,
            RateLimiter(limit=limiter.limit, window=limiter.window))
    with app_module.store._lock, app_module.store._conn() as db:
        db.execute("DELETE FROM harnesses")
        db.execute("DELETE FROM executors")
        db.execute("DELETE FROM schedules")
        db.execute("DELETE FROM hooks")
    with _db() as db:  # committed reseed (the seed fills an empty table)
        app_module.store._seed_harnesses(db)
    yield
    with app_module.store._lock, app_module.store._conn() as db:
        db.execute("DELETE FROM harnesses")
        db.execute("DELETE FROM executors")
        db.execute("DELETE FROM schedules")
        db.execute("DELETE FROM hooks")
    with _db() as db:
        app_module.store._seed_harnesses(db)


# ------------------------------------------------------------------ helpers
def _db() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def _names() -> list[str]:
    with _db() as db:
        rows = db.execute("SELECT name FROM harnesses ORDER BY name").fetchall()
    return [r["name"] for r in rows]


def _add(client, ui_auth, name=CUSTOM, **extra):
    return client.post("/api/harnesses", json={"name": name} | extra,
                       headers=ui_auth)


def _delete(client, ui_auth, name=CUSTOM):
    return client.delete(f"/api/harnesses/{name}", headers=ui_auth)


# --------------------------------------------------------------------- seed
class TestSeed:
    def test_seed_exactly_the_ten_constants(self, app_module):
        rows = app_module.store.list_harnesses()
        assert [r["name"] for r in rows] == sorted(app_module.store.KNOWN_HARNESSES)
        assert len(rows) == 10
        assert all(r["added_via"] == "seed" for r in rows)
        assert all(r["note"] == "" for r in rows)

    def test_reboot_idempotent_and_deletions_stick(self, tmp_path):
        """A second boot on a NON-empty table must not duplicate or
        resurrect: owner deletions survive restarts."""
        path = tmp_path / "board.db"
        store = Store(path)
        store.add_harness(CUSTOM)
        store.delete_harness("windsurf")
        Store(path)  # re-boot on the same file
        with sqlite3.connect(path) as db:
            db.row_factory = sqlite3.Row
            names = [r["name"] for r in
                     db.execute("SELECT name FROM harnesses").fetchall()]
        assert names.count(CUSTOM) == 1
        assert "windsurf" not in names
        assert len(names) == 10

    def test_open_read_no_bearer(self, client):
        r = client.get("/api/harnesses")
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True
        assert body["count"] == 10
        assert body["meta"] == {"seed_min_count": 10}
        assert {i["name"] for i in body["items"]} >= {"zcode", "claude-code"}


# ------------------------------------------------------------------- create
class TestCreate:
    def test_add_owner_row_201(self, client, ui_auth):
        r = _add(client, ui_auth, note="custom executor on vps")
        assert r.status_code == 201, r.text
        row = r.json()["harness"]
        assert row["name"] == CUSTOM
        assert row["added_via"] == "owner"
        assert row["note"] == "custom executor on vps"
        assert row["added_at"]
        assert CUSTOM in _names()

    def test_duplicate_409(self, client, ui_auth):
        assert _add(client, ui_auth).status_code == 201
        r = _add(client, ui_auth)
        assert r.status_code == 409
        assert CUSTOM in r.json()["detail"]

    def test_seed_name_duplicate_409(self, client, ui_auth):
        r = _add(client, ui_auth, name="zcode")
        assert r.status_code == 409

    @pytest.mark.parametrize("bad", [
        "Bad", "has space", ".leading-dot", "-leading-dash", "x" * 61, "",
    ])
    def test_invalid_name_422(self, client, ui_auth, bad):
        assert _add(client, ui_auth, name=bad).status_code == 422

    @pytest.mark.parametrize("good", ["a1", "agent.v2", "my-agent_2", "x" * 60])
    def test_valid_name_shapes(self, client, ui_auth, good):
        assert _add(client, ui_auth, name=good).status_code == 201

    def test_dictionary_cap_422(self, client, ui_auth, app_module,
                                monkeypatch):
        # the bulk-fill loop outpaces the 10/60s dictionary limiter — a
        # fresh one makes the quota test about the QUOTA, not the pace
        monkeypatch.setattr(
            app_module, "_harness_write_limiter",
            RateLimiter(limit=1000, window=60.0))
        # 10 seeds + adds up to the ceiling of 64 → the 55th add must 422.
        for i in range(54):
            assert _add(client, ui_auth, name=f"h-{i:02d}").status_code == 201
        r = _add(client, ui_auth, name="overflow")
        assert r.status_code == 422
        assert "capped" in r.json()["detail"]
        # freeing a slot (delete) lets the add through — quota, not a scar
        assert _delete(client, ui_auth, "h-00").status_code == 200
        assert _add(client, ui_auth, name="overflow").status_code == 201

    def test_guard_split_mode_machine_token_refused(
            self, client, split_tokens):
        """In the A1 split mode a MACHINE token must not mutate the
        dictionary (ui class only), and a bearer-less request is 401 (the
        cookie leg is absent in the test contour)."""
        r = client.post("/api/harnesses", json={"name": CUSTOM},
                        headers={"Authorization": f"Bearer {BOARD_TOKEN}"})
        assert r.status_code == 401
        r = client.post("/api/harnesses", json={"name": CUSTOM})
        assert r.status_code == 401
        assert CUSTOM not in _names()


# ------------------------------------------------------------------- delete
class TestDelete:
    def test_delete_owner_row_200(self, client, ui_auth):
        assert _add(client, ui_auth).status_code == 201
        r = _delete(client, ui_auth)
        assert r.status_code == 200
        assert CUSTOM not in _names()
        # no idempotence promise: the row is gone → 404
        assert _delete(client, ui_auth).status_code == 404

    def test_delete_unknown_404(self, client, ui_auth):
        assert _delete(client, ui_auth, "no-such-harness").status_code == 404

    def test_seed_row_deletable(self, client, ui_auth):
        assert _delete(client, ui_auth, "windsurf").status_code == 200
        assert "windsurf" not in _names()

    def test_in_use_by_executor_409(self, client, ui_auth):
        assert _add(client, ui_auth).status_code == 201
        r = client.post("/api/executors",
                        json={"name": "exec-1", "harness": CUSTOM},
                        headers=ui_auth)
        assert r.status_code == 201, r.text
        r = _delete(client, ui_auth)
        assert r.status_code == 409
        assert "registered executor" in r.json()["detail"]
        assert CUSTOM in _names()

    def test_in_use_by_queued_assignment_409(self, client, ui_auth, make_task):
        assert _add(client, ui_auth).status_code == 201
        task = make_task(title="harness pin")
        r = client.post("/api/assignments",
                        json={"task_id": task["id"], "specialist": "s",
                              "harness": CUSTOM},
                        headers=ui_auth)
        assert r.status_code == 201, r.text
        r = _delete(client, ui_auth)
        assert r.status_code == 409
        assert "active assignments" in r.json()["detail"]

    def test_terminal_assignment_does_not_block(self, client, ui_auth,
                                                make_task):
        """History is archival: a DONE assignment must not pin the
        dictionary forever (the delete keeps it verbatim anyway)."""
        assert _add(client, ui_auth).status_code == 201
        task = make_task(title="done assignment")
        r = client.post("/api/assignments",
                        json={"task_id": task["id"], "specialist": "s",
                              "harness": CUSTOM},
                        headers=ui_auth)
        assert r.status_code == 201
        aid = r.json()["assignment"]["id"]
        # claim → start → complete with the claim_token chain
        r = client.post(f"/api/assignments/{aid}/claim",
                        json={"claimed_by": "s"}, headers=ui_auth)
        assert r.status_code == 200, r.text
        token = r.json()["claim_token"]
        assert client.post(f"/api/assignments/{aid}/start",
                           json={"claim_token": token},
                           headers=ui_auth).status_code == 200
        assert client.post(f"/api/assignments/{aid}/complete",
                           json={"claim_token": token,
                                 "final_report": "done"},
                           headers=ui_auth).status_code == 200
        assert _delete(client, ui_auth).status_code == 200
        assert CUSTOM not in _names()

    def test_in_use_by_ENABLED_schedule_409_disabled_does_not_block(self, client, ui_auth):
        assert _add(client, ui_auth).status_code == 201
        r = client.post("/api/automation/schedules",
                        json={"name": "sched-1", "task_id": "t-1",
                              "specialist": "s", "harness": CUSTOM,
                              "trigger_kind": "interval",
                              "trigger_value": "PT1H"},
                        headers=ui_auth)
        assert r.status_code == 201, r.text
        sched_id = r.json()["id"]
        # creation is DISABLED (S1) — a disabled rule cannot fire, so it
        # must NOT block the dictionary (soft-deleted rows are never
        # destroyed; counting them would trap the harness forever)
        assert _delete(client, ui_auth).status_code == 200
        assert _add(client, ui_auth).status_code == 201
        r = client.patch(f"/api/automation/schedules/{sched_id}",
                         json={"enabled": True}, headers=ui_auth)
        assert r.status_code == 200, r.text
        r = _delete(client, ui_auth)
        assert r.status_code == 409
        assert "schedule" in r.json()["detail"]

    def test_in_use_by_ENABLED_hook_condition_409(self, client, ui_auth):
        assert _add(client, ui_auth).status_code == 201
        r = client.post("/api/automation/hooks",
                        json={"name": "hook-1", "on": "task.moved",
                              "condition": [{"field": "harness", "op": "eq",
                                             "value": CUSTOM}],
                              "action": "notify"},
                        headers=ui_auth)
        assert r.status_code == 201, r.text
        # creation is DISABLED (S1) → no block until enablement
        assert _delete(client, ui_auth).status_code == 200
        assert _add(client, ui_auth).status_code == 201
        r = client.post("/api/automation/hooks",
                        json={"name": "hook-2", "on": "task.moved",
                              "condition": [{"field": "harness", "op": "eq",
                                             "value": CUSTOM}],
                              "action": "notify"},
                        headers=ui_auth)
        hook_id = r.json()["id"]
        r = client.patch(f"/api/automation/hooks/{hook_id}",
                         json={"enabled": True}, headers=ui_auth)
        assert r.status_code == 200, r.text
        r = _delete(client, ui_auth)
        assert r.status_code == 409
        assert "hook" in r.json()["detail"]


# ------------------------------------------------------- the sixth gate
class TestGatesReadTheTable:
    """The point of the block: a CUSTOM harness flows through every
    nomination gate once added, and through none once deleted."""

    def test_custom_harness_flows_all_gates(self, client, ui_auth,
                                            make_task):
        assert _add(client, ui_auth).status_code == 201
        # 1. registration
        r = client.post("/api/executors",
                        json={"name": "exec-c", "harness": CUSTOM},
                        headers=ui_auth)
        assert r.status_code == 201, r.text
        # 2. enrollment hint
        r = client.post("/api/executors/enrollment",
                        json={"label": "vps", "harness_hint": CUSTOM},
                        headers=ui_auth)
        assert r.status_code == 201, r.text
        # 3. assignment create
        task = make_task(title="custom harness run")
        r = client.post("/api/assignments",
                        json={"task_id": task["id"], "specialist": "s",
                              "harness": CUSTOM},
                        headers=ui_auth)
        assert r.status_code == 201, r.text
        # 4. automation schedule payload
        r = client.post("/api/automation/schedules",
                        json={"name": "sched-c", "task_id": task["id"],
                              "specialist": "s", "harness": CUSTOM,
                              "trigger_kind": "interval",
                              "trigger_value": "PT1H"},
                        headers=ui_auth)
        assert r.status_code == 201, r.text
        # 5. rule condition enum (meta-dictionary lists the live value)
        meta = client.get("/api/automation/status", headers=ui_auth).json()
        assert CUSTOM in meta["condition_meta"]["values_hint"]["harness"]
        # 6. hook condition validation accepts the live value
        r = client.post("/api/automation/hooks",
                        json={"name": "hook-c", "on": "task.moved",
                              "condition": [{"field": "harness", "op": "eq",
                                             "value": CUSTOM}],
                              "action": "notify"},
                        headers=ui_auth)
        assert r.status_code == 201, r.text

    def test_unknown_harness_still_refused_everywhere(self, client, ui_auth,
                                                      make_task):
        bogus = "never-added"
        assert client.post(
            "/api/executors", json={"name": "e", "harness": bogus},
            headers=ui_auth).status_code == 422
        assert client.post(
            "/api/executors/enrollment",
            json={"harness_hint": bogus}, headers=ui_auth).status_code == 422
        task = make_task(title="bogus harness")
        r = client.post("/api/assignments",
                        json={"task_id": task["id"], "specialist": "s",
                              "harness": bogus},
                        headers=ui_auth)
        assert r.status_code == 422
        assert "known:" in r.json()["detail"]


# ------------------------------------------------------------------ audit
class TestSseAndAudit:
    def test_added_removed_audit_payload(self, client, ui_auth):
        assert _add(client, ui_auth, note="n").status_code == 201
        assert _delete(client, ui_auth).status_code == 200
        # The audit trail is the deterministic assertion surface (SSE frames
        # share the emitter; the dictionary parser is unit-tested viewer-side).
        with _db() as db:
            kinds = [row["kind"] for row in db.execute(
                "SELECT kind FROM events ORDER BY id").fetchall()]
        assert "harness.added" in kinds
        assert "harness.removed" in kinds
        with _db() as db:
            payload = json.loads(db.execute(
                "SELECT payload FROM events WHERE kind='harness.added' "
                "ORDER BY id DESC LIMIT 1").fetchone()["payload"])
        assert payload["name"] == CUSTOM
        assert payload["added_via"] == "owner"


# ------------------------------------------- the gate lives in the CORE
class TestGateInTheAssignmentCore:
    """P2 review fix: the harness gate must sit in the IN-TRANSACTION
    assignment core, not on the UI route — the manual run-now mints through
    the same private path, and a route-only gate would let it nominate a
    DELETED harness (a zombie queued row holding the ≤1-active slot)."""

    def test_run_now_on_deleted_harness_skips_not_500s(self, client, ui_auth,
                                                       make_task):
        assert _add(client, ui_auth).status_code == 201
        task = make_task(title="run-now core gate")
        r = client.post("/api/automation/schedules",
                        json={"name": "sched-run-now", "task_id": task["id"],
                              "specialist": "s", "harness": CUSTOM,
                              "trigger_kind": "interval",
                              "trigger_value": "PT1H"},
                        headers=ui_auth)
        assert r.status_code == 201, r.text
        sched_id = r.json()["id"]
        assert _delete(client, ui_auth).status_code == 200
        # run-now: honest 422 (NOT 500) + the journal carries the skip
        r = client.post(f"/api/automation/schedules/{sched_id}/run",
                        headers=ui_auth)
        assert r.status_code == 422, r.text
        assert "unknown harness" in r.json()["detail"]
        page = client.get("/api/automation/launches",
                          params={"rule_id": sched_id}).json()
        assert page["total"] == 1
        row = page["items"][0]
        assert row["decision"] == "skipped"
        assert "unknown harness" in row["reason"]
        # no zombie nomination: nothing queued on the deleted harness
        r = client.get("/api/assignments")
        assert all(row["harness"] != CUSTOM for row in r.json()["items"])

    def test_schedule_without_harness_gets_validated_default(self, client,
                                                             ui_auth):
        # the omission defaults to 'zcode' BEFORE validation — the effective
        # value passes the same live-dictionary gate as a provided one
        r = client.post("/api/automation/schedules",
                        json={"name": "s-noh-1", "task_id": "t-1",
                              "specialist": "s", "trigger_kind": "interval",
                              "trigger_value": "PT1H"},
                        headers=ui_auth)
        assert r.status_code == 201, r.text
        assert r.json()["harness"] == "zcode"
        # with the zcode seed deleted, the defaulted value is an honest 422
        assert _delete(client, ui_auth, "zcode").status_code == 200
        r = client.post("/api/automation/schedules",
                        json={"name": "s-noh-2", "task_id": "t-1",
                              "specialist": "s", "trigger_kind": "interval",
                              "trigger_value": "PT1H"},
                        headers=ui_auth)
        assert r.status_code == 422
        assert "unknown harness: 'zcode'" in r.json()["detail"]

    def test_route_gate_still_422_via_store(self, client, ui_auth, make_task):
        """The UI route keeps its contract (422 + the known list) — the
        message now comes from the store error mapped by _assignment_http,
        a single source of truth for every minting window."""
        task = make_task(title="route gate via store")
        r = client.post("/api/assignments",
                        json={"task_id": task["id"], "specialist": "s",
                              "harness": "never-added"},
                        headers=ui_auth)
        assert r.status_code == 422
        assert "unknown harness: never-added" in r.json()["detail"]
        assert "known:" in r.json()["detail"]
