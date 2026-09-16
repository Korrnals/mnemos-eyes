"""board-reflect contract: pinned tags (SEC-4), kind allowlist (422),
rate limit (429, 10/60s per client) and BE-4 (async reflect: a mnemos
failure must not crash the route or take the board down).

Each test gets a fresh rate limiter and its own FakeMnemos; a per-test
``qa-mnemos`` registry row wires the app to it (legacy1 is pre-seeded
DISABLED in conftest, so it is deterministically the only active server).
"""

from __future__ import annotations

import json

import pytest


@pytest.fixture(autouse=True)
def _fresh_limiter(fresh_reflect_limiter):
    """board-reflect rate limiting is a module global — reset per test."""


@pytest.fixture()
def wired(client, auth, fake_mnemos, allow_hosts, app_module):
    """One active memory server pointed at this test's FakeMnemos."""
    allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
    app_module.store.upsert_server({
        "name": "qa-mnemos", "url": fake_mnemos.url, "group_name": "default",
        "description": "", "token_ref": "",
    })
    app_module.registry.set_enabled("qa-mnemos", True)
    app_module.registry.set_state("qa-mnemos", "idle")
    yield fake_mnemos
    app_module.store.delete_server("qa-mnemos")


def _reflect(client, auth, **overrides):
    payload = {"specialist": "gcw-sre-devops", "problem": "check", "kind":
               "agent-refine-request"} | overrides
    return client.post("/api/board-reflect", json=payload, headers=auth)


class TestReflectContract:
    def test_success_returns_memory_id(self, client, auth, wired):
        r = _reflect(client, auth)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["memory_id"] == "fake-mem-1"
        assert body["server"] == "qa-mnemos"

    def test_tags_pinned_exactly(self, client, auth, wired):
        """SEC-4: records carry EXACTLY mnemos:open-question + source:board
        — board reflections are data, never decisions or instructions."""
        assert _reflect(client, auth).status_code == 200
        writes = wired.memories_bodies()
        assert writes
        assert writes[-1]["tags"] == ["mnemos:open-question", "source:board"]

    def test_no_decision_tag_anywhere_in_payload(self, client, auth, wired):
        assert _reflect(client, auth).status_code == 200
        writes = wired.memories_bodies()
        assert "mnemos:decision" not in json.dumps(writes[-1])

    def test_commit_kind_ok(self, client, auth, wired):
        r = _reflect(client, auth, kind="agent-refine-commit")
        assert r.status_code == 200
        assert wired.memories_bodies()[-1]["title"].startswith(
            "agent-refine commit marker")


class TestKindAllowlist:
    @pytest.mark.parametrize("kind", ["mnemos:decision", "bogus-kind"])
    def test_unknown_kind_422_and_nothing_written(self, client, auth, wired,
                                                  kind):
        r = _reflect(client, auth, kind=kind)
        assert r.status_code == 422
        assert wired.memories_bodies() == []


class TestRateLimit:
    def test_11th_call_429(self, client, auth, wired):
        statuses = [_reflect(client, auth).status_code for _ in range(12)]
        assert statuses[0] == 200
        assert 429 in statuses and statuses[-1] == 429
        writes = wired.memories_bodies()
        assert len(writes) == 10, "only the first 10 writes may reach mnemos"


class TestBE4ReflectDoesNotCrashRoute:
    """BE-4: reflect stays async and survives mnemos failures — the route
    answers with a handled error, and the board keeps serving."""

    def test_mnemos_500_is_handled_board_still_up(self, client, auth, wired):
        wired.fail_memories = True
        r = _reflect(client, auth)
        assert r.status_code in (500, 503), "handled error, not a crash"
        assert "mnemos" in r.text.lower()
        assert client.get("/api/board").status_code == 200

    def test_no_active_server_503(self, client, auth, wired, app_module):
        app_module.registry.set_enabled("qa-mnemos", False)
        r = _reflect(client, auth)
        assert r.status_code == 503
        assert "no active memory server" in r.text
        assert client.get("/api/board").status_code == 200
