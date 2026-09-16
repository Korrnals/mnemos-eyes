"""QA-1 pytest contour for vesmaro-eyes (sprint-1 stabilization gate).

Shared fixtures:
- ``client``        — in-process fastapi TestClient over server.app
                      (session-scoped; lifespan NOT started, so the
                      background profile refresher never runs)
- ``auth``          — valid Authorization headers for the test board token
- ``fake_mnemos``   — local threaded HTTP double of the mnemos engine that
                      records every request (method, path, Authorization
                      presence, JSON body)
- ``decoy``         — TCP listener that must stay at zero connections
                      (SSRF tripwire for rejected memory-server URLs)
- ``no_board_token`` — fail-closed mode (VESMARO_BOARD_TOKEN unset -> 503)
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
LEGACY_SECRET = "mnk_qa_fake_legacy_secret"  # synthetic; never printed

os.environ["VESMARO_DATA"] = str(DATA_DIR)
os.environ["VESMARO_SECRET_DIRS"] = str(SECRETS_DIR)
os.environ["VESMARO_MEMORY_CONFIG"] = str(DATA_DIR / "memories.yaml")  # absent
os.environ["VESMARO_BOARD_TOKEN"] = BOARD_TOKEN
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
        if self.path.startswith("/api/v1/stats"):
            self._reply(200, {"status": "ok", "volume": {"memories_total": 1}})
        elif self.path.startswith("/memories"):
            self._reply(200, [])
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
            self._reply(200, [])
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
    return {"Authorization": f"Bearer {BOARD_TOKEN}"}


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
    """Fail-closed mode: board token treated as NOT configured."""
    monkeypatch.setattr(app_module, "BOARD_WRITE_TOKEN", "")


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
def make_task(client, auth):
    """Create a task via the API; deletes it again on teardown."""
    created: list[str] = []

    def _make(**overrides) -> dict:
        payload = {"title": "qa task"} | overrides
        r = client.post("/api/tasks", json=payload, headers=auth)
        assert r.status_code == 201, r.text
        task = r.json()
        created.append(task["id"])
        return task

    yield _make
    for task_id in created:
        client.delete(f"/api/tasks/{task_id}", headers=auth)
