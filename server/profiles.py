"""Per-agent GCW profile builder (BE-9).

Root cause this module fixes: scripts/sync-gcw-profiles.py indexed EVERY
file of a specialist's plugin (all agents, all skills, prompts, manifest)
under that specialist's ``specialist:<slug>`` tag. Because several
specialists share one plugin (e.g. seven engineering roles live in
``gcw-engineering``), every card received every skill/instruction of the
plugin — cross-agent duplication served back by the mnemos-indexed
profile route.

New semantics (agreed with the owner, task BE-9):

- ``sections.*``      — ONLY what explicitly belongs to THIS agent:
                        its own ``*.agent.md`` (kind ``agent-file``) and
                        the skills / instruction files its .md references
                        by name (``scope: "agent"``, ``shared: false``).
- ``shared``          — plugin-level material available to every agent of
                        the plugin (unreferenced skills, canon
                        instructions, prompts, plugin manifest), each with
                        ``shared: true``, ``scope: "plugin"``. Never
                        repeated per-agent; ``shared.summary`` carries a
                        "+N ..." one-liner for the UI.
- Determinism         — scans are sorted, reference sets are order-free,
                        no timestamps inside the profile dict, so
                        ``build_profile`` is idempotent and refresh-all
                        upserts one stable cache row per specialist.

Section keys (instructions/skills/rules/triggers/other) and entry shape
(title/source_url/excerpt) are unchanged for SPA compatibility; only NEW
fields were added. Old section semantics are preserved: the agent's own
file lands in ``instructions``, referenced ``*.instructions.md`` canon in
``rules`` (as the sync script categorized them).

The mnemos index (scripts/sync-gcw-profiles.py) remains useful for
search/recall, but the board profile no longer depends on it: when the
GCW plugin tree is reachable, profiles are built straight from files,
which makes duplication structurally impossible.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

# Same env vars as scripts/sync-gcw-profiles.py — operators configure once.
GCW_PLUGINS_DIR = Path(os.environ.get(
    "GCW_PLUGINS_DIR",
    "/var/home/abyss/LABs/Projects/Reserching/GithubCopilotWorkflow/plugins",
))
GCW_INSTRUCTIONS_DIR = Path(os.environ.get(
    "GCW_INSTRUCTIONS_DIR",
    "/var/home/abyss/LABs/Projects/Reserching/"
    "GithubCopilotWorkflow/.github/instructions",
))

BUILDER_VERSION = "fs-scoped-v1"

# Per-entry excerpt caps. Agent entries keep enough text for the card's
# collapsible viewer; shared (plugin-level) listings are reference
# summaries only — full texts stay in the GCW repo. Bounds the
# profile_cache rows (see BE-6 cache-size concerns).
EXCERPT_LIMIT = 20_000
SHARED_EXCERPT_LIMIT = 2_000

_SECTIONS = ("instructions", "skills", "rules", "triggers", "other")


def slugify(name: str) -> str:
    """Board slug for a specialist display name (matches existing API)."""
    return (name.lower().replace("@gcw: ", "gcw-")
            .replace("gcw: ", "gcw-")
            .replace(" ", "-").replace("/", "-"))


def _read_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return None


def _frontmatter(text: str) -> dict[str, Any]:
    """Minimal frontmatter reader: scalar ``key: value`` pairs plus a
    string list under ``agents:``. No YAML dependency; anything richer
    is ignored (we only need name/description/delegation targets)."""
    meta: dict[str, Any] = {}
    if not text.startswith("---"):
        return meta
    lines = text.splitlines()[1:]
    in_agents = False
    for line in lines:
        if line.strip() == "---":
            break
        if line.startswith((" ", "-", "\t")):
            if in_agents and line.strip().startswith("-"):
                val = line.strip()[1:].strip().strip('"').strip("'")
                if val:
                    meta.setdefault("agents", []).append(val)
            continue
        m = re.match(r"^([A-Za-z_-]+):\s*(.*)$", line)
        if not m:
            continue
        key, val = m.group(1).lower(), m.group(2).strip().strip('"').strip("'")
        in_agents = key == "agents"
        if val:
            meta[key] = val
    return meta


def _mentioned(text: str, token: str) -> bool:
    """Word-boundary mention of ``token`` in ``text``. Backslash-free
    lookarounds because GCW names contain ``-`` (``\\b`` would glue to it)."""
    pat = re.compile(r"(?<![\w-])" + re.escape(token) + r"(?![\w-])")
    return bool(pat.search(text))


def _dedupe_by_key(items: list[dict[str, Any]], key_of, prefer: str) -> \
        list[dict[str, Any]]:
    """One entry per key (skill name / instruction stem). The same skill
    name is shipped by several GCW plugins (every plugin's skills are
    installed flat for every agent); keep the agent's own plugin copy as
    canonical and record the rest in ``also_in`` instead of repeating
    the file (the BE-9 dedup, second line of defense)."""
    order: list[Any] = []
    by_key: dict[Any, dict[str, Any]] = {}
    for it in items:
        key = key_of(it)
        cur = by_key.get(key)
        if cur is None:
            copy = dict(it)
            copy["also_in"] = []
            by_key[key] = copy
            order.append(key)
            continue
        other_plugin = it.get("plugin", "")
        if other_plugin and other_plugin not in cur["also_in"]:
            cur["also_in"].append(other_plugin)
        if other_plugin == prefer and cur.get("plugin") != prefer:
            # promote the own-plugin copy, keep collected aliases
            aliases = [p for p in cur["also_in"]] + [cur.get("plugin", "")]
            cur["also_in"] = sorted({p for p in aliases if p and p != prefer})
            cur.update({k: v for k, v in it.items() if k != "plugin"})
            cur["plugin"] = prefer
    return [by_key[k] for k in order]


def _scan_plugins(plugins_dir: Path) -> dict[str, list[dict[str, Any]]]:
    """Index all agent files and skills across plugins (sorted, stable)."""
    agents: list[dict[str, Any]] = []
    skills: list[dict[str, Any]] = []
    prompts: list[dict[str, Any]] = []
    if not plugins_dir.is_dir():
        return {"agents": agents, "skills": skills, "prompts": prompts}
    for pdir in sorted(p for p in plugins_dir.iterdir() if p.is_dir()):
        plugin = pdir.name
        for f in sorted((pdir / "agents").glob("*.agent.md")):
            text = _read_text(f)
            if text is None:
                continue
            fm = _frontmatter(text)
            agents.append({
                "plugin": plugin,
                "path": f,
                "stem": f.name.removesuffix(".agent.md"),
                "name": fm.get("name") or f.stem,
                "description": fm.get("description", ""),
                "agents": list(fm.get("agents", [])),
                "text": text,
            })
        skills_dir = pdir / "skills"
        if skills_dir.is_dir():
            for f in sorted(skills_dir.glob("*/SKILL.md")):
                text = _read_text(f)
                if text is None:
                    continue
                skills.append({
                    "plugin": plugin,
                    "path": f,
                    "name": f.parent.name,
                    "text": text,
                })
        prompts_dir = pdir / "prompts"
        if prompts_dir.is_dir():
            for f in sorted(prompts_dir.glob("*.prompt.md")):
                text = _read_text(f)
                if text is None:
                    continue
                prompts.append({
                    "plugin": plugin,
                    "path": f,
                    "name": f.name,
                    "text": text,
                })
    return {"agents": agents, "skills": skills, "prompts": prompts}


def _scan_instructions(instructions_dir: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not instructions_dir.is_dir():
        return out
    for f in sorted(instructions_dir.glob("*.instructions.md")):
        text = _read_text(f)
        if text is None:
            continue
        out.append({
            "path": f,
            "stem": f.name.removesuffix(".instructions.md"),
            "text": text,
        })
    return out


def _entry(*, title: str, path: Path, text: str, kind: str,
           shared: bool, source: str, excerpt_limit: int) -> dict[str, Any]:
    try:
        shown = str(path)
        root = str(GCW_PLUGINS_DIR.parent)
        if shown.startswith(root):
            shown = shown[len(root):].lstrip("/")
    except (TypeError, ValueError):  # pragma: no cover — defensive
        shown = str(path)
    return {
        "title": title[:140],
        "source_url": f"file://{path}",
        "excerpt": text[:excerpt_limit],
        "path": shown,
        "kind": kind,
        "shared": shared,
        "scope": "plugin" if shared else "agent",
        "source": source,
    }


def resolve_agent(name: str, index: dict[str, list[dict[str, Any]]]) -> \
        dict[str, Any] | None:
    """Match a requested specialist to its agent file. Accepts the
    display name ("@GCW: Tech Lead", "GCW: SRE/DevOps"), the board slug
    ("gcw-sre-devops") and bare stems ("tech-lead")."""
    want = slugify(name)
    want_bare = want.removeprefix("gcw-")
    for a in index["agents"]:
        if slugify(a["name"]) in (want, f"gcw-{want_bare}") \
                or slugify(a["stem"]) in (want, want_bare):
            return a
    return None


def build_profile(name: str, *, plugins_dir: Path | None = None,
                  instructions_dir: Path | None = None) -> dict[str, Any] | None:
    """Build a scoped profile for ``name`` straight from GCW plugin files.

    Returns ``None`` when the agent cannot be resolved (unknown name or
    GCW tree unavailable) so callers can fall back to the legacy
    memory-server path.
    """
    pdir = plugins_dir if plugins_dir is not None else GCW_PLUGINS_DIR
    idir = instructions_dir if instructions_dir is not None \
        else GCW_INSTRUCTIONS_DIR

    index = _scan_plugins(pdir)
    instructions = _scan_instructions(idir)
    agent = resolve_agent(name, index)
    if agent is None:
        return None

    text = agent["text"]
    plugin = agent["plugin"]

    # ---- per-agent scope: explicit references in THIS agent's .md only
    own = _entry(
        title=f"[instructions] {agent['name']} — {agent['path'].name}",
        path=agent["path"], text=text, kind="agent-file",
        shared=False, source="gcw-plugins", excerpt_limit=EXCERPT_LIMIT,
    )
    ref_skills = _dedupe_by_key(
        [s for s in index["skills"] if _mentioned(text, s["name"])],
        key_of=lambda s: s["name"], prefer=plugin,
    )
    ref_rules = _dedupe_by_key(
        [i for i in instructions
         if _mentioned(text, i["stem"])
         or _mentioned(text, i["stem"] + ".instructions.md")],
        key_of=lambda i: i["stem"], prefer="",
    )

    sections: dict[str, list[dict[str, Any]]] = {k: [] for k in _SECTIONS}
    sections["instructions"].append(own)
    for s in sorted(ref_skills, key=lambda x: x["name"]):
        sections["skills"].append(_entry(
            title=f"[skills] {s['name']} — {s['plugin']}/skills/{s['name']}/SKILL.md",
            path=s["path"], text=s["text"], kind="skill",
            shared=False, source="gcw-plugins", excerpt_limit=EXCERPT_LIMIT,
        ) | {"also_in": s["also_in"]})
    for i in sorted(ref_rules, key=lambda x: x["stem"]):
        sections["rules"].append(_entry(
            title=f"[rules] {i['stem']}.instructions.md",
            path=i["path"], text=i["text"], kind="instruction",
            shared=False, source="gcw-instructions",
            excerpt_limit=EXCERPT_LIMIT,
        ) | {"also_in": i["also_in"]})

    # ---- shared (plugin-level): available to every agent of the plugin,
    # listed once with shared:true — never merged into per-agent sections.
    ref_skill_names = {s["name"] for s in ref_skills}
    ref_rule_stems = {i["stem"] for i in ref_rules}
    plugin_skills = [s for s in index["skills"] if s["plugin"] == plugin]
    shared_skills = sorted(
        (s for s in plugin_skills if s["name"] not in ref_skill_names),
        key=lambda x: x["name"],
    )
    shared_prompts = sorted(
        (p for p in index["prompts"] if p["plugin"] == plugin),
        key=lambda x: x["name"],
    )
    shared_rules: list[dict[str, Any]] = sorted(
        (i for i in instructions if i["stem"] not in ref_rule_stems),
        key=lambda x: x["stem"],
    )
    manifest_path = pdir / plugin / "plugin.json"
    manifest_text = _read_text(manifest_path)

    shared_sections: dict[str, list[dict[str, Any]]] = {k: [] for k in _SECTIONS}
    for s in shared_skills:
        shared_sections["skills"].append(_entry(
            title=f"[skills] {s['name']} — {plugin}/skills/{s['name']}/SKILL.md",
            path=s["path"], text=s["text"], kind="skill",
            shared=True, source="gcw-plugins",
            excerpt_limit=SHARED_EXCERPT_LIMIT,
        ))
    for i in shared_rules:
        shared_sections["rules"].append(_entry(
            title=f"[rules] {i['stem']}.instructions.md",
            path=i["path"], text=i["text"], kind="instruction",
            shared=True, source="gcw-instructions",
            excerpt_limit=SHARED_EXCERPT_LIMIT,
        ))
    for p in shared_prompts:
        shared_sections["triggers"].append(_entry(
            title=f"[triggers] {p['name']}",
            path=p["path"], text=p["text"], kind="prompt",
            shared=True, source="gcw-plugins",
            excerpt_limit=SHARED_EXCERPT_LIMIT,
        ))
    if manifest_text is not None:
        shared_sections["rules"].append(_entry(
            title=f"[rules] {plugin}/plugin.json",
            path=manifest_path, text=manifest_text, kind="manifest",
            shared=True, source="gcw-plugins",
            excerpt_limit=SHARED_EXCERPT_LIMIT,
        ))

    shared_counts = {k: len(v) for k, v in shared_sections.items() if v}
    shared_total = sum(shared_counts.values())
    summary_bits = [f"+{n} plugin {k}" for k, n in sorted(shared_counts.items())]

    fm_desc = agent["description"]
    profile: dict[str, Any] = {
        "specialist": name,
        "slug": slugify(name),
        "builder": BUILDER_VERSION,
        "meta": {
            "role": name,
            "slug": slugify(name),
            "name": agent["name"],
            "plugin": plugin,
            "description": (fm_desc or "")[:500],
            "delegates_to": sorted(agent["agents"]),
        },
        "sections": sections,
        "shared": {
            "plugin": plugin,
            "sections": shared_sections,
            "counts": shared_counts,
            "total": shared_total,
            "summary": ", ".join(summary_bits),
        },
        "errors": [],
        "indexed": any(sections.values()),
    }
    return profile
