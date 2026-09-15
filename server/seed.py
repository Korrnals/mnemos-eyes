"""Board seed: real mnemos-eyes / vesmaro program tasks.

Every ``memory_ids`` entry below is a REAL mnemos memory id (verified via
the mnemos MCP channel on 2026-09-15), not a placeholder. The board UI
resolves them live against the connected mnemos instance — if a link goes
stale, the memory card shows that honestly.
"""

from __future__ import annotations

from typing import Any

SEED_VERSION = "1"

SEED_TASKS: list[dict[str, Any]] = [
    {
        "id": "T6",
        "col": "in-progress",
        "title": "L1 viewer: wire HttpAdapter to live mnemos + auth flow",
        "summary": "CORS + auth/2FA gate cleared 2026-06-17. HttpAdapter must be "
                   "wired against the live API with mnk_ bearer tokens and TOTP "
                   "for remote sessions.",
        "spec": "Session brief T6; backend session complete (HEAD 4331a22, "
                "make verify green). Auth contract: Authorization: Bearer mnk_...; "
                "remote sessions require TOTP via POST /auth/verify.",
        "agents": ["zcode"],
        "specialists": ["@GCW: Senior Frontend Developer", "@GCW: Tech Lead"],
        "env": "cluster",
        "project": "mnemos-eyes",
        "memory_ids": ["25cdc0e9-1912-4217-aaf0-0e7c48912df1"],
        "mnemos_tags": ["project:mnemos-eyes", "agent:gcw-tech-lead", "mnemos:decision"],
    },
    {
        "id": "TB-1",
        "col": "in-progress",
        "title": "vesmaro-eyes task board v0 — this board",
        "summary": "Minimal beautiful board: tasks → status → agents → envs → "
                   "specialists → real mnemos memory links. Ships as a container "
                   "with a mounted volume; deployed to the ai-agent cluster.",
        "spec": "Vanilla ES-module SPA + FastAPI + SQLite (WAL) on a mounted "
                "volume; SSE for live updates; /api/mnemos/* proxy to the live "
                "memory engine. Column names = mnemos workflow states.",
        "agents": ["zcode"],
        "specialists": ["@GCW: Tech Lead"],
        "env": "cluster",
        "project": "mnemos-eyes",
        "memory_ids": ["25cdc0e9-1912-4217-aaf0-0e7c48912df1"],
        "mnemos_tags": ["project:mnemos-eyes", "agent:zcode", "mnemos:session"],
    },
    # ---------------------------------------------------------------- in-progress
    {
        "id": "RB-1",
        "col": "blocked",
        "col-note": "waits for owner YES",
        "title": "Rebrand wave: mnemos → vesmaro (registration day)",
        "summary": "Owner confirmed vesmaro as final. Wait for the owner's YES, "
                   "then one-day registrations (GitHub org + placeholders → "
                   "PyPI/npm via Trusted Publishers → domains → MCP dirs).",
        "spec": "Runbook: ~/.gcw/architectural-committee/2026-09-15-vesmaro-registration-runbook.md. "
                "Phases A→B→C→D, one-day window 09:00–11:00. Protective pack: "
                "vesmara/vesmario/vesmaris/vesmarin/vesmeri on PyPI+npm+GH-org.",
        "agents": ["gcw-tech-lead"],
        "specialists": ["@GCW: Tech Lead", "owner"],
        "env": "laptop",
        "project": "mnemos",
        "memory_ids": [
            "86ce17e7-1099-4e94-aa1b-eba431522560",
            "bc6a6504-b269-41d2-b30f-0c28e0974efc",
            "9917a27d-5f1c-4f11-aa8b-fce513789a61",
            "754f83a7-466e-4a42-a884-76382c7ea6d4",
        ],
        "mnemos_tags": ["project:mnemos", "agent:gcw-tech-lead", "mnemos:decision"],
    },
    {
        "id": "RB-2",
        "col": "blocked",
        "title": "Pre-wave: LLM mis-spawn test + placeholder packages + monitoring",
        "summary": "Mandatory prep before the registration day: mis-spawn test "
                   "across 4–5 models, placeholder packages via "
                   "scripts/rebrand-placeholder.sh, weekly vesm*/mnem* monitoring.",
        "spec": "Round-3 requirement: LLM mis-spawn test (4-5 models, one-liners) "
                "must pass before name freeze. Placeholder script + cron checker "
                "go into the prep wave.",
        "agents": ["gcw-tech-lead"],
        "specialists": ["@GCW: Tech Lead", "@GCW: Senior Security Engineer"],
        "env": "laptop",
        "project": "mnemos",
        "memory_ids": ["754f83a7-466e-4a42-a884-76382c7ea6d4"],
        "mnemos_tags": ["project:mnemos", "agent:gcw-tech-lead", "mnemos:decision"],
    },
    {
        "id": "T1",
        "col": "open",
        "title": "L1 viewer: scaffold Vite + React + TS + Tailwind + shadcn",
        "summary": "Scaffold app per docs/architecture.md; ESLint/Prettier; folder "
                   "structure; commit 'chore: scaffold L1 viewer'.",
        "spec": "Session brief T1. React 19 + Vite + TanStack Query v5; the "
                "task board v0 (vanilla) is the fast probe, not a replacement "
                "for the real L1 stack.",
        "agents": ["gcw-senior-frontend-developer"],
        "specialists": ["@GCW: Senior Frontend Developer"],
        "env": "laptop",
        "project": "mnemos-eyes",
        "memory_ids": ["25cdc0e9-1912-4217-aaf0-0e7c48912df1"],
        "mnemos_tags": ["project:mnemos-eyes", "agent:gcw-senior-frontend-developer", "mnemos:session"],
    },
    {
        "id": "T2",
        "col": "open",
        "title": "L1 viewer: MemoryGateway + HttpAdapter + MockAdapter",
        "summary": "Isolated data layer per ADR 0002; MockAdapter fixtures so UI "
                   "can be built before backend auth/CORS land.",
        "spec": "Gateway interface per docs/architecture.md §4. DI at bootstrap; "
                "swap adapters via VITE_MNEMOS_API_URL / window.__TAURI__ later.",
        "agents": ["gcw-senior-frontend-developer"],
        "specialists": ["@GCW: Senior Frontend Developer"],
        "env": "laptop",
        "project": "mnemos-eyes",
        "memory_ids": [],
        "mnemos_tags": ["project:mnemos-eyes", "agent:gcw-senior-frontend-developer", "mnemos:session"],
    },
    {
        "id": "T4",
        "col": "open",
        "title": "Design system → code: tokens, theming, IrisLogo, breathing",
        "summary": "Tokens (teal iris / gold confidence / Lora scroll font) from "
                   "docs/design-system.md into src/styles/tokens.css; IrisLogo + "
                   "breathing animation with reduced-motion support.",
        "spec": "Signature moments: well hero, pupil focus search, memory scroll, "
                "breathing iris (3s cycle). Motion budget: max 1 ambient animation.",
        "agents": ["gcw-senior-frontend-developer"],
        "specialists": ["@GCW: Senior Frontend Developer"],
        "env": "laptop",
        "project": "mnemos-eyes",
        "memory_ids": [],
        "mnemos_tags": ["project:mnemos-eyes", "agent:gcw-senior-frontend-developer", "mnemos:session"],
    },
    {
        "id": "T3",
        "col": "open",
        "title": "L1 viewer: openapi-typescript codegen from mnemos /openapi.json",
        "summary": "Wire scripts/codegen.sh to the live API schema; commit or "
                   "generate-in-build; CI drift guard.",
        "spec": "npx openapi-typescript http://127.0.0.1:8765/openapi.json "
                "--output src/types/openapi.d.ts --immutable-types",
        "agents": ["gcw-senior-frontend-developer"],
        "specialists": ["@GCW: Senior Frontend Developer"],
        "env": "laptop",
        "project": "mnemos-eyes",
        "memory_ids": [],
        "mnemos_tags": ["project:mnemos-eyes", "agent:gcw-senior-frontend-developer", "mnemos:session"],
    },
    {
        "id": "T5",
        "col": "open",
        "title": "L1 pages/components from component-inventory against MockAdapter",
        "summary": "Search (FTS+semantic), memory list, memory detail scroll, tag "
                   "inspector, status panel, A2A sessions, traces, empty/loading/"
                   "error states, layout shell + IrisLogo.",
        "spec": "30+ components mapped in docs/component-inventory.md; lazy "
                "routes; TanStack Query staleTime table per architecture.md §6.",
        "agents": ["gcw-senior-frontend-developer"],
        "specialists": ["@GCW: Senior Frontend Developer"],
        "env": "laptop",
        "project": "mnemos-eyes",
        "memory_ids": [],
        "mnemos_tags": ["project:mnemos-eyes", "agent:gcw-senior-frontend-developer", "mnemos:session"],
    },
    {
        "id": "T7",
        "col": "open",
        "title": "a11y pass (WCAG 2.2 AA) + perf budget check",
        "summary": "Skills a11y-audit + frontend-perf-budget on the L1 pages.",
        "spec": "Session brief T7; runs after T5.",
        "agents": ["gcw-senior-frontend-developer"],
        "specialists": ["@GCW: Senior Frontend Developer"],
        "env": "laptop",
        "project": "mnemos-eyes",
        "memory_ids": [],
        "mnemos_tags": ["project:mnemos-eyes", "agent:gcw-senior-frontend-developer", "mnemos:session"],
    },
]

# Column order note: keep display order via store.COLUMNS; seed order here is
# authoring order and is preserved as intra-column position.