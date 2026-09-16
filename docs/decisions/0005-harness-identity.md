# ADR 0005: Harness identity — agents vs specialists

- Status: **Accepted** (2026-09-16)
- Deciders: owner (`@abyss`), `@GCW: Tech Lead`
- Related: ADR 0004 (board pivot), GCW tag contract (mnemos M2)

## Context

The board mixed **harnesses** (execution environments: zcode, Hermes, Pi,
Copilot, Claude Code, ...) with **specialists** (@GCW roles: Tech Lead,
Senior Frontend Developer, ...) in a single "agents" field — e.g. the seed
listed `gcw-tech-lead` as an agent. This makes harness efficiency
comparison impossible and confuses provenance: who executed vs. who is
accountable.

Owner requirement: the separation must hold **cross-system** — under any
stack configuration, with any component missing, the rule must work.

## Decision

1. **Two ontologies, never mixed**:
   - `agents` = **harnesses** — where the work physically executes
     (`zcode`, `hermes`, `pi`, `copilot`, `claude-code`, ...). Stored in
     the task `agents` field and in memory tags as `agent:<harness>`.
   - `specialists` = **roles** — who is accountable / what competency is
     needed (`@GCW: Tech Lead`, `owner`, ...). Stored in
     `specialists`/`mnemos_tags`.
2. **Cross-system enforcement lives in the data layer, not in UI**:
   - the board API **rejects** task creates whose `agents` contain role-like
     slugs (`gcw-*`, `@*`) — validation is server-side, so every client,
   script, and future integration inherits it;
   - memory provenance uses the mnemos tag contract `agent:<harness>` —
     any harness writing to any mnemos server already carries the rule.
3. **Memory metadata rule** (the instruction-level obligation): every
   memory written from a harness MUST carry `agent:<harness>` (mnemos tag
   contract already enforces exactly one). The board relies on it for
   per-harness activity/recall; GCW instruction canon must keep naming the
   harness, not the role, in `agent:` tags.
4. **Specialist composition is indexed into memory** (cross-system
   profile): `scripts/sync-gcw-profiles.py` indexes GCW role contracts,
   common instruction canon, and role-specific skills into mnemos with
   `specialist:<slug>` + `gcw:component:<kind>` tags (mnemos contract:
   `project:gcw`, `agent:gcw-agent-architect`, `mnemos:learning/decision`).
   The board reads the profile through the standard search API — no GCW
   checkout, no direct file access; works from any store that holds the
   index. Re-run the script after GCW changes.
5. **Server-side enforcement covers PATCH as well as create** (sprint-1
   hardening, BE-5): `PATCH /api/tasks/{id}` applies the same role-slug
   rejection (`gcw-*`, `@*` inside `agents` → HTTP 422) as `POST /api/tasks`.
   Before this, a patch could silently re-introduce role slugs into the
   harness field and corrupt per-harness efficiency stats. The rule is
   pinned by a server-side contract test in the pytest contour (QA-1), so
   regressions surface as CI failures, not as data drift.

## Consequences

- Seed v3: every task's `agents` = `['zcode']` (the harness that works on
  this board); roles live in `specialists` only.
- Harness efficiency stats (rail + agent drill) are now trustworthy.
- The refine loop (specialist card → Agent Architect task) is unaffected:
  the architect is a specialist; the task executes under a harness.
- Future GWS/harness integrations must map their identity to
  `agent:<harness>` and never to roles.