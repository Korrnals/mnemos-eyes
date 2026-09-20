# Freeze exceptions registry

- Status: **Active registry** (append-only; one entry per approved exception)
- Maintainers: `@GCW: Tech Lead` (approval), `@GCW: Senior Backend` (registry)
- Related: ADR 0006 (two-frontends fate — the vanilla-board freeze),
  ADR 0011 (UI convergence waves Ф0–Ф4)

Any change that touches the frozen vanilla board (`web/`, ADR 0006)
requires an entry here BEFORE the change lands: date, entity, scope,
rationale, approver. Entries are never deleted — superseded ones are
marked `Superseded by <date+id>` in place.

| Date | Entity | Scope | Rationale | Approved by |
| --- | --- | --- | --- | --- |
| 2026-09-20 | mesh-node display | `web/index.html` (rail section «Узлы меша»), `web/js/app.js` (`renderMeshNodes`, `fmtUptime`, healthLoop/SSE wiring), `web/styles/board.css` (`.mesh-nodes` read-only rows) | W5 observability in live vanilla board — **read-only** display only (dot/name/version/peers/uptime); node management stays API-only, no edit buttons, no new interaction surface | Tech Lead |
