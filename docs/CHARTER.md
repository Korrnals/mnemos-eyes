# mnemos-eyes — Project Charter

> Authoritative record of agreed decisions for the mnemos GUI companion.
> Owner: `@GCW: Tech Lead`. Design system owned by `@GCW: Senior Frontend Developer`.
> Status: **Design phase** (no app code yet).

---

## 1. Purpose & vision

`mnemos-eyes` is a **graphical interface to the mnemos long-term memory engine**.
It lets a human _see into_ the memory the agents accumulate: search it, read it,
understand where each fact came from, and watch the memory live.

Design north star: **"a gaze into oneself — into one's own thoughts"**
(_взгляд в себя, в свои мысли_). Calm, beautiful, lore-driven, never distracting.

---

## 2. Scope

### MVP = **L1 — Read-only Viewer**

The first release is a **viewer**, not an editor. It must let the user:

- **Search** memory: full-text (FTS5) + semantic (vector), with a unified search bar.
- **Browse** memory items: content, tags, provenance/source, confidence, timestamps.
- **Inspect tags** and the tag contract.
- **View status / health**: counts, store health, pipeline status.
- **Cluster graph**: visualize related memories.
- **A2A sessions**: list and inspect agent-to-agent sessions.
- **Traces**: view captured traces / compaction state.

### Out of MVP (later milestones)

- **L2 — Curator**: edit / merge / delete memories, manage tags, approve pipeline output.
- **L3 — Operator**: trigger pipeline runs, manage policies/schedules, DLQ, ingest.

The L2/L3 roadmap is owned jointly with `@GCW: Product Architect` if scope grows.

---

## 3. Decisions (agreed)

| # | Decision | Rationale |
| --- | --- | --- |
| **D1** | **Separate repo** `mnemos-eyes`, sibling to `mnemos`. | Clean separation of concerns; UI evolves independently of the engine. |
| **D2** | **Name** = `mnemos-eyes`. Internal lore may reference _Mnemosyne / Anamnesis_. | Ecosystem cohesion with `mnemos` beat a standalone name. |
| **D3** | **MVP = L1 read-only viewer.** | Prove value fast; lowest risk; no destructive ops in v1. |
| **D4** | **Stack = React + TypeScript + Vite + TanStack Query + Tailwind/shadcn.** | Mature, fast, design-flexible, large talent/tooling pool. |
| **D5** | **Web-first now, Tauri 2.0 native shell later.** | Web SPA ships fastest; Tauri adds desktop + mobile + local-first reusing ~90% of the frontend. |
| **D6** | **Isolated data-layer abstraction** (`MemoryGateway` interface with `HttpAdapter` and future `TauriAdapter`). | Defers the "web vs native" lock-in; same UI code in both modes. |
| **D7** | **Types auto-generated** from mnemos `/openapi.json` via `openapi-typescript`. | Single source of truth; no hand-drift between API and UI types. |
| **D8** | **Auth mandatory; 2FA (TOTP) for remote/mobile access.** | See §5 — local-only desktop relies on OS + optional app-lock; 2FA justified once the memory is reachable over the network. |
| **D9** | **Design is lore-driven** (eye / iris / well, "взгляд в себя"), beautiful but non-distracting, with light "living" animation. | Differentiator; matches the memory metaphor. |

---

## 4. Architecture (high level)

```text
┌─────────────────────────────────────────────┐
│  React + TS UI  (presentation, lore, motion) │
└───────────────────┬─────────────────────────┘
                    │  calls
┌───────────────────▼─────────────────────────┐
│  MemoryGateway  (interface — clean boundary) │
└───────┬───────────────────────────┬─────────┘
        │ web mode                  │ desktop / mobile
┌───────▼─────────┐         ┌───────▼──────────────┐
│  HttpAdapter    │         │  TauriAdapter        │
│  → mnemos API   │         │  → Rust → SQLite      │
└─────────────────┘         └──────────────────────┘
```

- **Phase 1:** `HttpAdapter` only → mnemos HTTP API.
- **Phase 2:** add `TauriAdapter` → Rust core reads the store in-process
  (no API exposed to the network).

Detailed frontend architecture + folder structure: owned by
`@GCW: Senior Frontend Developer` (see `docs/architecture.md`, to be authored).

---

## 5. Auth & security posture

- **All access is authenticated.** No anonymous read, even on loopback.
- **2FA (TOTP)** is **required for remote/mobile access** (phone → home mnemos server).
- **Local desktop (Tauri)** may rely on OS-level protection + an optional in-app lock.
- The **definitive threat model** is delegated to `@GCW: Senior Security Engineer`
  before any auth code is written.

---

## 6. Prerequisites on `mnemos` (backend work)

These are tracked as separate PRs in the `mnemos` repo, owned by
`@GCW: Senior System Engineer` and `@GCW: Senior Security Engineer`:

1. **CORS** support (configurable allow-list) — required for a browser SPA.
2. **AuthN/AuthZ** layer (token-based; TOTP 2FA for remote).
3. **`/openapi.json`** stable + documented (already served by FastAPI) — feeds
   `openapi-typescript` codegen.
4. (Phase 2) A **read API surface** clean enough for the `TauriAdapter` to bypass
   when reading SQLite directly.

> ⚠️ Until CORS + auth land in `mnemos`, the SPA can only run against a local
> dev proxy. This is the **gating dependency** for a real browser deployment.

---

## 7. Roadmap

| Phase | Deliverable | Owner |
| --- | --- | --- |
| **P0** | Charter + design brief + decisions (this doc set) | `@GCW: Tech Lead` |
| **P0.1** | Frontend architecture + design system spec (docs only) | `@GCW: Senior Frontend Developer` |
| **P0.2** | mnemos CORS + auth/2FA threat model | `@GCW: Senior System Engineer` + `@GCW: Senior Security Engineer` |
| **P1** | L1 viewer MVP (web) | `@GCW: Senior Frontend Developer` |
| **P2** | Tauri 2.0 shell (desktop + mobile) | `@GCW: Senior Frontend Developer` + `@GCW: SRE/DevOps` |
| **P3** | L2 curator features | TBD with `@GCW: Product Architect` |

---

## 8. Reference: prior art

The old `ai-brain` prototype (`../ai-brain/src/ai_brain/web/`) is **reference only**,
not a code base to reuse. Useful signals to mine:

- **Information architecture**: dashboard, memories, raw, knowledge, tags, watcher,
  graph, jobs, add — a feature map to cherry-pick from for L1/L2/L3.
- **Design tokens**: a GitHub-style dark/light CSS-variable system (starting point,
  not the final lore-driven aesthetic).
- **i18n**: RU/EN toggle pattern.

Do **not** port its vanilla-JS code; we start clean on the agreed stack.
