"""Memory-server API security: SEC-1 (SSRF egress policy, probe hygiene)
and SEC-2 (plain: rejection, legacy migration to 0600 file, masking in
API responses and server_log).

Ported from scripts/verify_security_sprint1.py (phases A4, B5–B11) into
the in-process contour. The script stays a standalone smoke tool and is
NOT imported here. Tests use the recorded-request FakeMnemos and the
connection-counting Decoy from conftest — validation failures must be
decided BEFORE any network activity, so the decoy staying at zero
connections is asserted without sleeps.
"""

from __future__ import annotations

import json
import socket
import sqlite3
from pathlib import Path

import pytest

from server.security import ValidationError, validate_memory_url

# Synthetic secret for the masking-fallback row (never printed anywhere).
QA_SECRET = "mnk_qa_masking_probe_secret_value"


def _add(client, auth, payload):
    return client.post("/api/memories/servers", json=payload, headers=auth)


# --------------------------------------------- SEC-2 legacy plain migration
class TestLegacyPlainMigrationOnBoot:
    """conftest pre-seeds a plain: row before app import; the registry
    must have migrated it to a 0600 file: ref on boot."""

    def test_api_reports_file_ref(self, client):
        rows = {s["name"]: s for s in
                client.get("/api/memories/servers").json()["servers"]}
        ref = rows["legacy1"]["token_ref"]
        assert ref.startswith("file:"), ref
        assert ref.endswith("legacy-legacy1.token")

    def test_secret_file_content_and_mode(self, legacy_secret, data_dir):
        path = data_dir / "secrets" / "legacy-legacy1.token"
        assert path.exists()
        assert path.read_text() == legacy_secret
        assert (path.stat().st_mode & 0o777) == 0o600

    def test_db_row_no_longer_plain(self, app_module):
        db = sqlite3.connect(app_module.DB_PATH)
        row = db.execute(
            "SELECT token_ref FROM memory_servers WHERE name='legacy1'"
        ).fetchone()
        db.close()
        assert row is not None and row[0].startswith("file:")


# ------------------------------------------------- SEC-1 add-time probe
class TestAddServerProbeHygiene:
    def test_valid_add_probes_fake_without_authorization(
            self, client, auth, fake_mnemos, allow_hosts):
        allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
        r = _add(client, auth, {
            "name": "fakesrv", "url": fake_mnemos.url,
            "token_ref": "env:NO_SUCH_VAR",
        })
        assert r.status_code == 201, r.text
        assert r.json()["probe_status"] == 200

        probes = [x for x in fake_mnemos.requests
                  if x["method"] == "POST" and x["path"] == "/search"]
        assert probes, "add-time reachability probe must have been sent"
        assert not any(p["auth_present"] for p in probes), \
            "SEC-1: the probe must carry NO Authorization header"

    def test_rejected_url_never_connects(self, client, auth, fake_mnemos,
                                         decoy, allow_hosts):
        """422 + decoy stays silent for every attacker-shaped URL.
        Validation happens before any network activity, so no sleep/wait:
        once the response is back, the decoy count is final."""
        allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
        cases = [
            ("http://10.255.255.1:9999", "private v4 host"),
            (f"http://127.0.0.1:{decoy.port}", "port outside allowlist"),
            ("http://user:pw@example.com", "userinfo in URL"),
            ("ftp://example.com", "non-http scheme"),
        ]
        for url, label in cases:
            r = _add(client, auth, {"name": "evil", "url": url})
            assert r.status_code == 422, f"{label}: {r.status_code} {r.text}"
            assert decoy.connections() == 0, \
                f"{label}: rejected URL was actually contacted"

    def test_duplicate_name_409(self, client, auth, fake_mnemos, allow_hosts):
        allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
        payload = {"name": "dup-srv", "url": fake_mnemos.url}
        assert _add(client, auth, payload).status_code == 201
        assert _add(client, auth, payload).status_code == 409

    def test_patch_to_disallowed_host_422(self, client, auth, fake_mnemos,
                                          allow_hosts):
        allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
        assert _add(client, auth, {
            "name": "patchme", "url": fake_mnemos.url}).status_code == 201
        r = client.patch("/api/memories/servers/patchme",
                         json={"name": "patchme", "url": "http://10.255.255.1"},
                         headers=auth)
        assert r.status_code == 422

    def test_patch_unknown_server_404(self, client, auth, fake_mnemos,
                                      allow_hosts):
        allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
        r = client.patch("/api/memories/servers/ghost",
                         json={"name": "ghost", "url": fake_mnemos.url},
                         headers=auth)
        assert r.status_code == 404


# ------------------------------------------- SEC-2 token_ref via the API
class TestTokenRefValidation:
    @pytest.mark.parametrize("ref,label", [
        (f"plain:{QA_SECRET}", "plain: rejected outright"),
        ("file:/etc/passwd", "file: outside provisioned secrets dir"),
        ("env:bad-name", "env: var name must match [A-Z_][A-Z0-9_]*"),
    ])
    def test_bad_token_ref_422(self, client, auth, fake_mnemos, allow_hosts,
                               ref, label):
        allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
        r = _add(client, auth, {"name": "eviltoken", "url": fake_mnemos.url,
                                "token_ref": ref})
        assert r.status_code == 422, f"{label}: {r.status_code}"

    def test_file_under_provisioned_dir_accepted(self, client, auth,
                                                 fake_mnemos, allow_hosts,
                                                 secrets_dir):
        allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
        secret_file = secrets_dir / "qa-provisioned.token"
        secret_file.write_text(QA_SECRET)
        r = _add(client, auth, {
            "name": "filesrv", "url": fake_mnemos.url,
            "token_ref": f"file:{secret_file}",
        })
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["has_token"] is True
        assert QA_SECRET not in r.text, "secret value must never be echoed"

    def test_empty_token_ref_ok_no_token(self, client, auth, fake_mnemos,
                                         allow_hosts):
        allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
        r = _add(client, auth, {"name": "tokenless", "url": fake_mnemos.url})
        assert r.status_code == 201
        assert r.json()["has_token"] is False


# ------------------------------- SEC-2 masking of a still-plain row (fallback)
class TestMaskingFallback:
    def test_plain_row_masked_in_api_response(self, client, auth,
                                              fake_mnemos, allow_hosts,
                                              app_module):
        """A plain: row written after boot (migration already ran) stays
        plain: in the DB but is masked in every API response."""
        allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
        app_module.store.upsert_server({
            "name": "maskme", "url": fake_mnemos.url, "group_name": "default",
            "description": "", "token_ref": f"plain:{QA_SECRET}",
        })
        try:
            r = client.get("/api/memories/servers")
            rows = {s["name"]: s for s in r.json()["servers"]}
            m = rows["maskme"]
            assert m["token_ref"] == "plain:<redacted>"
            assert m["has_token"] is True
            assert QA_SECRET not in r.text, "raw secret leaked in API response"
        finally:
            app_module.store.delete_server("maskme")

    def test_server_log_masked_on_write(self, client, auth, app_module):
        app_module.store.log_server_action(
            "maskme", "test",
            f"echo plain:{QA_SECRET} Bearer abc123 mnk_xyz")
        history = client.get("/api/memories/servers/maskme/history").json()
        details = [h.get("detail", "") for h in history.get("history", [])]
        assert details and details[0] == (
            "echo plain:<redacted> Bearer <redacted> mnk_<redacted>"
        )


# ------------------------------------------------------- server lifecycle
class TestServerLifecycle:
    def test_list_contains_legacy1(self, client):
        names = [s["name"] for s in
                 client.get("/api/memories/servers").json()["servers"]]
        assert "legacy1" in names

    def test_enable_disable_action(self, client, auth, fake_mnemos,
                                   allow_hosts):
        allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
        _add(client, auth, {"name": "lifesrv", "url": fake_mnemos.url})
        r = client.post("/api/memories/servers/lifesrv/action",
                        json={"action": "disable"}, headers=auth)
        assert r.status_code == 200 and r.json()["server"]["enabled"] is False
        r = client.post("/api/memories/servers/lifesrv/action",
                        json={"action": "enable"}, headers=auth)
        assert r.status_code == 200 and r.json()["server"]["enabled"] is True

    def test_unknown_action_422(self, client, auth):
        r = client.post("/api/memories/servers/legacy1/action",
                        json={"action": "detonate"}, headers=auth)
        assert r.status_code == 422

    def test_action_unknown_server_404(self, client, auth):
        r = client.post("/api/memories/servers/ghost/action",
                        json={"action": "enable"}, headers=auth)
        assert r.status_code == 404

    def test_delete_server(self, client, auth, fake_mnemos, allow_hosts):
        allow_hosts(f"127.0.0.1:{fake_mnemos.port}")
        _add(client, auth, {"name": "doomed-srv", "url": fake_mnemos.url})
        r = client.delete("/api/memories/servers/doomed-srv", headers=auth)
        assert r.status_code == 200
        names = [s["name"] for s in
                 client.get("/api/memories/servers").json()["servers"]]
        assert "doomed-srv" not in names
        assert client.delete("/api/memories/servers/doomed-srv",
                             headers=auth).status_code == 404


# ------------------------------- default egress policy (no allowlist env)
class TestDefaultEgressPolicy:
    """SEC-1 default policy (script phase A4): with NO allowlist env, only
    public hosts pass; loopback/private/metadata/unresolvable are denied
    BEFORE any connection. Pure unit level over validate_memory_url."""

    @pytest.mark.parametrize("url,label", [
        ("http://10.255.255.1", "private v4"),
        ("http://127.0.0.1:9999", "loopback"),
        ("http://169.254.169.254", "cloud metadata"),
        ("ftp://example.com", "bad scheme"),
    ])
    def test_rejected_without_network(self, no_allow_hosts, url, label):
        with pytest.raises(ValidationError):
            validate_memory_url(url)

    def test_unresolvable_host_denied(self, no_allow_hosts, monkeypatch):
        def _no_dns(host, *args, **kwargs):
            raise socket.gaierror(8, "hermetic: no resolution in tests")

        monkeypatch.setattr(socket, "getaddrinfo", _no_dns)
        with pytest.raises(ValidationError):
            validate_memory_url("http://cut-me-invalid.example")

    def test_public_ip_allowed_and_normalized(self, no_allow_hosts):
        url = "https://93.184.216.34/"
        assert validate_memory_url(url) == "https://93.184.216.34"

    def test_error_message_points_at_allowlist_env(self, no_allow_hosts):
        with pytest.raises(ValidationError, match="VESMARO_ALLOWED_MEMORY_HOSTS"):
            validate_memory_url("http://192.168.1.10")
