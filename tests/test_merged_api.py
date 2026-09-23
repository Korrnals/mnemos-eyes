"""Phase 0b (ADR 0011 §6/§11): the two additive BoardAdapter endpoints.

- GET /api/memories — merged listing across active servers: merge sort
  created_at DESC with the id tiebreak, uniform cursor contract (limit +
  opaque cursor → next_cursor, truncated on the silent page cap), per-item
  ``server`` field without id mutation, error isolation per server;
- GET /api/tags — aggregated tag listing (mnemos TagCount[] summed across
  stores, count DESC / name ASC, servers_scanned, error isolation).

The FakeMnemos doubles serve limit/offset windows of ``memories_result``
and ``tags_result`` so cursor continuation exercises a real has-more
signal (full page ⇒ maybe more).
"""

from __future__ import annotations

import base64
import json
from urllib.parse import parse_qs, urlparse

import pytest

from conftest import FakeMnemos
from server import mnemos_client

SERVER_A = "qa-mem-a"
SERVER_B = "qa-mem-b"


def mem(memory_id: str, created: str, title: str = "", tags: list | None = None,
        content: str = "body text", status: str = "raw",
        project: str = "") -> dict:
    return {"id": memory_id, "title": title, "content": content,
            "tags": tags or [], "status": status, "project": project,
            "created_at": created, "updated_at": created}


# Three records on A, two on B, timestamps interleaved: the merged order
# must be b1 > a1 > b2 > a2 > a3 regardless of which store owns what.
A_ITEMS = [
    mem("m-a1", "2026-09-03T00:00:00+00:00"),
    mem("m-a2", "2026-09-01T00:00:00+00:00"),
    mem("m-a3", "2026-08-30T00:00:00+00:00"),
]
B_ITEMS = [
    mem("m-b1", "2026-09-04T00:00:00+00:00"),
    mem("m-b2", "2026-09-02T00:00:00+00:00"),
]
MERGED_ORDER = ["m-b1", "m-a1", "m-b2", "m-a2", "m-a3"]


@pytest.fixture()
def mem_env(app_module, allow_hosts):
    """Two active memory servers (qa-mem-a, qa-mem-b) over private
    FakeMnemos doubles. Other registry rows are disabled for the duration
    and restored afterwards (the shared session DB outlives the test)."""
    fake_a, fake_b = FakeMnemos(), FakeMnemos()
    fake_a.memories_result = list(A_ITEMS)
    fake_b.memories_result = list(B_ITEMS)
    allow_hosts(f"127.0.0.1:{fake_a.port},127.0.0.1:{fake_b.port}")
    saved: dict[str, tuple[bool, str]] = {}
    for s in app_module.registry.servers():
        if s["name"] not in (SERVER_A, SERVER_B):
            saved[s["name"]] = (bool(s["enabled"]), s.get("state", "idle"))
            app_module.registry.set_enabled(s["name"], False)
    for name, fake in ((SERVER_A, fake_a), (SERVER_B, fake_b)):
        app_module.store.upsert_server({
            "name": name, "url": fake.url, "group_name": "default",
            "description": "", "token_ref": "",
        })
        app_module.registry.set_enabled(name, True)
        app_module.registry.set_state(name, "idle")
    yield app_module, fake_a, fake_b
    app_module.store.delete_server(SERVER_A)
    app_module.store.delete_server(SERVER_B)
    for name, (enabled, state) in saved.items():
        app_module.registry.set_enabled(name, enabled)
        app_module.registry.set_state(name, state)
    fake_a.close()
    fake_b.close()


def _b64(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode()


def _listing_calls(fake: FakeMnemos) -> list[dict]:
    with fake.lock:
        return [parse_qs(urlparse(r["path"]).query)
                for r in fake.requests
                if r["method"] == "GET" and r["path"].startswith("/memories?")]


class TestMemoriesMerged:
    def test_merge_order_and_item_contract(self, mem_env, client):
        r = client.get("/api/memories")
        assert r.status_code == 200, r.text
        body = r.json()
        assert [i["id"] for i in body["items"]] == MERGED_ORDER
        assert set(body["items"][0]) == {
            "id", "title", "tags", "status", "project", "created_at",
            "updated_at", "excerpt", "server",
        }
        by_id = {i["id"]: i for i in body["items"]}
        assert by_id["m-a1"]["server"] == SERVER_A
        assert by_id["m-b1"]["server"] == SERVER_B
        assert body["next_cursor"] is None      # both slices short → done
        assert body["truncated"] is False
        assert body["errors"] == []

    def test_created_at_desc_with_id_tiebreak(self, mem_env, client):
        _, fake_a, fake_b = mem_env
        tie = "2026-09-05T00:00:00+00:00"
        fake_a.memories_result = [mem("m-tie-b", tie)]
        fake_b.memories_result = [mem("m-tie-a", tie)]
        items = client.get("/api/memories").json()["items"]
        # uniform tiebreak: created_at DESC, id DESC (reverse tuple sort)
        assert [i["id"] for i in items] == ["m-tie-b", "m-tie-a"]

    def test_cursor_continuation_no_loss_no_dup(self, mem_env, client):
        seen: list[str] = []
        cursor = ""
        for _ in range(6):  # hard stop: pagination must terminate before this
            r = client.get("/api/memories", params={"limit": 2, "cursor": cursor})
            body = r.json()
            seen.extend(i["id"] for i in body["items"])
            cursor = body["next_cursor"]
            if cursor is None:
                break
        assert seen == MERGED_ORDER
        assert cursor is None

    def test_cursor_is_opaque_offsets_payload(self, mem_env, client):
        r = client.get("/api/memories", params={"limit": 2})
        cursor = r.json()["next_cursor"]
        assert cursor
        decoded = json.loads(base64.urlsafe_b64decode(cursor))
        assert decoded["v"] == 1
        assert set(decoded["offsets"]) == {SERVER_A, SERVER_B}
        assert decoded["offsets"] == {SERVER_A: 1, SERVER_B: 1}

    def test_limit_cap_marks_truncated(self, mem_env, client):
        r = client.get("/api/memories", params={"limit": 1000})
        assert r.status_code == 200
        body = r.json()
        assert len(body["items"]) <= 200
        assert body["truncated"] is True

    @pytest.mark.parametrize("bad_limit", [0, -5])
    def test_non_positive_limit_422(self, mem_env, client, bad_limit):
        assert client.get("/api/memories",
                          params={"limit": bad_limit}).status_code == 422

    def test_scope_single_server_only(self, mem_env, client):
        _, fake_a, fake_b = mem_env
        fake_b.requests.clear()
        r = client.get("/api/memories", params={"scope": SERVER_A})
        assert [i["id"] for i in r.json()["items"]] == ["m-a1", "m-a2", "m-a3"]
        assert all(i["server"] == SERVER_A for i in r.json()["items"])
        assert _listing_calls(fake_b) == []  # scoped out: never contacted

    def test_scope_unknown_server_404(self, mem_env, client):
        r = client.get("/api/memories", params={"scope": "no-such"})
        assert r.status_code == 404
        assert "no-such" in r.json()["detail"]

    def test_native_filters_pass_through(self, mem_env, client):
        client.get("/api/memories",
                   params={"status": "raw", "project": "mnemos"})
        calls = _listing_calls(mem_env[1])
        assert calls, "listing primitive not called"
        last = calls[-1]
        assert last.get("status") == ["raw"]
        assert last.get("project") == ["mnemos"]

    def test_one_failing_server_is_isolated(self, mem_env, client):
        app_module, fake_a, _ = mem_env
        app_module.store.upsert_server({
            "name": "qa-dead", "url": "http://127.0.0.1:9",
            "group_name": "default", "description": "", "token_ref": "",
        })
        app_module.registry.set_enabled("qa-dead", True)
        try:
            r = client.get("/api/memories", params={"scope": "all"})
            assert r.status_code == 200
            body = r.json()
            assert [i["id"] for i in body["items"]] == MERGED_ORDER
            assert [e["server"] for e in body["errors"]] == ["qa-dead"]
            assert body["errors"][0]["status"] == 503
        finally:
            app_module.store.delete_server("qa-dead")

    def test_invalid_cursor_422(self, mem_env, client):
        for bad in [
            "!!!not-base64!!!",                              # garbage
            _b64({"v": 2}),                                  # wrong version
            _b64({}),                                        # no offsets
            _b64({"v": 1, "offsets": {"x": -1}}),            # negative offset
            _b64({"v": 1, "offsets": {"x": "one"}}),         # non-int offset
        ]:
            r = client.get("/api/memories", params={"cursor": bad})
            assert r.status_code == 422, bad
            assert "cursor" in r.json()["detail"]

    def test_excerpt_and_title_caps(self, mem_env, client):
        _, fake_a, fake_b = mem_env
        fake_a.memories_result = [
            mem("m-wide", "2026-09-09T00:00:00+00:00", title="",
                content="c" * 500),
            mem("m-titled", "2026-09-08T00:00:00+00:00", title="T",
                content="x" * 500, tags=["project:from-tag"]),
        ]
        fake_b.memories_result = []
        items = {i["id"]: i for i in
                 client.get("/api/memories").json()["items"]}
        assert items["m-wide"]["excerpt"] == "c" * 200   # SEC-4 cap
        assert items["m-wide"]["title"] == "c" * 80      # content fallback
        assert items["m-titled"]["excerpt"] == "x" * 200
        assert items["m-titled"]["project"] == "from-tag"  # tag fallback

    def test_no_active_servers_empty_page(self, app_module, client):
        saved = {s["name"]: bool(s["enabled"])
                 for s in app_module.registry.servers()}
        for name in saved:
            app_module.registry.set_enabled(name, False)
        try:
            body = client.get("/api/memories").json()
            assert body == {"items": [], "next_cursor": None,
                            "truncated": False, "errors": []}
        finally:
            for name, enabled in saved.items():
                app_module.registry.set_enabled(name, enabled)


class TestTagsMerged:
    def test_aggregation_and_order(self, mem_env, client):
        _, fake_a, fake_b = mem_env
        fake_a.tags_result = [{"tag": "alpha", "count": 3},
                              {"tag": "beta", "count": 1}]
        fake_b.tags_result = [{"tag": "alpha", "count": 2},
                              {"tag": "gamma", "count": 5}]
        body = client.get("/api/tags").json()
        assert body["tags"] == [
            {"name": "alpha", "count": 5},   # summed across stores
            {"name": "gamma", "count": 5},   # count DESC, then name ASC
            {"name": "beta", "count": 1},
        ]
        assert body["servers_scanned"] == 2
        assert body["errors"] == []

    def test_failing_server_is_isolated(self, mem_env, client):
        app_module, _, _ = mem_env
        app_module.store.upsert_server({
            "name": "qa-dead", "url": "http://127.0.0.1:9",
            "group_name": "default", "description": "", "token_ref": "",
        })
        app_module.registry.set_enabled("qa-dead", True)
        try:
            r = client.get("/api/tags")
            assert r.status_code == 200
            body = r.json()
            assert body["servers_scanned"] == 2  # the two live fakes
            assert [e["server"] for e in body["errors"]] == ["qa-dead"]
        finally:
            app_module.store.delete_server("qa-dead")

    def test_malformed_records_skipped(self, mem_env, client):
        _, fake_a, fake_b = mem_env
        fake_a.tags_result = [{"tag": "ok", "count": 2},
                              {"tag": "bad-count", "count": "many"},
                              {"count": 7}, "junk"]
        fake_b.tags_result = []
        body = client.get("/api/tags").json()
        assert body["tags"] == [{"name": "ok", "count": 2}]
        assert body["servers_scanned"] == 2

    def test_empty_when_no_active_servers(self, app_module, client):
        saved = {s["name"]: bool(s["enabled"])
                 for s in app_module.registry.servers()}
        for name in saved:
            app_module.registry.set_enabled(name, False)
        try:
            assert client.get("/api/tags").json() == \
                {"tags": [], "servers_scanned": 0, "errors": []}
        finally:
            for name, enabled in saved.items():
                app_module.registry.set_enabled(name, enabled)


class TestContentFragment:
    """Unit contract of mnemos_client.content_fragment — the pulse wire
    field: <= 400 chars, whitespace-boundary cut, blank -> None."""

    def test_short_content_passes_through(self):
        assert mnemos_client.content_fragment("hello world") == "hello world"

    def test_exact_limit_kept_whole(self):
        text = "a" * 50 + " " + "b" * 349  # exactly 400 chars
        assert mnemos_client.content_fragment(text) == text

    def test_long_content_cut_at_whitespace(self):
        text = ("lorem " * 200).strip()  # 1199 chars, single-spaced words
        frag = mnemos_client.content_fragment(text)
        assert len(frag) <= 400
        assert text.startswith(frag)
        assert text[len(frag):len(frag) + 1] in ("", " ", "\t", "\n")

    def test_no_whitespace_in_window_hard_cut(self):
        assert mnemos_client.content_fragment("x" * 500) == "x" * 400

    @pytest.mark.parametrize("blank", ["", "   ", None])
    def test_blank_content_maps_to_none(self, blank):
        assert mnemos_client.content_fragment(blank) is None


class TestMemoryPulse:
    """Pulse items carry a truncated content fragment for the UI TextEngine:
    on the GET /memories path AND the POST /search fallback path, and
    through the merged /api/memories/pulse pass-through unchanged."""

    def test_items_carry_content_fragment(self, mem_env, client):
        r = client.get("/api/memories/pulse")
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        items = {i["id"]: i for i in body["items"]}
        assert set(items) == {"m-a1", "m-a2", "m-a3", "m-b1", "m-b2"}
        assert all(i["content"] == "body text" for i in items.values())
        assert items["m-a1"]["server"] == SERVER_A  # attribution intact

    def test_blank_content_is_null_not_missing(self, mem_env, client):
        _, fake_a, _ = mem_env
        fake_a.memories_result = [
            mem("m-blank", "2026-09-10T00:00:00+00:00", content="")]
        items = {i["id"]: i for i in client.get(
            "/api/memories/pulse", params={"scope": SERVER_A}).json()["items"]}
        assert "content" in items["m-blank"]
        assert items["m-blank"]["content"] is None

    def test_long_content_cut_at_whitespace_boundary(self, mem_env, client):
        _, fake_a, _ = mem_env
        text = ("lorem " * 200).strip()
        fake_a.memories_result = [
            mem("m-wide", "2026-09-10T00:00:00+00:00", content=text)]
        (item,) = client.get("/api/memories/pulse",
                             params={"scope": SERVER_A}).json()["items"]
        frag = item["content"]
        assert len(frag) <= 400
        assert text.startswith(frag)
        assert text[len(frag):len(frag) + 1] in ("", " ", "\t", "\n")

    def test_search_fallback_yields_fragment(self, mem_env, client):
        _, fake_a, _ = mem_env
        fake_a.fail_list = True            # GET /memories -> 500
        long = ("word " * 150).strip()     # 745 chars
        fake_a.search_results = [
            mem("m-fallback", "2026-09-10T00:00:00+00:00", content=long)]
        r = client.get("/api/memories/pulse", params={"scope": SERVER_A})
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        (item,) = body["items"]
        assert item["id"] == "m-fallback"
        frag = item["content"]
        assert len(frag) <= 400 and long.startswith(frag)
        assert long[len(frag):len(frag) + 1] in ("", " ", "\t", "\n")
        with fake_a.lock:
            posts = [q for q in fake_a.requests
                     if q["method"] == "POST" and q["path"] == "/search"]
        assert posts, "fallback must hit POST /search"

    def test_scoped_pulse_endpoint_carries_fragment(self, mem_env, client):
        r = client.get(f"/api/memories/servers/{SERVER_A}/pulse")
        assert r.status_code == 200, r.text
        items = r.json()["items"]
        assert items
        assert all(i["server"] == SERVER_A for i in items)
        assert all(i["content"] == "body text" for i in items)
