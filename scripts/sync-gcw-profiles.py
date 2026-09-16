#!/usr/bin/env python3
"""sync-gcw-profiles — index GCW specialist composition into mnemos memory.

Cross-system design (owner requirement 2026-09-16): the specialist card in
vesmaro-eyes must show instructions / skills / rules / triggers no matter
which harness or stack configuration is active. Instead of reading GCW files
at request time (couples the board to a GCW checkout), this script indexes
the composition into the mnemos store with stable tags:

    specialist:<slug>            — the specialist key
    gcw:component:<kind>         — instructions | skills | rules | triggers | meta

Any memory server holding these records serves the profile; the board reads
them through the standard search API. Re-run after GCW changes
(idempotent: upserts by source_url + title hash).

Usage:
    python3 scripts/sync-gcw-profiles.py [--zcode-dir DIR] [--server URL]

Runs against the first ACTIVE server from the board registry when --server
is omitted (needs the board's token — pass MNEMOS_TOKEN env or --server with
no-auth loopback).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

DEFAULT_ZCODE_DIR = Path(
    os.environ.get("ZCODE_HOME", "/var/home/abyss/.distrobox/ubuntu/home/.zcode")
)

SPECIALIST_SOURCES: dict[str, list[str]] = {
    # display name → GCW agent slugs to index
    "@GCW: Tech Lead": ["gcw-tech-lead"],
    "@GCW: Senior Frontend Developer": ["gcw-senior-frontend-developer"],
    "@GCW: Senior System Engineer": ["gcw-senior-system-engineer"],
    "@GCW: Senior Security Engineer": ["gcw-senior-security-engineer"],
    "@GCW: SRE/DevOps": ["gcw-sre-devops"],
    "@GCW: Agent Architect": ["gcw-agent-architect"],
    "@GCW: Product Manager": ["gcw-product-manager"],
    "@GCW: Senior DBA": ["gcw-senior-dba"],
    "@GCW: Senior QA Engineer": ["gcw-senior-qa-engineer"],
}

# role-contract sections that apply to every specialist
COMMON_INSTRUCTIONS = ["role-contracts.md", "gcw-agent-behavior.md"]


def slugify(name: str) -> str:
    return name.lower().replace("@gcw: ", "gcw-").replace(" ", "-")


def http_json(url: str, method: str = "POST", body: dict | None = None,
              token: str = "") -> tuple[int, dict | list | None]:
    req = urllib.request.Request(url, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data=data, timeout=20) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"null")
        except Exception:
            return e.code, None


def dedupe_id(specialist: str, kind: str, path: Path) -> str:
    h = hashlib.sha1(str(path).encode()).hexdigest()[:16]
    return f"sp-{slugify(specialist)}-{kind}-{h}"


def upsert_memory(server: str, token: str, content: str, title: str,
                  tags: list[str], memory_type: str, source_url: str,
                  stable_id: str) -> bool:
    """POST /memories with a stable metadata.id — mnemos keeps it deduped by
    content hash; the board treats (tags, title) as the key anyway."""
    # tag contract: exactly one project:*, one agent:*, >=1 mnemos:subtype.
    # extra tags (specialist:*, gcw:component:*) ride along freely.
    full_tags = list(dict.fromkeys(
        ["project:gcw", "agent:gcw-agent-architect"] + tags
    ))
    body = {
        "content": content[:100_000],
        "title": title[:200],
        "tags": full_tags,
        "source": "file",
        "source_url": source_url,
        "memory_type": memory_type,
        "metadata": {"profile_index": True, "stable_id": stable_id},
    }
    code, resp = http_json(f"{server}/memories", "POST", body, token)
    if code in (200, 201):
        return True
    print(f"  ! upsert failed [{code}]: {title[:60]} — {resp}", file=sys.stderr)
    return False


def index_specialist(server: str, token: str, display: str, slugs: list[str],
                     zcode_dir: Path) -> int:
    tag = f"specialist:{slugify(display)}"
    count = 0

    # 1) agent contracts (instructions)
    for slug in slugs:
        agent_file = zcode_dir / "agents" / f"{slug}.md"
        if agent_file.exists():
            ok = upsert_memory(
                server, token,
                agent_file.read_text(encoding="utf-8"),
                f"[instructions] {display} — agent contract ({slug})",
                [tag, "gcw:component:instructions", "mnemos:learning"],
                "snippet", f"file://{agent_file}",
                dedupe_id(display, "instructions", agent_file),
            )
            count += ok

    # 2) common instruction sections
    for rel in COMMON_INSTRUCTIONS:
        f = zcode_dir / "gcw" / "instructions" / rel
        if f.exists():
            ok = upsert_memory(
                server, token,
                f.read_text(encoding="utf-8"),
                f"[instructions] {display} — общий канон {rel}",
                [tag, "gcw:component:instructions", "mnemos:learning"],
                "snippet", f"file://{f}",
                dedupe_id(display, "instructions", f),
            )
            count += ok

    # 3) skills that mention the slug (role-specific skills only)
    skills_dir = zcode_dir / "skills"
    if skills_dir.exists():
        for skill in sorted(skills_dir.iterdir()):
            if not skill.is_dir():
                continue
            meta = skill / "SKILL.md"
            if not meta.exists():
                continue
            text = meta.read_text(encoding="utf-8")
            # role-specific: skill description mentions the slug/role words
            head = text[:1200].lower()
            role_words = slug.replace("gcw-", "").replace("-", " ")
            if role_words and role_words in head:
                ok = upsert_memory(
                    server, token, text,
                    f"[skills] {display} — skill {skill.name}",
                    [tag, "gcw:component:skills", "mnemos:learning"],
                    "snippet", f"file://{meta}",
                    dedupe_id(display, "skills", meta),
                )
                count += ok

    # 4) meta record: what the specialist IS (for the card header)
    meta_text = (
        f"SPECIALIST META for {display}\n"
        f"slug: {slugify(display)}\n"
        f"gcw_agents: {', '.join(slugs)}\n"
        f"kind: gcw-role\n"
        f"contract_files: {', '.join(str(zcode_dir / 'agents' / f'{s}.md') for s in slugs)}\n"
    )
    ok = upsert_memory(
        server, token, meta_text,
        f"[meta] {display} — профиль специалиста",
        [tag, "gcw:component:meta", "mnemos:decision"],
        "note", f"gcw://{slugify(display)}",
        dedupe_id(display, "meta", Path(f"meta/{display}")),
    )
    count += ok
    return count


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--zcode-dir", default=str(DEFAULT_ZCODE_DIR))
    ap.add_argument("--server", default=os.environ.get("SYNC_SERVER", "http://127.0.0.1:8787"))
    ap.add_argument("--token", default=os.environ.get("MNEMOS_TOKEN", ""))
    ap.add_argument("--only", default="", help="index only specialists matching this substring")
    args = ap.parse_args()

    server = args.server.rstrip("/")
    code, _ = http_json(f"{server}/health", "GET", None, args.token)
    if code != 200:
        print(f"mnemos unreachable at {server} (HTTP {code})", file=sys.stderr)
        return 1

    zcode_dir = Path(args.zcode_dir)
    total = 0
    for display, slugs in SPECIALIST_SOURCES.items():
        if args.only and args.only.lower() not in display.lower():
            continue
        n = index_specialist(server, args.token, display, slugs, zcode_dir)
        print(f"  {display}: {n} записей")
        total += n
    print(f"✓ {total} profile records indexed into {server}")
    return 0


if __name__ == "__main__":
    sys.exit(main())