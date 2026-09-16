# ADR 0008: Board backend stack — stay on Python/FastAPI (for now)

- Status: **Accepted by committee — pending owner ratification** (2026-09-16)
- Deciders: owner, `@GCW: Product Architect`, `@GCW: Tech Lead`
- Related: ADR 0004, ADR 0006, TL-4

## Context

Owner question: «голый питон не особо подходит — что насчёт Go? Конкуренция
даст преимущества?»

Facts:

| Aspect | Python/FastAPI (current) | Go |
| --- | --- | --- |
| Code state | 6.2K lines, approved through 6 feedback rounds | 0 — full rewrite |
| Load | 1 owner + agents, 35 tasks, 2 stores (micro) | same |
| Ecosystem | shares stack with mnemos engine (Python/FastAPI) | shares stack with mnemos-mesh (Go 1.25) |
| Latency | fine at this scale (health ping 16–90 ms) | marginal gain |
| Iteration speed | 5 rounds of fast owner-feedback cycles prove it | restart of the feedback loop |
| Team | GCW specialists cover both | GCW specialists cover both |

## Decision (proposed)

**Stay on Python/FastAPI.** Rationale: performance is not the constraint
at this workload; iteration speed with the owner is the binding constraint
and Python proved it across 6 rounds; a rewrite would discard 21 approved
fix-tasks and re-run every feedback cycle.

**Explicit trigger to revisit** (write this down, not silent):
re-evaluate Go for the backend when **any** of:
- merged views must serve >5 stores, **or p95 merged-view latency > 2 s**
  under normal load (store count alone is not the constraint — fan-out
  latency is);
- mnemos-mesh offers a query API and the merge layer moves into Go
  (ADR 0007 end-state);
- the board server becomes a shared service beyond this lab;
- the board starts storing real secrets or serving external consumers
  (security trigger — `plain:` token_ref is already debt);
- **p95 merged-view latency stays >10 s** at the current store count after
  progressive-merge mitigations (ADR 0007) — assessment of a fired trigger
  is an explicit archcom item, never silent.

## Consequences

- No rewrite of the approved board server; SEC/BE fix tasks apply to the
  Python code.
- Go remains the language of mesh (unchanged).
- The merge-layer design (ADR 0007) is written so a future Go merge
  service can take it over without changing the API surface.