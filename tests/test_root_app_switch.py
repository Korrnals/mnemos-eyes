"""Phase 4 (ADR 0011): the VESMARO_ROOT_APP switch — which UI owns "/".

board (default — the import-time env is unset in this contour, see
conftest's hermetic pop-list):
- / is the frozen board (VESMARO_WEB), /app is the viewer, board assets
  keep working at their absolute root paths, unknown paths 404, and
  /board does not exist (pre-Ф4 parity);

app (the flipped layout):
- / serves the viewer index, /board serves the frozen board (index +
  assets), /app 302-redirects to / (bookmark survival), non-file /app
  paths redirect prefix-stripped, deep links like /tasks/42 fall back to
  the viewer index (history-API routing at the root), and viewer assets
  keep their immutable cache under /app/assets (the production vite base
  is /app/ in BOTH modes — asset URLs never move);
- a missing VESMARO_APP_DIR answers 404 with the explanatory detail on
  every viewer surface.

ROOT_APP is monkeypatched per test — handlers read the module global at
request time, the same contract as APP_DIR (see test_app_spa.py).
"""

from __future__ import annotations

import pytest

BOARD_MARKER = "task board"  # <title> of web/index.html (the frozen board)


@pytest.fixture()
def app_dir(app_module, tmp_path, monkeypatch):
    """A fake viewer dist: index.html + one hashed asset (test_app_spa's
    recipe, reused so both suites stay in sync)."""
    (tmp_path / "index.html").write_text(
        "<!doctype html><title>viewer</title>", encoding="utf-8")
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "app-D41D8CD.js").write_text("console.log('viewer')",
                                           encoding="utf-8")
    monkeypatch.setattr(app_module, "APP_DIR", tmp_path)
    return tmp_path


@pytest.fixture()
def root_app(app_module, monkeypatch):
    """Flip the module to the post-Ф4 layout: the viewer owns "/"."""
    monkeypatch.setattr(app_module, "ROOT_APP", "app")


class TestDefaultIsBoard:
    def test_import_time_default_is_board(self, app_module):
        """Empty env (conftest pops VESMARO_ROOT_APP) → board mode."""
        assert app_module.ROOT_APP == "board"

    def test_root_serves_board_index(self, client):
        r = client.get("/")
        assert r.status_code == 200, r.text
        assert BOARD_MARKER in r.text
        assert r.headers["Cache-Control"] == "no-cache"

    def test_board_assets_still_served_from_root_paths(self, client):
        """web/index.html references /styles/... absolutely — those URLs
        must keep answering in board mode exactly as before Ф4."""
        r = client.get("/styles/board.css")
        assert r.status_code == 200
        assert "css" in r.headers["Content-Type"]
        assert r.headers.get("Cache-Control") != "no-store"

    def test_unknown_path_404(self, client):
        assert client.get("/no/such/path").status_code == 404

    def test_board_route_does_not_exist(self, client):
        """Pre-Ф4 parity: /board is not a route while the board owns /."""
        assert client.get("/board").status_code == 404
        assert client.get("/board/styles/board.css").status_code == 404


class TestRootAppApp:
    def test_root_serves_viewer_index(self, client, root_app, app_dir):
        r = client.get("/")
        assert r.status_code == 200, r.text
        assert "viewer" in r.text
        assert BOARD_MARKER not in r.text
        assert r.headers["Cache-Control"] == "no-cache"

    def test_board_index_served_under_board(self, client, root_app):
        r = client.get("/board")
        assert r.status_code == 200, r.text
        assert BOARD_MARKER in r.text
        assert r.headers["Cache-Control"] == "no-cache"
        assert client.get("/board/").text == r.text

    def test_board_assets_under_board(self, client, root_app):
        r = client.get("/board/styles/board.css")
        assert r.status_code == 200
        assert "css" in r.headers["Content-Type"]

    def test_board_assets_from_absolute_root_paths(self, client, root_app):
        """The board's index.html hardcodes /styles/... — after the flip
        those absolute URLs must still resolve (the root catch-all serves
        board files before any SPA fallback)."""
        assert client.get("/styles/board.css").status_code == 200
        assert client.get("/js/app.js").status_code == 200

    def test_missing_board_asset_404(self, client, root_app):
        r = client.get("/board/styles/no-such.css")
        assert r.status_code == 404

    def test_app_redirects_to_root(self, client, root_app, app_dir):
        """Bookmark survival: bare /app 302s to the new root."""
        for path in ("/app", "/app/"):
            r = client.get(path, follow_redirects=False)
            assert r.status_code == 302, path
            assert r.headers["Location"] == "/"

    def test_app_client_route_redirects_prefix_stripped(self, client,
                                                        root_app, app_dir):
        r = client.get("/app/tasks/42", follow_redirects=False)
        assert r.status_code == 302
        assert r.headers["Location"] == "/tasks/42"
        # Followed end-to-end the bookmark still lands on the app shell.
        landed = client.get("/app/tasks/42")
        assert landed.status_code == 200
        assert "viewer" in landed.text

    def test_app_real_files_still_served(self, client, root_app, app_dir):
        """Vite's production base is /app/, so index.html references
        /app/assets/... — asset URLs keep working after the flip."""
        r = client.get("/app/assets/app-D41D8CD.js")
        assert r.status_code == 200
        assert r.headers["Cache-Control"] == \
            "public, max-age=31536000, immutable"

    def test_deep_link_falls_back_to_viewer_index(self, client, root_app,
                                                  app_dir):
        """History-API routing at the root: /tasks/42 is a client route."""
        r = client.get("/tasks/42")
        assert r.status_code == 200, r.text
        assert "viewer" in r.text
        assert r.headers["Cache-Control"] == "no-cache"

    def test_api_unaffected_by_flip(self, client, root_app):
        """The switch is pure static routing — /api keeps its contract."""
        r = client.get("/api/health")
        assert r.status_code == 200
        assert r.headers["Cache-Control"] == "no-store"

    def test_missing_app_dir_404_with_detail(self, app_module, client,
                                             root_app, tmp_path,
                                             monkeypatch):
        monkeypatch.setattr(app_module, "APP_DIR", tmp_path / "no-such-dir")
        r = client.get("/")
        assert r.status_code == 404
        assert "viewer app is not deployed" in r.json()["detail"]
        assert "/board" in r.json()["detail"]  # points at the board home
        deep = client.get("/tasks/x")
        assert deep.status_code == 404
        assert "VESMARO_APP_DIR" in deep.json()["detail"]

    def test_traversal_never_escapes_board_tree(self, client, root_app,
                                                tmp_path):
        secret = tmp_path / "secret.txt"
        secret.write_text("board secret", encoding="utf-8")
        for raw_path in ("/styles/%2e%2e/secret.txt",
                         "/board/%2e%2e/secret.txt",
                         "/%2e%2e/secret.txt"):
            r = client.get(raw_path)
            assert r.status_code in (400, 404), raw_path
            assert "board secret" not in r.text


class TestRootAppNormalizer:
    """The fail-safe contract of _normalize_root_app: a typo must never
    flip the root UI nor crash the pod — it lands on 'board'."""

    @pytest.mark.parametrize("raw,expected", [
        (None, "board"),
        ("", "board"),
        ("   ", "board"),
        ("board", "board"),
        ("BOARD", "board"),
        (" Board ", "board"),
        ("app", "app"),
        ("APP", "app"),
        (" app ", "app"),
        ("apa", "board"),      # typo → fail safe
        ("application", "board"),
    ])
    def test_values(self, app_module, raw, expected):
        assert app_module._normalize_root_app(raw) == expected
