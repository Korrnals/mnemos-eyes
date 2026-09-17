"""UI-6 task-drafts contract: pinned tags (SEC-4 poisoning invariant, one
step further than board-reflect — user-supplied project/tags from the form
must land in CONTENT metadata, NEVER in memory tags), title prefix, rate
limit (429, 10/60s per client), error codes (422 empty text, 503 no
servers) and BE-4 (async write survives mnemos failure).

Each test gets a fresh rate limiter and its own FakeMnemos; the per-test
``qa-mnemos`` registry row wires the app to it (same pattern as
test_api_board_reflect.py).
"""

from __future__ import annotations

import pytest


@pytest.fixture()
def fresh_draft_limiter(app_module, monkeypatch):
    """Fresh per-test rate limiter (the app-level one is a module global)."""
    from server.security import RateLimiter
    limiter = RateLimiter(limit=app_module._DRAFT_RATE_LIMIT,
                          window=app_module._DRAFT_RATE_WINDOW)
    monkeypatch.setattr(app_module, "_draft_limiter", limiter)
    return limiter


@pytest.fixture(autouse=True)
def _fresh_limiter(fresh_draft_limiter):
    """task-drafts rate limiting is a module global — reset per test."""


@pytest.fixture()
def wired(client, auth, fake_mnemos, allow_hosts, app_module):
    """One active memory server pointed at this test's FakeMnemos.

    Earlier files (test_api_memory_servers) leave ENABLED rows (fakesrv,
    dup-srv, patchme) in the session-scoped DB pointing at closed ports.
    They are disabled for the duration of each test so qa-mnemos is
    deterministically the first (only) active server, and re-enabled on
    teardown."""
    allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
    leaked = [s["name"] for s in app_module.registry.servers()
              if s["name"] != "qa-mnemos" and s.get("enabled")]
    for name in leaked:
        app_module.registry.set_enabled(name, False)
    app_module.store.upsert_server({
        "name": "qa-mnemos", "url": fake_mnemos.url, "group_name": "default",
        "description": "", "token_ref": "",
    })
    app_module.registry.set_enabled("qa-mnemos", True)
    app_module.registry.set_state("qa-mnemos", "idle")
    yield fake_mnemos
    app_module.store.delete_server("qa-mnemos")
    for name in leaked:
        app_module.registry.set_enabled(name, True)


def _draft(client, auth, **overrides):
    payload = {"text": "починить дребезг реле в гараже",
               "project": "", "tags": ""} | overrides
    return client.post("/api/task-drafts", json=payload, headers=auth)


class TestDraftContract:
    def test_success_201_returns_memory_id(self, client, auth, wired):
        r = _draft(client, auth)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["ok"] is True
        assert body["memory_id"] == "fake-mem-1"
        assert body["server"] == "qa-mnemos"

    def test_tags_pinned_exactly(self, client, auth, wired):
        """SEC-4 + mnemos strict contract: records carry EXACTLY the
        sanitized project slug, the board's own agent stamp, and the
        mnemos:open-question + task-draft + source:board subtypes — a draft
        is an open question, not a decision."""
        assert _draft(client, auth).status_code == 201
        writes = wired.memories_bodies()
        assert writes
        assert writes[-1]["tags"] == [
            "project:mnemos-eyes", "agent:zcode",
            "mnemos:open-question", "task-draft", "source:board",
        ]

    def test_project_slug_sanitized_into_tag(self, client, auth, wired):
        """A clean project value becomes project:<slug>; a hostile or
        malformed one falls back to the default slug instead of leaking."""
        r = _draft(client, auth, project="garage_iot")
        assert r.status_code == 201
        assert wired.memories_bodies()[-1]["tags"][0] == "project:garage-iot"
        _draft(client, auth, project="project:evil")
        assert wired.memories_bodies()[-1]["tags"][0] == "project:mnemos-eyes"

    def test_user_project_and_tags_never_become_memory_tags(self, client,
                                                            auth, wired):
        """Poisoning invariant (ui-contract §12): whatever the owner types
        into the project/tags fields must NOT leak verbatim into the memory
        TAGS — the project value only lands as a sanitized slug stamp, tags
        live in content metadata only."""
        user_tags = "agent:gcw-something, project:secret, mnemos:decision"
        r = _draft(client, auth,
                   project="project:evil", tags=user_tags)
        assert r.status_code == 201
        write = wired.memories_bodies()[-1]
        assert write["tags"] == [
            "project:mnemos-eyes", "agent:zcode",
            "mnemos:open-question", "task-draft", "source:board",
        ]
        assert "mnemos:decision" not in write["tags"]
        # ... and the user input IS preserved in content metadata
        assert f"теги: {user_tags}" in write["content"]
        assert "проект: project:evil" in write["content"]

    def test_project_and_tags_travel_in_content(self, client, auth, wired):
        r = _draft(client, auth, project="mnemos-eyes", tags="research, api")
        assert r.status_code == 201
        write = wired.memories_bodies()[-1]
        assert "проект: mnemos-eyes" in write["content"]
        assert "теги: research, api" in write["content"]

    def test_note_type_and_mcp_source(self, client, auth, wired):
        assert _draft(client, auth).status_code == 201
        write = wired.memories_bodies()[-1]
        assert write["memory_type"] == "note"
        assert write["source"] == "mcp"

    def test_title_prefix_and_truncation(self, client, auth, wired):
        long_text = "x" * 200
        assert _draft(client, auth, text=long_text).status_code == 201
        write = wired.memories_bodies()[-1]
        assert write["title"] == f"task-draft: {long_text[:60]}"

    def test_writes_to_first_active_server(self, client, auth, wired,
                                           app_module):
        assert _draft(client, auth).status_code == 201
        # qa-mnemos is the only active server (legacy1 disabled in conftest)
        assert wired.memories_bodies()[-1]["title"].startswith("task-draft: ")


class TestDraftValidation:
    @pytest.mark.parametrize("text", ["", "   \n\t "])
    def test_empty_text_422_and_nothing_written(self, client, auth, wired,
                                                text):
        r = _draft(client, auth, text=text)
        assert r.status_code == 422
        assert wired.memories_bodies() == []


class TestDraftRateLimit:
    def test_11th_call_429(self, client, auth, wired):
        statuses = [_draft(client, auth).status_code for _ in range(12)]
        assert statuses[0] == 201
        assert 429 in statuses and statuses[-1] == 429
        writes = wired.memories_bodies()
        assert len(writes) == 10, "only the first 10 writes may reach mnemos"


class TestDraftFailures:
    def test_no_active_server_503(self, client, auth, wired, app_module):
        app_module.registry.set_enabled("qa-mnemos", False)
        r = _draft(client, auth)
        assert r.status_code == 503
        assert "no active memory server" in r.text
        assert client.get("/api/board").status_code == 200

    def test_mnemos_500_is_handled_board_still_up(self, client, auth, wired):
        wired.fail_memories = True
        r = _draft(client, auth)
        assert r.status_code in (500, 503), "handled error, not a crash"
        assert "mnemos" in r.text.lower()
        assert client.get("/api/board").status_code == 200


class TestDraftToBoardChore:
    """AC3: after the draft, the SPA files the chore task with the exact
    payload contract — verified here server-side (UI posts the same JSON)."""

    def test_chore_task_payload_contract(self, client, auth, wired,
                                         make_task):
        draft = _draft(client, auth, project="vesmaro-eyes").json()
        mid = draft["memory_id"]
        task = make_task(
            title=f"Оформить черновик задачи (memory {mid})",
            summary="починить дребезг реле в гараже",
            spec=(f"Черновик владельца в памяти {draft['server']}:{mid}. "
                  "@GCW: Task Manager — оформить в канон (название/summary/"
                  "spec/AC/исполнители), вернуть на доску в validating-статус."),
            col="open",
            agents=["zcode"],
            specialists=["@GCW: Task Manager"],
            env="unknown",
            project="vesmaro-eyes",
            mnemos_tags=["task-draft"],
            memory_ids=[mid],
        )
        assert task["col"] == "open"
        assert task["agents"] == ["zcode"]
        assert task["specialists"] == ["@GCW: Task Manager"]
        assert task["mnemos_tags"] == ["task-draft"]
        assert task["memory_ids"] == [mid]
        assert task["project"] == "vesmaro-eyes"
        board = client.get("/api/board").json()
        assert any(t["id"] == task["id"] for t in board["tasks"])
