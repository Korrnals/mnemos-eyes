"""One-off: import GCW task:queue memories into the vesmaro board.

Idempotent: skips a record if any board task already links its memory id.
"""
import json
import urllib.request

BASE = "http://vesmaro.abyss.lab/api"
import os
TOKEN = os.environ["VESMARO_BOARD_TOKEN"]
H = {"Content-Type": "application/json", "Authorization": "Bearer " + TOKEN}

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
SEV = {"critical": "critical", "high": "high", "medium": "normal", "low": "low"}

# (id, created, project, severity, owner_slug, title) — from mnemos task:queue listing 2026-09-17
RECORDS = [
    ("bd945a48-0888-4b1f-9ebb-841519e5f8b9", "2026-09-15", "mnemos", "high", "gcw-senior-system-engineer", "task-queue-vesmaro-graph-a0-wave1"),
    ("89a6405f-c3d3-49ba-9eb0-ff3dcad99f27", "2026-09-13", "gcw", "high", "agent-architect", "agents-frontmatter-migration-slug-to-name (довести до конца)"),
    ("13b00e20-e311-4890-8549-69723f7cd3d8", "2026-08-30", "gcw", "high", "gcw-agent-architect", "GCW-задача: канонизировать процессы, доказанные практикой mira (8 пунктов)"),
    ("6c655783-a259-4901-852c-ecf7703e8491", "2026-08-27", "mnemos", "medium", "gcw-senior-system-engineer", "task-queue-mnemos-phase2-backlog"),
    ("e9ae5791-6e7b-427d-856f-8976fa90998b", "2026-08-26", "mnemos", "high", "gcw-senior-system-engineer", "task-queue-mnemos-125-decomposition-waves"),
    ("179219f5-95d3-412f-8f86-d628306dc6ef", "2026-08-26", "mnemos", "medium", "gcw-senior-system-engineer", "task-queue-mnemos-p2-layer3-management-plane-scan"),
    ("e5b6e79d-dc1a-4f90-aefc-8091e4b6dac9", "2026-08-26", "mnemos", "high", "gcw-senior-system-engineer", "task-queue-mnemos-p1-scan-store-scoping-search-recall"),
    ("6bf3dfff-949f-45bc-b0e5-375189de5bc8", "2026-08-26", "mnemos", "low", "gcw-senior-system-engineer", "task-queue-mnemos-turns-fts-dead-index"),
    ("efe5bfa6-9f71-4725-8f16-da217abce3ab", "2026-08-22", "mnemos", "high", "gcw-senior-system-engineer", "task-queue-mnemos-p0-retrieve-scan-status-gate"),
    ("a138857a-20e2-4d6a-b856-8e4687e92357", "2026-08-22", "mnemos", "high", "gcw-senior-system-engineer", "task-queue-mnemos-139-env-var-double-prefix-bug"),
    ("397e9f5f-ace6-4cc5-afcb-631bc3cebb1a", "2026-08-21", "mnemos", "medium", "gcw-senior-system-engineer", "task-queue-mnemos-133-federation-hardening-m5"),
    ("383f2b30-99b2-4065-9a13-ff82219f9e6b", "2026-08-21", "mnemos", "low", "gcw-senior-system-engineer", "task-queue-mnemos-132-storage-optimizations"),
    ("1ae708f7-ea20-46dd-a524-d729837a8948", "2026-08-21", "mnemos", "medium", "gcw-senior-security-engineer", "task-queue-mnemos-131-adversarial-corpus-screening"),
    ("e1741507-d677-400e-9850-15f6f479e716", "2026-08-21", "mnemos", "medium", "gcw-senior-system-engineer", "task-queue-mnemos-130-verification-decay-contradictions"),
    ("b5d16001-b226-4192-9e2e-cde9052f953a", "2026-08-21", "mnemos", "medium", "gcw-senior-system-engineer", "task-queue-mnemos-129-feedback-gap-detection"),
    ("d2c857fc-2978-4a99-9e2d-61ebeaeaa274", "2026-08-21", "mnemos", "medium", "gcw-senior-system-engineer", "task-queue-mnemos-128-memory-edges-graph-expansion"),
    ("3b786bec-6b8c-4888-a1ab-4ff38de514d0", "2026-08-21", "mnemos", "high", "gcw-senior-security-engineer", "task-queue-mnemos-127-injection-path-security-review"),
    ("8bd17e11-7063-4597-8dc0-3954e1e5cceb", "2026-08-21", "mnemos", "high", "gcw-senior-qa-engineer", "task-queue-mnemos-126-golden-set-baseline"),
    ("e071dbdf-b0fa-4eb1-8062-2b50f9a1fc75", "2026-08-21", "mnemos", "high", "gcw-senior-system-engineer", "task-queue-mnemos-125-assemble-context-contract"),
    ("dac4aff0-9534-4a88-8545-1958cc0e9a8e", "2026-08-21", "mnemos", "medium", "gcw-senior-system-engineer", "task-queue-mnemos-124-mcp-presets-template"),
    ("93675150-9c58-4fb7-8ff5-cb64f281fb31", "2026-08-21", "mnemos", "medium", "gcw-senior-system-engineer", "task-queue-mnemos-123-zero-config-loopback"),
    ("fafb28ec-c324-496c-85fb-ef8ecd242a53", "2026-08-21", "mnemos", "high", "gcw-sre-devops", "task-queue-mnemos-122-pypi-packaging"),
    ("b298a6a1-da0e-4b38-b934-97f143537332", "2026-08-21", "mnemos", "medium", "gcw-senior-system-engineer", "task-queue-mnemos-p3-federation-production-hardening-m5-remainder"),
    ("cbfdde56-8a7e-45bc-9b47-53f3814ebd32", "2026-08-15", "mnemos", "normal", "gcw-tech-lead", "task: compaction service API in mnemos (Option C)"),
    ("bdc220c0-c204-41d3-94c6-18b0cc4fe89e", "2026-08-15", "gcw", "normal", "gcw-tech-lead", "task: agent-side pre-compaction for GCW agents (Option B)"),
    ("b61937ce-b5b6-46ff-bb5e-ab4a4a87c11d", "2026-08-15", "ollama-cloud-provider", "normal", "gcw-tech-lead", "task: provider-level context compaction (Option A)"),
    ("8a1cf3c9-e4d8-4a82-8dc8-10d8133f0bef", "2026-08-12", "ollama-cloud-provider", "normal", "gcw-tech-lead", "v0.12.0 — SSRF guard + mid-stream error detection + stale branch cleanup"),
    ("16aef487-c1f8-4ab0-a93a-817491991972", "2026-08-10", "gcw", "high", "gcw-agent-architect", "Agent tool efficiency + custom toolsets — reduce redundant tool calls by 80%"),
    ("38a558f2-077f-4c1c-b670-3608e054ea99", "2026-08-08", "ollama-cloud-provider", "normal", "gcw-tech-lead", "v0.10.0 slice — SSE parser refactor + VSIX hygiene"),
    ("c9cffdd2-3147-493e-9af8-4a06640a4688", "2026-08-07", "jira-tempo-mcp", "high", "gcw-senior-system-engineer", "jira-tempo-mcp v0.4.0 full review — 65 findings (32 code + 33 docs)"),
    ("d047455e-90ff-439d-b97d-c4135dbaf3a3", "2026-08-07", "jira-tempo-mcp", "high", "gcw-senior-system-engineer", "jira-tempo-mcp: REPORT_OUTPUT_DIR + MCP-autonomy + silent mkdir"),
    ("d1516ba2-fc57-43f5-bdd4-a6a6f01cd696", "2026-07-31", "sealbox", "normal", "gcw-tech-writer", "sealbox ADR-0007 markdownlint fix + draft-dir exclusion — verified brief for Tech Writer"),
    ("f3f9860e-eced-4c47-9d0a-2d55c351f1a6", "2026-07-30", "mnemos", "medium", "gcw-senior-system-engineer", "Synthesis: task-queue-mnemos-96-workflow-status"),
    ("7d864c91-863a-474c-8e83-18d8dd13f60e", "2026-07-30", "mnemos", "high", "gcw-senior-security-engineer", "task-queue-mnemos-p0-1-per-agent-auth"),
    ("62fe83c7-e877-4cfc-b3c9-18886b266ec1", "2026-07-30", "mnemos", "low", "gcw-senior-system-engineer", "task-queue-mnemos-97-mnemos-tags-pilot"),
    ("03c3ff9b-1c30-419d-9d9b-8f1f7bc09f66", "2026-07-30", "mnemos", "medium", "gcw-senior-system-engineer", "task-queue-mnemos-96-workflow-status"),
    ("318314e5-a97d-4b24-9fb9-790bab547f11", "2026-07-30", "agentsnode", "low", "gcw-tech-lead", "Backlog: mnemos chart deferred findings (M3-M5) + untracked ADR 0016"),
    ("7600c75a-9659-434a-8231-9cd7f7455b9d", "2026-07-28", "gcw", "low", "gcw-git-workflow-specialist", "changelog-orphaned-unreleased-section-cleanup"),
]

board = json.load(urllib.request.urlopen(BASE + "/board", timeout=15))
linked = {mid for t in board["tasks"] for mid in (t.get("memory_ids") or [])}
created, skipped = 0, 0
for mid, date, project, sev, owner, title in RECORDS:
    if mid in linked:
        skipped += 1
        continue
    spec_slug = SPEC_MAP.get(owner, "@" + owner)
    payload = {
        "title": title[:200],
        "summary": f"Импортировано из GCW task queue (mnemos {mid[:8]}, {date}). Полное описание — в связанной памяти (вкладка «Память»).",
        "spec": "",
        "col": "open",
        "env": "cluster" if project == "agentsnode" else "laptop",
        "agents": ["zcode"],
        "specialists": [spec_slug],
        "project": project,
        "priority": SEV.get(sev, "normal"),
        "memory_ids": [mid],
        "mnemos_tags": ["task-queue-import"],
    }
    req = urllib.request.Request(BASE + "/tasks", data=json.dumps(payload).encode(),
                                 method="POST", headers=H)
    urllib.request.urlopen(req, timeout=15)
    created += 1
print(f"created: {created}, skipped (already linked): {skipped}, total records: {len(RECORDS)}")
