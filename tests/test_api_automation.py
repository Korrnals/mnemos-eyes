"""SCHED-1 S1 (ADR 0013 §2): automation contracts — schedules/hooks CRUD,
launch journal, manual «Запустить сейчас», status/settings.

Coverage map (AC §7):
- CRUD validation: interval < 60 s → 422, unknown on/field/op → 422,
  non-'task' target_kind → 422, duplicate name → 422;
- run-now happy: assignment created with created_by='owner', manual
  journal row, task open → in-progress via the standard claim path;
  honest gates: 409 invariant, 422 archived/terminal, 404 unknown
  task/schedule (each refusal still journals a skipped row);
- next_run_at is server-owned: client values ignored on POST/PATCH;
- condition allowlist + source_allowlist defaults per action (SE А-1),
  machine opt-in audited, action switch resets the default;
- launches cursor contract: opaque cursor, next_cursor, attempted_at DESC
  id DESC tiebreak, truncated, filters, 422 on garbage;
- settings PUT audited old→new; status shape (engine=false, kill-switch
  default false, daily_used=0, condition_meta non-empty);
- SSE: automation.rule.{created,updated,toggled,deleted} on CRUD;
  run-now emits assignment.created and NEVER scheduler.launched (manual
  is not automation);
- soft-delete retention; ui-token class; 10/60 s rate budget.
"""

from __future__ import annotations

import asyncio
import itertools
import json

import pytest

from server.security import RateLimiter
from server.store import HOOK_EVENT_WHITELIST

_seq = itertools.count(1)


def _uname(prefix: str) -> str:
    """Session-unique rule name (the DB is shared across the session)."""
    return f"{prefix}-{next(_seq)}"


@pytest.fixture(autouse=True)
def fresh_automation_limiter(app_module, monkeypatch):
    """Fresh per-test rate limiter (module global otherwise accumulates
    across the session-scoped client)."""
    monkeypatch.setattr(
        app_module, "_automation_limiter",
        RateLimiter(limit=app_module._AUTOMATION_RATE_LIMIT,
                    window=app_module._AUTOMATION_RATE_WINDOW))


def _mk_schedule(client, auth, **overrides) -> dict:
    payload = {
        "name": _uname("sched"),
        "task_id": "t-unknown",
        "specialist": "gcw-tech-lead",
        "trigger_kind": "interval",
        "trigger_value": "PT6H",
    } | overrides
    r = client.post("/api/automation/schedules", json=payload, headers=auth)
    assert r.status_code == 201, r.text
    return r.json()


def _mk_hook(client, auth, **overrides) -> dict:
    payload = {"name": _uname("hook"), "on": "assignment.failed"} | overrides
    r = client.post("/api/automation/hooks", json=payload, headers=auth)
    assert r.status_code == 201, r.text
    return r.json()


def _board_events(app_module) -> list[dict]:
    return app_module.store.events(limit=1000)


class TestScheduleCrudValidation:
    def test_interval_below_60s_422(self, client, auth):
        r = client.post("/api/automation/schedules", json={
            "name": _uname("fast"), "task_id": "t-1",
            "specialist": "x", "trigger_kind": "interval",
            "trigger_value": "PT30S"}, headers=auth)
        assert r.status_code == 422
        assert "60" in r.json()["detail"]

    def test_garbage_duration_422(self, client, auth):
        r = client.post("/api/automation/schedules", json={
            "name": _uname("garbage"), "task_id": "t-1",
            "specialist": "x", "trigger_kind": "interval",
            "trigger_value": "every 5 minutes"}, headers=auth)
        assert r.status_code == 422

    def test_bad_time_of_day_422(self, client, auth):
        r = client.post("/api/automation/schedules", json={
            "name": _uname("tod"), "task_id": "t-1", "specialist": "x",
            "trigger_kind": "time-of-day", "trigger_value": "25:00"},
            headers=auth)
        assert r.status_code == 422

    def test_unknown_trigger_kind_422(self, client, auth):
        r = client.post("/api/automation/schedules", json={
            "name": _uname("cron"), "task_id": "t-1", "specialist": "x",
            "trigger_kind": "cron", "trigger_value": "* * * * *"},
            headers=auth)
        assert r.status_code == 422

    def test_non_task_target_kind_422(self, client, auth):
        r = client.post("/api/automation/schedules", json={
            "name": _uname("tpl"), "target_kind": "template",
            "task_id": "t-1", "specialist": "x", "trigger_kind": "interval",
            "trigger_value": "PT1H"}, headers=auth)
        assert r.status_code == 422
        assert "task" in r.json()["detail"]

    def test_duplicate_name_422(self, client, auth):
        name = _uname("dup")
        first = client.post("/api/automation/schedules", json={
            "name": name, "task_id": "t-1", "specialist": "x",
            "trigger_kind": "interval", "trigger_value": "PT1H"},
            headers=auth)
        assert first.status_code == 201
        again = client.post("/api/automation/schedules", json={
            "name": name, "task_id": "t-2", "specialist": "x",
            "trigger_kind": "interval", "trigger_value": "PT2H"},
            headers=auth)
        assert again.status_code == 422
        assert "already exists" in again.json()["detail"]

    def test_duplicate_name_on_rename_422(self, client, auth):
        a = _mk_schedule(client, auth)
        b = _mk_schedule(client, auth)
        r = client.patch(f"/api/automation/schedules/{b['id']}",
                         json={"name": a["name"]}, headers=auth)
        assert r.status_code == 422

    def test_unknown_harness_422(self, client, auth):
        r = client.post("/api/automation/schedules", json={
            "name": _uname("h"), "task_id": "t-1", "specialist": "x",
            "harness": "skynet", "trigger_kind": "interval",
            "trigger_value": "PT1H"}, headers=auth)
        assert r.status_code == 422

    def test_half_window_422(self, client, auth):
        r = client.post("/api/automation/schedules", json={
            "name": _uname("w"), "task_id": "t-1", "specialist": "x",
            "trigger_kind": "interval", "trigger_value": "PT1H",
            "window_from": "09:00"}, headers=auth)
        assert r.status_code == 422

    def test_creation_is_disabled_and_defaults(self, client, auth):
        rule = _mk_schedule(client, auth, enabled=True)  # client flag ignored
        assert rule["enabled"] is False          # creation is disabled (ADR §2)
        assert rule["harness"] == "zcode"
        assert rule["executor_id"] == ""
        assert rule["max_runs_per_day"] == 4
        assert rule["cooldown_s"] == 300
        assert rule["target_kind"] == "task"
        assert rule["created_by"] == "owner"
        assert rule["last_run_at"] is None       # S1: tick family untouched
        assert rule["next_run_at"]               # server-computed at create

    def test_open_reads_no_token(self, client):
        assert client.get("/api/automation/schedules").status_code == 200
        assert client.get("/api/automation/hooks").status_code == 200
        assert client.get("/api/automation/launches").status_code == 200
        assert client.get("/api/automation/status").status_code == 200
        assert client.get("/api/automation/settings").status_code == 200

    def test_unknown_schedule_404(self, client, auth):
        assert client.patch("/api/automation/schedules/999999",
                            json={"enabled": True},
                            headers=auth).status_code == 404
        assert client.delete("/api/automation/schedules/999999",
                             headers=auth).status_code == 404


class TestNextRunServerOwned:
    def test_client_next_run_at_ignored_on_create(self, client, auth):
        rule = _mk_schedule(client, auth, next_run_at="1999-01-01T00:00:00+00:00")
        assert rule["next_run_at"] != "1999-01-01T00:00:00+00:00"
        assert rule["next_run_at"] >= "2026"      # server clock, not client's

    def test_client_next_run_at_ignored_on_patch(self, client, auth):
        rule = _mk_schedule(client, auth)
        r = client.patch(f"/api/automation/schedules/{rule['id']}",
                         json={"next_run_at": "1999-01-01T00:00:00+00:00"},
                         headers=auth)
        assert r.status_code == 200
        # an empty patch changes nothing — next_run_at stays as computed
        assert r.json()["next_run_at"] == rule["next_run_at"]

    def test_patch_recomputes_next_run_from_now(self, client, auth):
        rule = _mk_schedule(client, auth, trigger_value="PT1H")
        r = client.patch(f"/api/automation/schedules/{rule['id']}",
                         json={"trigger_value": "PT2H"}, headers=auth)
        assert r.status_code == 200
        assert r.json()["next_run_at"] > rule["next_run_at"]  # later horizon

    def test_enable_is_a_recompute_too(self, client, auth):
        rule = _mk_schedule(client, auth)
        r = client.patch(f"/api/automation/schedules/{rule['id']}",
                         json={"enabled": True}, headers=auth)
        assert r.status_code == 200
        assert r.json()["enabled"] is True
        assert r.json()["next_run_at"] >= rule["next_run_at"]

    def test_idempotent_patch_emits_no_audit(self, client, auth, app_module):
        rule = _mk_schedule(client, auth)
        before = len(_board_events(app_module))
        r = client.patch(f"/api/automation/schedules/{rule['id']}",
                         json={"enabled": False}, headers=auth)  # no-op
        assert r.status_code == 200
        assert len(_board_events(app_module)) == before


class TestHookValidation:
    def test_unknown_on_422(self, client, auth):
        r = client.post("/api/automation/hooks", json={
            "name": _uname("bad"), "on": "task.report"}, headers=auth)
        assert r.status_code == 422

    def test_automation_event_cannot_be_whitelisted(self, client, auth):
        r = client.post("/api/automation/hooks", json={
            "name": _uname("loop"), "on": "scheduler.launched"},
            headers=auth)
        assert r.status_code == 422

    def test_unknown_condition_field_422(self, client, auth):
        r = client.post("/api/automation/hooks", json={
            "name": _uname("cf"), "on": "task.moved",
            "condition": [{"field": "spec", "op": "eq", "value": "x"}]},
            headers=auth)
        assert r.status_code == 422

    def test_unknown_condition_op_422(self, client, auth):
        r = client.post("/api/automation/hooks", json={
            "name": _uname("co"), "on": "task.moved",
            "condition": [{"field": "col", "op": "contains", "value": "x"}]},
            headers=auth)
        assert r.status_code == 422

    def test_condition_value_outside_enum_422(self, client, auth):
        r = client.post("/api/automation/hooks", json={
            "name": _uname("cv"), "on": "task.moved",
            "condition": [{"field": "col", "op": "eq", "value": "sideways"}]},
            headers=auth)
        assert r.status_code == 422

    def test_condition_extra_clause_key_422(self, client, auth):
        r = client.post("/api/automation/hooks", json={
            "name": _uname("cx"), "on": "task.moved",
            "condition": [{"field": "col", "op": "eq", "value": "open",
                           "evil": "inject"}]}, headers=auth)
        assert r.status_code == 422

    def test_valid_condition_stored_normalized(self, client, auth):
        rule = _mk_hook(client, auth, on="task.moved", condition=[
            {"field": "col", "op": "ne", "value": "open"},
            {"field": "project", "op": "in", "value": ["b", "a", "b"]},
        ])
        assert rule["condition"] == [
            {"field": "col", "op": "ne", "value": "open"},
            {"field": "project", "op": "in", "value": ["a", "b"]},  # dedup+sort
        ]

    def test_source_allowlist_defaults_by_action(self, client, auth):
        notify = _mk_hook(client, auth)                     # action defaults notify
        assert notify["action"] == "notify"
        assert notify["source_allowlist"] == ["machine", "server", "ui"]
        create = _mk_hook(client, auth, on="task.moved",
                          action="create_assignment")
        assert create["source_allowlist"] == ["server", "ui"]

    def test_automation_origin_never_allowlisted(self, client, auth):
        r = client.post("/api/automation/hooks", json={
            "name": _uname("src"), "on": "assignment.failed",
            "source_allowlist": ["ui", "automation"]}, headers=auth)
        assert r.status_code == 422

    def test_machine_optin_is_audited_old_to_new(self, client, auth, app_module):
        rule = _mk_hook(client, auth, on="task.moved",
                        action="create_assignment")
        before = _board_events(app_module)
        r = client.patch(f"/api/automation/hooks/{rule['id']}",
                         json={"source_allowlist": ["machine", "ui"]},
                         headers=auth)
        assert r.status_code == 200
        assert r.json()["source_allowlist"] == ["machine", "ui"]
        new = [e for e in _board_events(app_module)[len(before):]
               if e["kind"] == "rule.updated"]
        assert new and new[0]["payload"]["changes"]["source_allowlist"] == [
            ["server", "ui"], ["machine", "ui"]]

    def test_action_switch_resets_source_default(self, client, auth):
        rule = _mk_hook(client, auth)              # notify: machine,server,ui
        r = client.patch(f"/api/automation/hooks/{rule['id']}",
                         json={"action": "create_assignment"}, headers=auth)
        assert r.status_code == 200
        assert r.json()["source_allowlist"] == ["server", "ui"]

    def test_harness_condition_field_valid(self, client, auth):
        """meta and validator share one source: every advertised field
        (incl. the late-bound harness enum) validates at CRUD time."""
        rule = _mk_hook(client, auth, on="assignment.failed",
                        condition=[{"field": "harness", "op": "eq",
                                    "value": "zcode"}])
        assert rule["condition"] == [
            {"field": "harness", "op": "eq", "value": "zcode"}]
        meta = client.get("/api/automation/status").json()["condition_meta"]
        assert "harness" in meta["fields"]
        assert "zcode" in meta["values_hint"]["harness"]

    def test_unknown_action_422(self, client, auth):
        r = client.post("/api/automation/hooks", json={
            "name": _uname("act"), "on": "assignment.failed",
            "action": "webhook"}, headers=auth)
        assert r.status_code == 422


class TestRunNow:
    def test_run_now_happy_path(self, client, auth, make_task, app_module):
        task = make_task(title="run-now happy", spec="AC: сделать дело")
        rule = _mk_schedule(client, auth, task_id=task["id"])
        r = client.post(f"/api/automation/schedules/{rule['id']}/run",
                        headers=auth)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["decision"] == "launched"
        assert body["assignment_id"]
        assert body["run_at"]

        # the assignment is an ORDINARY owner-nominated row
        items = client.get("/api/assignments",
                           params={"task_id": task["id"]}).json()["items"]
        a = next(x for x in items if x["id"] == body["assignment_id"])
        assert a["state"] == "queued"
        assert a["created_by"] == "owner"      # manual = NOT automation (ADR §2)
        assert a["specialist"] == "gcw-tech-lead"

        # journal row: manual trigger, ui origin, snapshot name
        page = client.get("/api/automation/launches",
                          params={"rule_id": rule["id"]}).json()
        assert page["total"] == 1
        row = page["items"][0]
        assert row["decision"] == "launched"
        assert row["trigger"] == "manual"
        assert row["origin"] == "ui"
        assert row["rule_kind"] == "schedule"
        assert row["rule_name"] == rule["name"]
        assert row["assignment_id"] == body["assignment_id"]

        # schedule-clock columns untouched by the manual hand (§7)
        fresh = client.get("/api/automation/schedules").json()["items"]
        assert next(x for x in fresh if x["id"] == rule["id"])["last_run_at"] is None

        # standard claim path moves the task open → in-progress (the run
        # reuses the whole assignment state machine, not a side door)
        claim = client.post(f"/api/assignments/{body['assignment_id']}/claim",
                            json={"claimed_by": "poller-run-now"},
                            headers=auth)
        assert claim.status_code == 200
        tasks = {t["id"]: t for t in client.get("/api/board").json()["tasks"]}
        assert tasks[task["id"]]["col"] == "in-progress"

    def test_run_now_invariant_409_journals_skipped(self, client, auth,
                                                    make_task):
        task = make_task(title="run-now 409")
        rule = _mk_schedule(client, auth, task_id=task["id"])
        first = client.post(f"/api/automation/schedules/{rule['id']}/run",
                            headers=auth)
        assert first.status_code == 200
        second = client.post(f"/api/automation/schedules/{rule['id']}/run",
                             headers=auth)
        assert second.status_code == 409            # ≤1 active invariant
        page = client.get("/api/automation/launches",
                          params={"rule_id": rule["id"]}).json()
        assert page["total"] == 2
        assert [i["decision"] for i in page["items"]] == ["skipped", "launched"]
        assert "active assignment" in page["items"][0]["reason"]

    def test_run_now_archived_task_422(self, client, auth, make_task):
        task = make_task(title="run-now archived")
        rule = _mk_schedule(client, auth, task_id=task["id"])
        assert client.post(f"/api/tasks/{task['id']}/archive",
                           headers=auth).status_code == 200
        r = client.post(f"/api/automation/schedules/{rule['id']}/run",
                        headers=auth)
        assert r.status_code == 422

    def test_run_now_terminal_task_422(self, client, auth, make_task):
        task = make_task(title="run-now terminal", col="done")
        rule = _mk_schedule(client, auth, task_id=task["id"])
        r = client.post(f"/api/automation/schedules/{rule['id']}/run",
                        headers=auth)
        assert r.status_code == 422

    def test_run_now_unknown_task_404_journals_skipped(self, client, auth):
        rule = _mk_schedule(client, auth, task_id="t-no-such-task")
        r = client.post(f"/api/automation/schedules/{rule['id']}/run",
                        headers=auth)
        assert r.status_code == 404
        page = client.get("/api/automation/launches",
                          params={"rule_id": rule["id"]}).json()
        assert page["total"] == 1 and page["items"][0]["decision"] == "skipped"

    def test_run_now_unknown_schedule_404(self, client, auth):
        assert client.post("/api/automation/schedules/999999/run",
                           headers=auth).status_code == 404

    def test_run_now_works_on_disabled_rule(self, client, auth, make_task):
        """enabled=0 stops the (S2) engine, not the owner's hand — manual
        run-now is the conscious replacement for missed occurrences."""
        task = make_task(title="run-now disabled")
        rule = _mk_schedule(client, auth, task_id=task["id"])
        assert rule["enabled"] is False
        r = client.post(f"/api/automation/schedules/{rule['id']}/run",
                        headers=auth)
        assert r.status_code == 200
        assert r.json()["decision"] == "launched"

    def test_manual_runs_do_not_touch_daily_used(self, client, auth, make_task):
        task = make_task(title="run-now budget")
        rule = _mk_schedule(client, auth, task_id=task["id"])
        assert client.post(f"/api/automation/schedules/{rule['id']}/run",
                           headers=auth).status_code == 200
        status = client.get("/api/automation/status").json()
        assert status["daily_used"] == 0     # manual ≠ automation budget


class TestLaunchesCursor:
    def test_cursor_contract(self, client, auth, make_task, app_module,
                             monkeypatch):
        # a bigger budget for this bulk test (7 runs on one rule)
        monkeypatch.setattr(
            app_module, "_automation_limiter",
            RateLimiter(limit=100, window=60.0))
        task = make_task(title="cursor journal")
        rule = _mk_schedule(client, auth, task_id=task["id"])
        for _ in range(7):
            client.post(f"/api/automation/schedules/{rule['id']}/run",
                        headers=auth)
        page = client.get("/api/automation/launches",
                          params={"rule_id": rule["id"]}).json()
        assert page["total"] == 7
        # ordering: attempted_at DESC with the id tiebreak (same-second rows)
        ids = [i["id"] for i in page["items"]]
        assert ids == sorted(ids, reverse=True)

        # paginate in pages of 3 — no dupes, no gaps, continuation ends
        seen: list[int] = []
        cursor = ""
        pages = 0
        while True:
            params = {"rule_id": rule["id"], "limit": 3}
            if cursor:
                params["cursor"] = cursor
            p = client.get("/api/automation/launches",
                           params=params).json()
            pages += 1
            seen.extend(i["id"] for i in p["items"])
            cursor = p["next_cursor"]
            if not cursor:
                break
            assert pages < 10
        assert seen == ids

        # filters: decision + kind
        skipped = client.get("/api/automation/launches", params={
            "rule_id": rule["id"], "decision": "skipped"}).json()
        assert skipped["total"] == 6
        assert all(i["decision"] == "skipped" for i in skipped["items"])
        schedules_only = client.get("/api/automation/launches", params={
            "kind": "schedule"}).json()
        assert all(i["rule_kind"] == "schedule" for i in schedules_only["items"])
        assert schedules_only["total"] >= 7

    def test_truncated_on_limit_above_cap(self, client, auth):
        p = client.get("/api/automation/launches",
                       params={"limit": 500}).json()
        assert p["truncated"] is True
        assert len(p["items"]) <= 200
        again = client.get("/api/automation/launches",
                           params={"limit": 50}).json()
        assert again["truncated"] is False

    def test_garbage_cursor_422(self, client):
        assert client.get("/api/automation/launches",
                          params={"cursor": "not-a-cursor"}).status_code == 422
        assert client.get(
            "/api/automation/launches",
            params={"cursor": "eyJ2IjogMSwgIm9mZnNldCI6IC0xfQ"}).status_code == 422

    def test_garbage_filters_422(self, client):
        assert client.get("/api/automation/launches",
                          params={"kind": "cron"}).status_code == 422
        assert client.get("/api/automation/launches",
                          params={"decision": "boom"}).status_code == 422


class TestSettingsAndStatus:
    def test_status_shape_s1(self, client):
        s = client.get("/api/automation/status").json()
        assert s["ok"] is True
        assert s["engine"] is False            # S1: the loop does not exist
        assert s["global_kill_switch"] is False  # disable-by-default (C-1)
        assert s["daily_cap"] == 20            # ADR §6 starting value
        assert s["daily_used"] == 0
        meta = s["condition_meta"]
        assert meta["fields"] and meta["ops"] == ["eq", "in", "ne"]
        assert meta["values_hint"]["col"] == [
            "open", "in-progress", "blocked", "resolved", "done"]
        assert meta["values_hint"]["project"] is None  # no closed enum
        assert meta["events"] == sorted(HOOK_EVENT_WHITELIST)
        assert set(meta["actions"]) == {"create_assignment", "notify"}
        assert "rules" in s and "schedules" in s["rules"]

    def test_settings_get_defaults(self, client):
        s = client.get("/api/automation/settings").json()
        assert s == {"ok": True, "enabled": False, "cap_global_per_day": 20}

    def test_settings_put_audited_old_to_new(self, client, auth, app_module):
        before = _board_events(app_module)
        r = client.put("/api/automation/settings",
                       json={"enabled": True, "cap_global_per_day": 25},
                       headers=auth)
        assert r.status_code == 200
        assert r.json() == {"ok": True, "enabled": True,
                            "cap_global_per_day": 25}
        audits = [e for e in _board_events(app_module)[len(before):]
                  if e["kind"] == "automation.settings.changed"]
        assert audits, "settings PUT must audit"
        changes = audits[0]["payload"]["changes"]
        assert changes["enabled"] == [False, True]
        assert changes["cap_global_per_day"] == [20, 25]
        # GET reflects the persisted board_meta
        assert client.get("/api/automation/settings").json() == {
            "ok": True, "enabled": True, "cap_global_per_day": 25}
        # idempotent PUT: no new audit event
        mark = len(_board_events(app_module))
        assert client.put("/api/automation/settings",
                          json={"enabled": True, "cap_global_per_day": 25},
                          headers=auth).status_code == 200
        assert len(_board_events(app_module)) == mark
        # status banner reads the same flags
        status = client.get("/api/automation/status").json()
        assert status["global_kill_switch"] is True
        assert status["daily_cap"] == 25
        # engine stays false in S1 regardless of the flag (inert data)
        assert status["engine"] is False

    def test_settings_put_garbage_cap_422(self, client, auth):
        r = client.put("/api/automation/settings",
                       json={"cap_global_per_day": 0}, headers=auth)
        assert r.status_code == 422


class TestAuditOldToNew:
    def test_patch_audits_rule_updated(self, client, auth, app_module):
        rule = _mk_schedule(client, auth, trigger_value="PT1H")
        before = _board_events(app_module)
        r = client.patch(f"/api/automation/schedules/{rule['id']}",
                         json={"trigger_value": "PT3H"}, headers=auth)
        assert r.status_code == 200
        events = [e for e in _board_events(app_module)[len(before):]
                  if e["kind"].startswith("rule.")]
        assert [e["kind"] for e in events] == ["rule.updated"]
        p = events[0]["payload"]
        assert p["rule_kind"] == "schedule" and p["rule_id"] == rule["id"]
        assert p["changes"]["trigger_value"] == ["PT1H", "PT3H"]

    def test_enable_audits_rule_toggled(self, client, auth, app_module):
        rule = _mk_schedule(client, auth)
        before = _board_events(app_module)
        client.patch(f"/api/automation/schedules/{rule['id']}",
                     json={"enabled": True}, headers=auth)
        events = [e for e in _board_events(app_module)[len(before):]
                  if e["kind"].startswith("rule.")]
        assert [e["kind"] for e in events] == ["rule.toggled"]
        assert events[0]["payload"]["changes"]["enabled"] == [False, True]

    def test_create_audits_rule_created(self, client, auth, app_module):
        before = _board_events(app_module)
        rule = _mk_hook(client, auth)
        events = [e for e in _board_events(app_module)[len(before):]
                  if e["kind"] == "rule.created"]
        assert events and events[0]["payload"]["rule_kind"] == "hook"
        assert events[0]["payload"]["name"] == rule["name"]

    def test_delete_is_soft_disable_retention(self, client, auth, app_module):
        rule = _mk_schedule(client, auth)
        client.patch(f"/api/automation/schedules/{rule['id']}",
                     json={"enabled": True}, headers=auth)
        before = _board_events(app_module)
        r = client.delete(f"/api/automation/schedules/{rule['id']}",
                          headers=auth)
        assert r.status_code == 200
        # retention: the row survives, disabled
        items = client.get("/api/automation/schedules").json()["items"]
        fresh = next(x for x in items if x["id"] == rule["id"])
        assert fresh["enabled"] is False
        # audited old→new
        events = [e for e in _board_events(app_module)[len(before):]
                  if e["kind"] == "rule.deleted"]
        assert events and events[0]["payload"]["changes"]["enabled"] == [
            True, False]
        # the retained row can be re-enabled (it was never destroyed)
        r2 = client.patch(f"/api/automation/schedules/{rule['id']}",
                          json={"enabled": True}, headers=auth)
        assert r2.status_code == 200 and r2.json()["enabled"] is True


class TestTokenAndRate:
    def test_mutations_require_ui_token(self, client, app_module, monkeypatch):
        assert client.post("/api/automation/schedules", json={
            "name": "x", "task_id": "t", "specialist": "s",
            "trigger_kind": "interval", "trigger_value": "PT1H"}
        ).status_code == 401

    def test_split_mode_board_token_refused(self, client, auth, app_module,
                                            monkeypatch):
        monkeypatch.setattr(app_module, "UI_WRITE_TOKEN", "qa-ui-token")
        r = client.post("/api/automation/schedules", json={
            "name": _uname("split"), "task_id": "t-1", "specialist": "x",
            "trigger_kind": "interval", "trigger_value": "PT1H"},
            headers=auth)  # board (machine) token
        assert r.status_code == 401
        ui = {"Authorization": "Bearer qa-ui-token"}
        ok = client.post("/api/automation/schedules", json={
            "name": _uname("split"), "task_id": "t-1", "specialist": "x",
            "trigger_kind": "interval", "trigger_value": "PT1H"},
            headers=ui)
        assert ok.status_code == 201

    def test_rate_limit_10_per_60s(self, client, auth):
        statuses = []
        for i in range(11):
            r = client.post("/api/automation/schedules", json={
                "name": _uname(f"rl"), "task_id": "t-1", "specialist": "x",
                "trigger_kind": "interval", "trigger_value": "PT1H"},
                headers=auth)
            statuses.append(r.status_code)
        assert statuses[:10] == [201] * 10
        assert statuses[10] == 429
        assert "rate limit" in r.json()["detail"]


class TestSseEmission:
    def test_rule_events_and_no_scheduler_launched(self, app_module, client,
                                                   auth, make_task):
        """automation.rule.* emitted by the CRUD routes (S1); run-now emits
        assignment.created through the standard path and NEVER
        scheduler.launched (manual is not automation). Raw-ASGI pattern:
        the TestClient buffers streaming responses."""
        task = make_task(title="sse automation", spec="AC")

        async def run() -> bytes:
            frames: list[dict] = []
            hello = asyncio.Event()
            done = asyncio.Event()
            never = asyncio.Event()

            async def sse_receive():
                await never.wait()
                return {"type": "http.disconnect"}  # pragma: no cover

            async def sse_send(message):
                frames.append(message)
                body = message.get("body", b"")
                if b'"hello"' in body:
                    hello.set()
                if b"automation.rule.deleted" in body:
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

            async def do(method: str, path: str, payload: dict | None) -> None:
                body = json.dumps(payload).encode() if payload is not None else b""
                got: list[dict] = []
                seen = {"body": False}

                async def receive():
                    if not seen["body"]:
                        seen["body"] = True
                        return {"type": "http.request", "body": body,
                                "more_body": False}
                    return {"type": "http.disconnect"}

                async def send(message):
                    got.append(message)

                scope = {
                    "type": "http", "asgi": {"version": "3.0"},
                    "http_version": "1.1", "method": method,
                    "scheme": "http", "path": path, "raw_path": path.encode(),
                    "query_string": b"", "root_path": "",
                    "headers": [
                        (b"host", b"testserver"),
                        (b"authorization", auth["Authorization"].encode()),
                        *([(b"content-type", b"application/json"),
                           (b"content-length",
                            str(len(body)).encode())] if payload is not None else []),
                    ],
                    "client": ("127.0.0.1", 12346),
                    "server": ("127.0.0.1", 80),
                }
                await app_module.app(scope, receive, send)

            name = _uname("sse")
            await do("POST", "/api/automation/schedules", {
                "name": name, "task_id": task["id"],
                "specialist": "gcw-tech-lead", "trigger_kind": "interval",
                "trigger_value": "PT1H"})
            sid = next(r["id"] for r in client.get(
                "/api/automation/schedules").json()["items"]
                if r["name"] == name)
            await do("PATCH", f"/api/automation/schedules/{sid}",
                     {"trigger_value": "PT2H"})
            await do("PATCH", f"/api/automation/schedules/{sid}",
                     {"enabled": True})
            await do("POST", f"/api/automation/schedules/{sid}/run", {})
            await do("DELETE", f"/api/automation/schedules/{sid}", None)

            await asyncio.wait_for(done.wait(), timeout=5)
            sse_task.cancel()
            try:
                await sse_task
            except asyncio.CancelledError:
                pass
            return b"".join(m.get("body", b"") for m in frames
                            if m["type"] == "http.response.body")

        stream = asyncio.run(run())
        assert b'"kind": "automation.rule.created"' in stream
        assert b'"kind": "automation.rule.updated"' in stream
        assert b'"kind": "automation.rule.toggled"' in stream
        assert b'"kind": "automation.rule.deleted"' in stream
        # payload discriminators
        assert b'"rule_kind": "schedule"' in stream
        assert b'"changes"' in stream
        # run-now rides the standard assignment.created path…
        assert b'"kind": "assignment.created"' in stream
        # …and is NOT automation: scheduler.* has no emitters before S2
        assert b"scheduler.launched" not in stream
        assert b"scheduler.missed" not in stream
