"""Task inbox aggregation engine (AGG-1).

Scans every ACTIVE memory server for records tagged ``task:queue`` and
mirrors them into the board's ``task_inbox`` SQLite table (see
``Store.upsert_inbox_records``). Memory content is DATA (SEC-4): only the
title, an excerpt (first 300 chars of content) and the tags travel into
the mirror — the board never executes or treats a queue record as an
instruction.

Query primitive: ``GET /memories?tags=task:queue`` — a TRUE tag listing
per the mnemos 4.1.0 OpenAPI (POST /search is a hybrid ranker where "*"
matches nothing reliably; not a listing), via ``mnemos_client.fetch_json``
(fully async; the event loop is never blocked). One failing server only
degrades its own slice: its error is recorded in the scan result and the
scan continues.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any

from . import mnemos_client
from .memory_registry import ServerRegistry
from .store import INBOX_EDITABLE_FIELDS, Store

log = logging.getLogger("vesmaro.inbox")

INBOX_TAG = "task:queue"
# Listing primitive (prod 1.3.1 root cause, mnemos 4.1.0 OpenAPI): POST
# /search is a HYBRID RANKER — "*" does not match everything and ``tags``
# only filters the ranked results, so a tag sweep via /search loses records
# (prod: exactly 1 arbitrary hit per store instead of the 38 backlog
# records; the tag drill shares this defect — backlog ticket, not fixed
# here). GET /memories supports ``tags`` as a TRUE listing (the same
# primitive mnemos_list_recent serves) and returns the full Memory[] array.
SCAN_LIMIT = 200  # one request per scan; offset pagination is a deliberate
#                  v1 omission — 200 covers any real task:queue backlog
SCAN_INTERVAL_SECONDS = 300.0
EXCERPT_CHARS = 300

# severity:<x> tag → board priority (same map as scripts/import_task_queue.py)
SEVERITY_MAP = {
    "critical": "critical", "high": "high", "medium": "normal", "low": "low",
}
# board priority → severity:<x> tag (inverse, used when writing an edited
# revision back to mnemos: board 'normal' is spelled severity:medium there)
REVERSE_SEVERITY_MAP = {v: k for k, v in SEVERITY_MAP.items()}

# UI-25: fields of the FUTURE task the owner may correct before adopting.
# They ride the mirror row's ``edits`` JSON column (store.save_inbox_edits);
# every other key in that JSON is bookkeeping (revision sync state) and is
# never merged into task fields. The dictionary lives on the store (single
# source, no import cycle); aliased here for the edit/revision helpers.
EDITABLE_FIELDS = INBOX_EDITABLE_FIELDS

# owner:<slug> tag → canonical @GCW specialist name (same map as the import
# script; unknown slugs degrade to "@<slug>" rather than being dropped)
SPEC_MAP = {
    "gcw-senior-system-engineer": "@GCW: Senior System Engineer",
    "gcw-senior-security-engineer": "@GCW: Senior Security Engineer",
    "gcw-senior-qa-engineer": "@GCW: Senior QA Engineer",
    "gcw-tech-writer": "@GCW: Tech Writer",
    "gcw-git-workflow-specialist": "@GCW: Git Workflow Specialist",
    "gcw-agent-architect": "@GCW: Agent Architect",
    "gcw-sre-devops": "@GCW: SRE/DevOps",
    "gcw-tech-lead": "@GCW: Tech Lead",
    "agent-architect": "@GCW: Agent Architect",
    "tech-writer": "@GCW: Tech Writer",
}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _tag_value(tags: list[str], prefix: str) -> str:
    """First ``prefix:<value>`` tag's value ('' when absent)."""
    for tag in tags or []:
        if isinstance(tag, str) and tag.startswith(prefix):
            return tag[len(prefix):]
    return ""


def record_from_memory(server_name: str, item: dict[str, Any]) -> dict[str, Any] | None:
    """Mirror record from one mnemos /memories listing hit — data fields
    only (SEC-4).

    Parsing is defensive about the hit shape: ``created_at`` may be absent
    or null (→ ``source_created_at=''``, the record is still mirrored) and
    an ``excerpt`` field may exist WITHOUT full ``content`` — prefer it,
    fall back to content, cap at EXCERPT_CHARS. Returns None only for hits
    without an id (nothing to key the mirror row / dedup on)."""
    memory_id = item.get("id")
    if not memory_id:
        log.debug("inbox scan on %s: hit without id skipped", server_name)
        return None
    tags = [t for t in (item.get("tags") or []) if isinstance(t, str)]
    content = item.get("content") or ""
    owner = _tag_value(tags, "owner:")
    return {
        "memory_id": memory_id,
        "server": server_name,
        "project": _tag_value(tags, "project:"),
        "title": item.get("title") or content[:80],
        "excerpt": (item.get("excerpt") or content)[:EXCERPT_CHARS],
        "tags": tags,
        "priority": SEVERITY_MAP.get(_tag_value(tags, "severity:"), "normal"),
        "specialist": SPEC_MAP.get(owner, f"@{owner}" if owner else ""),
        "source_created_at": item.get("created_at") or "",
    }


def _hits_of(body: Any) -> list[dict[str, Any]] | None:
    """Normalize a GET /memories listing body: a bare list is the contract;
    ``{items: [...]}`` / ``{results: [...]}`` are accepted defensively.
    None when the shape is unrecognized (treated as a server error)."""
    if isinstance(body, list):
        return [x for x in body if isinstance(x, dict)]
    if isinstance(body, dict):
        for key in ("items", "results"):
            hits = body.get(key)
            if isinstance(hits, list):
                return [x for x in hits if isinstance(x, dict)]
    return None


async def refresh_inbox(registry: ServerRegistry, store: Store) -> dict[str, Any]:
    """One full scan across all active memory servers: per server a
    GET /memories?tags=task:queue listing (async, never blocks the loop).
    Error-isolated per server: a server that fails (HTTP error /
    unreachable / unrecognized body) contributes an entry to ``errors`` and
    nothing else. Returns the scan counters ``{scanned_servers, found,
    new, errors}`` and stamps the ``task_inbox_refreshed_at`` board_meta
    marker for the GET endpoint."""
    servers = registry.active_servers()
    results = await asyncio.gather(*(
        mnemos_client.fetch_json(
            s, "/memories", {"tags": INBOX_TAG, "limit": SCAN_LIMIT},
        ) for s in servers
    ))
    scanned = 0
    errors: list[dict[str, Any]] = []
    batch: list[dict[str, Any]] = []
    seen: set[str] = set()
    for server, (code, body) in zip(servers, results):
        hits = _hits_of(body)
        if code != 200 or hits is None:
            errors.append({
                "server": server["name"],
                "status": code,
                "detail": str(body.get("detail"))[:200]
                if isinstance(body, dict) else "",
            })
            continue
        scanned += 1
        for item in hits:
            rec = record_from_memory(server["name"], item)
            if rec is None or rec["memory_id"] in seen:
                continue  # duplicate within one scan: first server wins
            seen.add(rec["memory_id"])
            batch.append(rec)
    seen_at = _now()
    found, new = store.upsert_inbox_records(batch, seen_at)
    store.set_meta(Store.INBOX_REFRESHED_AT_KEY, seen_at)
    return {
        "scanned_servers": scanned,
        "found": found,
        "new": new,
        "errors": errors,
    }


def parse_edits(raw: str | None) -> dict[str, Any]:
    """Parse the mirror row's ``edits`` JSON (''/null → {}). Defensive: a
    malformed blob degrades to {} — the base fields stay authoritative and
    the row remains adoptable (an edit is an overlay, never a corruptor)."""
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except ValueError:
        log.warning("inbox edits blob is not JSON — ignored")
        return {}
    return data if isinstance(data, dict) else {}


def field_edits(edits: dict[str, Any]) -> dict[str, str]:
    """Only the owner-editable task fields of an edits blob — the overlay
    the adopt flow merges over the base mirror fields. Empty strings are
    meaningful (the owner CLEARED the field), never skipped."""
    return {
        key: str(edits[key]) for key in EDITABLE_FIELDS
        if isinstance(edits.get(key), str)
    }


def revision_memory_body(rec: dict[str, Any], edits: dict[str, Any]) -> dict[str, Any]:
    """POST /memories body for the EDITED revision of a task:queue record
    (UI-25 sync-back).

    mnemos exposes NO content-update over HTTP (checked against the 4.1.0
    prod surface and the 4.3.0 source: no PATCH/PUT /memories route —
    ``manager.update`` is internal-only), so the honest minimal mechanism is
    a NEW revision record on the same server:

    - ``title``/``content`` carry the edited fields (content = the edited
      summary, or the board-known excerpt when only other fields changed —
      SEC-4: the board never holds more than the excerpt);
    - ``tags`` = the source tags with ``project:``/``severity:`` replaced
      by the edited values, plus the ``task:edit`` provenance tag;
      ``task:queue`` is KEPT so the queue keeps describing this pending
      work (the mirror re-sees the revision and dedups it via the native
      task's memory_ids link);
    - ``metadata.supersedes`` names the original memory id.

    The original record is intentionally left untouched: mutability is not
    an mnemos API concept — the revision is the supersession record."""
    raw_tags = rec.get("tags") or []
    if isinstance(raw_tags, str):  # raw mirror rows carry tags as JSON text
        try:
            raw_tags = json.loads(raw_tags)
        except ValueError:
            raw_tags = []
    if not isinstance(raw_tags, list):
        raw_tags = []
    tags = [t for t in raw_tags if isinstance(t, str)]
    overlaid = field_edits(edits)
    if "project" in overlaid:
        tags = [t for t in tags if not t.startswith("project:")]
        if overlaid["project"]:  # cleared project → no project: tag at all
            tags.append(f"project:{overlaid['project']}")
    if "priority" in overlaid:
        tags = [t for t in tags if not t.startswith("severity:")]
        tags.append(f"severity:{REVERSE_SEVERITY_MAP.get(overlaid['priority'], 'medium')}")
    tags.append("task:edit")
    return {
        "title": overlaid.get("title") or rec.get("title") or "",
        "content": overlaid.get("summary") or rec.get("excerpt") or "",
        "tags": tags,
        "memory_type": "note",
        "metadata": {
            "supersedes": rec.get("memory_id", ""),
            "edited_by": "vesmaro-eyes:inbox-edit",
        },
    }


async def background_refresher(registry: ServerRegistry, store: Store,
                               interval: float = SCAN_INTERVAL_SECONDS) -> None:
    """Lifespan task: one scan right after boot (the await below makes
    startup non-blocking), then every ``interval`` seconds. A failing scan
    is logged and absorbed; the loop itself never dies."""
    while True:
        try:
            result = await refresh_inbox(registry, store)
            log.info(
                "task inbox scanned: servers=%d found=%d new=%d errors=%d",
                result["scanned_servers"], result["found"], result["new"],
                len(result["errors"]),
            )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — background loop must never die
            log.exception("task inbox scan failed")
        await asyncio.sleep(interval)
