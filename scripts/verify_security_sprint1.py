#!/usr/bin/env python3
"""Sprint-1 security verification (SEC-1 / SEC-2 / SEC-3 / board-reflect).

Runs the agreed acceptance cases end-to-end against a local uvicorn
instance with throwaway data dirs and a fake mnemos engine. Never prints
secret values (only booleans/status codes).

Run (from the repo root):
    python3 -m venv /tmp/sec-venv
    /tmp/sec-venv/bin/pip install -q -r server/requirements.txt
    /tmp/sec-venv/bin/python scripts/verify_security_sprint1.py

Exit code 0 = all cases pass.
"""

from __future__ import annotations

import http.server
import json
import os
import shutil
import socket
import subprocess
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# Synthetic test secret — never printed, only compared.
FAKE_SECRET = "mnk_test_fake_secret_do_not_print"
DEV_TOKEN = "dev-verify-token"

RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail and not ok else ""))


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# ------------------------------------------------------------------ decoy
class Decoy:
    """Listener that counts inbound connections (must stay at 0)."""

    def __init__(self) -> None:
        self.count = 0
        self._lock = threading.Lock()
        self.port = free_port()
        self._srv = socket.socket()
        self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._srv.bind(("127.0.0.1", self.port))
        self._srv.listen(8)
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


# ------------------------------------------------------------- fake mnemos
class _FakeHandler(http.server.BaseHTTPRequestHandler):
    records: list[dict] = []
    lock = threading.Lock()

    def log_message(self, *args):  # silence
        pass

    def _record(self, body: bytes) -> None:
        with self.lock:
            _FakeHandler.records.append({
                "method": self.command,
                "path": self.path,
                "auth_present": bool(self.headers.get("Authorization")),
                "body": body.decode("utf-8", "replace") if body else "",
            })

    def _reply(self, code: int, payload: dict | list) -> None:
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._record(b"")
        self._reply(200, {"status": "ok", "volume": {"memories_total": 1}})

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        self._record(body)
        self._reply(201 if self.path == "/memories" else 200,
                    {"id": "fake-mem-1"} if self.path == "/memories" else [])


class FakeMnemos:
    def __init__(self) -> None:
        self.port = free_port()
        self._srv = http.server.ThreadingHTTPServer(("127.0.0.1", self.port), _FakeHandler)
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def requests(self) -> list[dict]:
        with _FakeHandler.lock:
            return list(_FakeHandler.records)

    def close(self) -> None:
        self._srv.shutdown()


# ----------------------------------------------------------------- server
def start_uvicorn(data_dir: Path, port: int, *, token: str | None,
                  allowlist: str | None) -> subprocess.Popen:
    env = os.environ.copy()
    env["VESMARO_DATA"] = str(data_dir)
    for var in ("VESMARO_BOARD_TOKEN", "VESMARO_ALLOWED_MEMORY_HOSTS",
                "VESMARO_MEMORY_SERVERS", "VESMARO_MEMORY_CONFIG",
                "VESMARO_SECRET_DIRS", "VESMARO_SECRET_DIR"):
        env.pop(var, None)
    if token is not None:
        env["VESMARO_BOARD_TOKEN"] = token
    if allowlist is not None:
        env["VESMARO_ALLOWED_MEMORY_HOSTS"] = allowlist
    # legacy plain: migration materializes secrets here; default /data/secrets
    # is not writable on dev boxes, so pin it inside the throwaway data dir
    secrets_dir = data_dir / "secrets"
    secrets_dir.mkdir(parents=True, exist_ok=True)
    env["VESMARO_SECRET_DIRS"] = str(secrets_dir)
    log = open(data_dir / "uvicorn.log", "w")
    return subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server.app:app",
         "--host", "127.0.0.1", "--port", str(port), "--log-level", "warning"],
        cwd=ROOT, env=env, stdout=log, stderr=log,
    )


def wait_health(base: str, timeout: float = 25.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if httpx.get(f"{base}/api/health", timeout=2).status_code == 200:
                return True
        except httpx.HTTPError:
            pass
        time.sleep(0.25)
    return False


def seed_plain_server(db_dir: Path, url: str) -> None:
    from server.store import Store

    Store(db_dir / "board.db").upsert_server({
        "name": "legacy1", "url": url, "group_name": "default",
        "description": "legacy seed", "token_ref": f"plain:{FAKE_SECRET}",
    })


# ------------------------------------------------------------------ phases
def phase_a() -> None:
    """Fail-closed guard with NO token configured + default egress policy."""
    from server.security import ValidationError, validate_memory_url

    data = Path(tempfile.mkdtemp(prefix="sec-a-"))
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = start_uvicorn(data, port, token=None, allowlist=None)
    try:
        check("A1: server boots without token", wait_health(base))
        r = httpx.post(f"{base}/api/tasks", json={"title": "x"}, timeout=5)
        check("A2: mutation without token -> 503", r.status_code == 503, str(r.status_code))
        r = httpx.post(f"{base}/api/tasks", json={"title": "x"},
                       headers={"Authorization": f"Bearer {DEV_TOKEN}"}, timeout=5)
        check("A3: mutation with ad-hoc token while unset -> 503 (fail-closed)",
              r.status_code == 503, str(r.status_code))
        # Default (no allowlist env) URL policy — validation happens before
        # any network activity, so no probe can be issued for these.
        for url, label in (("http://10.255.255.1", "private v4"),
                           ("http://127.0.0.1:9999", "loopback"),
                           ("http://169.254.169.254", "metadata"),
                           ("http://evil", "unresolvable"),
                           ("ftp://example.com", "bad scheme")):
            try:
                validate_memory_url(url)
                check(f"A4: default policy rejects {label} ({url})", False, "accepted")
            except ValidationError:
                check(f"A4: default policy rejects {label} ({url})", True)
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        shutil.rmtree(data, ignore_errors=True)


def phase_b() -> None:
    """Token configured: allowlist mode, probe hygiene, masking, migration,
    board-reflect tags + rate limit."""
    data = Path(tempfile.mkdtemp(prefix="sec-b-"))
    decoy = Decoy()
    fake = FakeMnemos()
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    auth = {"Authorization": f"Bearer {DEV_TOKEN}"}
    allowlist = f"127.0.0.1:{fake.port}"

    seed_plain_server(data, fake.url)  # legacy plain: row pre-boot
    proc = start_uvicorn(data, port, token=DEV_TOKEN, allowlist=allowlist)
    try:
        check("B1: server boots with token+allowlist", wait_health(base))

        # --- SEC-3 mutation guard
        r = httpx.post(f"{base}/api/tasks", json={"title": "x"}, timeout=5)
        check("B2: mutation without token -> 401", r.status_code == 401, str(r.status_code))
        r = httpx.post(f"{base}/api/tasks", json={"title": "x"},
                       headers={"Authorization": "Bearer wrong"}, timeout=5)
        check("B3: mutation with wrong token -> 401", r.status_code == 401, str(r.status_code))
        r = httpx.post(f"{base}/api/tasks", json={"title": "verify"}, headers=auth, timeout=5)
        check("B4: mutation with correct token -> 201", r.status_code == 201, str(r.status_code))

        # --- SEC-1 SSRF: rejected hosts, no connection to the decoy
        for url, label in ((f"http://10.255.255.1:9999", "private host"),
                           (f"http://127.0.0.1:{decoy.port}", "port outside allowlist"),
                           ("http://user:pw@example.com", "userinfo"),
                           ("ftp://example.com", "bad scheme")):
            r = httpx.post(f"{base}/api/memories/servers",
                           headers=auth, json={"name": "evil", "url": url}, timeout=5)
            time.sleep(0.8)
            check(f"B5: add {label} -> 422, no connection",
                  r.status_code == 422 and decoy.connections() == 0,
                  f"status={r.status_code} decoy={decoy.connections()}")

        # --- SEC-1/SEC-2 token_ref hardening via API
        for ref, label in ((f"plain:{FAKE_SECRET}", "plain:"),
                           ("file:/etc/passwd", "file outside secrets dir"),
                           ("env:bad-name", "bad env name")):
            r = httpx.post(f"{base}/api/memories/servers", headers=auth,
                           json={"name": "evil", "url": fake.url, "token_ref": ref}, timeout=5)
            check(f"B6: token_ref {label} -> 422", r.status_code == 422, str(r.status_code))

        # --- SEC-1 probe carries NO Authorization
        r = httpx.post(f"{base}/api/memories/servers", headers=auth,
                       json={"name": "fakesrv", "url": fake.url,
                             "token_ref": "env:NO_SUCH_VAR"}, timeout=15)
        check("B7: valid add -> 201", r.status_code == 201, str(r.status_code))
        probes = [x for x in fake.requests() if x["path"] == "/search" and x["method"] == "POST"]
        check("B7a: add-probe reached fake mnemos", bool(probes))
        check("B7b: add-probe had NO Authorization header",
              bool(probes) and not any(p["auth_present"] for p in probes))

        # --- PATCH validated too
        r = httpx.patch(f"{base}/api/memories/servers/fakesrv", headers=auth,
                        json={"name": "fakesrv", "url": "http://10.255.255.1"}, timeout=5)
        check("B8: PATCH to disallowed host -> 422", r.status_code == 422, str(r.status_code))

        # --- SEC-2 migration: legacy plain -> file (0600) at load
        r = httpx.get(f"{base}/api/memories/servers", timeout=5)
        rows = {x["name"]: x for x in r.json().get("servers", [])}
        legacy = rows.get("legacy1", {})
        ref = legacy.get("token_ref", "")
        migrated = ref.startswith("file:") and ref.endswith("legacy-legacy1.token")
        check("B9: legacy plain rewritten to file: ref", migrated, ref)
        if migrated:
            p = Path(ref[5:])
            check("B9a: secret file exists, content matches, mode 0600",
                  p.exists() and p.read_text() == FAKE_SECRET
                  and (p.stat().st_mode & 0o777) == 0o600)
        db = sqlite3.connect(data / "board.db")
        row = db.execute("SELECT token_ref FROM memory_servers WHERE name='legacy1'").fetchone()
        db.close()
        check("B9b: DB row no longer carries plain:", bool(row) and row[0].startswith("file:"),
              "" if not row else row[0][:12])

        # --- SEC-2 masking of a still-plain row (fallback path)
        from server.store import Store
        Store(data / "board.db").upsert_server({
            "name": "maskme", "url": fake.url, "group_name": "default",
            "description": "", "token_ref": f"plain:{FAKE_SECRET}",
        })
        r = httpx.get(f"{base}/api/memories/servers", timeout=5)
        text = r.text
        rows = {x["name"]: x for x in r.json().get("servers", [])}
        m = rows.get("maskme", {})
        check("B10: plain: masked in API (plain:<redacted>), has_token=true",
              m.get("token_ref") == "plain:<redacted>" and m.get("has_token") is True,
              json.dumps(m.get("token_ref", "")))
        check("B10a: raw secret value absent from API response", FAKE_SECRET not in text)

        # --- SEC-2 server_log masking (write-side)
        Store(data / "board.db").log_server_action(
            "maskme", "test", f"echo plain:{FAKE_SECRET} Bearer abc123 mnk_xyz")
        r = httpx.get(f"{base}/api/memories/servers/maskme/history", timeout=5)
        details = [h.get("detail", "") for h in r.json().get("history", [])]
        check("B11: server_log detail masked on write",
              bool(details) and details[0] == "echo plain:<redacted> Bearer <redacted> mnk_<redacted>",
              str(details[:1]))

        # --- board-reflect: tags + kind allowlist + rate limit
        r = httpx.post(f"{base}/api/board-reflect", headers=auth,
                       json={"specialist": "gcw-sre-devops", "problem": "check",
                             "kind": "agent-refine-request"}, timeout=15)
        check("B12: board-reflect -> 200", r.status_code == 200, f"{r.status_code} {r.text[:120]}")
        mems = [x for x in fake.requests() if x["path"] == "/memories"]
        payload = json.loads(mems[-1]["body"]) if mems else {}
        check("B12a: tags are exactly contract stamps + open-question + source:board",
              payload.get("tags") == ["project:mnemos-eyes", "agent:zcode",
                                      "mnemos:open-question", "source:board"],
              json.dumps(payload.get("tags")))
        check("B12b: no mnemos:decision anywhere in payload",
              "mnemos:decision" not in json.dumps(payload))
        r = httpx.post(f"{base}/api/board-reflect", headers=auth,
                       json={"specialist": "x", "problem": "y",
                             "kind": "mnemos:decision"}, timeout=5)
        check("B13: kind=mnemos:decision -> 422", r.status_code == 422, str(r.status_code))
        statuses = []
        for _ in range(12):
            statuses.append(httpx.post(f"{base}/api/board-reflect", headers=auth,
                                       json={"specialist": "x", "problem": "y",
                                             "kind": "agent-refine-request"},
                                       timeout=15).status_code)
        check("B14: rate limit engages (429 seen, last call limited)",
              429 in statuses and statuses[-1] == 429, str(statuses))

        # --- pure unit: deterministic RateLimiter
        from server.security import RateLimiter
        rl = RateLimiter(limit=3, window=60.0)
        outcomes = [rl.acquire("u") for _ in range(4)]
        check("B15: RateLimiter unit (3 pass, 4th blocked)",
              outcomes == [True, True, True, False], str(outcomes))
    finally:
        proc.terminate()
        proc.wait(timeout=10)
        decoy.close()
        fake.close()
        shutil.rmtree(data, ignore_errors=True)


def main() -> int:
    # Deterministic unit-policy tests: drop inherited operator overrides.
    for var in ("VESMARO_ALLOWED_MEMORY_HOSTS", "VESMARO_SECRET_DIRS",
                "VESMARO_SECRET_DIR"):
        os.environ.pop(var, None)
    phase_a()
    phase_b()
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed")
    if failed:
        print("FAILED:")
        for name, _, detail in failed:
            print(f"  - {name} {detail}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
