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
import hmac
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from . import mnemos_client
from .memory_registry import ServerRegistry, resolve_token, write_config_template
from .profiles import build_profile
from .security import (
    RateLimiter,
    ValidationError,
    validate_memory_url,
    validate_token_ref,
)
from .store import (
    REPORT_KINDS,
    Store,
    TASK_STATUSES,
    TaskLockedError,
    VALID_STATUSES,
)
from .task_inbox import background_refresher as inbox_background_refresher
from .task_inbox import refresh_inbox

DATA_DIR = Path(os.environ.get("VESMARO_DATA", "/data"))
DB_PATH = DATA_DIR / "board.db"
STATIC_DIR = Path(os.environ.get("VESMARO_WEB", Path(__file__).resolve().parents[1] / "web"))

# Board read/write is open on the LAN by design (the cluster ingress is the
# boundary); mnemos credentials stay server-side. Since SEC-3 the write
# guard is FAIL-CLOSED: mutations require this bearer token, and when it is
# not configured every mutation answers 503. The Helm chart generates the
# token; compose.yaml ships a dev default for local runs.
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


async def _profile_cache_refresher() -> None:
    """Refresh specialist profile caches in the background (every 5 min).

    BE-9: the deterministic filesystem build runs first; the mnemos probe
    below only serves names the builder cannot resolve. This keeps the
    scoped (deduplicated) profiles from being clobbered by the flat
    mnemos index, which duplicates plugin files across specialists.
    """
    while True:
        await asyncio.sleep(300)
        try:
            for name in {t["specialists"][0] for t in store.board()["tasks"]
                          if t.get("specialists")}:
                built = await asyncio.to_thread(build_profile, name)
                if built is not None:
                    store.put_profile_cache(name, built)
                    continue
                tag = f"specialist:{name.lower().replace('@gcw: ', 'gcw-').replace(' ', '-')}"
                tag2 = tag  # same value
                servers = registry.active_servers()
                if not servers:
                    continue
                probe_queries = ("*", "specialist", "[instructions]", "[skills]", "[rules]", "[triggers]")
                results = await asyncio.gather(*(
                    mnemos_client.post_json_async(
                        s, "/search", {"query": q, "tags": [tag], "limit": 60},
                        timeout=15.0,
                    ) for s in servers for q in probe_queries
                ))
                server_names = [s["name"] for s in servers for _ in probe_queries]
                sections: dict[str, list[dict[str, Any]]] = {
                    "instructions": [], "skills": [], "rules": [], "triggers": [],
                }
                seen: set[str] = set()
                for s_name, (code, data) in zip(server_names, results):
                    if code != 200:
                        continue
                    for it in (data if isinstance(data, list) else []):
                        mid = it.get("id")
                        if mid and mid in seen:
                            continue
                        if mid:
                            seen.add(mid)
                        kind = _section_of(it.get("title", ""))
                        if kind == "meta":
                            continue
                        if kind in sections:
                            sections[kind].append({
                                "title": (it.get("title") or "")[:140],
                                "source_url": (it.get("source_url") or ""),
                                "excerpt": (it.get("content") or "")[:200000],
                                "id": it.get("id"),
                                "server": s_name,
                            })
                if any(sections.values()):
                    store.put_profile_cache(name, {
                        "specialist": name,
                        "slug": name.lower().replace("@gcw: ", "gcw-").replace(" ", "-"),
                        "meta": {"role": name},
                        "sections": sections, "errors": [],
                        "indexed": True,
                    })
        except Exception:  # noqa — background loop must never die
            pass


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    # One-shot reports backfill (BE-7 wave) — strictly opt-in via env so a
    # plain boot never mutates data. Intended for the deploy window; the
    # same backfill is available as scripts/backfill_reports.py (pick one).
    # Idempotent inside the store: board_meta flag + tasks with existing
    # reports are never touched.
    if os.environ.get("VESMARO_BACKFILL_REPORTS", "") == "1":
        created = await asyncio.to_thread(store.backfill_reports)
        logging.getLogger("vesmaro.backfill").info(
            "reports backfill finished: created=%d", created)
    task = asyncio.create_task(_profile_cache_refresher())
    # AGG-1: inbox scan starts right after boot (non-blocking) and repeats
    # every 5 min inside the task; errors are absorbed in the loop.
    inbox_task = asyncio.create_task(inbox_background_refresher(registry, store))
    yield
    task.cancel()
    inbox_task.cancel()


COLUMN_RU = {
    "open": "открыто", "in-progress": "в работе", "blocked": "блокировано",
    "resolved": "решено", "done": "готово",
}

app = FastAPI(title="vesmaro-eyes", version="1.3.2", lifespan=lifespan)


# --------------------------------------------------------------------- models
class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    summary: str = ""
    spec: str = ""
    col: str = "open"
    # BE-10: optional explicit workflow status; defaults to the col map.
    status: str | None = None
    # BE-12: priority dictionary value; store validates and defaults to
    # 'normal' (garbage → ValueError → 422, same boundary as env/status).
    priority: str = "normal"
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
    # BE-10: full workflow dictionary (incl. `withdrawn`, which has no
    # board column); lives until the next column move — see store.move_task.
    status: str | None = None
    # BE-12: content edit of a task older than 24h (EDITABLE_FIELDS) is
    # rejected with 423 unless the request opts in here. Status changes are
    # workflow transitions and stay free at any age (UI-8 «Вернуть в работу»).
    force: bool = False
    priority: str | None = None
    env: str | None = None
    agents: list[str] | None = None
    specialists: list[str] | None = None
    project: str | None = None
    memory_ids: list[str] | None = None
    mnemos_tags: list[str] | None = None


def _validate_agents(agents: list[str]) -> None:
    """ADR 0005 (BE-5): ``agents`` are execution harnesses (zcode, hermes,
    ...); role-like slugs are specialists and belong in ``specialists``.
    Enforced identically on create AND patch, server-side, so every client
    inherits the rule. Raises HTTP 422."""
    bad = [a for a in agents if a.startswith("gcw-") or a.startswith("@")]
    if bad:
        raise HTTPException(
            422,
            f"agents must be harnesses (zcode, hermes, ...), not roles: {bad}; "
            "use specialists for @GCW roles",
        )


class MoveBody(BaseModel):
    col: str
    position: int | None = None


class ServerSpec(BaseModel):
    """Create/update a memory server connection. token: never returned."""
    name: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    url: str = Field(min_length=1)
    group_name: str = "default"
    description: str = ""
    token_ref: str = ""   # env:VAR | file:<path under a provisioned secrets dir>;
                          # plain: is rejected via the API (SEC-2)
    enabled: bool = True


class ServerAction(BaseModel):
    action: str  # enable | disable | pause | resume | reload | sync | test


class GroupSpec(BaseModel):
    name: str = Field(min_length=1, max_length=60, pattern=r"^[a-z0-9][a-z0-9_-]*$")
    title: str = ""
    description: str = ""


# OpenAPI response contract (arch-committee mandate #1). All models allow
# extra fields so serialization never drops keys the SPA reads; required
# fields are only those the store provably always returns.
class _ApiModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class TaskOut(_ApiModel):
    id: str
    col: str
    position: int
    title: str
    summary: str
    spec: str
    agents: list[str]
    specialists: list[str]
    env: str
    project: str
    memory_ids: list[str]
    mnemos_tags: list[str]
    created_at: str
    updated_at: str
    archived: int = 0
    status: str                     # BE-10: workflow dictionary value — store always returns it post-migration
    priority: str                   # BE-12: priority dictionary value — store always returns it post-migration
    archived_from: str = ""         # BE-11b: pre-archive column


class BoardOut(_ApiModel):
    columns: list[str]
    tasks: list[TaskOut]
    counts: dict[str, int]


class OkOut(_ApiModel):
    ok: bool


class OkNoteOut(_ApiModel):
    ok: bool
    note: str = ""


class TaskMemoriesOut(_ApiModel):
    items: dict[str, Any]
    unresolved: list[dict[str, Any]]
    sources: dict[str, str]


class GroupOut(_ApiModel):
    name: str
    title: str = ""
    description: str = ""
    created_at: str = ""
    servers: list[str] = []


class MemoryServerOut(_ApiModel):
    """Public server shape (``_server_public``) — token values never present."""
    name: str
    url: str
    group_name: str
    description: str = ""
    enabled: bool = True
    state: str = "idle"
    token_ref: str = ""
    has_token: bool = False
    ok: bool | None = None
    latency_ms: float | None = None
    probe_status: int | None = None


class MemoryServersOut(_ApiModel):
    ok: bool
    servers: list[MemoryServerOut]
    groups: list[GroupOut]


class ServerActionOut(_ApiModel):
    ok: bool
    server: MemoryServerOut | None = None


class GroupsOut(_ApiModel):
    ok: bool
    groups: list[GroupOut]


class GroupSaveOut(_ApiModel):
    ok: bool
    group: GroupOut


class GroupMemberBody(_ApiModel):
    server: str = Field(min_length=1)
    op: str = "add"  # add | remove


class GroupMemberOut(_ApiModel):
    ok: bool
    server: MemoryServerOut | None = None


class ReflectOut(_ApiModel):
    ok: bool
    memory_id: str | None = None
    server: str


class TaskDraftBody(BaseModel):
    """UI-6: raw owner thought from the "Новая задача" board form.
    ``project`` / ``tags`` are free-form strings — they are folded into the
    memory CONTENT as metadata, never into memory tags (poisoning
    invariant, ui-contract §12)."""
    text: str = Field(min_length=1, max_length=8000)
    project: str = Field(default="", max_length=120)
    tags: str = Field(default="", max_length=400)


class TaskDraftOut(_ApiModel):
    ok: bool
    memory_id: str | None = None
    server: str


# Task inbox mirror (AGG-1). ``created_at`` is the SOURCE memory's creation
# timestamp; ``stale`` means the record stopped coming back from its server
# (last_seen older than Store.INBOX_STALE_SECONDS); ``adopted`` means a
# native board task was created from it.
class TaskInboxItem(_ApiModel):
    memory_id: str
    server: str
    project: str
    title: str
    excerpt: str
    tags: list[str]
    priority: str
    specialist: str
    created_at: str
    last_seen: str
    stale: bool
    adopted: bool
    adopted_task_id: str | None = None


class TaskInboxOut(_ApiModel):
    items: list[TaskInboxItem]
    count: int
    refreshed_at: str


class TaskInboxRefreshOut(_ApiModel):
    scanned_servers: int
    found: int
    new: int
    errors: list[dict[str, Any]]


class NotificationOut(_ApiModel):
    id: int
    category: str
    title: str
    message: str = ""
    task_id: str | None = None
    ts: str
    read: bool


class NotificationsOut(_ApiModel):
    ok: bool
    unread: int
    items: list[NotificationOut]


class NotificationReadBody(_ApiModel):
    id: int | None = None  # None marks ALL as read


class NotificationReadOut(_ApiModel):
    ok: bool
    unread: int


# Agent report contract (BE-11a). Body is capped at 16K server-side; kind is
# the two-value report dictionary. A second kind="final" supersedes previous
# live finals — history is kept, flagged with superseded=true.
class ReportCreate(BaseModel):
    body: str = Field(min_length=1, max_length=16384)
    kind: str = "intermediate"  # intermediate | final
    agent: str = Field(default="", max_length=120)


class ReportOut(_ApiModel):
    id: int
    task_id: str
    kind: str
    agent: str
    body: str
    superseded: bool
    created_at: str


class ReportCreatedOut(_ApiModel):
    ok: bool
    report: ReportOut
    superseded: list[int] = []  # ids of previous finals marked superseded


class ReportsOut(_ApiModel):
    ok: bool
    task_id: str
    count: int
    items: list[ReportOut]


# BE-7: task history timeline for the task modal — board audit events plus
# linked memory checkpoints. Optional context keys (detail/source/ts) are
# absent when empty (route sets response_model_exclude_none).
class EventItem(_ApiModel):
    ts: str
    title: str
    detail: str | None = None


class MemoryItem(_ApiModel):
    ts: str | None = None
    title: str
    source: str | None = None
    detail: str | None = None


class HistoryOut(_ApiModel):
    events: list[EventItem]
    memories: list[MemoryItem]


class UnarchiveOut(_ApiModel):
    ok: bool
    task: TaskOut | None = None


# Archive v2 (BE-11b): flat filtered page + per-project grouping over the
# FULL matching set (not the page), so the v1 teaser counts stay stable
# under pagination. ``count`` is the legacy total-matching key.
class ArchiveOut(_ApiModel):
    ok: bool
    count: int
    total: int
    limit: int
    offset: int
    items: list[TaskOut]
    projects: dict[str, list[dict[str, Any]]]


# Specialist profile contract (BE-9). ``sections`` carry ONLY what the
# agent's own .md owns or references; plugin-level material available to
# every agent of the plugin lives in ``shared`` (shared=true, scope=
# "plugin") so it is never repeated per card. Entry shape keeps the
# legacy keys (title/source_url/excerpt); id/server come from the legacy
# mnemos path, path/kind/scope/source from the filesystem builder.
class ProfileEntry(_ApiModel):
    title: str = ""
    source_url: str = ""
    excerpt: str = ""
    path: str = ""
    kind: str = ""
    shared: bool | None = None   # None = legacy mnemos entry (unknown)
    scope: str = ""
    source: str = ""
    also_in: list[str] = []      # other plugins shipping the same name


class SpecialistProfileOut(_ApiModel):
    ok: bool
    cached: bool = False
    specialist: str
    slug: str
    meta: dict[str, Any]
    sections: dict[str, list[ProfileEntry]]
    shared: dict[str, Any] = {}
    errors: list[Any] = []
    indexed: bool = False


class RefreshAllOut(_ApiModel):
    ok: bool
    refreshed: int  # built + legacy-fallback successes (legacy field)
    built: int = 0
    memory_fallback: int = 0
    failed: int = 0


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
async def board(status: str = "") -> BoardOut:
    """Board projection; BE-10 optional ``?status=`` filter over the
    workflow dictionary (422 on unknown values). ``counts`` always describe
    the whole board, not the filtered view."""
    if status:
        if status not in TASK_STATUSES:
            raise HTTPException(422, f"invalid status: {status}")
        return store.board(status=status)
    return store.board()


@app.post("/api/tasks", status_code=201)
async def create_task(body: TaskCreate, request: Request) -> TaskOut:
    _guard_write(request)
    if body.col not in VALID_STATUSES:
        raise HTTPException(422, f"invalid col: {body.col}")
    _validate_agents(body.agents)  # ADR 0005: harnesses only
    # store raises ValueError on unknown env/col — surface as 422, not 500
    try:
        task = store.create_task(body.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    _notify_and_broadcast("work", f"{task['id']}: новая задача", task["title"][:120], task["id"], {"kind": "task.created", "task": task})
    return task


@app.patch("/api/tasks/{task_id}")
async def patch_task(task_id: str, body: TaskPatch, request: Request) -> TaskOut:
    """Task PATCH (BE-12).

    - Content fields (EDITABLE_FIELDS: title, summary, spec, project, env,
      priority, agents, specialists, memory_ids, mnemos_tags) on a task
      older than 24h answer **423 Locked** unless ``force=true``; a forced
      edit is echoed back with ``forced: true`` and audited in the
      task.updated event (payload ``forced: true``).
    - ``status`` is NOT content: workflow transitions (e.g. UI-8 «Вернуть
      в работу») stay free at any task age — the 423 window never applies.
    - ``col`` is silently ignored by the store allow-list (columns move via
      POST /move) — long-standing v1 semantics, not an error.
    - ``force`` itself is a request mode, never a task column: it is popped
      here and never reaches the update payload.
    """
    _guard_write(request)
    if body.agents is not None:
        _validate_agents(body.agents)  # ADR 0005 (BE-5): same rule as create
    dump = body.model_dump(exclude_none=True)
    force = dump.pop("force", False)  # request mode — not part of the payload
    # store raises ValueError on unknown env/priority — surface as 422, not 500
    try:
        task = store.update_task(task_id, dump, force=force)
    except TaskLockedError:
        raise HTTPException(
            423,
            "задача старше 24ч — редактирование заблокировано "
            "(force=true для принудительной правки)",
        ) from None
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if task is None:
        raise HTTPException(404, "task not found")
    if force:
        # extra="allow" keeps the flag in the serialized TaskOut
        task["forced"] = True
    _broadcast({"kind": "task.updated", "task": task})
    return task


@app.post("/api/tasks/{task_id}/move")
async def move_task(task_id: str, body: MoveBody, request: Request) -> TaskOut:
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
async def delete_task(task_id: str, request: Request) -> OkOut:
    _guard_write(request)
    if not store.delete_task(task_id):
        raise HTTPException(404, "task not found")
    _notify_and_broadcast("work", f"{task_id}: удалена", "", task_id, {"kind": "task.deleted", "task_id": task_id})
    return {"ok": True}


async def _resolve_task_memory_cards(
    task_id: str, scope: str = ""
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]:
    """Shared memory-link resolver (task drawer + BE-7 history timeline):
    resolve ``task.memory_ids`` across a server, a group, or all active
    servers. Returns ``(items, unresolved, sources)`` — ``items`` maps a
    memory id to its card, ``sources`` to the resolving server's name.
    404 when the task does not exist; empty structures without links."""
    task = store.task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")
    ids: list[str] = task.get("memory_ids") or []
    if not ids:
        return {}, [], {}

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
    return items, unresolved, sources


@app.get("/api/tasks/{task_id}/memories")
async def task_memories(task_id: str, scope: str = "") -> TaskMemoriesOut:
    """Resolve task memory links against a server, a group, or all servers."""
    items, unresolved, sources = await _resolve_task_memory_cards(task_id, scope)
    return {"items": items, "unresolved": unresolved, "sources": sources}


def _event_detail(e: dict[str, Any]) -> str:
    """Human-readable context line for one board audit event (BE-7 history
    timeline). An empty return means "omit the detail row"."""
    p = e.get("payload") or {}
    kind = e["kind"]
    if kind == "task.moved":
        return f"{p.get('from', '?')} → {p.get('to', '?')}"
    if kind == "task.updated":
        # updated_at is bookkeeping the store stamps on every write — not a
        # semantic field, so it never appears in the human digest
        fields = ", ".join(f for f in p.get("fields", []) if f != "updated_at")
        return f"поля: {fields}" if fields else ""
    if kind == "task.created":
        return f"колонка {p.get('col', '?')}"
    if kind == "task.archived":
        return f"из колонки {p.get('from', '?')}"
    if kind == "task.unarchived":
        return f"в колонку {p.get('to', '?')}"
    if kind == "task.report":
        return f"{p.get('kind', 'отчёт')}, агент: {p.get('agent') or '—'}"
    if kind == "task.deleted":
        return ""
    text = str(p)[:200]
    return "" if text == "{}" else text


@app.get("/api/tasks/{task_id}/history", response_model_exclude_none=True)
async def task_history(task_id: str) -> HistoryOut:
    """BE-7: merged timeline for the task modal — the task's board audit
    events (title = event kind, detail = human-readable payload digest) plus
    its linked memory checkpoints (source = resolving server, detail =
    excerpt capped at 200 chars). The SPA merges and sorts both lists by
    ``ts`` desc; the server pre-sorts defensively."""
    task = store.task(task_id)
    if task is None:
        raise HTTPException(404, "task not found")

    events: list[dict[str, Any]] = []
    for e in store.task_events(task_id):
        item: dict[str, Any] = {"ts": e["ts"], "title": e["kind"]}
        detail = _event_detail(e)
        if detail:
            item["detail"] = detail
        events.append(item)
    events.sort(key=lambda i: i["ts"], reverse=True)

    cards, _unresolved, sources = await _resolve_task_memory_cards(task_id)
    memories: list[dict[str, Any]] = []
    for mid, card in cards.items():
        m: dict[str, Any] = {
            "ts": card.get("created_at") or None,
            "title": card.get("title") or mid,
            "source": sources.get(mid) or None,
        }
        excerpt = (card.get("excerpt") or "")[:200]
        if excerpt:
            m["detail"] = excerpt
        memories.append(m)
    memories.sort(key=lambda i: i.get("ts") or "", reverse=True)
    return {"events": events, "memories": memories}


# ------------------------------------------------------- memory servers CRUD
def _server_public(s: dict[str, Any]) -> dict[str, Any]:
    """Public shape — token values are NEVER included; legacy ``plain:``
    refs are masked (SEC-2) while ``has_token`` still reports that a
    secret is provisioned for this server."""
    ref = s.get("token_ref", "") or ""
    return {
        "name": s["name"],
        "url": s["url"],
        "group_name": s["group_name"],
        "description": s["description"],
        "enabled": bool(s["enabled"]),
        "state": s["state"],
        "token_ref": "plain:<redacted>" if ref.startswith("plain:") else ref,
        "has_token": bool(resolve_token(ref)),
    }


@app.get("/api/memories/servers")
async def memory_servers() -> MemoryServersOut:
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


async def _validate_server_spec(body: ServerSpec) -> tuple[str, str]:
    """SEC-1 boundary: validate url (scheme + host egress policy) and
    token_ref (no plain:, file: only under provisioned dirs) BEFORE any
    network activity or persistence. Raises 422 on violation."""
    try:
        # getaddrinfo inside validate_memory_url is a blocking syscall;
        # keep the event loop free while DNS resolves (or times out)
        url = await asyncio.to_thread(validate_memory_url, body.url)
        token_ref = validate_token_ref(body.token_ref)
    except ValidationError as exc:
        raise HTTPException(422, str(exc)) from exc
    return url, token_ref


@app.post("/api/memories/servers", status_code=201)
async def add_memory_server(body: ServerSpec, request: Request) -> MemoryServerOut:
    _guard_write(request)
    url, token_ref = await _validate_server_spec(body)
    existing = store.get_server(body.name)
    if existing is None:
        # verify reachability before first save (honest, non-blocking).
        # SEC-1: the probe for a NEW host carries NO Authorization header —
        # an attacker-chosen URL must never receive the memory token.
        probe_spec = {"name": body.name, "url": url, "token": ""}
        code, _ = await mnemos_client.post_json_async(probe_spec, "/search",
                                                      {"query": "ping", "limit": 1}, timeout=6.0)
        row = registry.add_or_update({
            "name": body.name, "url": url, "group_name": body.group_name,
            "description": body.description, "token_ref": token_ref,
        })
        store.log_server_action(body.name, "added", f"probe http {code}")
        if code == 503:
            row = registry.set_state(body.name, "error") or row
        _broadcast({"kind": "server.changed"})
        return {**_server_public(row), "probe_status": code}
    raise HTTPException(409, f"server '{body.name}' already exists")


@app.patch("/api/memories/servers/{name}")
async def edit_memory_server(name: str, body: ServerSpec, request: Request) -> MemoryServerOut:
    _guard_write(request)
    url, token_ref = await _validate_server_spec(body)
    if store.get_server(name) is None:
        raise HTTPException(404, f"server '{name}' not found")
    row = registry.add_or_update({
        "name": name, "url": url, "group_name": body.group_name,
        "description": body.description, "token_ref": token_ref,
    })
    _broadcast({"kind": "server.changed", "server": name})
    return _server_public(row)


@app.post("/api/memories/servers/{name}/action")
async def memory_server_action(name: str, body: ServerAction, request: Request) -> ServerActionOut:
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
async def delete_memory_server(name: str, request: Request) -> OkNoteOut:
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
async def memory_groups() -> GroupsOut:
    return {"ok": True, "groups": registry.groups()}


@app.post("/api/memories/groups")
async def save_memory_group(body: GroupSpec, request: Request) -> GroupSaveOut:
    _guard_write(request)
    g = registry.save_group(body.name, body.title, body.description)
    _broadcast({"kind": "server.changed", "server": f"group:{body.name}"})
    return {"ok": True, "group": g}


@app.delete("/api/memories/groups/{name}")
async def delete_memory_group(name: str, request: Request) -> OkNoteOut:
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


@app.get("/api/memories/groups/{name}/info")
async def group_info(name: str) -> dict[str, Any]:
    """Cluster card data: membership, per-member live state, history."""
    groups = {g["name"]: g for g in registry.groups()}
    g = groups.get(name)
    if g is None:
        raise HTTPException(404, f"group '{name}' not found")
    members = [s for s in registry.servers() if s["group_name"] == name]
    probes = await asyncio.gather(*(mnemos_client.ping(s) for s in members))
    stats = await asyncio.gather(*(mnemos_client.store_stats(s) for s in members))
    per_member = []
    for s, p, st in zip(members, probes, stats):
        per_member.append({
            "name": s["name"], "url": s["url"], "enabled": bool(s["enabled"]),
            "state": s["state"], "ok": p["ok"], "latency_ms": p["latency_ms"],
            "memories_total": (st or {}).get("memories_total"),
            "version": (st or {}).get("version"),
            "by_project": (st or {}).get("by_project", {}),
        })
    return {
        "ok": True, "group": {"name": name, "members": g["servers"],
                               "description": g.get("description", "")},
        "members": per_member,
        "history": store.group_history(name),
    }


@app.post("/api/memories/groups/{name}/members")
async def group_membership(name: str, body: GroupMemberBody, request: Request) -> GroupMemberOut:
    """Add/remove a server to/from a group: body {server, op: 'add'|'remove'}."""
    _guard_write(request)
    server = body.server
    op = body.op
    if store.get_server(server) is None:
        raise HTTPException(404, f"server '{server}' not found")
    if op == "add":
        out = registry.set_group(server, name)
        store.log_group_action(name, "member-added", server)
    elif op == "remove":
        out = registry.set_group(server, "default")
        store.log_group_action(name, "member-removed", server)
    else:
        raise HTTPException(422, f"unknown op: {op}")
    _broadcast({"kind": "server.changed", "server": server})
    return {"ok": True, "server": _server_public(out) if out else None}


@app.get("/api/memories/groups/{name}/history")
async def group_history(name: str) -> dict[str, Any]:
    return {"ok": True, "group": name, "history": store.group_history(name)}


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


# Board reflections are DATA, never instructions (SEC-4 poisoning hardening):
# mnemos:decision and any other subtype are forbidden here, so agent
# harnesses treat these records as open questions from the board, not as
# directives. The mnemos strict tag contract additionally requires exactly
# one project:<slug> and one agent:<slug> per memory — the board stamps its
# own identity (never a specialist slug) to stay attributable without
# impersonating an agent.
BOARD_PROJECT_TAG = "project:mnemos-eyes"
BOARD_AGENT_TAG = "agent:zcode"
BOARD_REFLECT_TAGS = [
    BOARD_PROJECT_TAG,
    BOARD_AGENT_TAG,
    "mnemos:open-question",
    "source:board",
]
_REFLECT_RATE_LIMIT = 10        # requests per client ...
_REFLECT_RATE_WINDOW = 60.0     # ... per sliding window (seconds)
_reflect_limiter = RateLimiter(limit=_REFLECT_RATE_LIMIT, window=_REFLECT_RATE_WINDOW)


@app.post("/api/board-reflect")
async def board_reflect(body: ReflectBody, request: Request) -> ReflectOut:
    """Refine cycle persistence: write the request/commit-marker into mnemos
    memory tagged ``mnemos:open-question`` + ``source:board`` plus the
    contract-required project/agent stamps (SEC-4: board data is not
    instructions — harnesses must not treat these records as decisions or
    directives). Rate limited per client. Returns the created memory id."""
    _guard_write(request)
    client_ip = request.client.host if request.client else "unknown"
    if not _reflect_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"board-reflect rate limit exceeded "
            f"({_REFLECT_RATE_LIMIT} per {_REFLECT_RATE_WINDOW:.0f}s per client)",
        )
    if body.kind not in ("agent-refine-request", "agent-refine-commit"):
        raise HTTPException(422, f"unknown kind: {body.kind}")

    servers = registry.active_servers()
    if not servers:
        raise HTTPException(503, "no active memory server")
    server = servers[0]

    if body.kind == "agent-refine-commit":
        content = (
            f"AGENT-REFINE COMMIT PREPARED for {body.specialist}: "
            f"{body.problem}. Tag: agent-refine. GCW commit pending — embed in next release (orphan-commit policy)."
        )
        title = f"agent-refine commit marker — {body.specialist}"
    else:
        content = (
            f"AGENT-REFINE REQUEST for {body.specialist}: {body.problem} "
            f"Owner feedback from the vesmaro-eyes specialist card. "
            f"@GCW: Agent Architect to analyze instructions/skills/rules and propose changes."
        )
        title = f"agent-refine request: {body.specialist}"

    # BE-4: must stay async — a sync httpx call here would freeze the event
    # loop and stall every concurrent request (e.g. GET /api/board) for the
    # full mnemos round-trip.
    code, body_resp = await mnemos_client.post_json_async(server, "/memories", {
        "content": content[:4000],
        "title": title[:120],
        "tags": list(BOARD_REFLECT_TAGS),
        "source": "mcp",
        "memory_type": "note",
    })
    if code not in (200, 201):
        detail = body_resp.get("detail") if isinstance(body_resp, dict) else str(body_resp)
        raise HTTPException(code, f"mnemos: {detail}")
    memory_id = body_resp.get("id") if isinstance(body_resp, dict) else None
    return {"ok": True, "memory_id": memory_id, "server": server["name"]}


# UI-6 "Новая задача": raw owner thought → memory draft. Freeze exception
# (ADR 0006): tracker workflow feature — "the tracker needs itself".
# Poisoning invariant (ui-contract §12, same SEC-4 rule as board-reflect):
# records written here carry EXACTLY the three tags below — user-supplied
# project/tags from the form are metadata inside CONTENT, never raw tags.
# The memory still needs the mnemos strict-contract stamps (exactly one
# project:<slug> + one agent:<slug>): the slug is sanitized server-side and
# the agent stamp is the board's own identity, so no specialist slug can be
# injected through this endpoint. Subtype tags keep the record data, not
# instructions (SEC-4).
_DRAFT_PROJECT_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,48}")
_DRAFT_RATE_LIMIT = 10         # requests per client ...
_DRAFT_RATE_WINDOW = 60.0      # ... per sliding window (seconds)
_draft_limiter = RateLimiter(limit=_DRAFT_RATE_LIMIT, window=_DRAFT_RATE_WINDOW)


def _draft_tags(project: str) -> list[str]:
    slug = project.strip().lower().replace("_", "-")
    if not _DRAFT_PROJECT_SLUG.fullmatch(slug):
        slug = "mnemos-eyes"
    return [
        f"project:{slug}",
        BOARD_AGENT_TAG,
        "mnemos:open-question",
        "task-draft",
        "source:board",
    ]


@app.post("/api/task-drafts", status_code=201)
async def create_task_draft(body: TaskDraftBody, request: Request) -> TaskDraftOut:
    """Persist the owner's raw thought as a mnemos draft note (tags pinned
    to the _draft_tags() contract set) and return the memory coordinates;
    the SPA then files the "Оформить черновик задачи" chore on the board.
    Rate limited per client like board-reflect."""
    _guard_write(request)
    client_ip = request.client.host if request.client else "unknown"
    if not _draft_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"task-drafts rate limit exceeded "
            f"({_DRAFT_RATE_LIMIT} per {_DRAFT_RATE_WINDOW:.0f}s per client)",
        )
    text = body.text.strip()
    if not text:
        raise HTTPException(422, "draft text is empty")

    servers = registry.active_servers()
    if not servers:
        raise HTTPException(503, "no active memory server")
    server = servers[0]

    # project / tags from the form are CONTENT metadata only — never tags
    meta_lines = [f"проект: {body.project.strip() or '—'}",
                  f"теги: {body.tags.strip() or '—'}"]
    content = text + "\n\n— метаданные формы —\n" + "\n".join(meta_lines)
    title = f"task-draft: {text[:60]}"

    # BE-4: async mnemos round-trip — never block the event loop.
    code, body_resp = await mnemos_client.post_json_async(server, "/memories", {
        "content": content[:4000],
        "title": title[:120],
        "tags": _draft_tags(body.project),
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
                        unread_only: bool = False) -> NotificationsOut:
    return {
        "ok": True,
        "unread": store.unread_count(),
        "items": store.notifications(after_id=after_id, limit=limit,
                                     unread_only=unread_only),
    }


@app.post("/api/notifications/read")
async def notifications_read(
    request: Request, body: NotificationReadBody | None = None
) -> NotificationReadOut:
    _guard_write(request)
    # no body or {"id": null} marks ALL as read (previous contract kept)
    store.mark_read(body.id if body else None)
    return {"ok": True, "unread": store.unread_count()}


@app.get("/api/archive")
async def archive(
    q: str = "",
    status: str = "",
    col: str = "",
    agent: str = "",
    project: str = "",
    limit: int = 50,
    offset: int = 0,
) -> ArchiveOut:
    """Archive v2 (BE-11b): ``q`` LIKE over title/summary, ``status`` /
    ``col`` exact, ``agent`` a member of the agents array, ``project``
    exact; ``limit``/``offset`` paginate ``items`` while ``total`` (and the
    legacy ``count`` key) always report the full matching set. ``projects``
    grouping also covers the full matching set so v1 teaser counts stay
    stable under pagination."""
    if status and status not in TASK_STATUSES:
        raise HTTPException(422, f"invalid status: {status}")
    if col and col not in VALID_STATUSES:
        raise HTTPException(422, f"invalid col: {col}")
    limit = max(0, min(limit, 200))
    offset = max(0, offset)
    rows = store.archived_tasks(q=q.strip(), status=status, col=col,
                                agent=agent.strip(), project=project)
    total = len(rows)
    by_project: dict[str, list[dict[str, Any]]] = {}
    for t in rows:
        by_project.setdefault(t.get("project") or "без проекта", []).append({
            "id": t["id"], "title": t["title"], "col": t["col"],
            "agents": t.get("agents", []), "env": t.get("env"),
            "updated_at": t.get("updated_at"),
        })
    return {
        "ok": True,
        "count": total,   # legacy key (v1 SPA reads it)
        "total": total,
        "limit": limit,
        "offset": offset,
        "items": rows[offset:offset + limit],
        "projects": by_project,
    }


@app.post("/api/tasks/{task_id}/archive")
async def archive_task(task_id: str, request: Request) -> OkOut:
    _guard_write(request)
    if not store.archive_task(task_id):
        raise HTTPException(404, "task not found or already archived")
    _notify_and_broadcast("work", f"{task_id}: в архиве", "задача архивирована", task_id, {"kind": "task.archived", "task_id": task_id})
    return {"ok": True}


@app.post("/api/tasks/{task_id}/unarchive")
async def unarchive_task(task_id: str, request: Request) -> UnarchiveOut:
    """Restore an archived task to its pre-archive column (BE-11b); rows
    archived before ``archived_from`` existed fall back to ``open``."""
    _guard_write(request)
    task = store.unarchive_task(task_id)
    if task is None:
        raise HTTPException(404, "task not found or not archived")
    _notify_and_broadcast("work", f"{task_id}: из архива", "задача возвращена на доску", task_id, {"kind": "task.unarchived", "task_id": task_id})
    return {"ok": True, "task": task}


# ------------------------------------------------------- agent reports (BE-11a)
# Same per-client sliding-window pattern as task-drafts; a friendlier budget
# because agents report several times per task (intermediates + final).
_REPORT_RATE_LIMIT = 30         # requests per client ...
_REPORT_RATE_WINDOW = 60.0      # ... per sliding window (seconds)
_report_limiter = RateLimiter(limit=_REPORT_RATE_LIMIT, window=_REPORT_RATE_WINDOW)


@app.post("/api/tasks/{task_id}/reports", status_code=201)
async def create_task_report(task_id: str, body: ReportCreate,
                             request: Request) -> ReportCreatedOut:
    """Append an agent report to a task. 404 on unknown task; 422 on an
    unknown kind or an empty body; 429 when the per-client rate limit is
    exhausted. A second kind="final" supersedes previous live finals
    (history kept, flagged)."""
    _guard_write(request)
    client_ip = request.client.host if request.client else "unknown"
    if not _report_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"task reports rate limit exceeded "
            f"({_REPORT_RATE_LIMIT} per {_REPORT_RATE_WINDOW:.0f}s per client)",
        )
    if body.kind not in REPORT_KINDS:
        raise HTTPException(422, f"unknown report kind: {body.kind}")
    if not body.body.strip():
        raise HTTPException(422, "report body is empty")
    try:
        added = store.add_report(task_id, body.body, body.kind, body.agent)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if added is None:
        raise HTTPException(404, "task not found")
    report, superseded_ids = added
    _notify_and_broadcast(
        "work", f"{task_id}: отчёт агента ({body.kind})",
        report["body"][:120], task_id,
        {"kind": "report", "task_id": task_id,
         "report": {**report, "body": report["body"][:200]}},
    )
    return {"ok": True, "report": report, "superseded": superseded_ids}


@app.get("/api/tasks/{task_id}/reports")
async def list_task_reports(task_id: str) -> ReportsOut:
    """Chronological report history for a task (oldest first)."""
    reports = store.list_reports(task_id)
    if reports is None:
        raise HTTPException(404, "task not found")
    return {"ok": True, "task_id": task_id,
            "count": len(reports), "items": reports}


# --------------------------------------------------------- task inbox (AGG-1)
# Mirror of task:queue memories from every active memory server, refreshed
# by the background scanner (task_inbox.background_refresher) or on demand
# via POST /api/tasks/inbox/refresh. Queue-memories are DATA (SEC-4): the
# mirror stores title/excerpt/tags only and never treats content as
# instructions.
_INBOX_REFRESH_RATE_LIMIT = 5   # requests per client ...
_INBOX_REFRESH_RATE_WINDOW = 60.0  # ... per sliding window (seconds)
_inbox_refresh_limiter = RateLimiter(
    limit=_INBOX_REFRESH_RATE_LIMIT, window=_INBOX_REFRESH_RATE_WINDOW)


@app.get("/api/tasks/inbox")
async def tasks_inbox(scope: str = "all", project: str = "",
                      include_adopted: bool = False) -> TaskInboxOut:
    """AGG-1 inbox: task:queue records mirrored from active memory servers.

    - dedup (unconditional): records whose memory_id is linked from ANY
      native task's memory_ids (bulk import included) never appear here;
    - ``scope``: 'all' or one source server name; ``project``: exact match;
    - ``include_adopted``: re-include rows that already produced a native
      task (hidden by default);
    - ``stale``: the source server stopped returning the record (last_seen
      older than 30 min);
    - ``refreshed_at``: timestamp of the last completed scan (board_meta).
    """
    items = store.list_inbox(scope=scope, project=project,
                             include_adopted=include_adopted)
    return TaskInboxOut(
        items=[TaskInboxItem(**i) for i in items],
        count=len(items),
        refreshed_at=store.inbox_refreshed_at(),
    )


@app.post("/api/tasks/inbox/refresh")
async def tasks_inbox_refresh(request: Request) -> TaskInboxRefreshOut:
    """Force one inbox scan synchronously (mutation-action). The mnemos
    round-trips are async, so the event loop never blocks; the request may
    take seconds — that is accepted for an explicit refresh. Rate limited
    per client; a failing server degrades its own slice only."""
    _guard_write(request)
    client_ip = request.client.host if request.client else "unknown"
    if not _inbox_refresh_limiter.acquire(client_ip):
        raise HTTPException(
            429,
            f"task-inbox refresh rate limit exceeded "
            f"({_INBOX_REFRESH_RATE_LIMIT} per {_INBOX_REFRESH_RATE_WINDOW:.0f}s per client)",
        )
    result = await refresh_inbox(registry, store)
    return TaskInboxRefreshOut(**result)


@app.post("/api/tasks/inbox/{memory_id}/adopt", status_code=201)
async def tasks_inbox_adopt(memory_id: str, request: Request) -> TaskOut:
    """Adopt a mirrored task:queue record as a NATIVE board task.

    The memory content is never copied — the task links it via memory_ids
    (SEC-4). 409 with the existing ``task_id`` on double adoption; 404 when
    the mirror row is unknown."""
    _guard_write(request)
    rec = store.get_inbox_item(memory_id)
    if rec is None:
        raise HTTPException(404, "memory not found in task inbox")
    if rec.get("adopted_task_id"):
        return JSONResponse(
            status_code=409,
            content={
                "task_id": rec["adopted_task_id"],
                "detail": "inbox record already adopted",
            },
        )
    specialist = rec.get("specialist") or ""
    # store raises ValueError on a garbage env/priority in the mirror row —
    # surface as 422, never as a 500
    try:
        task = store.create_task({
            "title": (rec.get("title") or f"task:queue {memory_id[:8]}")[:200],
            "summary": (
                f"Принято из task:queue ({rec['server']}, память {memory_id[:8]}) "
                "— полное описание в связанной памяти."
            ),
            "project": rec.get("project", ""),
            "priority": rec.get("priority", "normal"),
            "env": "laptop",
            "agents": ["zcode"],
            "specialists": [specialist] if specialist else [],
            "memory_ids": [memory_id],
            "mnemos_tags": ["task-queue-import"],
        })
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    if not store.mark_inbox_adopted(memory_id, task["id"]):
        logging.getLogger("vesmaro.inbox").warning(
            "adopt: mirror row %s vanished mid-adopt (native task %s kept)",
            memory_id, task["id"])
    _notify_and_broadcast(
        "work", f"{task['id']}: принята из task:queue",
        task["title"][:120], task["id"],
        {"kind": "task.created", "task": task},
    )
    return task


# -------------------------------------------------------- specialist profile
@app.get("/api/specialists/profile")
async def specialist_profile_q(name: str, refresh: bool = False) -> SpecialistProfileOut:
    """Query-param variant (slash-safe for names like SRE/DevOps)."""
    return await specialist_profile(name=name, refresh=refresh)


@app.get("/api/specialists/{name}/profile")
async def specialist_profile(name: str, refresh: bool = False) -> SpecialistProfileOut:
    """Specialist composition (instructions/skills/rules/triggers).

    BE-9 semantics: ``sections`` hold only this agent's own files and the
    skills/instructions its .md explicitly references; plugin-level
    material available to every agent of the plugin is returned once in
    ``shared`` (``shared: true``, ``scope: "plugin"``, ``counts`` and a
    ``summary`` line) instead of being repeated on every card.

    Serving order: SQLite cache (instant, populated by refresh-all or the
    background loop) → deterministic filesystem build from the GCW plugin
    tree → legacy mnemos-index search for names the builder cannot
    resolve. Pass ?refresh=1 to force a rebuild.
    """
    slug = (name.lower().replace("@gcw: ", "gcw-")
            .replace(" ", "-").replace("/", "-"))

    if not refresh:
        cached = store.get_profile_cache(name)
        if cached:
            return {"ok": True, "cached": True, "updated_at": cached["updated_at"],
                    **cached["profile"]}

    # BE-9 fast path: deterministic build from GCW plugin files. No
    # memory-server round-trip; duplication is structurally impossible
    # because sections come from explicit per-agent references only.
    built = await asyncio.to_thread(build_profile, name)
    if built is not None:
        store.put_profile_cache(name, built)
        return {"ok": True, "cached": False, **built}

    # legacy slow path: search memory servers for the index tag.
    # A single probe query misses records (hybrid scoring quirks), so run
    # several probe queries and merge by id.
    tag = f"specialist:{slug}"
    legacy_tag = tag.replace("-", "/", 2) if "/" not in tag else tag
    tags_probe = [tag, legacy_tag]
    servers = registry.active_servers()
    probe_queries = ("*", "specialist", "[instructions]", "[skills]", "[rules]", "[triggers]", "[meta]")
    results = await asyncio.gather(*(
        mnemos_client.post_json_async(
            s, "/search", {"query": q, "tags": [t], "limit": 60},
            timeout=15.0,
        )
        for s in servers for q in probe_queries for t in tags_probe
    ))
    server_names = [s["name"] for s in servers for q in probe_queries for t in tags_probe]
    packed = list(zip(server_names, results))
    sections: dict[str, list[dict[str, Any]]] = {
        "instructions": [], "skills": [], "rules": [], "triggers": [], "other": [],
    }
    meta: dict[str, Any] = {"role": name, "slug": slug}
    errors = []
    seen: set[str] = set()
    for s_name, (code, data) in packed:
        if code != 200:
            errors.append({"server": s_name, "status": code})
            continue
        for it in (data if isinstance(data, list) else []):
            mid = it.get("id")
            if mid and mid in seen:
                continue
            if mid:
                seen.add(mid)
            kind = _section_of(it.get("title", ""))
            entry = {
                "title": (it.get("title") or "")[:140],
                "source_url": (it.get("source_url") or ""),
                "excerpt": (it.get("content") or "")[:200000],
                "id": it.get("id"),
                "server": s_name,
            }
            if kind in sections and kind != "other":
                sections[kind].append(entry)
            elif kind == "meta":
                meta.update(_parse_meta_excerpt(it.get("content") or ""))
            else:
                sections["other"].append(entry)

    profile = {
        "specialist": name, "slug": slug, "meta": meta,
        "sections": sections, "errors": errors,
        "indexed": any(sections.values()),
    }
    if profile["indexed"]:
        store.put_profile_cache(name, profile)
    return {"ok": True, "cached": False, **profile}


@app.post("/api/specialists/refresh-all")
async def specialists_refresh_all(request: Request) -> RefreshAllOut:
    """Prime/refresh all profile caches now (used right after sync).

    BE-9: rebuilds every board specialist from GCW plugin files via the
    deterministic scoped builder (idempotent upsert — one stable cache
    row per specialist, repeats never duplicate). Names the builder
    cannot resolve fall back to the legacy memory-server refresh.
    """
    _guard_write(request)
    specialists = sorted({s for t in store.board()["tasks"] for s in (t.get("specialists") or [])})
    built = memory_fallback = failed = 0
    for name in specialists:
        try:
            profile = await asyncio.to_thread(build_profile, name)
            if profile is not None:
                store.put_profile_cache(name, profile)
                built += 1
                continue
            await specialist_profile(name=name, refresh=True)
            memory_fallback += 1
        except Exception:
            failed += 1
    return {"ok": True, "refreshed": built + memory_fallback,
            "built": built, "memory_fallback": memory_fallback,
            "failed": failed}


def _section_of(title: str) -> str:
    tl = title.lower()
    if tl.startswith("[meta]"):
        return "meta"
    if tl.startswith("[instructions]"):
        return "instructions"
    if tl.startswith("[skills]"):
        return "skills"
    if tl.startswith("[rules]"):
        return "rules"
    if tl.startswith("[triggers]"):
        return "triggers"
    return "other"


def _parse_meta_excerpt(text: str) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for line in text.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            out[k.strip().lower()] = v.strip()[:200]
    return out


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
    """Mutation guard (SEC-3, fail-closed).

    Empty VESMARO_BOARD_TOKEN means auth is NOT configured: every mutation
    is rejected with 503 (the Helm chart provisions the token; compose.yaml
    ships a dev value for local runs). The comparison is constant-time.
    """
    if not BOARD_WRITE_TOKEN:
        raise HTTPException(
            503,
            "mutation auth is not configured: set VESMARO_BOARD_TOKEN to "
            "enable board writes (fail-closed; see compose.yaml for local dev)",
        )
    auth = request.headers.get("Authorization", "")
    expected = f"Bearer {BOARD_WRITE_TOKEN}"
    if not hmac.compare_digest(auth.encode("utf-8"), expected.encode("utf-8")):
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