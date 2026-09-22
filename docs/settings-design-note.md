# Design note: expanding /system/settings (owner directive 2026-09-22)

- Status: **design only** (owner ask: "important settings — thoughtfully,
  not blindly"). Branch `docs/settings-design`; merge after owner + TL.
- Inputs: eyes ADR 0006/0011/0013; mesh ROADMAP-v2 §8, ADR-0021 (Q10.1).

## 0. Freeze check (ADR 0006)

The freeze covers the **vanilla board (`web/`)** only; `/system/settings` lives in the
**React viewer (L1)**, built as a shell ("further sections join as sibling blocks").
Expansion there is normal L1 work: **no freeze-exception entry needed**; `web/` untouched.

## 1. Settings architecture today (facts)

- Storage `board_meta` KV (SQLite); server-side 422 gates validate
  (`_validate_default_executor` precedent), client mirrors reasons
  verbatim; writes UI-token gated; no secrets ever rendered.
- Audit `log_board_event` → SSE `/api/events`: change-history feed exists
  (`default.changed`, `automation.settings.changed`, `mesh.node.changed`).
- Live: execution defaults (page), automation kill-switch + cap (API,
  engine honestly inert), store enable/disable/pause (action API).
- Hardcoded today: reaper 60 s, presence sweep 60 s, validation sweep
  900 s, mesh healthz probe timeout, pulse defaults.

## 2. Inventory → three-tier safety model

Test, in order: (1) board-own read/render/pacing only → **A**; (2) changes
runtime behavior or forwards a node-affecting intent → **B**; (3) trust,
data topology, credentials, irreversible surface → **C**.

### Tier A — safe now (board-own, reversible, no data impact)

| Setting | Why safe |
| --- | --- |
| Execution default/fallback executor | board-own resolution chain; live today |
| Health poll interval + probe timeout | paces the board's own reads only |
| Presence stale threshold | changes a label, not behavior |
| Pulse/list defaults (page size, default scope) | rendering only |
| Viewer locale (ru/en), theme/density | client-local |
| Automation daily cap | restrictive by direction; engine inert today |

### Tier B — confirmation/gate required

| Setting | Flavor | Gate |
| --- | --- | --- |
| Automation kill switch ON | board | confirm modal; load-bearing only when the scheduler-S2 engine lands |
| Store enable/disable/pause | board | confirm modal (query fan-out changes); existing action API |
| Executor enable/disable | board | confirm modal (dispatch eligibility) |
| Mesh-node observation on/off | board | edits node registry; UI deliberately read-only today — lift only by explicit decision (phase 2) |
| Explicit one-shot sync / lazy-fetch | **intent** | ONE intent to operator's own mnemos (Q10.1); mnemos confirm-gate decides; typed confirm + verdict surfaced |
| Meta-poll cadence change | intent-later | config lives in `mesh.yaml`/mnemos (ADR-0021 Q10.7) → Tier C until an intent API exists; display is Tier A |

### Tier C — never on this page (CLI/API/config with review)

- **S1/S2/S3 mode switching** (data-topology sense): per-pair `mesh.yaml`
  `peers[].federation` + per-store mnemos `federation.*`; mismatch fails
  closed (weaker wins); S3 gated behind #33 + ADR-0020 — a topology
  decision, not a toggle. Effective-mode **display** is Tier A.
- Mesh-node add/edit/delete (base_url): SSRF allowlist, API-only posture.
- Store add/edit incl. `token_ref`: secret-adjacent (env:/file: policy); stays in its
  governed flow, never duplicated into settings.
- Certs/CA/mTLS, ACL & moderation policy, migrations, poller allowlist,
  S3 join admission (confirmed on the receiving store), signed-origins v2.

Vocabulary guard: scheduler S1/S2 (ADR 0013) ≠ data-topology S1/S2/S3 (ADR-0021); the
page always labels which "mode" it means.

## 3. Architecture principle — observe, don't command (ROADMAP-v2 §8)

- No new write path from this page to mesh nodes, ever. Tier B splits:
  **B-board** — board-owned behavior via existing UI-token APIs + local
  confirm; **B-intent** — render state, forward ONE intent call to the
  operator's own mnemos; confirm-gates and two-gate import live in mnemos
  and survive direct calls (Q10.1/Q10.11).
- State converges by read-back from the same health/status endpoints used
  today — no optimistic "success" without read-back.
- Modes are read, not written: show effective mode and sync watermark per
  node; switching stays in config with review.

## 4. New APIs required (all additive)

1. eyes: `GET/PUT /api/settings/board` — allowlisted `board_meta` keys,
   422 on unknown key, audit `settings.changed`. Unlocks Tier A.
2. mesh/mnemos: healthz self-report — effective federation mode,
   `federation.index`/`lazy_fetch` flags, meta-poll watermark (read-only).
3. mnemos: one intent endpoint for explicit fetch (CLI parity
   `vesmaro fetch --id`); pending/confirmed/refused; the confirm-gate
   runs inside mnemos, not the board.
4. eyes←mnemos federation status read model — **archcom-conditioned**
   (ADR-0021 Q10.4 deferred board visibility for S2 v1); not in phase 1.

## 5. UX skeleton

- Sections in tier order: «Display & observation» (A) → «Behavior» (B) →
  «Federation» (read-only; sync trigger only once API 3 lands) → footer
  «CLI/API-only» list for Tier C (names + pointers, no controls).
- Search filters across sections; change history = panel fed by the
  existing events feed (settings/change kinds) + per-setting "last
  changed" hint.
- Tier B confirm modal states the consequence in one line («queries stop fanning out
  to X»); sync intent adds typed confirm + mnemos verdict; honest inert labels.

## 6. Phase 1 — minimal useful set (zero new cross-system writes)

1. Execution defaults (live — keep).
2. Automation kill switch + daily cap (existing API, inert-honest label).
3. Health poll interval + presence stale threshold (new settings API).
4. Pulse/list defaults.
5. Store quick toggles enable/disable/pause (existing API + confirm).
6. Viewer locale + theme.
7. Federation display column (effective mode + watermark) — with the
   healthz self-report; display only.

NOT in phase 1: node-observation toggles in UI, any sync-trigger button
(waits for the mnemos intent API), every Tier C item.

## 7. Not-doing

No mesh control surface, no mode switching, no credential editing, no
per-project executor overrides in the first two phases. Implementation
follows as separate slices after owner ratification; §8 posture changes
go through archcom first.
