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
