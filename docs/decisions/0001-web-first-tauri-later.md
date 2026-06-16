# ADR 0001 — Web-first SPA, Tauri 2.0 native shell later

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** user, `@GCW: Tech Lead`

## Context

We want `mnemos-eyes` to eventually run as **web + desktop + mobile** with one
visual language, and ideally **local-first** (read the store without exposing an
API to the network). Two tensions:

- A pure **browser SPA** ships fastest but **cannot read SQLite directly** — it
  always needs the mnemos HTTP API reachable.
- A **native shell (Tauri 2.0)** can read the store **in-process via Rust**
  (no exposed API) and targets desktop **and** mobile from the same web frontend,
  but adds build/packaging complexity up front.

## Decision

Build the **web SPA first** (Phase 1) and add a **Tauri 2.0 shell later**
(Phase 2). The same React frontend is reused in both; Tauri only swaps the data
source (see ADR 0002).

## Consequences

- ✅ Fastest path to a usable viewer.
- ✅ Desktop + mobile + local-first reachable later with ~90% code reuse.
- ✅ "Web vs native" lock-in is deferred, not forced now.
- ⚠️ Phase 1 depends on mnemos shipping **CORS + auth** (gating dependency).
- ⚠️ Tauri adds Rust toolchain + mobile signing later (owned with SRE/DevOps).

## Alternatives rejected

- **Native-GPU toolkit** (egui/iced/Fyne): too constraining for the lore-driven,
  animated, design-rich UI we want. CSS/webview wins on visual fidelity.
- **Tauri from day one:** slower first ship; unnecessary before the UI is proven.
