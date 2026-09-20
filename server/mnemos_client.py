"""HTTP client(s) to live mnemos memory engines.

Multi-server: the board watches several mnemos instances (see
``memory_registry``) — individually or merged into a group ("memory
cluster"). Every function takes a *server dict* ``{name,url,token,...}``
so callers address a specific engine; the browser never sees tokens.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

# mnemos hybrid search vectorizes on CPU and can take ~5 s per query.
_TIMEOUT = httpx.Timeout(15.0, connect=2.0)


def _headers(server: dict[str, Any]) -> dict[str, str]:
    h = {"Accept": "application/json"}
    token = server.get("token") or ""
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


async def fetch_json(server: dict[str, Any], path: str,
                     params: dict[str, Any] | None = None) -> tuple[int, Any]:
    """GET a path from one mnemos server. Returns (status_code, body)."""
    url = f"{server['url']}{path}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_headers(server)) as client:
            resp = await client.get(url, params=params)
    except httpx.HTTPError as exc:
        return 503, {"detail": f"{server['name']}: unreachable ({exc.__class__.__name__})"}
    if resp.status_code >= 400:
        try:
            body: Any = resp.json()
        except ValueError:
            body = {"detail": resp.text[:300]}
        return resp.status_code, body
    try:
        return resp.status_code, resp.json()
    except ValueError:
        return resp.status_code, {"detail": "mnemos returned non-JSON"}


async def post_json_async(server: dict[str, Any], path: str, body: dict[str, Any],
                          timeout: float = 8.0) -> tuple[int, Any]:
    """POST JSON to one mnemos server (async — usable inside async routes)."""
    url = f"{server['url']}{path}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(timeout), headers=_headers(server)) as client:
            resp = await client.post(url, json=body)
    except httpx.HTTPError as exc:
        return 503, {"detail": f"{server['name']}: unreachable ({exc.__class__.__name__})"}
    if resp.status_code >= 400:
        try:
            data: Any = resp.json()
        except ValueError:
            data = {"detail": resp.text[:300]}
        return resp.status_code, data
    try:
        return resp.status_code, resp.json()
    except ValueError:
        return resp.status_code, {"detail": "mnemos returned non-JSON"}


# ------------------------------------------------------------------ probes
# W5 (ROADMAP-v2 §5): mesh-node healthz probe. healthz is intentionally
# UNAUTHENTICATED (a mesh node must not hold board-class secrets, ADR
# 0009 Amd 2) and lives on the node's metrics address, so this client
# never attaches an Authorization header and never reads a token. Short
# timeout: the board health loop probes every node on request and a dead
# node must not stall it (honest-offline, same principle as store pings).
MESH_HEALTHZ_TIMEOUT_S = 3.0


async def mesh_node_healthz(node: dict[str, Any],
                            timeout: float = MESH_HEALTHZ_TIMEOUT_S
                            ) -> tuple[int, Any]:
    """GET {base_url}/healthz on a mesh node. Returns (status_code, body).

    200 + JSON dict is the healthy shape; 503 (with a ``detail``) means
    unreachable/timeout/non-JSON — the same honest-failure contract as
    fetch_json, minus any token plumbing.
    """
    url = f"{node['base_url']}/healthz"
    try:
        async with httpx.AsyncClient(
                timeout=httpx.Timeout(timeout, connect=min(timeout, 2.0)),
                headers={"Accept": "application/json"}) as client:
            resp = await client.get(url)
    except httpx.HTTPError as exc:
        return 503, {"detail": f"{node['name']}: unreachable ({exc.__class__.__name__})"}
    if resp.status_code >= 400:
        try:
            body: Any = resp.json()
        except ValueError:
            body = {"detail": resp.text[:300]}
        return resp.status_code, body
    try:
        return resp.status_code, resp.json()
    except ValueError:
        return resp.status_code, {"detail": "mesh node returned non-JSON"}


async def ping(server: dict[str, Any]) -> dict[str, Any]:
    """Cheap liveness probe: GET /health (no vectorize, no search).

    Used by the board's periodic health loop so the store indicator is
    stable: enabled+reachable = green, regardless of search latency.
    """
    started = time.monotonic()
    code, body = await fetch_json(server, "/health")
    return {
        "server": server["name"],
        "group": server.get("group_name", server.get("group", "default")),
        "ok": code == 200,
        "http_status": code,
        "latency_ms": round((time.monotonic() - started) * 1000, 1),
        "url": server["url"],
        "auth": bool(server.get("token")),
        "error": None if code == 200 else str(body.get("detail") if isinstance(body, dict) else body),
    }


async def health(server: dict[str, Any]) -> dict[str, Any]:
    """Deep probe: one real search (honest end-to-end latency)."""
    started = time.monotonic()
    code, body = await post_json_async(
        server, "/search", {"query": "vesmaro", "limit": 1}, timeout=12.0
    )
    latency_ms = round((time.monotonic() - started) * 1000, 1)
    ok = code == 200
    summary: dict[str, Any] = {
        "server": server["name"],
        "group": server.get("group", "default"),
        "ok": ok,
        "http_status": code,
        "latency_ms": latency_ms,
        "url": server["url"],
        "auth": bool(server.get("token")),
    }
    # mnemos POST /search returns a bare list of results.
    results = body if isinstance(body, list) else (body or {}).get("results", [])
    if ok:
        summary["probe_hits"] = len(results)
        summary["probe_top_score"] = results[0].get("score") if results else None
    else:
        summary["error"] = body.get("detail") if isinstance(body, dict) else str(body)
    return summary


async def store_stats(server: dict[str, Any]) -> dict[str, Any] | None:
    """Volume stats of one store (None when unreachable)."""
    code, body = await fetch_json(server, "/api/v1/stats")
    if code != 200 or not isinstance(body, dict):
        return None
    vol = body.get("volume", {})
    return {
        "memories_total": vol.get("memories_total"),
        "by_project": vol.get("by_project", {}),
        "by_agent": vol.get("by_agent", {}),
        "by_status": vol.get("by_status", {}),
        "version": body.get("version"),
    }


async def memory_pulse(server: dict[str, Any], project: str = "",
                       limit: int = 12) -> dict[str, Any]:
    """Recent memories from ONE store (optionally per project); with stats."""
    params: dict[str, Any] = {"limit": limit}
    if project:
        params["project"] = project
    code, body = await fetch_json(server, "/memories", params)
    if code != 200 or not isinstance(body, list):
        code2, body2 = await fetch_json(server, "/search", {"query": project or "vesmaro", "limit": limit})
        if code2 != 200 or not isinstance(body2, list):
            return {"server": server["name"], "ok": False, "status": code, "detail": body,
                    "items": []}
        items = body2
    else:
        items = body
    return {
        "server": server["name"],
        "group": server.get("group", "default"),
        "ok": True,
        "items": [
            {
                "id": i.get("id"),
                "title": i.get("title") or (i.get("content", "")[:80]),
                "tags": i.get("tags", []),
                "status": i.get("status"),
                "created_at": i.get("created_at"),
            }
            for i in items
        ],
    }


async def search(server: dict[str, Any], query: str, limit: int = 10,
                 project: str = "") -> tuple[int, Any]:
    """Hybrid search on ONE server (POST /search; mnemos is POST-only here)."""
    body: dict[str, Any] = {"query": query, "limit": min(limit, 25)}
    if project:
        body["project"] = project
    return await post_json_async(server, "/search", body, timeout=15.0)


async def resolve_memories(server: dict[str, Any], ids: list[str]) -> dict[str, Any]:
    """Resolve memory ids on ONE server for task drawers. Honest failures."""
    out: dict[str, Any] = {"server": server["name"], "items": {}, "unresolved": []}
    for mid in ids[:12]:
        code, body = await fetch_json(server, f"/memories/{mid}")
        if code == 200 and isinstance(body, dict):
            out["items"][mid] = {
                "id": mid,
                "title": body.get("title") or (body.get("content", "")[:80]),
                "tags": body.get("tags", []),
                "status": body.get("status"),
                "created_at": body.get("created_at"),
                "excerpt": (body.get("content", "") or "")[:220],
            }
        else:
            out["unresolved"].append({"id": mid, "status": code})
    return out