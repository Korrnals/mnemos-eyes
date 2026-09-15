"""Memory-server registry: multiple mnemos instances + groups (clusters).

The board can watch **several memory servers** at once — each a live mnemos
HTTP endpoint with its own bearer token — and treat them **individually or
as named groups ("memory clusters")**. This mirrors the deployment reality:

- ``cluster`` — the mnemos inside the ai-agent k3s cluster (in-cluster DNS),
- ``laptop``  — the operator's laptop mnemos (reachable from the cluster only
  if the mesh/federation path allows it; honest 503 when not).

Servers are declared in a YAML file on the mounted volume (``/data/memories.yaml``)
or injected via the ``VESMARO_MEMORY_SERVERS`` env (JSON). The registry lives
in the DB too (server rows carry runtime health), but the YAML/env file is the
source of truth for connection data — secrets never go into SQLite.

Token sources per server, in priority order:
  1. ``token_file``  — path on the mounted volume (e.g. mounted secret)
  2. ``token_env``   — name of an environment variable
  3. ``token``       — inline (dev convenience; avoid in committed configs)
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import yaml

DEFAULT_CONFIG_PATH = Path(os.environ.get("VESMARO_MEMORY_CONFIG", "/data/memories.yaml"))
ENV_JSON = os.environ.get("VESMARO_MEMORY_SERVERS", "")


def _resolve_token(spec: dict[str, Any]) -> str:
    if spec.get("token_file"):
        try:
            return Path(spec["token_file"]).read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    if spec.get("token_env"):
        return os.environ.get(str(spec["token_env"]), "")
    return str(spec.get("token", "") or "")


def load_servers() -> list[dict[str, Any]]:
    """Return declared memory servers.

    Each server: {name, url, token, group, description}. The ``cluster``
    server falls back to MNEMOS_URL/MNEMOS_TOKEN so the single-server
    deployment of v0 keeps working unchanged.
    """
    raw: list[dict[str, Any]] = []
    if ENV_JSON:
        try:
            parsed = json.loads(ENV_JSON)
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
    else:
        # v0 single-server fallback (cluster mnemos via env).
        raw = [
            {
                "name": "cluster",
                "url": os.environ.get("MNEMOS_URL", "http://agentsnode-mnemos:8787"),
                "token_env": "MNEMOS_TOKEN",
                "group": "abyss",
                "description": "mnemos in the ai-agent k3s cluster",
            }
        ]

    servers: list[dict[str, Any]] = []
    for i, spec in enumerate(raw):
        if not isinstance(spec, dict) or not spec.get("name") or not spec.get("url"):
            continue
        servers.append(
            {
                "name": str(spec["name"]),
                "url": str(spec["url"]).rstrip("/"),
                "token": _resolve_token(spec),
                "group": str(spec.get("group", "default")),
                "description": str(spec.get("description", "")),
                "primary": spec.get("primary", i == 0),
            }
        )
    if not servers:
        servers.append(
            {
                "name": "cluster",
                "url": os.environ.get("MNEMOS_URL", "http://agentsnode-mnemos:8787"),
                "token": os.environ.get("MNEMOS_TOKEN", ""),
                "group": "abyss",
                "description": "mnemos in the ai-agent k3s cluster",
                "primary": True,
            }
        )
    return servers


def groups_of(servers: list[dict[str, Any]]) -> dict[str, list[str]]:
    """group name -> ordered server names."""
    groups: dict[str, list[str]] = {}
    for s in servers:
        groups.setdefault(s["group"], []).append(s["name"])
    return groups


def config_doc_example() -> dict[str, Any]:
    return {
        "servers": [
            {
                "name": "cluster",
                "url": "http://agentsnode-mnemos:8787",
                "token_env": "MNEMOS_TOKEN",
                "group": "abyss",
            },
            {
                "name": "laptop",
                "url": "http://192.168.1.86:8787",
                "token_env": "MNEMOS_LAPTOP_TOKEN",
                "group": "abyss",
            },
        ]
    }


def write_config_template(path: Path) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "# vesmaro-eyes — memory servers registry\n"
        "# The board watches each mnemos server separately, or the servers\n"
        "# merged into a group (a \"memory cluster\").\n"
        "# Token resolution per server: token_file > token_env > token.\n"
        + yaml.safe_dump(config_doc_example(), sort_keys=False),
        encoding="utf-8",
    )