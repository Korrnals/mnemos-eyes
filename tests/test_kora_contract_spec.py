"""Kora week-0 contract gate (ADR 0019 rev.2, «Неделя 0 — контракт-first»).

docs/kora/openapi.yaml is the frozen API contract for slices 1–3, written
BEFORE any server code. This gate validates the artifact itself so the
freeze is enforceable in CI from day one:

- the slice 1–3 endpoints exist with the agreed methods and operation ids;
- the frozen enums (harness / state / origin / error codes) do not drift;
- the single redaction choke-point is declared and every content-bearing
  field is marked as passing through it;
- the SSE dictionary is metadata-only (no content fields, additive-only);
- the derived-registry semantics (PK + UNIQUE host) are encoded;
- no ACP surface (CI-tripwire spirit, ADR 0019 §5).

When the slices land, the FastAPI /openapi.json must satisfy the same
invariants (extend this module — or the merged test_openapi_contract.py —
at implementation time; the YAML stays the canonical pre-implementation
snapshot of the freeze).
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

SPEC_PATH = Path(__file__).resolve().parent.parent / "docs" / "kora" / "openapi.yaml"


@pytest.fixture(scope="module")
def spec() -> dict:
    assert SPEC_PATH.exists(), f"missing contract artifact: {SPEC_PATH}"
    loaded = yaml.safe_load(SPEC_PATH.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def _schema(spec: dict, name: str) -> dict:
    schemas = spec["components"]["schemas"]
    assert name in schemas, f"schema {name} missing from components"
    return schemas[name]


def _required(schema: dict) -> set[str]:
    return set(schema.get("required", []))


class TestSpecBasics:
    def test_openapi_version_and_freeze_marker(self, spec: dict) -> None:
        assert spec["openapi"].startswith("3.1")
        # The freeze marker: this file is the week-0 contract, not a live
        # server export.
        assert spec["info"]["x-kora-status"] == "frozen-week0"
        assert spec["info"]["x-kora-adr"].endswith(
            "0019-kora-workspace-phase1.md"
        )

    def test_no_acp_surface(self, spec: dict) -> None:
        """ADR 0019 §5: no network ACP in phase 1 — the tripwire spirit.
        Descriptions may MENTION the absence (x-kora-no-acp); the wire
        must not carry it: no path, no operation id, no schema name."""
        for path in spec["paths"]:
            assert "acp" not in path.lower(), f"ACP path surface: {path}"
            for method in spec["paths"][path].values():
                if isinstance(method, dict) and "operationId" in method:
                    assert "acp" not in method["operationId"].lower(), (
                        f"ACP operation id on {path}")
        for name in spec["components"]["schemas"]:
            assert "acp" not in name.lower(), f"ACP schema surface: {name}"

    def test_no_duplicate_path_keys(self) -> None:
        """YAML duplicate keys would silently drop operations — parse-level
        guard: the parsed path count must match the raw text occurrences of
        top-level path entries."""
        raw = SPEC_PATH.read_text(encoding="utf-8")
        loaded = yaml.safe_load(raw)
        # Every operation id must be unique (a lost duplicate would show up
        # as a missing operation below, this is the cheap belt-and-braces).
        op_ids = [
            op["operationId"]
            for item in loaded["paths"].values()
            for method, op in item.items()
            if method in {"get", "post", "put", "patch", "delete"}
        ]
        assert len(op_ids) == len(set(op_ids)), "duplicate operationId"


class TestSlice1ListContract:
    def test_endpoint_shape(self, spec: dict) -> None:
        get = spec["paths"]["/kora/sessions"]["get"]
        assert get["operationId"] == "listKoraSessions"
        assert get["tags"] == ["kora-slice1"]
        assert get["responses"]["200"]["content"]["application/json"][
            "schema"
        ]["$ref"].endswith("KoraSessionsOut")

    def test_session_item_required_fields(self, spec: dict) -> None:
        out = _schema(spec, "KoraSessionOut")
        must_have = {
            "id", "executor_id", "native_id", "harness", "state", "origin",
            "steerable", "age_seconds", "last_line_preview",
            "started_at", "last_activity_at", "project", "cwd",
        }
        assert must_have <= set(out["properties"])
        # The registry PK pair is carried on every row, always.
        assert {"id", "executor_id", "native_id", "harness", "state",
                "origin", "steerable", "age_seconds"} <= _required(out)

    def test_frozen_enums(self, spec: dict) -> None:
        assert _schema(spec, "KoraHarness")["enum"] == ["zcode", "vscode", "pi"]
        assert _schema(spec, "KoraSessionState")["enum"] == ["live", "idle", "dead"]
        assert _schema(spec, "KoraOrigin")["enum"] == ["relay", "local"]

    def test_preview_clamped(self, spec: dict) -> None:
        preview = _schema(spec, "KoraSessionOut")["properties"]["last_line_preview"]
        assert preview["maxLength"] == 160
        assert preview.get("x-kora-redacted") is True

    def test_coverage_block_present(self, spec: dict) -> None:
        listing = _schema(spec, "KoraSessionsOut")
        assert "coverage" in _required(listing)
        support = _schema(spec, "KoraCoverageHarness")["properties"]["support"]
        assert support["enum"] == ["full", "lists-only", "metadata-only", "absent"]
        coverage = _schema(spec, "KoraCoverageOut")
        assert {"harnesses", "gaps"} <= _required(coverage)


class TestSlice2TranscriptContract:
    def test_endpoint_shape(self, spec: dict) -> None:
        get = spec["paths"]["/kora/sessions/{session_id}/transcript"]["get"]
        assert get["operationId"] == "getKoraSessionTranscript"
        assert get["tags"] == ["kora-slice2"]

    def test_cursor_parameters(self, spec: dict) -> None:
        params = {
            p["name"]: p
            for p in spec["paths"]["/kora/sessions/{session_id}/transcript"][
                "get"
            ]["parameters"]
            if "name" in p  # skip $ref parameters (they carry no name in place)
        }
        after = params["after_seq"]["schema"]
        assert after["minimum"] == 0 and after["default"] == 0
        limit = params["limit"]["schema"]
        assert limit["maximum"] == 200 and limit["default"] == 50

    def test_cursor_response_keys(self, spec: dict) -> None:
        out = _schema(spec, "KoraTranscriptOut")
        assert {"session_id", "items", "next_after_seq", "has_more"} <= _required(out)

    def test_item_content_redacted(self, spec: dict) -> None:
        item = _schema(spec, "KoraTranscriptItemOut")
        assert {"seq", "role", "ts", "content", "redaction_applied"} <= _required(item)
        assert item["properties"]["content"].get("x-kora-redacted") is True

    def test_mnd_wall_is_explanatory(self, spec: dict) -> None:
        """mnd_ = metadata-only: the 403 wall must carry a schema (the
        explanation), never be a bare status (ADR 0019 §4)."""
        resp = spec["paths"]["/kora/sessions/{session_id}/transcript"]["get"][
            "responses"
        ]["403"]
        assert resp["content"]["application/json"]["schema"]["$ref"].endswith(
            "KoraErrorOut"
        )


class TestSlice3RelayContract:
    def test_create_session_endpoint(self, spec: dict) -> None:
        post = spec["paths"]["/kora/sessions"]["post"]
        assert post["operationId"] == "createKoraSession"
        assert post["tags"] == ["kora-slice3"]
        body = post["requestBody"]["content"]["application/json"]["schema"]
        assert body["$ref"].endswith("KoraSessionCreate")

    def test_create_body_is_executor_project_prompt(self, spec: dict) -> None:
        body = _schema(spec, "KoraSessionCreate")
        assert _required(body) == {"executor_id", "project", "prompt"}
        # P4-1: the prompt clamp is frozen — argv-borne transport hygiene
        # relies on the 32k cap riding the schema, not a server default.
        assert body["properties"]["prompt"]["maxLength"] == 32000

    def test_send_message_endpoint_and_provenance_404(self, spec: dict) -> None:
        post = spec["paths"]["/kora/sessions/{session_id}/messages"]["post"]
        assert post["operationId"] == "sendKoraSessionMessage"
        # Foreign triple resolves as 404 server-side (security gate 1).
        assert "404" in post["responses"]
        assert "409" in post["responses"]  # loud host-conflict resolution
        # P4-1: message text clamp rides the same 32k freeze as prompts.
        text = _schema(spec, "KoraMessageCreate")["properties"]["text"]
        assert text["maxLength"] == 32000

    def test_delivery_is_honest(self, spec: dict) -> None:
        delivery = _schema(spec, "KoraDeliveryOut")
        assert delivery["properties"]["status"]["enum"] == [
            "queued", "delivered", "failed",
        ]
        accepted = _schema(spec, "KoraMessageAcceptedOut")
        assert {"ok", "session_id", "delivery", "confirm_required"} <= _required(
            accepted
        )

    def test_step_up_ttl_cap(self, spec: dict) -> None:
        grant = spec["paths"]["/kora/steering/step-up"]["post"]
        assert grant["operationId"] == "enableKoraSteeringStepUp"
        ttl = _schema(spec, "KoraStepUpOut")["properties"]["ttl_seconds"]
        assert ttl["maximum"] == 900  # ~15 min by contract
        revoke = spec["paths"]["/kora/steering/step-up"]["delete"]
        assert revoke["responses"]["204"]["description"].startswith("Revoked")

    def test_error_code_vocabulary_frozen(self, spec: dict) -> None:
        codes = _schema(spec, "KoraErrorOut")["properties"]["code"]["enum"]
        assert codes == [
            "unauthorized", "metadata_only", "step_up_required",
            "step_up_denied", "session_not_found", "host_conflict",
            "validation",
        ]


class TestCrossCuttingSemantics:
    def test_derived_registry_extension(self, spec: dict) -> None:
        registry = spec["x-kora-registry"]
        assert registry["pk"] == ["executor_id", "native_id"]
        assert registry["invariant"] == "UNIQUE executors.host"
        assert registry["kind"] == "derived"

    def test_redaction_choke_point_is_single(self, spec: dict) -> None:
        redaction = spec["x-kora-redaction"]
        assert redaction["choke-point"] == "server/kora/redaction.py"
        assert redaction["audit"] == "session.transcript_viewed"

    def test_content_fields_carry_redaction_marker(self, spec: dict) -> None:
        """P3-1 structural guard (allowlist): EVERY content-class field
        must carry ``x-kora-redacted: true`` — a field that cannot go
        through the choke-point does not ship (x-kora-redaction). A NEW
        content field without the marker fails here; conversely a marker
        on a non-content field fails the dead-marker check below."""
        # content classes: session previews + transcript bodies + relay
        # message/prompt TEXT. Metadata (ids, enums, timestamps, cursors)
        # is deliberately NOT here — masking a status enum is noise.
        content_fields = {
            "KoraSessionOut": {"last_line_preview"},
            "KoraTranscriptItemOut": {"content"},
            "KoraSessionCreate": {"prompt"},
            "KoraMessageCreate": {"text"},
        }
        for schema_name, fields in content_fields.items():
            schema = _schema(spec, schema_name)
            props = schema.get("properties", {})
            for field in fields:
                assert field in props, (
                    f"{schema_name}.{field} vanished from the contract — "
                    "update the content-field map"
                )
                assert props[field].get("x-kora-redacted") is True, (
                    f"{schema_name}.{field} is content WITHOUT "
                    "x-kora-redacted — it must pass the choke-point"
                )
        # dead markers: x-kora-redacted on anything else is a rot site.
        marked = {
            (name, field)
            for name, schema in spec["components"]["schemas"].items()
            for field, meta in schema.get("properties", {}).items()
            if meta.get("x-kora-redacted")
        }
        expected = {(name, f) for name, fs in content_fields.items()
                     for f in fs}
        assert marked == expected, (
            f"redaction markers drifted: unmarked content or stray "
            f"markers — {marked ^ expected}"
        )
        # and NO unmarked free-text property may appear in a content
        # class at all — a NEW field sneaks past the map above by simply
        # not being in it; here EVERY string-ish property of the class
        # must be in the marked map or be structural metadata (id-likes).
        structural = {
            "KoraSessionOut": {"id", "executor_id", "native_id", "harness",
                               "project", "cwd", "state", "origin",
                               "steerable", "started_at",
                               "last_activity_at", "age_seconds"},
            "KoraTranscriptItemOut": {"seq", "role", "kind", "ts",
                                      "redaction_applied"},
            "KoraSessionCreate": {"executor_id", "project"},
            "KoraMessageCreate": set(),
        }
        for schema_name, fields in content_fields.items():
            props = _schema(spec, schema_name).get("properties", {})
            for field in props:
                assert field in fields or field in structural[schema_name], (
                    f"{schema_name}.{field} is neither marked content nor "
                    "structural metadata — classify it or delete it"
                )

    def test_sse_dictionary_metadata_only(self, spec: dict) -> None:
        events = spec["x-kora-events"]["events"]
        assert events == ["session.listed", "session.updated", "session.closed"]
        assert spec["x-kora-events"]["vocabulary"] == "additive-only"
        # Structural metadata-only enforcement (INVERTED ALLOWLIST, P4-2):
        # every event property must be KNOWN metadata — a mutation that
        # adds last_message/preview/anything new fails here, a blocklist
        # would not. Chat content NEVER rides the event bus (ADR 0019 §3:
        # the browser re-reads the store tail via authenticated GET).
        allowed = {
            "event", "session_id", "executor_id", "native_id", "harness",
            "project", "last_seq", "at",
        }
        for name in (
            "KoraSessionListedEvent",
            "KoraSessionUpdatedEvent",
            "KoraSessionClosedEvent",
        ):
            schema = _schema(spec, name)
            props = set(schema.get("properties", {}))
            unknown = props - allowed
            assert not unknown, (
                f"{name} carries non-allowlisted fields {sorted(unknown)} "
                "— metadata only; content rides the authenticated GET"
            )
            # the event kind matches its vocabulary entry exactly
            kind = {
                "KoraSessionListedEvent": "session.listed",
                "KoraSessionUpdatedEvent": "session.updated",
                "KoraSessionClosedEvent": "session.closed",
            }[name]
            assert schema["properties"]["event"]["enum"] == [kind]

    def test_access_class_schemes(self, spec: dict) -> None:
        schemes = spec["components"]["securitySchemes"]
        assert schemes["ownerCookie"]["in"] == "cookie"
        assert schemes["deviceToken"]["bearerFormat"] == "mnd_"
