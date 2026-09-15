"""vesmaro-eyes — task board server (FastAPI).

Serves the vanilla-JS SPA from ``../web`` and a small JSON API over the
board store, plus a narrow authenticated proxy to **one or more live
mnemos engines** (multi-server, groups = "memory clusters").

Run:    uvicorn server.app:app --host 0.0.0.0 --port 8080
Volume: /data (board.db + memories.yaml)
"""

from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import mnemos_client
from .memory_registry import (
    DEFAULT_CONFIG_PATH,
    groups_of,
    load_servers,
    write_config_template,
)
from .store import Store, VALID_STATUSES

DATA_DIR = Path(os.environ.get("VESMARO_DATA", "/data"))
DB_PATH = DATA_DIR / "board.db"
STATIC_DIR = Path(os.environ.get("VESMARO_WEB", Path(__file__).resolve().parents[1] / "web"))

# Board read/write is open on the LAN by design (the cluster ingress is the
# boundary); mnemos credentials stay server-side. Override to require a
# bearer for mutations if the board ever leaves the trust zone.
BOARD_WRITE_TOKEN = os.environ.get("VESMARO_BOARD_TOKEN", "")

write_config_template(DEFAULT_CONFIG_PATH)

store = Store(DB_PATH)

# SSE fan-out: subscribers get every board event as it is logged.
_subscribers: set[asyncio.Queue[dict[str, Any]]] = set()


def _broadcast(event: dict[str, Any]) -> None:
    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:  # pragma: no cover — queue is unbounded
            pass


def get_server(name: str) -> dict[str, Any]:
    for s in load_servers():
        if s["name"] == name:
            return s
    raise HTTPException(404, f"memory server '{name}' not declared")


def get_scope(scope: str) -> tuple[str, list[dict[str, Any]]]:
    """Resolve a scope: a single server name or a group name."""
    servers = load_servers()
    matched = [s for s in servers if s["name"] == scope]
    if matched:
        return "server", matched
    grouped = [s for s in servers if s["group"] == scope]
    if grouped:
        return "group", grouped
    raise HTTPException(404, f"no memory server or group named '{scope}'")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield


app = FastAPI(title="vesmaro-eyes", version="0.2.0", lifespan=lifespan)


# --------------------------------------------------------------------- models
class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    summary: str = ""
    spec: str = ""
    col: str = "open"
    env: str = "unknown"
    agents: list[str] = []
    specialists: list[str] = []
    project: str = ""
    memory_ids: list[str] = []
    mnemos_tags: list[str] = []


class TaskPatch(BaseModel):
    title: str | None = None
    summary: str | None = None
    spec: str | None = None
    env: str | None = None
    agents: list[str] | None = None
    specialists: list[str] | None = None
    project: str | None = None
    memory_ids: list[str] | None = None
    mnemos_tags: list[str] | None = None


class MoveBody(BaseModel):
    col: str
    position: int | None = None


# ------------------------------------------------------------------ board API
@app.get("/api/health")
async def health() -> dict[str, Any]:
    servers = load_servers()
    probes = await asyncio.gather(*(mnemos_client.health(s) for s in servers))
    stats = await asyncio.gather(*(mnemos_client.store_stats(s) for s in servers))
    per_server = []
    for s, p, st in zip(servers, probes, stats):
        per_server.append({
            "name": s["name"],
            "group": s["group"],
            "description": s["description"],
            "ok": p["ok"],
            "latency_ms": p["latency_ms"],
            "error": p.get("error"),
            "memories_total": (st or {}).get("memories_total"),
        })
    return {
        "ok": True,
        "service": "vesmaro-eyes",
        "board_tasks": sum(store.board()["counts"].values()),
        "servers": per_server,
        "groups": groups_of(servers),
    }


@app.get("/api/board")
async def board() -> dict[str, Any]:
    return store.board()


@app.post("/api/tasks", status_code=201)
async def create_task(body: TaskCreate, request: Request) -> dict[str, Any]:
    _guard_write(request)
    if body.col not in VALID_STATUSES:
        raise HTTPException(422, f"invalid col: {body.col}")
    task = store.create_task(body.model_dump())
    _broadcast({"kind": "task.created", "task": task})
    return task


@app.patch("/api/tasks/{task_id}")
async def patch_task(task_id: str, body: TaskPatch, request: Request) -> dict[str, Any]:
    _guard_write(request)
    task = store.update_task(task_id, body.model_dump(exclude_none=True))
    if task is None:
        raise HTTPException(404, "task not found")
    _broadcast({"kind": "task.updated", "task": task})
    return task


@app.post("/api/tasks/{task_id}/move")
async def move_task(task_id: str, body: MoveBody, request: Request) -> dict[str, Any]:
    _guard_write(request)
    try:
        task = store.move_task(task_id, body.col, body.position)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if task is None:
        raise HTTPException(404, "task not found")
    _broadcast({"kind": "task.moved", "task": task})
    return task


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str, request: Request) -> dict[str, Any]:
    _guard_write(request)
    if not store.delete_task(task_id):
        raise HTTPException(404, "task not found")
    _broadcast({"kind": "task.deleted", "task_id": task_id})
    return {"ok": True}


@app.get("/api/tasks/{task_id}/memories")
async def task_memories(task_id: str, scope: str = "") -> dict[str, Any]:
    """Resolve task memory links against a server, a group, or all servers.

    Multi-server: ids are attempted on every server in scope; a hit is
    attributed to the resolving server so the UI can show provenance.
    """
    task = store.task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    ids: list[str] = task.get("memory_ids") or []
    if not ids:
        return {"items": {}, "unresolved": [], "sources": {}}

    if scope:
        _, servers = get_scope(scope)
    else:
        servers = load_servers()

    results = await asyncio.gather(
        *(mnemos_client.resolve_memories(s, ids) for s in servers)
    )
    items: dict[str, Any] = {}
    unresolved: list[dict[str, Any]] = []
    sources: dict[str, str] = {}
    for s, r in zip(servers, results):
        for mid, card in r["items"].items():
            if mid not in items:
                items[mid] = card
                sources[mid] = s["name"]
        for u in r["unresolved"]:
            if u["id"] not in items and all(u["id"] != x["id"] for x in unresolved):
                unresolved.append({"id": u["id"], "status": u["status"],
                                   "server": s["name"]})
    # an id unresolved everywhere lists once per server; trim to first
    seen: set[str] = set()
    unresolved = [u for u in unresolved if not (u["id"] in seen or seen.add(u["id"]))]
    return {"items": items, "unresolved": unresolved, "sources": sources}


@app.get("/api/memories/servers")
async def memory_servers() -> dict[str, Any]:
    """Declared memory servers + groups (no tokens ever leave the server)."""
    servers = load_servers()
    probes = await asyncio.gather(*(mnemos_client.health(s) for s in servers))
    by_name = {p["server"]: p for p in probes}
    return {
        "ok": True,
        "servers": [
            {
                "name": s["name"],
                "group": s["group"],
                "description": s["description"],
                "url": s["url"],
                "ok": by_name.get(s["name"], {}).get("ok", False),
                "latency_ms": by_name.get(s["name"], {}).get("latency_ms"),
            }
            for s in servers
        ],
        "groups": groups_of(servers),
    }


@app.get("/api/memories/pulse")
async def memory_pulse_all(project: str = "mnemos-eyes", limit: int = 8,
                           scope: str = "") -> dict[str, Any]:
    """Merged pulse across scope (all servers | group | one server)."""
    if scope:
        kind, servers = get_scope(scope)
    else:
        kind, servers = "all", load_servers()
    limit = min(limit, 20)
    results = await asyncio.gather(
        *(mnemos_client.memory_pulse(s, project=project, limit=limit) for s in servers)
    )
    merged_items: list[dict[str, Any]] = []
    per_server: list[dict[str, Any]] = []
    for s, r in zip(servers, results):
        per_server.append({
            "server": s["name"], "ok": r["ok"],
            "items": len(r.get("items", [])), "detail": r.get("detail"),
        })
        for item in r.get("items", []):
            item["server"] = s["name"]
            merged_items.append(item)
    merged_items.sort(key=lambda i: i.get("created_at") or "", reverse=True)
    if not merged_items:
        # honest store stats per server when the project is empty everywhere
        stats = await asyncio.gather(*(mnemos_client.store_stats(s) for s in servers))
        store_stats = [
            {"server": s["name"], "stats": st}
            for s, st in zip(servers, stats)
        ]
        return {
            "ok": any(p["ok"] for p in per_server),
            "scope": scope or "all", "kind": kind, "items": [],
            "per_server": per_server, "store_stats": store_stats,
        }
    return {
        "ok": True, "scope": scope or "all", "kind": kind,
        "items": merged_items[:limit], "per_server": per_server,
    }


@app.get("/api/memories/servers/{scope}/pulse")
async def memory_pulse(scope: str, project: str = "mnemos-eyes", limit: int = 8) -> dict[str, Any]:
    """Pulse for one server OR a merged group pulse (items tagged by server)."""
    kind, servers = get_scope(scope)
    limit = min(limit, 20)
    results = await asyncio.gather(
        *(mnemos_client.memory_pulse(s, project=project, limit=limit) for s in servers)
    )
    merged_items: list[dict[str, Any]] = []
    per_server: list[dict[str, Any]] = []
    for s, r in zip(servers, results):
        per_server.append({
            "server": s["name"], "ok": r["ok"],
            "items": len(r.get("items", [])), "detail": r.get("detail"),
        })
        for item in r.get("items", []):
            item["server"] = s["name"]
            merged_items.append(item)
    merged_items.sort(key=lambda i: i.get("created_at") or "", reverse=True)
    if not merged_items:
        # honest store stats per server when the project is empty everywhere
        stats = await asyncio.gather(*(mnemos_client.store_stats(s) for s in servers))
        store_stats = [
            {"server": s["name"], "stats": st}
            for s, st in zip(servers, stats)
        ]
        return {
            "ok": all(p["ok"] for p in per_server),
            "scope": scope, "kind": kind, "items": [],
            "per_server": per_server, "store_stats": store_stats,
        }
    return {
        "ok": True, "scope": scope, "kind": kind,
        "items": merged_items[:limit], "per_server": per_server,
    }


@app.get("/api/memories/servers/{scope}/stats")
async def memory_stats(scope: str) -> dict[str, Any]:
    kind, servers = get_scope(scope)
    stats = await asyncio.gather(*(mnemos_client.store_stats(s) for s in servers))
    return {
        "ok": True, "scope": scope, "kind": kind,
        "stores": [
            {"server": s["name"], "group": s["group"], "stats": st or None}
            for s, st in zip(servers, stats)
        ],
    }


@app.get("/api/mnemos/search")
async def mnemos_search(q: str, limit: int = 10, project: str = "", scope: str = "") -> dict[str, Any]:
    """Search one server (scope=server name), a group, or the primary server."""
    servers = load_servers()
    if scope:
        _, scoped = get_scope(scope)
    else:
        scoped = [servers[0]]
    limit = min(limit, 25)
    results = await asyncio.gather(
        *(mnemos_client.search(s, q, limit=limit, project=project) for s in scoped)
    )
    merged: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for s, (code, data) in zip(scoped, results):
        if code != 200:
            errors.append({"server": s["name"], "status": code,
                           "detail": data.get("detail") if isinstance(data, dict) else str(data)})
            continue
        items = data if isinstance(data, list) else data.get("results", [])
        for it in items:
            if isinstance(it, dict):
                it["server"] = s["name"]
                merged.append(it)
    merged.sort(key=lambda i: i.get("score") or 0, reverse=True)
    return {"ok": not errors or bool(merged), "results": merged[:limit], "errors": errors}


def _guard_write(request: Request) -> None:
    if not BOARD_WRITE_TOKEN:
        return
    auth = request.headers.get("Authorization", "")
    if auth != f"Bearer {BOARD_WRITE_TOKEN}":
        raise HTTPException(401, "board write token required")


# ------------------------------------------------------------------------ SSE
@app.get("/api/events")
async def events() -> StreamingResponse:
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=256)
    _subscribers.add(queue)

    async def stream() -> AsyncIterator[bytes]:
        try:
            # Initial retry hint + a hello event so proxies flush headers.
            yield b"retry: 3000\n\n"
            yield _sse({"kind": "hello", "last_event_id": store.last_event_id()})
            while True:
                event = await queue.get()
                yield _sse(event)
        except asyncio.CancelledError:  # client disconnected
            pass
        finally:
            _subscribers.discard(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _sse(event: dict[str, Any]) -> bytes:
    import json

    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n".encode("utf-8")


# ----------------------------------------------------------------- static SPA
@app.get("/", include_in_schema=False)
async def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="web")