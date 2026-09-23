"""Poller bootstrap — the ONE-COMMAND onboarding routes (wave 3D).

QA matrix (each test names its line):
- artifact routes are OPEN reads answering the REPO files byte-for-byte
  (the dev fallback resolves scripts/ and deploy/poller/ — the image path
  via VESMARO_POLLER_DIR is covered by the 404 test's env override);
- bootstrap.sh is served as text/x-shellscript; the artifacts as
  text/x-python and text/plain; ca.crt as application/x-x509-ca-cert;
- the packaged-dir env override wins: an EMPTY dir answers 404 for every
  artifact (honest "not packaged", never a guess);
- ca.crt is fail-closed by configuration: without VESMARO_TLS_CA_FILE →
  503 naming the chart fix; with a missing file → 503; with a real file →
  200 byte-for-byte (the chart mount contract, values pollerBootstrap.caFile);
- no-store rides the global /api/* middleware — an installer must never be
  cached between board upgrades;
- the served bootstrap.sh is the REAL script: it passes `bash -n` and
  shellcheck (when available) — the board never serves a broken installer.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
BOOTSTRAP_SH = REPO / "deploy" / "poller" / "bootstrap.sh"
POLLER_PY = REPO / "scripts" / "assignment_poller.py"
UNIT_SVC = REPO / "deploy" / "poller" / "vesmaro-assignment-poller.service"


@pytest.fixture(autouse=True)
def clean_artifact_env(monkeypatch):
    """The test contour never leaks an artifact-dir/CA override: the dev
    fallback (repo layout) must be the default resolution."""
    monkeypatch.delenv("VESMARO_POLLER_DIR", raising=False)
    monkeypatch.delenv("VESMARO_TLS_CA_FILE", raising=False)


# ------------------------------------------------------- repo byte-for-byte
class TestArtifactsFromRepo:
    def test_bootstrap_script_bytes_and_content_type(self, client):
        r = client.get("/api/poller/bootstrap.sh")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/x-shellscript")
        assert r.content == BOOTSTRAP_SH.read_bytes()

    def test_poller_py_bytes_and_content_type(self, client):
        r = client.get("/api/poller/artifacts/poller.py")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/x-python")
        assert r.content == POLLER_PY.read_bytes()

    def test_unit_bytes_and_content_type(self, client):
        r = client.get("/api/poller/artifacts/vesmaro-assignment-poller.service")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/plain")
        assert r.content == UNIT_SVC.read_bytes()

    def test_open_read_no_bearer(self, client):
        for path in ("/api/poller/bootstrap.sh",
                     "/api/poller/artifacts/poller.py",
                     "/api/poller/artifacts/vesmaro-assignment-poller.service"):
            assert client.get(path).status_code == 200

    def test_no_store_on_installer_responses(self, client):
        r = client.get("/api/poller/bootstrap.sh")
        assert r.headers["cache-control"] == "no-store"


# ------------------------------------------------------ packaged-dir env
class TestPackagedDirOverride:
    def test_empty_packaged_dir_404_every_artifact(self, client, app_module,
                                                   monkeypatch, tmp_path):
        monkeypatch.setenv("VESMARO_POLLER_DIR", str(tmp_path))
        for path in ("/api/poller/bootstrap.sh",
                     "/api/poller/artifacts/poller.py",
                     "/api/poller/artifacts/vesmaro-assignment-poller.service"):
            r = client.get(path)
            assert r.status_code == 404
            assert "VESMARO_POLLER_DIR" in r.json()["detail"]

    def test_packaged_dir_wins_over_repo(self, client, monkeypatch, tmp_path):
        marker = tmp_path / "bootstrap.sh"
        marker.write_bytes(b"#!/bin/sh\n# packaged copy\n")
        monkeypatch.setenv("VESMARO_POLLER_DIR", str(tmp_path))
        r = client.get("/api/poller/bootstrap.sh")
        assert r.status_code == 200
        assert r.content == marker.read_bytes()


# ---------------------------------------------------------------- ca.crt
class TestCaArtifact:
    def test_unmounted_ca_is_honest_503(self, client):
        r = client.get("/api/poller/artifacts/ca.crt")
        assert r.status_code == 503
        assert "VESMARO_TLS_CA_FILE" in r.json()["detail"]
        assert "pollerBootstrap" in r.json()["detail"]

    def test_missing_ca_file_is_503_not_guess(self, client, monkeypatch):
        monkeypatch.setenv("VESMARO_TLS_CA_FILE", "/nonexistent/ca.crt")
        r = client.get("/api/poller/artifacts/ca.crt")
        assert r.status_code == 503
        assert "fail-closed" in r.json()["detail"]

    def test_non_pem_file_is_refused_not_leaked(self, client, monkeypatch,
                                                tmp_path):
        """A mispointed env must not leak an arbitrary file (e.g. a secret
        key) to anonymous readers: only PEM certificates are servable."""
        secret_like = tmp_path / "not-a-cert"
        secret_like.write_bytes(b"VESMARO_BOARD_TOKEN=totally-not-a-cert\n")
        monkeypatch.setenv("VESMARO_TLS_CA_FILE", str(secret_like))
        r = client.get("/api/poller/artifacts/ca.crt")
        assert r.status_code == 503
        assert "PEM" in r.json()["detail"]
        assert b"totally-not-a-cert" not in r.content

    def test_mounted_ca_serves_bytes(self, client, monkeypatch, tmp_path):
        ca = tmp_path / "ca.crt"
        ca.write_bytes(b"-----BEGIN CERTIFICATE-----\nLAB\n-----END CERTIFICATE-----\n")
        monkeypatch.setenv("VESMARO_TLS_CA_FILE", str(ca))
        r = client.get("/api/poller/artifacts/ca.crt")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("application/x-x509-ca-cert")
        assert r.content == ca.read_bytes()


# --------------------------------------------- the served script is real
class TestServedScriptIsSound:
    def test_bootstrap_passes_bash_n(self, client):
        r = client.get("/api/poller/bootstrap.sh")
        proc = subprocess.run(["bash", "-n", "-"], input=r.content)
        assert proc.returncode == 0

    @pytest.mark.skipif(shutil.which("shellcheck") is None,
                        reason="shellcheck not installed")
    def test_bootstrap_passes_shellcheck(self, client):
        r = client.get("/api/poller/bootstrap.sh")
        proc = subprocess.run(
            ["shellcheck", "--severity=warning", "-"],
            input=r.content, capture_output=True)
        assert proc.returncode == 0, proc.stdout.decode()
