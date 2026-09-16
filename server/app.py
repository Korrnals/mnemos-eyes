"""vesmaro-eyes — task board server (FastAPI).

Serves the vanilla-JS SPA from ``../web`` and a small JSON API over the
board store, plus a narrow authenticated proxy to **one or more live
mnemos engines** (multi-server, groups = "memory clusters"), with full
UI management: add/edit/enable/disable/pause/remove servers and groups.

Run:    uvicorn server.app:app --host 0.0.0.0 --port 8080
Volume: /data (board.db)
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
from .memory_registry import ServerRegistry, write_config_template
from .store import Store, VALID_STATUSES

DATA_DIR = Path(os.environ.get("VESMARO_DATA", "/data"))
DB_PATH = DATA_DIR / "board.db"
STATIC_DIR = Path(os.environ.get("VESMARO_WEB", Path(__file__).resolve().parents[1] / "web"))

# Board read/write is open on the LAN by design (the cluster ingress is the
# boundary); mnemos credentials stay server-side. Override to require a
# bearer for mutations if the board ever leaves the trust zone.
BOARD_WRITE_TOKEN = os.environ.get("VESMARO_BOARD_TOKEN", "")

write_config_template(DATA_DIR / "memories.yaml")

store = Store(DB_PATH)
registry = ServerRegistry(store)

# SSE fan-out: subscribers get every board event as it is logged.
_subscribers: set[asyncio.Queue[dict[str, Any]]] = set()


def _broadcast(event: dict[str, Any]) -> None:
    for q in list(_subscribers):
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:  # pragma: no cover — queue is unbounded
            pass


def _notify_and_broadcast(category: str, title: str, message: str = "",
                          task_id: str | None = None, event: dict[str, Any] | None = None) -> None:
    """Persist a notification, then broadcast it together with the board event."""
    n = store.notify(category, title, message, task_id)
    if event:
        event["notification"] = n
    _broadcast(event or {"kind": "notification", "notification": n})


def get_scope_servers(scope: str, active_only: bool = False) -> tuple[str, list[dict[str, Any]]]:
    """Resolve scope: 'all' | group name | server name → server list."""
    servers = registry.active_servers() if active_only else registry.servers()
    matched = [s for s in servers if s["name"] == scope]
    if matched:
        return "server", matched
    grouped = [s for s in servers if s["group_name"] == scope]
    if grouped:
        return "group", grouped
    if scope == "all":
        return "all", [s for s in servers if s.get("enabled")]
    raise HTTPException(404, f"no memory server or group named '{scope}'")


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    yield


COLUMN_RU = {
    "open": "открыто", "in-progress": "в работе", "blocked": "блокировано",
    "resolved": "решено", "done": "готово",
}

app = FastAPI(title="vesmaro-eyes", version="0.7.0", lifespan=lifespan)


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


class ServerSpec(BaseModel):
    """Create/update a memory server connection. token: never returned."""
    name: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    url: str = Field(min_length=1)
    group_name: str = "default"
    description: str = ""
    token_ref: str = ""          # env:VAR | file:/path | plain:token
    enabled: bool = True


class ServerAction(BaseModel):
    action: str  # enable | disable | pause | resume | reload | sync | test


class GroupSpec(BaseModel):
    name: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    title: str = ""
    description: str = ""


# ------------------------------------------------------------------ board API
@app.get("/api/health")
async def health() -> dict[str, Any]:
    servers = registry.servers()
    probes = await asyncio.gather(*(mnemos_client.ping(s) for s in servers))
    stats = await asyncio.gather(*(mnemos_client.store_stats(s) for s in servers))
    per_server = []
    for s, p, st in zip(servers, probes, stats):
        per_server.append({
            "name": s["name"],
            "group_name": s["group_name"],
            "enabled": bool(s["enabled"]),
            "state": s["state"],
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
        "groups": store.list_groups(),
    }


@app.get("/api/board")
async def board() -> dict[str, Any]:
    return store.board()


@app.post("/api/tasks", status_code=201)
async def create_task(body: TaskCreate, request: Request) -> dict[str, Any]:
    _guard_write(request)
    if body.col not in VALID_STATUSES:
        raise HTTPException(422, f"invalid col: {body.col}")
    # harness validation: agents must be execution harnesses, not roles
    bad = [a for a in body.agents if a.startswith("gcw-") or a.startswith("@")]
    if bad:
        raise HTTPException(422, f"agents must be harnesses (zcode, hermes, ...), not roles: {bad}; use specialists for @GCW roles")
    task = store.create_task(body.model_dump())
    _notify_and_broadcast("work", f"{task['id']}: новая задача", task["title"][:120], task["id"], {"kind": "task.created", "task": task})
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
    _notify_and_broadcast("work", f"{task['id']}: статус → {COLUMN_RU.get(task['col'], task['col'])}", "", task["id"], {"kind": "task.moved", "task": task})
    return task


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: str, request: Request) -> dict[str, Any]:
    _guard_write(request)
    if not store.delete_task(task_id):
        raise HTTPException(404, "task not found")
    _notify_and_broadcast("work", f"{task_id}: удалена", "", task_id, {"kind": "task.deleted", "task_id": task_id})
    return {"ok": True}


@app.get("/api/tasks/{task_id}/memories")
async def task_memories(task_id: str, scope: str = "") -> dict[str, Any]:
    """Resolve task memory links against a server, a group, or all servers."""
    task = store.task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    ids: list[str] = task.get("memory_ids") or []
    if not ids:
        return {"items": {}, "unresolved": [], "sources": {}}

    if scope and scope != "all":
        _, servers = get_scope_servers(scope)
    else:
        servers = registry.active_servers()

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
    seen: set[str] = set()
    unresolved = [u for u in unresolved if not (u["id"] in seen or seen.add(u["id"]))]
    return {"items": items, "unresolved": unresolved, "sources": sources}


# ------------------------------------------------------- memory servers CRUD
def _server_public(s: dict[str, Any]) -> dict[str, Any]:
    """Public shape — never includes the token itself."""
    return {
        "name": s["name"],
        "url": s["url"],
        "group_name": s["group_name"],
        "description": s["description"],
        "enabled": bool(s["enabled"]),
        "state": s["state"],
        "token_ref": s.get("token_ref", ""),
        "has_token": bool(s.get("token")),
    }


@app.get("/api/memories/servers")
async def memory_servers() -> dict[str, Any]:
    rows = registry.servers()
    probes = await asyncio.gather(*(mnemos_client.ping(s) for s in rows))
    by_name = {p["server"]: p for p in probes}
    return {
        "ok": True,
        "servers": [
            {**_server_public(s),
             "ok": by_name.get(s["name"], {}).get("ok", False),
             "latency_ms": by_name.get(s["name"], {}).get("latency_ms")}
            for s in rows
        ],
        "groups": registry.groups(),
    }


@app.post("/api/memories/servers", status_code=201)
async def add_memory_server(body: ServerSpec, request: Request) -> dict[str, Any]:
    _guard_write(request)
    url = body.url.rstrip("/")
    existing = store.get_server(body.name)
    if existing is None:
        # verify reachability before first save (honest, non-blocking)
        probe_spec = {"name": body.name, "url": url, "token": _token_for(body.token_ref)}
        code, _ = await mnemos_client.post_json_async(probe_spec, "/search",
                                                      {"query": "ping", "limit": 1}, timeout=6.0)
        row = registry.add_or_update({
            "name": body.name, "url": url, "group_name": body.group_name,
            "description": body.description, "token_ref": body.token_ref,
        })
        store.log_server_action(body.name, "added", f"probe http {code}")
        if code == 503:
            row = registry.set_state(body.name, "error") or row
        _broadcast({"kind": "server.changed"})
        return {**_server_public(row), "probe_status": code}
    raise HTTPException(409, f"server '{body.name}' already exists")


def _token_for(token_ref: str) -> str:
    from .memory_registry import resolve_token
    return resolve_token(token_ref)


@app.patch("/api/memories/servers/{name}")
async def edit_memory_server(name: str, body: ServerSpec, request: Request) -> dict[str, Any]:
    _guard_write(request)
    if store.get_server(name) is None:
        raise HTTPException(404, f"server '{name}' not found")
    row = registry.add_or_update({
        "name": name, "url": body.url.rstrip("/"), "group_name": body.group_name,
        "description": body.description, "token_ref": body.token_ref,
    })
    _broadcast({"kind": "server.changed", "server": name})
    return _server_public(row)


@app.post("/api/memories/servers/{name}/action")
async def memory_server_action(name: str, body: ServerAction, request: Request) -> dict[str, Any]:
    _guard_write(request)
    row = store.get_server(name)
    if row is None:
        raise HTTPException(404, f"server '{name}' not found")
    act = body.action
    if act == "enable":
        out = registry.set_enabled(name, True)
    elif act == "disable":
        out = registry.set_enabled(name, False)
    elif act == "pause":
        out = registry.set_state(name, "paused")
    elif act == "resume":
        out = registry.set_state(name, "idle")
    elif act == "reload":
        # re-read connection data and probe
        s = next(x for x in registry.servers() if x["name"] == name)
        code, _ = await mnemos_client.post_json_async(s, "/search", {"query": "ping", "limit": 1}, timeout=6.0)
        out = registry.set_state(name, "idle" if code != 503 else "error")
        store.log_server_action(name, "reloaded", f"probe http {code}")
        _broadcast({"kind": "server.changed", "server": name})
        return {"ok": True, "server": _server_public(out) if out else None, "probe_status": code}
    elif act == "sync":
        # mark syncing, probe, then settle back to idle (a real store-level
        # sync lands with mnemos-mesh; for now it validates connectivity)
        registry.set_state(name, "syncing")
        s = next(x for x in registry.servers() if x["name"] == name)
        code, _ = await mnemos_client.post_json_async(s, "/search", {"query": "sync-check", "limit": 1}, timeout=8.0)
        st = await mnemos_client.store_stats(s)
        out = registry.set_state(name, "idle" if code == 200 else "error")
        store.log_server_action(name, "synced", f"probe http {code}, memories={(st or {}).get('memories_total')}")
        _broadcast({"kind": "server.changed", "server": name})
        return {"ok": code == 200, "server": _server_public(out) if out else None,
                "probe_status": code, "stats": st}
    elif act == "test":
        s = next(x for x in registry.servers() if x["name"] == name)
        p = await mnemos_client.health(s)
        return {"ok": p["ok"], "probe": p}
    else:
        raise HTTPException(422, f"unknown action: {act}")
    store.log_server_action(name, act)
    _notify_and_broadcast("system", f"хранилище {name}: {act}", "", None, {"kind": "server.changed", "server": name})
    return {"ok": True, "server": _server_public(out) if out else None}


@app.delete("/api/memories/servers/{name}")
async def delete_memory_server(name: str, request: Request) -> dict[str, Any]:
    """Remove from the board registry. The memory store itself is untouched."""
    _guard_write(request)
    if not registry.delete(name):
        raise HTTPException(404, f"server '{name}' not found")
    _broadcast({"kind": "server.changed", "server": name})
    return {"ok": True, "note": "removed from board; the store itself is untouched"}


@app.get("/api/memories/servers/{name}/history")
async def memory_server_history(name: str) -> dict[str, Any]:
    return {"ok": True, "server": name, "history": store.server_history(name)}


@app.get("/api/memories/groups")
async def memory_groups() -> dict[str, Any]:
    return {"ok": True, "groups": registry.groups()}


@app.post("/api/memories/groups")
async def save_memory_group(body: GroupSpec, request: Request) -> dict[str, Any]:
    _guard_write(request)
    g = registry.save_group(body.name, body.title, body.description)
    _broadcast({"kind": "server.changed", "server": f"group:{body.name}"})
    return {"ok": True, "group": g}


@app.delete("/api/memories/groups/{name}")
async def delete_memory_group(name: str, request: Request) -> dict[str, Any]:
    _guard_write(request)
    if name == "default":
        raise HTTPException(422, "cannot delete the default group")
    if not registry.delete_group(name):
        raise HTTPException(404, f"group '{name}' not found")
    _broadcast({"kind": "server.changed", "server": f"group:{name}"})
    return {"ok": True, "note": "servers moved to group 'default'"}


# ------------------------------------------------------------- merged views
@app.get("/api/memories/pulse")
async def memory_pulse_all(project: str = "", limit: int = 12,
                           scope: str = "") -> dict[str, Any]:
    """Merged pulse across scope (all servers | group | one server)."""
    if scope and scope != "all":
        kind, servers = get_scope_servers(scope)
    else:
        kind, servers = "all", registry.active_servers()
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
    return await memory_pulse_all(project=project, limit=limit, scope=scope)


@app.get("/api/memories/item/{memory_id}")
async def memory_item(memory_id: str) -> dict[str, Any]:
    """Full memory card for the pulse/session modal (first resolving server)."""
    servers = registry.active_servers()
    for s in servers:
        code, body = await mnemos_client.fetch_json(s, f"/memories/{memory_id}")
        if code == 200 and isinstance(body, dict):
            return {
                "ok": True,
                "server": s["name"],
                "memory": {
                    "id": body.get("id", memory_id),
                    "title": body.get("title") or "",
                    "content": body.get("content") or "",
                    "raw_content": body.get("raw_content"),
                    "tags": body.get("tags", []),
                    "status": body.get("status"),
                    "memory_type": body.get("memory_type"),
                    "source": body.get("source"),
                    "source_url": body.get("source_url"),
                    "project": (body.get("tags") or [""])[0].replace("project:", "") if body.get("tags") else "",
                    "agent": next((t[6:] for t in (body.get("tags") or []) if t.startswith("agent:")), ""),
                    "created_at": body.get("created_at"),
                    "updated_at": body.get("updated_at"),
                },
            }
    return {"ok": False, "error": "memory not found on any active server"}


@app.get("/api/memories/servers/{scope}/stats")
async def memory_stats(scope: str) -> dict[str, Any]:
    kind, servers = get_scope_servers(scope)
    stats = await asyncio.gather(*(mnemos_client.store_stats(s) for s in servers))
    return {
        "ok": True, "scope": scope, "kind": kind,
        "stores": [
            {"server": s["name"], "group": s["group_name"], "stats": st or None}
            for s, st in zip(servers, stats)
        ],
    }


@app.get("/api/mnemos/search")
async def mnemos_search(q: str, limit: int = 10, project: str = "", scope: str = "") -> dict[str, Any]:
    """Search one server (scope=server name), a group, or all active servers."""
    if scope and scope != "all":
        _, scoped = get_scope_servers(scope)
    else:
        scoped = registry.active_servers()
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


class ReflectBody(BaseModel):
    specialist: str
    problem: str = ""
    kind: str = "agent-refine-request"  # agent-refine-request | agent-refine-commit


@app.post("/api/board-reflect")
async def board_reflect(body: ReflectBody, request: Request) -> dict[str, Any]:
    """Refine cycle persistence: write the request/commit-marker into mnemos
    memory (project:gcw, agent:gcw-agent-architect, mnemos:open-question /
    mnemos:decision) so the Agent Architect harness picks it up across
    sessions. Returns the created memory id."""
    _guard_write(request)
    from .mnemos_client import post_json

    servers = registry.active_servers()
    if not servers:
        raise HTTPException(503, "no active memory server")
    server = servers[0]

    if body.kind == "agent-refine-commit":
        content = (
            f"AGENT-REFINE COMMIT PREPARED for {body.specialist}: "
            f"{body.problem}. Tag: agent-refine. GCW commit pending — embed in next release (orphan-commit policy)."
        )
        tags = ["project:gcw", "agent:gcw-agent-architect", "mnemos:decision", "agent-refine"]
        title = f"agent-refine commit marker — {body.specialist}"
    else:
        content = (
            f"AGENT-REFINE REQUEST for {body.specialist}: {body.problem} "
            f"Owner feedback from the vesmaro-eyes specialist card. "
            f"@GCW: Agent Architect to analyze instructions/skills/rules and propose changes."
        )
        tags = ["project:gcw", "agent:gcw-agent-architect", "mnemos:open-question", "agent-refine"]
        title = f"agent-refine request: {body.specialist}"

    code, body_resp = post_json(server, "/memories", {
        "content": content[:4000],
        "title": title[:120],
        "tags": tags,
        "source": "mcp",
        "memory_type": "note",
    })
    if code not in (200, 201):
        detail = body_resp.get("detail") if isinstance(body_resp, dict) else str(body_resp)
        raise HTTPException(code, f"mnemos: {detail}")
    memory_id = body_resp.get("id") if isinstance(body_resp, dict) else None
    return {"ok": True, "memory_id": memory_id, "server": server["name"]}


# ----------------------------------------------------------- notifications
@app.get("/api/notifications")
async def notifications(after_id: int = 0, limit: int = 50,
                        unread_only: bool = False) -> dict[str, Any]:
    return {
        "ok": True,
        "unread": store.unread_count(),
        "items": store.notifications(after_id=after_id, limit=limit,
                                     unread_only=unread_only),
    }


@app.post("/api/notifications/read")
async def notifications_read(body: dict[str, Any] | None = None) -> dict[str, Any]:
    nid = (body or {}).get("id")
    store.mark_read(int(nid) if nid else None)
    return {"ok": True, "unread": store.unread_count()}


@app.get("/api/archive")
async def archive() -> dict[str, Any]:
    tasks = store.archived_tasks()
    # group by project, then by month of updated_at
    by_project: dict[str, list[dict[str, Any]]] = {}
    for t in tasks:
        by_project.setdefault(t.get("project") or "без проекта", []).append({
            "id": t["id"], "title": t["title"], "col": t["col"],
            "agents": t.get("agents", []), "env": t.get("env"),
            "updated_at": t.get("updated_at"),
        })
    return {"ok": True, "count": len(tasks), "projects": by_project}


@app.post("/api/tasks/{task_id}/archive")
async def archive_task(task_id: str, request: Request) -> dict[str, Any]:
    _guard_write(request)
    if not store.archive_task(task_id):
        raise HTTPException(404, "task not found or already archived")
    _notify_and_broadcast("work", f"{task_id}: в архиве", "задача архивирована", task_id, {"kind": "task.archived", "task_id": task_id})
    return {"ok": True}


@app.post("/api/tasks/{task_id}/unarchive")
async def unarchive_task(task_id: str, request: Request) -> dict[str, Any]:
    _guard_write(request)
    if not store.unarchive_task(task_id):
        raise HTTPException(404, "task not found or not archived")
    _notify_and_broadcast("work", f"{task_id}: из архива", "задача возвращена на доску", task_id, {"kind": "task.unarchived", "task_id": task_id})
    return {"ok": True}


# -------------------------------------------------------- specialist profile
@app.get("/api/specialists/{name}/profile")
async def specialist_profile(name: str) -> dict[str, Any]:
    """Specialist composition from memory (cross-system): instructions,
    skills, rules, triggers. Records are indexed into mnemos by
    scripts/sync-gcw-profiles.py with the tag specialist:<slug> — any
    store holding the index serves the profile, no GCW checkout needed.
    """
    slug = name.lower().replace("@gcw: ", "gcw-").replace(" ", "-")
    tag = f"specialist:{slug}"
    servers = registry.active_servers()
    results = await asyncio.gather(*(
        mnemos_client.post_json_async(
            s, "/search", {"query": "*", "tags": [tag], "limit": 50},
            timeout=15.0,
        ) for s in servers
    ))
    sections: dict[str, list[dict[str, Any]]] = {
        "instructions": [], "skills": [], "rules": [], "triggers": [],
    }
    meta: dict[str, Any] = {"role": name, "slug": slug}
    errors = []
    for s, (code, data) in zip(servers, results):
        if code != 200:
            errors.append({"server": s["name"], "status": code})
            continue
        for it in (data if isinstance(data, list) else []):
            kind = it.get("memory_type") or _section_of(it.get("title", ""))
            entry = {
                "title": (it.get("title") or "")[:120],
                "source_url": (it.get("source_url") or "") or "",
                "excerpt": (it.get("content") or "")[:400],
                "id": it.get("id"),
                "server": s["name"],
            }
            if kind in sections:
                sections[kind].append(entry)
            elif kind == "meta":
                meta.update(_parse_meta_excerpt(it.get("content") or ""))
            else:
                sections.setdefault("other", []).append(entry)
    return {
        "ok": not errors or any(sections.values()),
        "specialist": name, "slug": slug, "meta": meta,
        "sections": sections, "errors": errors,
        "indexed": any(sections.values()),
    }


def _section_of(title: str) -> str:
    tl = title.lower()
    if "instruction" in tl or "инструкц" in tl:
        return "instructions"
    if "skill" in tl:
        return "skills"
    if "rule" in tl or "правил" in tl:
        return "rules"
    if "trigger" in tl or "триггер" in tl:
        return "triggers"
    if "meta" in tl or "profile" in tl:
        return "meta"
    return "other"


def _parse_meta_excerpt(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for line in text.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            out[k.strip().lower()] = v.strip()[:200]
    return out


@app.get("/api/tasks/{task_id}/history")
async def task_history(task_id: str) -> dict[str, Any]:
    """Unified timeline for a task: board events + linked-memories timeline.

    Board events come from the store audit log; memory entries (checkpoints,
    decisions, learnings from mnemos) are pulled from all active servers for
    the task's linked memory ids. Single uniform shape for the UI timeline:
    {ts, kind, title, detail, source}.
    """
    task = store.task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")

    events: list[dict[str, Any]] = [
        {
            "ts": e["ts"],
            "kind": "board",
            "title": e["kind"],
            "detail": _human_event(e),
            "source": "board",
        }
        for e in store.task_events(task_id)
    ]

    # memory timeline for linked ids
    mem_items: list[dict[str, Any]] = []
    ids: list[str] = task.get("memory_ids") or []
    if ids:
        servers = registry.active_servers()
        results = await asyncio.gather(
            *(mnemos_client.resolve_memories(s, ids) for s in servers)
        )
        for s, r in zip(servers, results):
            for mid, card in r["items"].items():
                mem_items.append({
                    "ts": card.get("created_at") or "",
                    "kind": "memory",
                    "title": card.get("title") or mid[:8],
                    "detail": (card.get("excerpt") or "")[:200],
                    "source": f"{s['name']} · {card.get('status') or ''}".strip(" ·"),
                })
    mem_items.sort(key=lambda x: x["ts"] or "", reverse=True)

    return {"ok": True, "task": task_id, "events": events, "memories": mem_items}


def _human_event(e: dict[str, Any]) -> str:
    p = e.get("payload") or {}
    kind = e["kind"]
    if kind == "task.moved":
        return f"{p.get('from', '?')} → {p.get('to', '?')}"
    if kind == "task.updated":
        return "поля: " + ", ".join(p.get("fields", []))
    if kind == "task.created":
        return "создана в колонке " + str(p.get("col", "?"))
    if kind == "task.deleted":
        return "удалена"
    return str(p)[:200]


@app.get("/api/tags/{tag}/drill")
async def tag_drill(tag: str, limit: int = 12) -> dict[str, Any]:
    """Cross-cutting drill-down: everything tied to one tag.

    Returns: board tasks carrying this tag + memories matching the tag
    across all active memory servers (tags filter, recency order).
    """
    servers = registry.active_servers()
    results = await asyncio.gather(*(
        mnemos_client.post_json_async(
            s, "/search", {"query": "*", "tags": [tag], "limit": min(limit, 25)},
            timeout=15.0,
        ) for s in servers
    ))
    memories: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for s, (code, data) in zip(servers, results):
        if code != 200:
            errors.append({"server": s["name"], "status": code})
            continue
        for it in (data if isinstance(data, list) else []):
            if isinstance(it, dict):
                it["server"] = s["name"]
                memories.append(it)
    memories.sort(key=lambda i: i.get("created_at") or "", reverse=True)

    board_tasks = [
        {
            "id": t["id"], "title": t["title"], "col": t["col"],
            "agents": t["agents"], "env": t["env"],
        }
        for t in store.board()["tasks"]
        if tag in (t.get("mnemos_tags") or []) or tag in (t.get("specialists") or [])
        or tag in (t.get("agents") or [])
    ]
    return {
        "ok": not errors or bool(memories),
        "tag": tag,
        "tasks": board_tasks,
        "memories": [
            {
                "id": m["id"], "title": m.get("title") or "",
                "tags": m.get("tags", []), "server": m.get("server"),
                "created_at": m.get("created_at"), "status": m.get("status"),
                "excerpt": (m.get("content") or "")[:180],
            }
            for m in memories[:limit]
        ],
        "errors": errors,
    }


@app.get("/api/agents/{name}/activity")
async def agent_activity(name: str, project: str = "", limit: int = 10) -> dict[str, Any]:
    """Cross-store agent activity: recent memories per agent (mnemos /recall)."""
    servers = registry.active_servers()
    results = await asyncio.gather(*(
        mnemos_client.fetch_json(
            s, f"/recall/agent/{name}",
            {"limit": min(limit, 25), **({"project": project} if project else {})},
        ) for s in servers
    ))
    items: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for s, (code, body) in zip(servers, results):
        if code != 200 or not isinstance(body, list):
            errors.append({"server": s["name"], "status": code})
            continue
        for it in body:
            if isinstance(it, dict):
                it["server"] = s["name"]
                items.append(it)
    items.sort(key=lambda i: i.get("created_at") or "", reverse=True)
    board_tasks = [
        {"id": t["id"], "title": t["title"], "col": t["col"], "env": t["env"]}
        for t in store.board()["tasks"] if name in (t.get("agents") or [])
    ]
    return {
        "ok": not errors or bool(items),
        "agent": name,
        "tasks": board_tasks,
        "memories": [
            {
                "id": i["id"], "title": i.get("title") or "",
                "tags": i.get("tags", []), "server": i.get("server"),
                "created_at": i.get("created_at"),
                "excerpt": (i.get("content") or "")[:180],
            }
            for i in items[:limit]
        ],
        "errors": errors,
    }


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
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield _sse(event)
                except asyncio.TimeoutError:
                    yield b": keep-alive\n\n"  # comment frame — keeps proxies from idling out
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
    return FileResponse(
        STATIC_DIR / "index.html",
        headers={"Cache-Control": "no-cache"},  # entry point always fresh
    )


app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="web")