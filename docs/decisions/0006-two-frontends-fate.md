# ADR 0006: Fate of the two frontends (vanilla board vs React L1)

- Status: **Accepted by committee — pending owner ratification** (2026-09-16)
- Deciders: owner, `@GCW: Tech Lead`, `@GCW: Product Architect`
- Related: ADR 0004 (board pivot), ADR 0005 (harness identity)

## Context

The project now has **two frontend tracks**:

1. **vanilla board** (`web/`, no-build ES modules) — the operational
   cockpit, approved by the owner through 6 feedback rounds (v0.3–v0.9),
   deployed to the cluster;
2. **L1 viewer** (React + TS + Vite per `docs/architecture.md`) — the next
   milestone, scaffold not started.

Without an explicit decision, every new board feature either blocks L1 or
deepens divergence. This is the main strategic risk identified in the
architecture review.

## Options

- **A. Board converges into the L1 shell** (board becomes a feature module
  inside the React app). Cost: rewrite of 6 feedback rounds; risk of losing
  approved behaviour.
- **B. Board stays vanilla until EOL** (L1 is a separate product surface).
  Cost: two stacks forever; but zero migration risk.
- **C. Decision deferred until mesh federation lands** (ADR 0007 changes
  the scope model; convergence may resolve itself).

## Recommendation

**Adopt C with a freeze rule:**

1. The board is a **feature-frozen cockpit**: bug fixes and security fixes
   only (SEC/BE classes); **new features go to L1**.
   - **Bug-class is formal**: a defect against ui-contract.md or against
     approved v0.3–v0.9 behaviour = board; any *new action/entity/section*
     = L1 backlog, regardless of size.
   - **Freeze-exception register**: any board change outside bugfix is
     logged as a one-liner in the tracker (class, rationale). Triage is
     two lines; TL decides.
   - Fixes-only list includes **a11y-blocking fixes and `tokens.css`
     sync** — tokens are a single source of truth; the board must not die
     from desync.
2. L1 is built per `docs/architecture.md` (scaffold already planned).
3. **Convergence gate fires at the earlier of:** (a) mesh query-API lands
   (ADR 0007 end-state); (b) L1 reaches parity on the owner's daily loop
   (pulse, search, task drill — ui-contract §3–4), confirmed by one owner
   feedback round. Until then the board stays deployed as cockpit.
   L1 parity checklist = behaviour approved in v0.3–v0.9 rounds; owner of
   the checklist = TL; updated every feedback round.
4. **Freeze metric:** 100% of feature-class requests route to L1; net
   feature surface of the board = 0.
4. **What transfers to L1 regardless of the choice**: design tokens
   (`tokens.css`), the UI contract (`ui-contract.md`), the board server API
   (multi-store merge layer), the ADR 0005 ontology, the SSE event
   vocabulary. **What never transfers**: board DOM/JS code (ai-brain
   precedent, CHARTER §8).

## Consequences

- New board feature requests → TL triage: bug-class → board; feature → L1
  backlog.
- The board server API is a **long-lived asset**: it gets typed schemas
  (OpenAPI) and contract tests (QA-1) before any L1 work.
- Token files are synced between tracks by script (single source of
  truth).