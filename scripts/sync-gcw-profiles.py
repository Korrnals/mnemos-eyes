#!/usr/bin/env python3
"""sync-gcw-profiles — index GCW specialist composition into mnemos memory.

Cross-system design: specialist composition (instructions / skills / rules /
triggers) is indexed from GCW plugin files into mnemos with stable tags
(specialist:<slug>, gcw:component:<kind>). Any memory server holding the
index serves the profile — the board needs no GCW checkout.

Idempotent: run again after GCW changes.

Usage:
    python3 scripts/sync-gcw-profiles.py [--server URL] [--token TOK] [--only SUBSTR]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path

GCW_PLUGINS_DIR = Path(os.environ.get(
    "GCW_PLUGINS_DIR",
    "/var/home/abyss/LABs/Projects/Reserching/GithubCopilotWorkflow/plugins",
))
GCW_INSTRUCTIONS_DIR = Path(os.environ.get(
    "GCW_INSTRUCTIONS_DIR",
    "/var/home/abyss/LABs/Projects/Reserching/GithubCopilotWorkflow/.github/instructions",
))

SPECIALIST_PLUGINS: dict[str, list[str]] = {
    "@GCW: Tech Lead": ["gcw-engineering"],
    "@GCW: Senior Frontend Developer": ["gcw-engineering"],
    "@GCW: Senior System Engineer": ["gcw-engineering"],
    "@GCW: Senior Security Engineer": ["gcw-engineering"],
    "@GCW: SRE/DevOps": ["gcw-engineering"],
    "@GCW: Senior DBA": ["gcw-engineering"],
    "@GCW: Senior QA Engineer": ["gcw-engineering"],
    "@GCW: Task Manager": ["gcw-engineering"],
    "@GCW: Code Reviewer": ["gcw-code-review"],
    "@GCW: Concierge": ["gcw-concierge"],
    "@GCW: Docs Writer": ["gcw-docs"],
    "@GCW: Product Manager": ["gcw-product"],
    "@GCW: Product Architect": ["gcw-product"],
    "@GCW: Analytics Lead": ["gcw-product"],
    "@GCW: Agent Architect": ["gcw-agent-architect"],
    "@GCW: Executor": ["gcw-executor"],
    "@GCW: Researcher": ["gcw-research"],
}

CANON_RULES = [
    "gcw-agent-behavior", "communication-language", "destructive-actions",
    "response-style", "scope-discipline", "sensitive-data", "terminal-safety",
    "token-economics", "git-workflow", "review-process",
]


def slugify(name: str) -> str:
    return (name.lower().replace("@gcw: ", "gcw-")
            .replace(" ", "-").replace("/", "-"))


def collect_files(slugs: list[str]) -> dict[str, list[Path]]:
    files: dict[str, list[Path]] = {"instructions": [], "skills": [],
                                    "rules": [], "triggers": []}
    for slug in slugs:
        pdir = GCW_PLUGINS_DIR / slug
        for f in sorted((pdir / "agents").glob("*.agent.md")):
            files["instructions"].append(f)
        skills = pdir / "skills"
        if skills.exists():
            for f in sorted(skills.glob("*/SKILL.md")):
                files["skills"].append(f)
        prompts = pdir / "prompts"
        if prompts.exists():
            for f in sorted(prompts.glob("*.prompt.md")):
                files["triggers"].append(f)
        pj = pdir / "plugin.json"
        if pj.exists():
            files["rules"].append(pj)
    if GCW_INSTRUCTIONS_DIR.exists():
        for f in sorted(GCW_INSTRUCTIONS_DIR.glob("*.instructions.md")):
            if any(c in f.name for c in CANON_RULES):
                files["rules"].append(f)
    return files


def dedupe_id(specialist: str, kind: str, path: Path) -> str:
    h = hashlib.sha1(str(path).encode()).hexdigest()[:16]
    return f"sp-{slugify(specialist)}-{kind}-{h}"


def upsert(server: str, token: str, content: str, title: str, tags: list[str],
           path: Path, kind: str, specialist: str) -> bool:
    full = list(dict.fromkeys(
        ["project:gcw", "agent:gcw-agent-architect"] + tags))
    body = {
        "content": content[:100_000],
        "title": title[:200],
        "tags": full,
        "source": "file",
        "source_url": f"file://{path}",
        "memory_type": "snippet",
        "metadata": {"profile_index": True,
                      "stable_id": dedupe_id(specialist, kind, path)},
    }
    req = urllib.request.Request(f"{server}/memories", method="POST")
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, data=json.dumps(body).encode(), timeout=30) as r:
            return r.status in (200, 201)
    except urllib.error.HTTPError as e:
        print(f"  ! [{e.code}] {title[:70]}", file=sys.stderr)
        return False


def index_specialist(server: str, token: str, display: str, slugs: list[str]) -> int:
    tag = f"specialist:{slugify(display)}"
    count = 0
    kind_meta = {
        "instructions": ("instructions", "learning"),
        "skills": ("skills", "learning"),
        "rules": ("rules", "rule"),
        "triggers": ("triggers", "session"),
    }
    files = collect_files(slugs)
    for kind, entries in files.items():
        if kind not in kind_meta:
            continue
        label, subtype = kind_meta[kind]
        for path in entries:
            try:
                content = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            tags = [tag, f"gcw:component:{kind}", f"mnemos:{subtype}"]
            if upsert(server, token, content,
                      f"[{label}] {display} — {path.name}", tags, path, kind, display):
                count += 1

    meta_text = (
        f"SPECIALIST META for {display}\n"
        f"slug: {slugify(display)}\n"
        f"gcw_plugins: {chr(44).join(slugs)}\n"
        f"kind: gcw-plugin-role\n"
        f"components: instructions, skills, rules, triggers\n"
    )
    meta_tags = [tag, "gcw:component:meta", "mnemos:decision"]
    if upsert(server, token, meta_text,
              f"[meta] {display} — профиль специалиста", meta_tags,
              Path(f"gcw://{slugify(display)}"), "meta", display):
        count += 1
    return count


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default=os.environ.get("SYNC_SERVER", "http://127.0.0.1:8787"))
    ap.add_argument("--token", default=os.environ.get("MNEMOS_TOKEN", ""))
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    server = args.server.rstrip("/")
    try:
        with urllib.request.urlopen(f"{server}/health", timeout=10) as r:
            if r.status != 200:
                print(f"mnemos unhealthy at {server}", file=sys.stderr)
                return 1
    except Exception as e:
        print(f"mnemos unreachable at {server}: {e}", file=sys.stderr)
        return 1

    total = 0
    for display, slugs in SPECIALIST_PLUGINS.items():
        if args.only and args.only.lower() not in display.lower():
            continue
        n = index_specialist(server, args.token, display, slugs)
        print(f"  {display}: {n} записей")
        total += n
    print(f"OK: {total} profile records indexed into {server}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
