# ADR 0007: Merged views — board aggregation vs mnemos-mesh federation

- Status: **Accepted by committee — pending owner ratification** (2026-09-16)
- Deciders: owner, `@GCW: Tech Lead`, `@GCW: Senior System Engineer`
- Related: ADR 0006, mnemos-mesh README («dumb transport, opaque envelopes»)

## Context

The project now has **two competing ways to present a unified memory
across stores**:

1. **Board-side merge** (implemented, v0.2+): the board server queries
   every declared memory server (multi-probe search, merged pulse, scoped
   views) and aggregates results itself, with per-server provenance badges.
2. **mnemos-mesh federation** (Go transport, planned MSH-1): stores
   federate at the transport level; the UI would see one federated store.

These are **competing mechanisms**: if mesh federation presents a unified
view, the board's merge layer duplicates it; if the board keeps its own
merge, mesh becomes a transport detail.

## Decision (proposed)

**Split by concern:**

- **mnemos-mesh = store-to-store replication** (background, ownership of
  data placement). It makes cross-store *links* resolve natively and keeps
  both stores converged.
- **Board merge layer = query-time aggregation for UI views** (pulse,
  search, drill-downs) *until mesh provides a query API*. Mesh as
  «dumb transport» does not offer a query interface; the board's merge
  layer remains the UI-facing aggregation point.
- **Monopoly until mesh query-API:** the board merge layer is the ONLY
  sanctioned multi-store read path — L1 consumes `/api/memories/*` and
  must not implement its own multi-probe aggregation.
- **Merge UX is progressive:** per-store probes run in parallel with
  per-store timeout; partial results stream to the UI (SSE) with
  provenance badges — never a blocking all-store wait; fan-out bounded
  (BE-6).
- When mesh grows a query/federation endpoint, the board's merge layer
  becomes an **adapter behind it** — the API surface
  (`/api/memories/*`) does not change.

## Consequences

- MSH-1 (mesh federation) and the board's merge layer are **complementary**,
  not competing: mesh replicates, the board aggregates for display.
- The profile header protocol is **fixed as a versioned, additive-only
  contract**: index records carry tag `profile-index:v1`; the mapping of
  `[kind]` title prefixes to sections (`_section_of()`) is documented as
  the contract between `sync-gcw-profiles.py` and the board; new sections
  are added, readers skip unknown ones. Contract text: `@GCW: Tech Writer`
  (archcom assignment), included into ui-contract as a separate section.
- The merge layer needs latency-aware design for 3+ stores (hybrid search
  is 4–7 s per store; fan-out must stay bounded — BE-6).
- **Security condition (archcom, Security Engineer):** the merge layer is a
  server-side fan-out over registry URLs — a standing SSRF primitive. URL
  validation (http/https only, deny localhost/link-local/169.254, resolve
  check) and board egress policy are part of the merge-layer design, not an
  afterthought.
- Mesh federation is a new trust boundary: mTLS between stores + workload
  identity — mandatory items in the MSH-1 threat model (deferred to mesh
  milestone, not sprint 1).