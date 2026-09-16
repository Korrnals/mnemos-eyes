"""Memory-server registry backed by the board DB (full UI CRUD).

Servers and groups live in SQLite (``memory_servers`` / ``memory_groups``)
— the UI can add, edit, enable/disable, pause/remove them. Tokens are
NEVER stored in the DB: a server row carries ``token_ref`` which resolves
at request time to a secret from

  1. ``env:<VARNAME>``  — environment variable
  2. ``file:<path>``    — file on the mounted volume (e.g. a mounted secret)
  3. ``plain:<token>``  — LEGACY ONLY (never accepted via the API since
     SEC-2; on load, existing plain refs are migrated to a 0600 file under
     the provisioned secrets directory, or kept but always masked in API
     responses when that is impossible)

On first boot the registry seeds itself from the legacy YAML config
(``/data/memories.yaml``) or the v0 env fallbacks, so existing deployments
migrate without manual steps.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import yaml

from .store import Store

DEFAULT_CONFIG_PATH = Path(os.environ.get("VESMARO_MEMORY_CONFIG", "/data/memories.yaml"))
ENV_JSON = os.environ.get("VESMARO_MEMORY_SERVERS", "")


def resolve_token(token_ref: str) -> str:
    if not token_ref:
        return ""
    if token_ref.startswith("env:"):
        return os.environ.get(token_ref[4:], "")
    if token_ref.startswith("file:"):
        try:
            return Path(token_ref[5:]).read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    if token_ref.startswith("plain:"):
        return token_ref[6:]
    return ""


def _materialize_plain(name: str, token: str) -> str | None:
    """Store a legacy plain: token as a 0600 file in the provisioned
    secrets directory (SEC-2 on-the-fly migration). Returns the file: ref,
    or None when the secret could not be written (row keeps plain: but is
    masked in every API response)."""
    from .security import secret_dirs

    try:
        secrets_dir = secret_dirs()[0]
        secrets_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(secrets_dir, 0o700)
        path = secrets_dir / f"legacy-{name}.token"
        if not (path.exists() and path.read_text(encoding="utf-8") == token):
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(token)
        return str(path)
    except OSError:
        return None


def _guess_token_ref(url: str, name: str) -> str:
    """Best-effort token_ref for YAML/env-migrated servers."""
    if name == "cluster":
        return "env:MNEMOS_TOKEN"
    if name == "laptop":
        return "env:MNEMOS_LAPTOP_TOKEN"
    return ""


def _legacy_specs() -> list[dict[str, Any]]:
    """Server specs from v0 sources: env JSON, then YAML, then env fallback."""
    raw: list[dict[str, Any]] = []
    if ENV_JSON:
        try:
            parsed = json_loads(ENV_JSON)
            if isinstance(parsed, list):
                raw = parsed
            elif isinstance(parsed, dict) and isinstance(parsed.get("servers"), list):
                raw = parsed["servers"]
        except ValueError:
            raw = []
    elif DEFAULT_CONFIG_PATH.exists():
        try:
            doc = yaml.safe_load(DEFAULT_CONFIG_PATH.read_text(encoding="utf-8")) or {}
            raw = doc.get("servers", []) if isinstance(doc, dict) else []
        except yaml.YAMLError:
            raw = []
    elif os.environ.get("MNEMOS_URL"):
        raw = [{
            "name": "cluster",
            "url": os.environ["MNEMOS_URL"],
            "token_env": "MNEMOS_TOKEN",
            "group": "abyss",
            "description": "mnemos in the ai-agent k3s cluster",
        }]
    out: list[dict[str, Any]] = []
    for spec in raw:
        if not isinstance(spec, dict) or not spec.get("name") or not spec.get("url"):
            continue
        name = str(spec["name"])
        token_ref = spec.get("token_ref") or (
            f"env:{spec['token_env']}" if spec.get("token_env") else ""
        ) or _guess_token_ref(str(spec["url"]), name)
        out.append({
            "name": name,
            "url": str(spec["url"]).rstrip("/"),
            "group_name": str(spec.get("group") or spec.get("group_name") or "default"),
            "description": str(spec.get("description", "")),
            "token_ref": token_ref,
            "enabled": bool(spec.get("enabled", True)),
        })
    return out


def json_loads(text: str) -> Any:
    import json
    return json.loads(text)


class ServerRegistry:
    """DB-backed registry; lazily migrates legacy YAML/env declarations."""

    def __init__(self, store: Store) -> None:
        self._store = store
        self._migrate_legacy()
        self._migrate_plain_refs()

    def _migrate_plain_refs(self) -> None:
        """SEC-2: rewrite legacy ``plain:<token>`` rows on load.

        Preferred: materialize the secret into a 0600 file under the
        provisioned secrets directory and store a ``file:`` ref. Fallback
        (write failed): the row keeps ``plain:`` but the raw value is never
        returned — app._server_public masks it and server-side log writes
        are scrubbed (store.mask_secrets). Empty ``plain:`` refs are cleared.
        """
        for row in self._store.list_servers():
            ref = row.get("token_ref") or ""
            if not ref.startswith("plain:"):
                continue
            base = {
                "name": row["name"],
                "url": row["url"],
                "group_name": row.get("group_name", "default"),
                "description": row.get("description", ""),
            }
            token = ref[6:]
            if not token:
                self._store.upsert_server({**base, "token_ref": ""})
                continue
            path = _materialize_plain(row["name"], token)
            if path is None:
                continue  # keep as-is; masked everywhere in the API
            self._store.upsert_server({**base, "token_ref": f"file:{path}"})

    def _migrate_legacy(self) -> None:
        if self._store.list_servers():
            return  # already seeded
        legacy = _legacy_specs()
        groups: set[str] = {"default"}
        for spec in legacy:
            groups.add(spec["group_name"])
        for g in sorted(groups):
            if g != "default":
                self._store.upsert_group(g)
        for spec in legacy:
            self._store.upsert_server(spec)

    # ---------------------------------------------------------------- read
    def servers(self, include_disabled: bool = True) -> list[dict[str, Any]]:
        rows = self._store.list_servers(include_disabled=include_disabled)
        for r in rows:
            r["token"] = resolve_token(r.get("token_ref", ""))
        return rows

    def active_servers(self) -> list[dict[str, Any]]:
        return [s for s in self.servers() if s.get("enabled") and s.get("state") != "paused"]

    def groups(self) -> list[dict[str, Any]]:
        return self._store.list_groups()

    # --------------------------------------------------------------- write
    def add_or_update(self, spec: dict[str, Any]) -> dict[str, Any]:
        return self._store.upsert_server(spec)

    def set_enabled(self, name: str, enabled: bool) -> dict[str, Any] | None:
        return self._store.set_server_enabled(name, enabled)

    def set_state(self, name: str, state: str) -> dict[str, Any] | None:
        return self._store.set_server_state(name, state)

    def set_group(self, name: str, group: str) -> dict[str, Any] | None:
        return self._store.set_server_group(name, group)

    def delete(self, name: str) -> bool:
        return self._store.delete_server(name)

    def save_group(self, name: str, title: str = "", description: str = "") -> dict[str, Any]:
        return self._store.upsert_group(name, title, description)

    def delete_group(self, name: str) -> bool:
        return self._store.delete_group(name)


def write_config_template(path: Path) -> None:
    """Kept for backwards compatibility; no longer required at startup."""
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "# vesmaro-eyes — memory servers registry (legacy seed file).\n"
        "# Since v0.3 servers are managed in the board UI (stored in board.db);\n"
        "# this file is only read once to seed the registry.\n",
        encoding="utf-8",
    )