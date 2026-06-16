# SESSION: mnemos-eyes — L1 Read-only Viewer (Phase 1)

> **How to start this session:** tell the agent
> _"проинициализируй сессию из `docs/sessions/SESSION-01-l1-viewer.md`"_.
> The agent (acting as `@GCW: Tech Lead`) reads this file, restores context,
> and dispatches the tasks below to the named specialists.

- **Project:** `mnemos-eyes` (`git@github.com:Korrnals/mnemos-eyes.git`)
- **Repo path:** `/var/home/abyss/LABs/AI/mnemos-eyes`
- **Session owner / orchestrator:** `@GCW: Tech Lead`
- **Primary specialist:** `@GCW: Senior Frontend Developer`
- **Status:** 🟢 Ready to start (design + architecture specs already committed)
- **Companion session:** `mnemos` backend — see `../mnemos/docs/sessions/SESSION-01-backend-mvp.md`

---

## 1. Goal

Ship the **L1 read-only viewer**: a web SPA that lets the user search and browse
mnemos memory, with the lore-driven "obsidian well / gaze-into-self" aesthetic.

No edit/delete (that is L2). No cluster graph (deferred to L2 per ADR 0003).

## 2. Context to restore (read first)

| File | Why |
| --- | --- |
| `docs/CHARTER.md` | Scope, decisions D1–D9, roadmap, prerequisites |
| `docs/design-brief.md` | Creative direction (eye/iris/well, "взгляд в себя") |
| `docs/design-system.md` | Tokens, motion budget, signature moments |
| `docs/architecture.md` | `MemoryGateway`, adapters, routing, TanStack Query |
| `docs/component-inventory.md` | 30+ L1 components mapped to gateway calls |
| `docs/decisions/0001..0003` | web-first/Tauri, data-layer, accent/font/clusters |

**Locked design decisions (do not relitigate):**

- Accent = **teal** (`--color-iris`), gold = confidence signal (ADR 0003 / D10).
- Memory content font = **Lora**; mono for `rule`/`code` types (D11).
- Cluster graph = **deferred to L2** (D12) — hide the nav slot in L1.

## 3. Scope of L1 (build these)

Search (FTS + semantic) · memory list · memory detail ("scroll") · tag inspector
(client-side aggregation) · status/health panel · A2A session list + detail ·
traces view · empty/loading/error states · layout shell + IrisLogo + theming
(dark/light) · breathing-iris idle animation (respect `prefers-reduced-motion`).

## 4. Task breakdown & assignment

| # | Task | Owner | Depends on |
| --- | --- | --- | --- |
| **T1** | Scaffold app: Vite + React + TS + Tailwind + shadcn/ui + TanStack Query; ESLint/Prettier; folder structure per `architecture.md`. Commit `chore: scaffold L1 viewer`. | `@GCW: Senior Frontend Developer` | — |
| **T2** | Implement `MemoryGateway` interface + `HttpAdapter` + a `MockAdapter` (fixtures) so UI can be built before backend auth/CORS land. DI at bootstrap. | `@GCW: Senior Frontend Developer` | T1 |
| **T3** | `openapi-typescript` codegen wired to mnemos `/openapi.json` (script + generated types committed or generated in build). | `@GCW: Senior Frontend Developer` | T1; mnemos OpenAPI stable |
| **T4** | Design system → code: tokens (teal/gold, Lora), theming, IrisLogo, breathing animation. | `@GCW: Senior Frontend Developer` | T1 |
| **T5** | Build L1 pages/components from `component-inventory.md` against `MockAdapter`. | `@GCW: Senior Frontend Developer` | T2, T4 |
| **T6** | Wire `HttpAdapter` to the real mnemos API once CORS+auth are available; auth/login flow. | `@GCW: Senior Frontend Developer` | T5; **backend session T-AUTH** |
| **T7** | a11y pass (WCAG 2.2 AA) + perf budget check. | `@GCW: Senior Frontend Developer` (skills `a11y-audit`, `frontend-perf-budget`) | T5 |

## 5. Cross-session dependencies (the gate)

L1 can be **built end-to-end against `MockAdapter`** without the backend. But
**T6 (real data + login)** is blocked until the backend session delivers:

- **CORS** (configurable allow-list) on mnemos.
- **Auth** (token-based; 2FA for remote) on mnemos.
- (nice-to-have) `GET /tags`, `GET /clusters` (clusters only matters at L2).

Track those in `../mnemos/docs/sessions/SESSION-01-backend-mvp.md`.

## 6. Workflow rules (per repo policy)

- Feature branches → PR → squash-merge to protected `main`.
- Conventional commits in **English**; respond to user in **Russian**.
- Subagents report back to `@GCW: Tech Lead`; the Tech Lead commits.
- Lint/typecheck/test must be **green by fix, not suppression** before a PR.
- No secrets in code; auth tokens via env/secret store.

## 7. Definition of done (L1)

- [ ] App builds, lints, type-checks clean; CI green (if CI added).
- [ ] All L1 components implemented and working against `MockAdapter`.
- [ ] `HttpAdapter` works against a real mnemos with CORS+auth (T6).
- [ ] Search (FTS + semantic), memory detail, tags, status, sessions, traces usable.
- [ ] Dark/light theme + breathing-iris animation + reduced-motion support.
- [ ] WCAG 2.2 AA pass; perf budget met.
- [ ] README "run locally" section updated.

## 8. First action when session starts

`@GCW: Tech Lead` delegates **T1 + T2 + T4** to `@GCW: Senior Frontend Developer`
in parallel (they are independent of the backend), and asks the user to confirm
green-light for `npm`/scaffolding (the repo currently holds docs only).
