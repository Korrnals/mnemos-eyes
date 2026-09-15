"""HTTP client to the live mnemos memory engine.

The board server is the only component that talks to mnemos — the browser
SPA never sees mnemos credentials. In the ai-agent cluster we reach mnemos
via the in-cluster service ``agentsnode-mnemos:8787``; in local compose we
use a loopback URL from the environment.
"""

from __future__ import annotations

import os
import time
from typing import Any

import httpx

# A mnk_ API token with TOTP not required. Read from the environment; in the
# cluster it is injected from the existing ``mnemos-m2m-token`` secret.
MNEMOS_URL = os.environ.get("MNEMOS_URL", "http://agentsnode-mnemos:8787")
MNEMOS_TOKEN = os.environ.get("MNEMOS_TOKEN", "")

_TIMEOUT = httpx.Timeout(15.0, connect=2.0)


def _headers() -> dict[str, str]:
    h = {"Accept": "application/json"}
    if MNEMOS_TOKEN:
        h["Authorization"] = f"Bearer {MNEMOS_TOKEN}"
    return h


async def fetch_json(path: str, params: dict[str, Any] | None = None) -> tuple[int, Any]:
    """GET a path from mnemos. Returns (status_code, body)."""
    url = f"{MNEMOS_URL.rstrip('/')}{path}"
    async with httpx.AsyncClient(timeout=_TIMEOUT, headers=_headers()) as client:
        try:
            resp = await client.get(url, params=params)
        except httpx.HTTPError as exc:
            return 503, {"detail": f"mnemos unreachable: {exc.__class__.__name__}"}
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


async def post_json_async(path: str, body: dict[str, Any], timeout: float = 6.0) -> tuple[int, Any]:
    """POST JSON to mnemos asynchronously (usable inside async routes)."""
    url = f"{MNEMOS_URL.rstrip('/')}{path}"
    async with httpx.AsyncClient(timeout=httpx.Timeout(timeout), headers=_headers()) as client:
        try:
            resp = await client.post(url, json=body)
        except httpx.HTTPError as exc:
            return 503, {"detail": f"mnemos unreachable: {exc.__class__.__name__}"}
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


def post_json(path: str, body: dict[str, Any], timeout: float = 15.0) -> tuple[int, Any]:
    """POST JSON to mnemos (synchronous helper, used sparingly)."""
    url = f"{MNEMOS_URL.rstrip('/')}{path}"
    try:
        with httpx.Client(timeout=timeout, headers=_headers()) as client:
            resp = client.post(url, json=body)
    except httpx.HTTPError as exc:
        return 503, {"detail": f"mnemos unreachable: {exc.__class__.__name__}"}
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


async def health() -> dict[str, Any]:
    """Cheap async health probe used by /api/health aggregation.

    mnemos hybrid search vectorizes on CPU and can take ~5 s per query, so
    this probe uses a generous read timeout and reports honest latency.
    """
    started = time.monotonic()
    code, body = await post_json_async("/search", {"query": "vesmaro", "limit": 1}, timeout=8.0)
    latency_ms = round((time.monotonic() - started) * 1000, 1)
    ok = code == 200
    summary: dict[str, Any] = {
        "ok": ok,
        "http_status": code,
        "latency_ms": latency_ms,
        "url": MNEMOS_URL,
        "auth": bool(MNEMOS_TOKEN),
    }
    # mnemos POST /search returns a bare list of results.
    results = body if isinstance(body, list) else (body or {}).get("results", [])
    if ok:
        summary["probe_hits"] = len(results)
        summary["probe_top_score"] = results[0].get("score") if results else None
    else:
        summary["error"] = body.get("detail") if isinstance(body, dict) else str(body)
    return summary


async def memory_pulse(project: str = "mnemos-eyes", limit: int = 8) -> dict[str, Any]:
    """Recent memories for the live 'memory pulse' rail on the board."""
    code, body = await fetch_json("/memories", {"project": project, "limit": limit})
    if code != 200 or not isinstance(body, list):
        # Fall back to search — some deployments restrict listing.
        code2, body2 = await fetch_json("/search", {"query": project, "limit": limit})
        if code2 != 200 or not isinstance(body2, dict):
            return {"ok": False, "status": code, "detail": body}
        items = body2.get("results") or []
        return {
            "ok": True,
            "source": "search",
            "items": [
                {
                    "id": i.get("id"),
                    "title": i.get("title") or (i.get("content", "")[:80]),
                    "tags": i.get("tags", []),
                    "score": i.get("score"),
                    "status": i.get("status"),
                }
                for i in items
            ],
        }
    return {
        "ok": True,
        "source": "memories",
        "items": [
            {
                "id": i.get("id"),
                "title": i.get("title") or (i.get("content", "")[:80]),
                "tags": i.get("tags", []),
                "score": None,
                "status": i.get("status"),
            }
            for i in body
        ],
    }


async def resolve_memories(ids: list[str]) -> dict[str, Any]:
    """Resolve memory ids to cards for task drawers. Failures are honest."""
    out: dict[str, Any] = {"items": {}, "unresolved": []}
    for mid in ids[:12]:
        code, body = await fetch_json(f"/memories/{mid}")
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