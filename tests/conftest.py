"""QA-1 pytest contour for vesmaro-eyes (sprint-1 stabilization gate).

Shared fixtures:
- ``client``        — in-process fastapi TestClient over server.app
                      (session-scoped; lifespan NOT started, so the
                      background profile refresher never runs)
- ``auth``          — valid Authorization headers for the test board token
                      (machine class; also passes ui-class guards in the
                      default transition env, see ``split_tokens``)
- ``ui_auth``       — Authorization headers for the ui-class test token
- ``machine_auth``  — alias of ``auth`` for tests that care about the class
- ``split_tokens``  — ADR 0009 A1 split mode: ui token configured with a
                      value distinct from the board token
- ``no_board_token`` — fail-closed mode (no token class configured -> 503)
- ``fake_mnemos``   — local threaded HTTP double of the mnemos engine that
                      records every request (method, path, Authorization
                      presence, JSON body)
- ``decoy``         — TCP listener that must stay at zero connections
                      (SSRF tripwire for rejected memory-server URLs)
- ``allow_hosts`` / ``no_allow_hosts`` — egress-allowlist env helpers
- ``fresh_reflect_limiter`` — per-test rate limiter reset
- ``make_task``     — create a task via the API, auto-delete on teardown

server.app reads VESMARO_* configuration at import time, so this module
pins a throwaway environment BEFORE anything imports server.app; the app
module is imported lazily, exactly once per session. A legacy ``plain:``
row is pre-seeded into the DB before that import so ServerRegistry runs
the SEC-2 plain->file migration on boot (asserted in
test_api_memory_servers.py).

This contour is independent from scripts/verify_security_sprint1.py: the
same security invariants are reimplemented here (the script stays a
standalone smoke tool and is never imported by tests).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ------------------------------------------------------------- environment
# Pinned at import time because server.app / memory_registry read these
# while being imported. Deterministic, hermetic: no legacy YAML/env seeds,
# no operator overrides leaking in from the shell.
DATA_DIR = Path(tempfile.mkdtemp(prefix="vesmaro-qa-"))
SECRETS_DIR = DATA_DIR / "secrets"
SECRETS_DIR.mkdir(parents=True, exist_ok=True)
BOARD_TOKEN = "qa-board-token"
# ADR 0009 A1: the ui-class token. Deliberately NOT pinned into the env —
# the default test contour mirrors today's deployment (transition: board
# token only), so existing guard tests exercise the ui fallback. Tests
# that need the full split opt in via the ``split_tokens`` fixture.
UI_TOKEN = "qa-ui-token"
LEGACY_SECRET = "mnk_qa_fake_legacy_secret"  # synthetic; never printed

os.environ["VESMARO_DATA"] = str(DATA_DIR)
os.environ["VESMARO_SECRET_DIRS"] = str(SECRETS_DIR)
os.environ["VESMARO_MEMORY_CONFIG"] = str(DATA_DIR / "memories.yaml")  # absent
os.environ["VESMARO_BOARD_TOKEN"] = BOARD_TOKEN
os.environ.pop("VESMARO_UI_TOKEN", None)
for _var in ("VESMARO_ALLOWED_MEMORY_HOSTS", "VESMARO_MEMORY_SERVERS",
             "MNEMOS_URL", "VESMARO_WEB"):
    os.environ.pop(_var, None)

# Pre-seed the legacy plain: row BEFORE server.app is imported anywhere, so
# the registry's on-boot SEC-2 migration (plain -> 0600 file) executes.
# legacy1 starts DISABLED so board-reflect tests deterministically hit the
# single server their fixture wires up.
from server.store import Store  # noqa: E402  (no import-time env reads)

Store(DATA_DIR / "board.db").upsert_server({
    "name": "legacy1", "url": "http://127.0.0.1:9", "group_name": "default",
    "description": "legacy seed row", "token_ref": f"plain:{LEGACY_SECRET}",
    "enabled": False,
})

_app_module = None


def get_app_module():
    """Import server.app exactly once, after the env above is pinned."""
    global _app_module
    if _app_module is None:
        import server.app as module
        _app_module = module
    return _app_module


# -------------------------------------------------------------- fake mnemos
class _FakeMnemosHandler(BaseHTTPRequestHandler):
    """Records every request on the owning FakeMnemos; never authenticates."""

    def log_message(self, *args):  # silence request logging
        pass

    def _record(self, body: bytes) -> None:
        fake: FakeMnemos = self.server.fake  # type: ignore[attr-defined]
        with fake.lock:
            fake.requests.append({
                "method": self.command,
                "path": self.path,
                "auth_present": bool(self.headers.get("Authorization")),
                "body": body.decode("utf-8", "replace") if body else "",
            })

    def _reply(self, code: int, payload) -> None:
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._record(b"")
        fake: FakeMnemos = self.server.fake  # type: ignore[attr-defined]
        if self.path.startswith("/memories/"):
            # single-memory card lookup (resolve_memories path); only ids
            # registered in fake.memory_cards resolve, everything else keeps
            # the legacy list reply -> unresolved
            mid = self.path[len("/memories/"):].split("?")[0]
            card = fake.memory_cards.get(mid)
            if card is not None:
                self._reply(200, card)
                return
        if self.path.startswith("/api/v1/stats"):
            self._reply(200, {"status": "ok", "volume": {"memories_total": 1}})
        elif self.path.startswith("/memories"):
            # AGG-1: with a tags query-param this is the tag LISTING the
            # task-inbox scanner reads; without it the merged-listing path
            # (Ф0b) gets a limit/offset window into fake.memories_result
            # (the legacy pulse path keeps its empty reply on the default)
            from urllib.parse import parse_qs, urlparse
            q = parse_qs(urlparse(self.path).query)
            if "tags" in q:
                self._reply(200, fake.listing_results)
            else:
                offset = int(q.get("offset", ["0"])[0])
                limit = int(q.get("limit", ["0"])[0])
                window = (fake.memories_result[offset:offset + limit]
                          if limit else fake.memories_result)
                self._reply(200, window)
        elif self.path.startswith("/tags"):
            # Ф0b: aggregated tag listing primitive (mnemos TagCount[])
            self._reply(200, fake.tags_result)
        else:  # /health and anything else
            self._reply(200, {"status": "ok"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        self._record(body)
        fake: FakeMnemos = self.server.fake  # type: ignore[attr-defined]
        if self.path == "/memories":
            if fake.fail_memories:
                self._reply(500, {"detail": "fake mnemos: intentional failure"})
                return
            with fake.lock:
                fake.mem_count += 1
                self._reply(201, {"id": f"fake-mem-{fake.mem_count}"})
        elif self.path == "/search":
            if fake.fail_search:
                self._reply(500, {"detail": "fake mnemos: intentional failure"})
                return
            # AGG-1: the task-inbox scanner (and any other tag-drill style
            # caller) reads hits from here; default stays [] for legacy tests
            self._reply(200, fake.search_results)
        else:
            self._reply(200, {})


class FakeMnemos:
    """Loopback mnemos engine double. ``fail_memories`` / ``fail_search``
    flip its write/search endpoints to 500 to exercise failure paths."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.lock = threading.Lock()
        self.fail_memories = False
        self.fail_search = False
        self.mem_count = 0
        # AGG-1: hits returned by POST /search (generic tags-filter callers);
        # default [] keeps legacy replies intact
        self.search_results: list[dict] = []
        # AGG-1: GET /memories?tags=... LISTING body (the task-inbox
        # scanner's primitive); without a tags param /memories replies []
        self.listing_results: list[dict] = []
        # Ф0b: GET /memories (no tags param) listing body — served as a
        # limit/offset window so cursor-pagination tests see a real
        # has-more signal (full page ⇒ maybe more); default [] keeps the
        # legacy pulse replies intact
        self.memories_result: list[dict] = []
        # Ф0b: GET /tags reply (mnemos TagCount[] shape)
        self.tags_result: list[dict] = []
        # memory id -> full card dict served by GET /memories/{id}
        # (BE-7 history tests wire task-linked checkpoints here)
        self.memory_cards: dict[str, dict] = {}
        self._srv = ThreadingHTTPServer(("127.0.0.1", 0), _FakeMnemosHandler)
        self._srv.daemon_threads = True
        self._srv.fake = self  # type: ignore[attr-defined]
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()
        self.port = self._srv.server_address[1]

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def memories_bodies(self) -> list[dict]:
        """Parsed JSON bodies of all POST /memories writes."""
        with self.lock:
            return [json.loads(r["body"]) for r in self.requests
                    if r["method"] == "POST" and r["path"] == "/memories"]

    def listing_requests(self) -> list[str]:
        """Query strings of all GET /memories tag-listing calls."""
        with self.lock:
            return [r["path"].split("?", 1)[1] for r in self.requests
                    if r["method"] == "GET" and r["path"].startswith("/memories?")
                    and "tags=" in r["path"]]

    def close(self) -> None:
        self._srv.shutdown()
        self._srv.server_close()


# -------------------------------------------------------------------- decoy
class Decoy:
    """TCP listener that counts accepted connections. Any nonzero count in
    a test that expects 0 means a 'rejected' URL was actually contacted."""

    def __init__(self) -> None:
        import socket
        self.count = 0
        self._lock = threading.Lock()
        self._srv = socket.socket()
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind(("127.0.0.1", 0))
        self._srv.listen(8)
        self.port = self._srv.getsockname()[1]
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def _loop(self) -> None:
        while True:
            try:
                conn, _ = self._srv.accept()
            except OSError:
                return
            with self._lock:
                self.count += 1
            conn.close()

    def connections(self) -> int:
        with self._lock:
            return self.count

    def close(self) -> None:
        self._srv.close()


# ----------------------------------------------------------------- fixtures
@pytest.fixture(scope="session")
def app_module():
    return get_app_module()


@pytest.fixture(scope="session")
def client(app_module):
    from fastapi.testclient import TestClient
    # No context manager -> lifespan (background refresher loop) stays off.
    return TestClient(app_module.app)


@pytest.fixture()
def auth():
    """Board (machine-class) token headers; passes ui-class guards too in
    the default transition env — mirrors today's single-token deploy."""
    return {"Authorization": f"Bearer {BOARD_TOKEN}"}


@pytest.fixture()
def ui_auth(app_module):
    """Ui-class token headers — the CURRENTLY effective ui token (module
    globals read live, so tests that enable ``split_tokens`` before the
    request still get the right bearer; transition env falls back to the
    board token, mirroring _token_classes())."""
    effective = app_module.UI_WRITE_TOKEN or app_module.BOARD_WRITE_TOKEN
    return {"Authorization": f"Bearer {effective}"}


@pytest.fixture()
def machine_auth():
    """Machine-class token headers (same bearer as ``auth``; named for
    tests that assert the class split explicitly)."""
    return {"Authorization": f"Bearer {BOARD_TOKEN}"}


@pytest.fixture()
def split_tokens(app_module, monkeypatch):
    """ADR 0009 A1 split mode: ui token configured with a value distinct
    from the board token. From here on the machine token must STOP passing
    ui-class guards (and vice versa: the ui token is not machine-class)."""
    monkeypatch.setattr(app_module, "UI_WRITE_TOKEN", UI_TOKEN)


@pytest.fixture()
def data_dir() -> Path:
    return DATA_DIR


@pytest.fixture()
def secrets_dir() -> Path:
    return SECRETS_DIR


@pytest.fixture()
def legacy_secret() -> str:
    return LEGACY_SECRET


@pytest.fixture()
def fake_mnemos():
    fake = FakeMnemos()
    yield fake
    fake.close()


@pytest.fixture()
def decoy():
    d = Decoy()
    yield d
    d.close()


@pytest.fixture()
def no_board_token(app_module, monkeypatch):
    """Fail-closed mode: NO token class configured at all — every
    mutation answers 503, reads stay open."""
    monkeypatch.setattr(app_module, "BOARD_WRITE_TOKEN", "")
    monkeypatch.setattr(app_module, "UI_WRITE_TOKEN", "")


@pytest.fixture()
def allow_hosts(monkeypatch):
    """Set VESMARO_ALLOWED_MEMORY_HOSTS to the given comma-separated entries."""
    def _set(entries: str) -> None:
        monkeypatch.setenv("VESMARO_ALLOWED_MEMORY_HOSTS", entries)
    return _set


@pytest.fixture()
def no_allow_hosts(monkeypatch):
    """Default egress policy (env unset): public hosts only."""
    monkeypatch.delenv("VESMARO_ALLOWED_MEMORY_HOSTS", raising=False)


@pytest.fixture()
def fresh_reflect_limiter(app_module, monkeypatch):
    """Fresh per-test rate limiter (the app-level one is a module global)."""
    from server.security import RateLimiter
    limiter = RateLimiter(limit=app_module._REFLECT_RATE_LIMIT,
                          window=app_module._REFLECT_RATE_WINDOW)
    monkeypatch.setattr(app_module, "_reflect_limiter", limiter)
    return limiter


@pytest.fixture()
def make_task(client, app_module):
    """Create a task via the API; deletes it again on teardown.

    Task creation is a ui mutation (ADR 0009 A1); the bearer is resolved
    per call from the module globals so tests that toggle the split
    before creating still work; transition mode falls back to the board
    token.
    """
    created: list[str] = []

    def _make(**overrides) -> dict:
        effective = app_module.UI_WRITE_TOKEN or app_module.BOARD_WRITE_TOKEN
        headers = {"Authorization": f"Bearer {effective}"}
        payload = {"title": "qa task"} | overrides
        r = client.post("/api/tasks", json=payload, headers=headers)
        assert r.status_code == 201, r.text
        task = r.json()
        created.append(task["id"])
        return task

    yield _make
    effective = app_module.UI_WRITE_TOKEN or app_module.BOARD_WRITE_TOKEN
    headers = {"Authorization": f"Bearer {effective}"}
    for task_id in created:
        client.delete(f"/api/tasks/{task_id}", headers=headers)
