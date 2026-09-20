"""OpenAPI contract (arch-committee gate 1→2): /openapi.json must expose
TaskCreate / TaskPatch / TaskOut plus the response schemas of the key
routes, AND the key routes must actually reference them. A schema that
exists but is unreferenced does not satisfy the contract.
"""

from __future__ import annotations

import pytest


@pytest.fixture(scope="module")
def spec(client):
    r = client.get("/openapi.json")
    assert r.status_code == 200
    return r.json()


def _components(spec) -> dict:
    return spec.get("components", {}).get("schemas", {})


def _response_schema(spec, path: str, method: str, status: str = "200") -> dict:
    return (spec["paths"][path][method]["responses"][status]
            ["content"]["application/json"]["schema"])


def _ref_name(schema: dict) -> str:
    return schema.get("$ref", "").rsplit("/", 1)[-1]


class TestSchemasPresent:
    @pytest.mark.parametrize("name", [
        "TaskCreate", "TaskPatch", "TaskOut", "BoardOut", "OkOut",
        "MemoryServerOut", "MemoryServersOut", "GroupOut", "ReflectOut",
        "NotificationOut", "NotificationsOut",
        "SpecialistProfileOut", "RefreshAllOut",
        # BE-10 / BE-11
        "ReportCreate", "ReportOut", "ReportCreatedOut", "ReportsOut",
        "ArchiveOut", "UnarchiveOut",
        # BE-7: task history timeline
        "HistoryOut", "EventItem", "MemoryItem",
        # AGG-1: task inbox mirror
        "TaskInboxItem", "TaskInboxOut", "TaskInboxRefreshOut",
        # Ф0b: merged memory listing + aggregated tags (BoardAdapter)
        "MemoryListItem", "MemoryListOut", "TagCountOut", "TagListOut",
        # ARCH-9 (ADR 0009 Amd 2): executor registry + execution settings
        "ExecutorOut", "ExecutorListOut", "ExecutorRegister",
        "ExecutorRegisteredOut", "ExecutorPatch", "ExecutorStateChangeOut",
        "ExecutionSettingsOut", "ExecutionSettingsBody",
        # SCHED-1 S1 (ADR 0013 §2): automation contracts — schedules/hooks/
        # journal/run-now/status/settings, for codegen
        "ScheduleOut", "SchedulesOut", "ScheduleCreate", "SchedulePatch",
        "HookOut", "HooksOut", "HookCreate", "HookPatch",
        "LaunchOut", "LaunchesOut", "ConditionItem", "ScheduleRunOut",
        "AutomationStatusOut", "AutomationSettingsOut",
        "AutomationSettingsBody", "RuleDeletedOut",
        # W5 (ROADMAP-v2 §5): mesh nodes as observable entities
        "MeshNodeOut", "MeshNodesOut", "MeshNodeHealthOut", "MeshNodeSpec",
    ])
    def test_schema_exists(self, spec, name):
        assert name in _components(spec)

    def test_task_out_declares_spa_contract_fields(self, spec):
        out = _components(spec)["TaskOut"]
        props = set(out.get("properties", {}))
        required = set(out.get("required", []))
        must_have = {"id", "col", "position", "title", "summary", "spec",
                     "agents", "specialists", "env", "project", "memory_ids",
                     "mnemos_tags", "created_at", "updated_at"}
        assert must_have <= props
        assert must_have <= required, "SPA reads these unconditionally"

    def test_task_out_declares_status_field(self, spec):
        """BE-10: every task carries the workflow status."""
        out = _components(spec)["TaskOut"]
        props = set(out.get("properties", {}))
        required = set(out.get("required", []))
        assert "status" in props
        assert "status" in required, "store always returns status post-migration"
        assert "archived_from" in props

    def test_report_out_declares_contract_fields(self, spec):
        """BE-11a: reports expose id/kind/agent/body/superseded/created_at."""
        out = _components(spec)["ReportOut"]
        props = set(out.get("properties", {}))
        must_have = {"id", "task_id", "kind", "agent", "body", "superseded",
                     "created_at"}
        assert must_have <= props

    def test_archive_out_declares_pagination_contract(self, spec):
        """BE-11b: archive exposes total/limit/offset plus the legacy keys."""
        out = _components(spec)["ArchiveOut"]
        props = set(out.get("properties", {}))
        must_have = {"ok", "count", "total", "limit", "offset", "items",
                     "projects"}
        assert must_have <= props


class TestKeyRoutesReferenceSchemas:
    def test_create_task(self, spec):
        create = spec["paths"]["/api/tasks"]["post"]
        assert _ref_name(create["requestBody"]["content"]
                         ["application/json"]["schema"]) == "TaskCreate"
        assert _ref_name(_response_schema(spec, "/api/tasks", "post", "201")) \
            == "TaskOut"

    def test_patch_task(self, spec):
        patch = spec["paths"]["/api/tasks/{task_id}"]["patch"]
        assert _ref_name(patch["requestBody"]["content"]
                         ["application/json"]["schema"]) == "TaskPatch"
        assert _ref_name(_response_schema(
            spec, "/api/tasks/{task_id}", "patch")) == "TaskOut"

    def test_board(self, spec):
        assert _ref_name(_response_schema(spec, "/api/board", "get")) \
            == "BoardOut"

    def test_memory_servers(self, spec):
        assert _ref_name(_response_schema(spec, "/api/memories/servers", "get")) \
            == "MemoryServersOut"

    def test_board_reflect(self, spec):
        assert _ref_name(_response_schema(spec, "/api/board-reflect", "post")) \
            == "ReflectOut"

    def test_notifications(self, spec):
        assert _ref_name(_response_schema(spec, "/api/notifications", "get")) \
            == "NotificationsOut"

    def test_task_reports(self, spec):
        post = spec["paths"]["/api/tasks/{task_id}/reports"]["post"]
        assert _ref_name(post["requestBody"]["content"]
                         ["application/json"]["schema"]) == "ReportCreate"
        assert _ref_name(_response_schema(
            spec, "/api/tasks/{task_id}/reports", "post", "201")) \
            == "ReportCreatedOut"
        assert _ref_name(_response_schema(
            spec, "/api/tasks/{task_id}/reports", "get")) == "ReportsOut"

    def test_archive(self, spec):
        assert _ref_name(_response_schema(spec, "/api/archive", "get")) \
            == "ArchiveOut"

    def test_unarchive(self, spec):
        assert _ref_name(_response_schema(
            spec, "/api/tasks/{task_id}/unarchive", "post")) == "UnarchiveOut"

    def test_task_history(self, spec):
        """BE-7: the history route must reference the timeline models."""
        assert _ref_name(_response_schema(
            spec, "/api/tasks/{task_id}/history", "get")) == "HistoryOut"
        out = _components(spec)["HistoryOut"]
        props = set(out.get("properties", {}))
        assert {"events", "memories"} <= props
        event_item = _components(spec)["EventItem"]
        assert {"ts", "title"} <= set(event_item.get("properties", {}))
        memory_item = _components(spec)["MemoryItem"]
        assert {"ts", "title", "source", "detail"} \
            <= set(memory_item.get("properties", {}))

    def test_task_inbox(self, spec):
        """AGG-1: the inbox routes must reference the mirror models."""
        assert _ref_name(_response_schema(spec, "/api/tasks/inbox", "get")) \
            == "TaskInboxOut"
        assert _ref_name(_response_schema(
            spec, "/api/tasks/inbox/refresh", "post")) == "TaskInboxRefreshOut"
        item = _components(spec)["TaskInboxItem"]
        must_have = {"memory_id", "server", "project", "title", "excerpt",
                     "tags", "priority", "specialist", "created_at",
                     "last_seen", "stale", "adopted", "adopted_task_id"}
        assert must_have <= set(item.get("properties", {}))

    def test_merged_memories_cursor_contract(self, spec):
        """Ф0b (ADR 0011 §11): GET /api/memories references MemoryListOut
        and pins the uniform pagination keys."""
        assert _ref_name(_response_schema(spec, "/api/memories", "get")) \
            == "MemoryListOut"
        out = _components(spec)["MemoryListOut"]
        must_have = {"items", "next_cursor", "truncated", "errors"}
        assert must_have <= set(out.get("properties", {}))
        item = _components(spec)["MemoryListItem"]
        must_have_item = {"id", "title", "tags", "status", "project",
                          "created_at", "updated_at", "excerpt", "server"}
        assert must_have_item <= set(item.get("properties", {}))
        assert {"id", "server"} <= set(item.get("required", []))

    def test_merged_tags(self, spec):
        """Ф0b: GET /api/tags references TagListOut with counters."""
        assert _ref_name(_response_schema(spec, "/api/tags", "get")) \
            == "TagListOut"
        out = _components(spec)["TagListOut"]
        assert {"tags", "servers_scanned", "errors"} \
            <= set(out.get("properties", {}))
        tag = _components(spec)["TagCountOut"]
        assert {"name", "count"} <= set(tag.get("properties", {}))

    def test_assignments(self, spec):
        """ADR 0009 Ф1 (ARCH-4): the assignment queue routes must reference
        the queue models — the freeze-frame portable contract."""
        for name in ("AssignmentOut", "AssignmentsOut", "AssignmentCreate",
                     "AssignmentCreatedOut", "AssignmentClaimedOut",
                     "AssignmentStateOut", "AssignmentFinishedOut"):
            assert name in _components(spec)
        assert _ref_name(_response_schema(
            spec, "/api/assignments", "get")) == "AssignmentsOut"
        post = spec["paths"]["/api/assignments"]["post"]
        assert _ref_name(post["requestBody"]["content"]
                         ["application/json"]["schema"]) == "AssignmentCreate"
        assert _ref_name(_response_schema(
            spec, "/api/assignments", "post", "201")) == "AssignmentCreatedOut"
        assert _ref_name(_response_schema(
            spec, "/api/assignments/{assignment_id}/claim", "post")) \
            == "AssignmentClaimedOut"
        assert _ref_name(_response_schema(
            spec, "/api/assignments/{assignment_id}/complete", "post")) \
            == "AssignmentFinishedOut"
        out = _components(spec)["AssignmentOut"]
        must_have = {"id", "task_id", "specialist", "harness", "state",
                     "created_by", "claimed_by", "spec_hash",
                     "executor_id", "claimed_by_executor", "created_at"}
        assert must_have <= set(out.get("properties", {}))
        # §11: the claim token rides only in the claim response
        assert "claim_token" not in out.get("properties", {})
        claimed = _components(spec)["AssignmentClaimedOut"]
        assert {"assignment", "claim_token"} <= set(claimed.get("properties", {}))

    def test_executors(self, spec):
        """ARCH-9 (ADR 0009 Amd 2): the executor-registry routes must
        reference the registry models — the freeze-frame portable contract.
        ExecutorOut carries computed presence but NEVER secret material;
        the plaintext executor_secret rides only in ExecutorRegisteredOut
        (shown once, claim_token pattern)."""
        for name in ("ExecutorOut", "ExecutorListOut", "ExecutorRegister",
                     "ExecutorRegisteredOut", "ExecutorPatch",
                     "ExecutorStateChangeOut"):
            assert name in _components(spec)
        assert _ref_name(_response_schema(
            spec, "/api/executors", "get")) == "ExecutorListOut"
        post = spec["paths"]["/api/executors"]["post"]
        assert _ref_name(post["requestBody"]["content"]
                         ["application/json"]["schema"]) == "ExecutorRegister"
        assert _ref_name(_response_schema(
            spec, "/api/executors", "post", "201")) == "ExecutorRegisteredOut"
        assert _ref_name(_response_schema(
            spec, "/api/executors/{executor_id}", "patch")) \
            == "ExecutorStateChangeOut"
        assert _ref_name(_response_schema(
            spec, "/api/executors/{executor_id}/heartbeat", "post")) \
            == "ExecutorStateChangeOut"
        out = _components(spec)["ExecutorOut"]
        must_have = {"id", "name", "harness", "host", "transport",
                     "capabilities", "version", "enabled", "state",
                     "last_seen", "presence", "registered_at", "updated_at"}
        assert must_have <= set(out.get("properties", {}))
        # secret hygiene: neither the hash nor the plaintext is a public field
        assert not ({"secret", "secret_hash", "executor_secret"}
                    & set(out.get("properties", {})))
        registered = _components(spec)["ExecutorRegisteredOut"]
        assert {"executor", "executor_secret"} <= set(
            registered.get("properties", {}))
        listing = _components(spec)["ExecutorListOut"]
        assert {"ok", "count", "items", "meta"} <= set(
            listing.get("properties", {}))
        # AssignmentOut grew the ARCH-9 additive fields (Amd 2 §5/§9)
        assignment = _components(spec)["AssignmentOut"]
        assert {"topics", "routing"} <= set(assignment.get("properties", {}))

    def test_execution_settings(self, spec):
        """ARCH-9: default-executor settings route pair (Amd 2 §5)."""
        assert _ref_name(_response_schema(
            spec, "/api/settings/execution", "get")) == "ExecutionSettingsOut"
        put = spec["paths"]["/api/settings/execution"]["put"]
        assert _ref_name(put["requestBody"]["content"]
                         ["application/json"]["schema"]) \
            == "ExecutionSettingsBody"
        assert _ref_name(_response_schema(
            spec, "/api/settings/execution", "put")) == "ExecutionSettingsOut"

    def test_automation(self, spec):
        """SCHED-1 S1 (ADR 0013 §2): the automation routes must reference
        the contract models — the freeze-frame portable contract for the
        future /system/automation UI. ScheduleOut carries the server-owned
        clock columns; the CREATE body must NOT declare them (a client
        value is ignored by contract)."""
        assert _ref_name(_response_schema(
            spec, "/api/automation/schedules", "get")) == "SchedulesOut"
        post = spec["paths"]["/api/automation/schedules"]["post"]
        assert _ref_name(post["requestBody"]["content"]
                         ["application/json"]["schema"]) == "ScheduleCreate"
        assert _ref_name(_response_schema(
            spec, "/api/automation/schedules", "post", "201")) == "ScheduleOut"
        assert _ref_name(_response_schema(
            spec, "/api/automation/schedules/{rule_id}", "patch")) \
            == "ScheduleOut"
        assert _ref_name(_response_schema(
            spec, "/api/automation/hooks", "get")) == "HooksOut"
        assert _ref_name(_response_schema(
            spec, "/api/automation/hooks", "post", "201")) == "HookOut"
        assert _ref_name(_response_schema(
            spec, "/api/automation/launches", "get")) == "LaunchesOut"
        assert _ref_name(_response_schema(
            spec, "/api/automation/schedules/{rule_id}/run", "post")) \
            == "ScheduleRunOut"
        assert _ref_name(_response_schema(
            spec, "/api/automation/status", "get")) == "AutomationStatusOut"
        assert _ref_name(_response_schema(
            spec, "/api/automation/settings", "get")) == "AutomationSettingsOut"
        put = spec["paths"]["/api/automation/settings"]["put"]
        assert _ref_name(put["requestBody"]["content"]
                         ["application/json"]["schema"]) \
            == "AutomationSettingsBody"

        sched = _components(spec)["ScheduleOut"]
        must_have = {"id", "name", "enabled", "target_kind", "task_id",
                     "specialist", "harness", "executor_id", "trigger_kind",
                     "trigger_value", "window_from", "window_to",
                     "max_runs_per_day", "cooldown_s", "next_run_at",
                     "last_run_at", "created_by", "created_at", "updated_at"}
        assert must_have <= set(sched.get("properties", {}))
        # the schedule clock is server-owned: NOT client-declared
        create = _components(spec)["ScheduleCreate"]
        assert not ({"next_run_at", "last_run_at", "enabled"}
                    & set(create.get("properties", {})))

        hook = _components(spec)["HookOut"]
        must_have_hook = {"id", "name", "enabled", "on", "condition",
                          "source_allowlist", "action", "action_payload",
                          "cooldown_s", "budget", "created_by", "created_at",
                          "updated_at"}
        assert must_have_hook <= set(hook.get("properties", {}))

        launch = _components(spec)["LaunchOut"]
        must_have_launch = {"id", "rule_id", "rule_kind", "rule_name",
                            "run_at", "event_id", "trigger", "origin",
                            "decision", "reason", "assignment_id",
                            "attempted_at"}
        assert must_have_launch <= set(launch.get("properties", {}))
        listing = _components(spec)["LaunchesOut"]
        assert {"items", "next_cursor", "truncated"} <= set(
            listing.get("properties", {}))

    def test_mesh_nodes(self, spec):
        """W5 (ROADMAP-v2 §5): the mesh-node routes must reference the
        registry models. MeshNodeOut carries the live healthz snapshot
        but NO secret material — a mesh node holds no token by contract."""
        assert _ref_name(_response_schema(spec, "/api/mesh/nodes", "get")) \
            == "MeshNodesOut"
        post = spec["paths"]["/api/mesh/nodes"]["post"]
        assert _ref_name(post["requestBody"]["content"]
                         ["application/json"]["schema"]) == "MeshNodeSpec"
        assert _ref_name(_response_schema(
            spec, "/api/mesh/nodes", "post", "201")) == "MeshNodeOut"
        assert _ref_name(_response_schema(
            spec, "/api/mesh/nodes/{name}", "patch")) == "MeshNodeOut"
        out = _components(spec)["MeshNodeOut"]
        must_have = {"name", "base_url", "description", "enabled",
                     "status", "ok", "error", "health"}
        assert must_have <= set(out.get("properties", {}))
        # secret hygiene: the node contract is token-free end to end
        assert not ({"token", "token_ref", "secret"}
                    & set(out.get("properties", {})))
        assert not ({"token", "token_ref", "secret"}
                    & set(_components(spec)["MeshNodeSpec"]
                          .get("properties", {})))
        health = _components(spec)["MeshNodeHealthOut"]
        assert {"version", "node_id", "uptime_seconds", "core_connected",
                "peers_total", "peers_reachable"} \
            <= set(health.get("properties", {}))
        listing = _components(spec)["MeshNodesOut"]
        assert {"ok", "nodes"} <= set(listing.get("properties", {}))
