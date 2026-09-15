"""vesmaro-eyes — task board server (FastAPI).

Serves the vanilla-JS SPA from ``../web`` and a small JSON API over the
board store, plus a narrow authenticated proxy to the live mnemos engine.

Run:    uvicorn server.app:app --host 0.0.0.0 --port 8080
Volume: /data/board.db (WAL)
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
from .store import Store, VALID_STATUSES

DATA_DIR = Path(os.environ.get("VESMARO_DATA", "/data"))
DB_PATH = DATA_DIR / "board.db"
STATIC_DIR = Path(os.environ.get("VESMARO_WEB", Path(__file__).resolve().parents[1] / "web"))

# Board read/write is open on the LAN by design (the cluster ingress is the
# boundary); mnemos credentials stay server-side. Override to require a
# bearer for mutations if the board ever leaves the trust zone.
BOARD_WRITE_TOKEN = os.environ.get("VESMARO_BOARD_TOKEN", "")

store = Store(DB_PATH)

# SSE fan-out: subscribers get every board event as it is logged.
_subscribers: set[asyncio.Queue[dict[str, Any]]] = set()


def _broadcast(event: dict[str, Any]) -> None:
    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:  # pragma: no cover — queue is unbounded
            pass


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield


app = FastAPI(title="vesmaro-eyes", version="0.1.0", lifespan=lifespan)


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
    mnemos, pulse = await asyncio.gather(
        mnemos_client.health(),
        mnemos_client.memory_pulse(limit=1),
    )
    return {
        "ok": True,
        "service": "vesmaro-eyes",
        "board_tasks": sum(store.board()["counts"].values()),
        "mnemos": mnemos,
        "pulse_probe": {"ok": pulse["ok"]},
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
async def task_memories(task_id: str) -> dict[str, Any]:
    task = store.task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    ids: list[str] = task.get("memory_ids") or []
    if not ids:
        return {"items": {}, "unresolved": []}
    return await mnemos_client.resolve_memories(ids)


@app.get("/api/mnemos/tags")
async def mnemos_tags() -> dict[str, Any]:
    code, body = await mnemos_client.fetch_json("/tags")
    if code != 200:
        raise HTTPException(code, body if isinstance(body, str) else body.get("detail", "mnemos error"))
    return {"ok": True, "tags": body}


@app.get("/api/mnemos/pulse")
async def mnemos_pulse(project: str = "mnemos-eyes", limit: int = 8) -> dict[str, Any]:
    data = await mnemos_client.memory_pulse(project=project, limit=min(limit, 20))
    # Enrich with honest store stats — when the project has no memories here
    # (e.g. the laptop store is federated separately), say so instead of
    # pretending the memory is empty.
    if not data.get("items"):
        code, stats = await mnemos_client.fetch_json("/api/v1/stats")
        if code == 200 and isinstance(stats, dict):
            data["store_stats"] = {
                "memories_total": stats.get("volume", {}).get("memories_total"),
                "by_project": stats.get("volume", {}).get("by_project", {}),
            }
    return data


@app.get("/api/mnemos/search")
async def mnemos_search(q: str, limit: int = 10, project: str = "") -> dict[str, Any]:
    body: dict[str, Any] = {"query": q, "limit": min(limit, 25)}
    if project:
        body["project"] = project
    # mnemos search is POST-only; hybrid search takes ~5 s (CPU vectorize).
    code, data = await mnemos_client.post_json_async("/search", body, timeout=15.0)
    if code != 200:
        raise HTTPException(code, data if isinstance(data, str) else data.get("detail", "mnemos error"))
    results = data.get("results", data) if isinstance(data, dict) else data
    # mnemos /search returns a bare list of results.
    return {"ok": True, "results": results if isinstance(results, list) else []}


@app.get("/api/mnemos/memory/{memory_id}")
async def mnemos_memory(memory_id: str) -> dict[str, Any]:
    """Fetch one memory for display (opened from the pulse rail)."""
    code, body = await mnemos_client.fetch_json(f"/memories/{memory_id}")
    if code != 200:
        raise HTTPException(code, body if isinstance(body, str) else body.get("detail", "mnemos error"))
    return {"ok": True, "memory": body}


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