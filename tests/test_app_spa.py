"""Phase 0a (ADR 0011): the /app viewer deployment surface.

- catch-all routes: /app and /app/ serve index.html; deep paths fall back
  to index.html (history-API routing); real files (assets) are served with
  an immutable cache header;
- traversal attempts are rejected (security verdict §5.4: path-join must
  never escape VESMARO_APP_DIR);
- a missing/empty VESMARO_APP_DIR answers 404 with an explanatory detail
  (an image without the Node stage is a legitimate state).

APP_DIR is monkeypatched per test — the handlers read the module global at
request time, so no re-import is needed.
"""

from __future__ import annotations

import pytest


@pytest.fixture()
def app_dir(app_module, tmp_path, monkeypatch):
    """A fake viewer dist: index.html + one hashed asset."""
    (tmp_path / "index.html").write_text(
        "<!doctype html><title>viewer</title>", encoding="utf-8")
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "app-D41D8CD.js").write_text("console.log('viewer')",
                                           encoding="utf-8")
    monkeypatch.setattr(app_module, "APP_DIR", tmp_path)
    return tmp_path


class TestAppCatchAll:
    def test_app_root_serves_index(self, client, app_dir):
        r = client.get("/app")
        assert r.status_code == 200, r.text
        assert "viewer" in r.text
        assert r.headers["Cache-Control"] == "no-cache"

    def test_app_trailing_slash_serves_index(self, client, app_dir):
        r = client.get("/app/")
        assert r.status_code == 200
        assert "viewer" in r.text

    def test_deep_route_falls_back_to_index(self, client, app_dir):
        """History-API routing: an unknown client route must return the
        SPA shell, not a 404."""
        r = client.get("/app/memory/42/recall")
        assert r.status_code == 200
        assert "viewer" in r.text

    def test_real_asset_is_served_immutable(self, client, app_dir):
        r = client.get("/app/assets/app-D41D8CD.js")
        assert r.status_code == 200
        assert "viewer" in r.text.replace("console.log('viewer')", "viewer") \
            or "console.log" in r.text
        assert r.headers["Cache-Control"] == "public, max-age=31536000, immutable"

    def test_traversal_attempt_rejected(self, client, app_dir):
        """Security verdict §5.4: dot-segments must not escape the dist.
        The board DB lives next to APP_DIR's parent in tests — reading it
        would prove traversal."""
        secret = app_dir.parent / "secret.txt"
        secret.write_text("board secret", encoding="utf-8")
        for raw_path in ("/app/../secret.txt", "/app/%2e%2e/secret.txt"):
            r = client.get(raw_path)
            assert r.status_code in (400, 404), raw_path
            assert "board secret" not in r.text

    def test_missing_dir_answers_404_with_detail(self, app_module, client,
                                                 tmp_path, monkeypatch):
        monkeypatch.setattr(app_module, "APP_DIR", tmp_path / "no-such-dir")
        r = client.get("/app")
        assert r.status_code == 404
        assert "viewer app is not deployed" in r.json()["detail"]
        deep = client.get("/app/some/route")
        assert deep.status_code == 404
        assert "VESMARO_APP_DIR" in deep.json()["detail"]

    def test_empty_dir_answers_404(self, app_module, client, tmp_path,
                                   monkeypatch):
        empty = tmp_path / "empty"
        empty.mkdir()
        monkeypatch.setattr(app_module, "APP_DIR", empty)
        assert client.get("/app").status_code == 404
        assert client.get("/app/anything").status_code == 404

    def test_board_root_unaffected(self, client, app_dir):
        """The frozen board at / keeps working with the viewer deployed."""
        r = client.get("/")
        assert r.status_code == 200
        assert "text/html" in r.headers["Content-Type"]
