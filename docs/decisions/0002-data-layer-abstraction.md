# ADR 0002 — Isolated data-layer (`MemoryGateway`)

- **Status:** Accepted
- **Date:** 2026-06-16
- **Deciders:** user, `@GCW: Tech Lead`

## Context

The UI must work both against the **mnemos HTTP API** (web mode) and, later,
against a **Tauri Rust core** that reads SQLite in-process (native mode). If the
UI calls `fetch()` directly everywhere, switching modes means rewriting the UI.

## Decision

All data access goes through a single **`MemoryGateway` interface**. Concrete
adapters implement it:

- **`HttpAdapter`** — talks to the mnemos HTTP API (Phase 1).
- **`TauriAdapter`** — calls Rust commands via `invoke()` → local store (Phase 2).

Components and hooks depend only on `MemoryGateway`, never on `fetch`/`invoke`
directly. Adapter is injected once at app bootstrap.

## Consequences

- ✅ Same UI code in web and native modes (clean architecture boundary).
- ✅ Deferring ADR 0001's "web vs native" decision is actually possible.
- ✅ Testability: gateway is trivially mockable.
- ⚠️ One indirection layer to maintain; types must stay in sync (mitigated by
  `openapi-typescript` codegen from `/openapi.json`).
