# ADR 0003 — Accent color, content typography, clusters in L2

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** user, `@GCW: Tech Lead`, `@GCW: Senior Frontend Developer`

## Context

During P0.1 the Frontend Developer raised three design/scope questions (Q1–Q4)
that block the start of Phase 1 implementation. The user accepted the Tech Lead
recommendations.

## Decisions

### D10 — Primary accent = **teal**, gold = confidence signal

- `--color-iris` (primary accent) = **deep-well teal** (`#1a8a96` seed) — the
  colour of depth and water, matching the "obsidian well" lore.
- Mnemosyne **gold/amber** is reserved as `--color-confidence`, used to mark
  **high-confidence memories**, not as a competing decorative accent.
- Rationale: a meaningful semantic pair (depth vs valuable signal) beats two
  rival accents.

### D11 — Memory content typography = **Lora** (serif "scroll"), mono for code/rules

- Default memory content renders in **Lora** (humanist serif → the "scroll" feel).
- Memories of type `rule` / `code` render in **JetBrains Mono**.
- UI chrome stays on the humanist sans from the design system.

### D12 — Cluster graph **deferred to L2**

- mnemos exposes **no `GET /clusters` endpoint** today (only an aggregate metric).
- Building the cluster graph would require backend work + a graph library
  (React Flow vs d3-force, Q3) and is not essential to the L1 read-only viewer.
- Therefore the **cluster graph and the graph-library decision (Q3) move to L2.**
- L1 ships without the graph; the nav slot is hidden until L2.

## Consequences

- ✅ Phase 1 is unblocked on design (accent + fonts fixed).
- ✅ L1 scope shrinks (no graph) → faster MVP.
- ✅ Q3 (graph library) is parked, not decided under pressure.
- ⚠️ `GET /clusters` (and the graph) become L2 backend + frontend work items.
- Tags: mnemos also has no `GET /tags` endpoint; for L1 tags are aggregated
  client-side from the memory list. A dedicated endpoint is a backend nice-to-have
  tracked in the backend session.
