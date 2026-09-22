# Design note: expanding /system/settings (owner directive 2026-09-22)

- Status: **design only, no implementation here**. Owner ask: "important
  settings for toggling components and modes — thoughtfully, not blindly."
  Branch `docs/settings-design`; merge only after owner + TL review.
- Inputs: eyes ADR 0006/0011/0013; mesh ROADMAP-v2 §8, ADR-0021 (Q10.1).

## 0. Freeze check (ADR 0006)

The freeze covers the **vanilla board (`web/`)** only. `/system/settings`
lives in the **React viewer (L1)**, built as a shell ("further sections
join as sibling blocks" — `viewer/src/app/routes.tsx`). Expansion there is
normal L1 work: **no freeze-exception entry needed**; `web/` untouched.

## 1. Settings architecture today (facts)

- Storage `board_meta` KV (SQLite); validation server-side 422 gates
  (`_validate_default_executor` precedent) — client mirrors reasons
  verbatim; writes UI-token gated (`_guard_ui_write`); no secrets rendered.
- Audit `store.log_board_event` → SSE `/api/events`: a change-history feed
  already exists (`default.changed`, `automation.settings.changed`,
  `mesh.node.changed`) — history needs no new plumbing.
- Live surfaces: execution defaults (page), automation kill-switch + cap
  (API; engine honestly inert), store enable/disable/pause (action API).
- Hardcoded, not yet settings: reaper 60 s, presence sweep 60 s, validation
  sweep 900 s, mesh healthz probe timeout, pulse defaults.

## 2. Inventory → three-tier safety model

Test, in order: (1) board-own read/render/pacing only → **A**; (2) changes
runtime behavior of board-owned components or forwards a node-affecting
intent → **B**; (3) trust, data topology, credentials, irreversible
surface → **C**.

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
  closed (weaker mode wins); S3 gated behind #33 + ADR-0020 — a topology
  decision, not a toggle. Effective-mode **display** is Tier A.
- Mesh-node add/edit/delete (base_url): SSRF allowlist, API-only posture.
- Store add/edit incl. `token_ref`: secret-adjacent (env:/file: policy);
  stays in its governed flow, never duplicated into settings.
- Certs/CA/mTLS, ACL & moderation policy, DB migrations, poller allowlist,
  S3 join admission (confirmed on the receiving store, fail closed),
  signed-origins v2.

Vocabulary guard: scheduler S1/S2 (ADR 0013) ≠ data-topology S1/S2/S3
(ADR-0021); the page always labels which "mode" it means.

## 3. Architecture principle — observe, don't command (ROADMAP-v2 §8)

- No new write path from this page to mesh nodes, ever. Tier B splits:
  **B-board** — board-owned behavior via existing UI-token APIs with a
  local confirm; **B-intent** — the board renders state and forwards
  exactly ONE intent call to the operator's own mnemos; orchestration,
  confirm-gates and two-gate import live in mnemos and survive direct API
  calls (ADR-0021 Q10.1/Q10.11).
- State converges by read-back from the same health/status endpoints used
  today — no optimistic "success" without read-back.
- Modes are read, not written: the board shows effective mode and sync
  watermark per node; switching stays in config with review.

## 4. New APIs required (all additive)

1. eyes: `GET/PUT /api/settings/board` — allowlisted `board_meta` keys
   (intervals, thresholds, display), 422 on unknown key, audit
   `settings.changed`. Unlocks all of Tier A.
2. mesh/mnemos: healthz self-report — effective federation mode,
   `federation.index`/`lazy_fetch` flags, meta-poll watermark (read-only).
3. mnemos: one intent endpoint for explicit fetch (CLI parity
   `vesmaro fetch --id`); returns pending/confirmed/refused; the
   confirm-gate runs inside mnemos, not the board.
4. eyes←mnemos federation status read model — **archcom-conditioned**
   (ADR-0021 Q10.4 deferred board visibility for S2 v1); listed, not
   assumed by phase 1.

## 5. UX skeleton

- Sections in tier order: «Display & observation» (A) → «Behavior» (B) →
  «Federation» (read-only; sync trigger only once API 3 lands) → footer
  «CLI/API-only» list for Tier C (names + pointers, no controls).
- Search filters across all sections; change history = collapsible panel
  fed by the existing events feed (settings/change kinds) plus a
  per-setting "last changed" hint.
- Tier B confirm modal states the consequence in one line («queries stop
  fanning out to X», «engine may fire up to N runs/day»); sync intent adds
  typed confirm and surfaces the mnemos gate verdict; honest inert labels
  wherever behavior is inert today.

## 6. Phase 1 — minimal useful set (zero new cross-system writes)

1. Execution defaults (live — keep).
2. Automation kill switch + daily cap (existing API, inert-honest label).
3. Health poll interval (new board settings API).
4. Presence stale threshold.
5. Pulse/list defaults.
6. Store quick toggles enable/disable/pause (existing API + confirm).
7. Viewer locale + theme.
8. Federation display column (effective mode + watermark) — with the
   healthz self-report; display only.

NOT in phase 1: node-observation toggles in UI, any sync-trigger button
(waits for the mnemos intent API), every Tier C item.

## 7. Not-doing

No mesh control surface, no mode switching, no credential editing, no
per-project executor overrides (reserved scope) in the first two phases.
Implementation follows as separate slices after owner ratification; any §8
posture change goes through archcom first.
