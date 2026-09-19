# ADR 0013: Scheduler & hooks — launch automation as a separate domain (SCHED-1, variant C)

- Status: **Accepted** (committee 2026-09-20; owner ratification 2026-09-20 —
  «Окей, принимается. Работаем дальше», agent-bridge session)
- Deciders: owner, АРХКОМ-5 (Product Architect, Senior System Engineer,
  Senior Security Engineer, Senior Frontend Developer), `@GCW: Tech Lead`
- Related: SCHED-1 problem statement
  (`docs/architecture/sched1-scheduler-hooks-problem.md`), ADR 0009
  (+Amendment 2), АРХКОМ-4/5 protocols, ADR 0011 (convergence waves),
  ARCH-7 (reaper), ARCH-9 (executor registry)

## Context

Owner directive (2026-09-20): hooks and scheduler belong in the interface —
their functionality must be worked out. Today every launch is manually
triggered by the owner (`POST /api/assignments` is ui-token only); recurring
work costs a click per cycle; existing periodic machinery (profile refresher,
inbox scanner, WF-1 sweep, future reaper) is code, not data — invisible and
non-configurable. Full problem statement, tensions (Н1–Н7) and option
analysis: see SCHED-1 doc; committee verdicts: АРХКОМ-5 protocol.

## Decision

**Variant C — contracts before engine.** S1 (contracts + CRUD + manual
"run now") lands first and creates no T2 surface; S2 (the engine, variant A:
in-process scheduler loop + ECA subscriber) is enabled only behind a formal
T2 checklist, default-off, by explicit owner opt-in. Variant B
(poller-side cron) is rejected by all four verdicts: it either breaks the
token split (A1) or adds a third token subject, moves gate enforcement out
of the server's trust domain, and races the launch journal under
multi-transport. Hooks are board-internal ECA only; outbound webhooks are
out of v1 (return requires the SSRF contract, Security C-8).

### 1. Domain frame (anti-creep)

Routing answers **"who"** (executor resolution, ADR 0009 Am2 §5); automation
answers **"when / in response to what"**. Automation is a separate domain
with its own rules, journal, budgets and kill-switch — never an extension of
the default-executor chain. The two are composed (a rule nominates through
the same resolution chain), never merged.

### 2. S1 contracts (no hard dependencies; sequenced after ARCH-9 to avoid
concurrent `store.py` churn; branch from main)

Schema per SCHED-1 §5 with SE deltas (normative):

- `schedules`: `name UNIQUE`, `enabled DEFAULT 0` (creation is disabled;
  enablement is a separate audited action), v1 `target_kind='task'` only,
  `trigger_kind ∈ {interval, time-of-day}` with **interval ≥ 60 s** (422),
  `next_run_at` is **server-computed only** (POST/PATCH/enable recompute
  from now; never accepted from a client — keeps client clocks out of the
  schedule-clock family), budgets in-row (`max_runs_per_day` default 4,
  `cooldown_s` default 300). No separate pause column: `enabled=0` is the
  per-rule kill-switch.
- `hooks`: `name UNIQUE`, single `on` kind validated against the server
  constant `HOOK_EVENT_WHITELIST` (structurally excludes `automation.*` and
  heartbeat events), `condition` fields/ops from a closed allowlist
  (`eq/ne/in`) validated at CRUD time (422, not at fire time).
- `launches` (append-only journal): `rule_name` snapshot (journal stays
  readable after rule deletion), `trigger ∈ {tick, manual, event}`,
  `origin`, `decision ∈ {launched, skipped, missed}`, `reason`,
  `assignment_id`, `attempted_at`. Idempotency via **two partial unique
  indexes**: `(rule_id, run_at) WHERE rule_kind='schedule'` and
  `(rule_id, event_id) WHERE rule_kind='hook'` (event id — the monotonic
  audit-row id, not a second timestamp).
- CRUD endpoints (ui-token, 10/60 s): `GET/POST/PATCH/DELETE
  /api/automation/{schedules,hooks}` (audit `rule.*` old→new; DELETE =
  soft-disable retention), `GET /api/automation/launches?rule_id=&kind=…`
  (cursor contract), `POST /api/automation/schedules/{id}/run` —
  **synchronous** `{decision, reason?, assignment_id?}` (manual trigger =
  ui-token action, `trigger='manual'`, does NOT consume per-rule budgets),
  `GET/PUT /api/automation/settings` (kill-switch + caps, audited),
  `GET /api/automation/status` — engine on/off, caps, **condition
  meta-dictionary** (fields/ops/values enums; the UI form must not
  hardcode — Frontend blocker). Filter `GET /api/assignments?by=automation`
  (`created_by LIKE 'automation:%'`).
- SSE reserve (additive-only): `automation.rule.{created,updated,toggled,
  deleted}` (a single `rule.changed` kind is sufficient for list sync),
  `scheduler.launched` (into the UI-10 execution feed — automation must be
  visible), `scheduler.missed` (notification + SSE; skipped is journal-only,
  re-fetched — silence of a schedule must shout, skipping must not).
  No per-tick events.

### 3. Source allowlist is action-dependent (SE А-1 + Security C-2/C-3)

`notify` is allowed from any origin except `automation` (payload never
interpolated into anything, C-4). `create_assignment` is allowed only from
`ui`/`server` origins; a `machine` origin requires an explicit per-rule
owner opt-in, audited old→new. **Origin is derived by the server from the
token class at event-record time, never from an event field** (CWE-290).
The condition field allowlist excludes everything machine-writable —
explicit consequence, to be recorded verbatim in this ADR: **`task.moved`
events (moves are machine-class writes) do not trigger create-actions in
v1.** Residual human vector (an agent persuading the owner to act, producing
a ui-origin event) is accepted and mitigated by snapshot-only content (C-4)
and visible attribution (C-5).

### 4. Fire semantics (S2)

- **Journal-first**: `fire_schedule(rule_id, run_at)` / `fire_hook(rule_id,
  event_id)` execute as one store transaction: `INSERT OR IGNORE` into
  `launches` (rowcount 0 ⇒ already handled) → all gates evaluated on live
  data in-transaction (kill-switch, window, budgets as SQL counters,
  cooldown, WF-1/archived/terminal assignability — nothing cached, Н2
  closed structurally) → assignment inserted by the same private code path
  as `create_assignment` with `created_by='automation:{rule_id}'` → on any
  gate failure the row flips to `skipped(reason)`. SSE emitted only after
  commit.
- **Liveness gate (SE А-2)**: the engine resolves the target through the
  executor chain (Am2 §5) + `executor_alive()` and records
  `skipped(inactive-executor)` instead of minting into a dead queue. The
  scheduler never reads assignment heartbeat clocks — liveness only via the
  sanctioned ARCH-9 API.
- **ECA wiring**: an in-process bounded queue (drop+log on overflow) fed by
  an `_emit(kind, task_id, payload, origin)` refactor of the emit points;
  a single consumer loop evaluates `hook_match` and fires. The request path
  stays fast; the store stays rule-agnostic. Anti-loop is structural,
  five layers: `automation` origin absent from every default allowlist;
  `HOOK_EVENT_WHITELIST` excludes `automation.*`; per-rule cooldown;
  per-rule/specialist/global budgets; the ≤1-active invariant.
- **Missed policy**: skip + journal. Per due schedule, `run_at` is the
  latest occurrence ≤ now; within a freshness window of ~2 ticks the full
  gate evaluation runs, older occurrences journal `missed(downtime)` —
  exactly one missed row per occurrence, catch-up structurally impossible;
  manual run-now is the conscious replacement. Missed → notification + SSE.
- **Engine loop**: `_scheduler_loop` 60 s in lifespan with
  `log.exception` (never `except: pass`) and a `board_meta` last-tick
  heartbeat so the UI can honestly show "engine off / ticking / silent".
  Background loops get a shared `_loop_runner(name, interval, fn)` helper
  with staggered startup sleeps (15/30/45/60 s) — five concurrent tasks are
  comfortable for the single-worker deployment.

### 5. T2 gate — enabling S2 (checklist, verifiable; T2.2–T2.6 are CI
invariants, not one-time checks)

1. ARCH-9 merged; per-executor tokens enforced in claim (machine token
   cannot claim an explicit-pinned assignment).
2. Rate limit on the `automation:*` principal (429 + `automation.throttled`
   audit; keyed by rule_id).
3. Red-team injection test: agent-written events (including payload
   mimicking rule conditions in structured fields) never fire hooks;
   origin filtering is dispatch-side.
4. Fire-storm drill: chained rules do not retrigger from machine-origin
   automation events; the global cap trips into `automation.paused` + SSE;
   drill recorded in the runbook.
5. Kill-switch proven: per-rule disable and global pause stop everything;
   both ui-token + audited.
6. Launch journal complete: every automation-origin assignment has a
   journal row (rule_id, rule_version_hash, trigger_event_id, condition
   snapshot) — invariant-tested.
7. Assignment-run sessions run unprivileged (named permission profile;
   cannot reach rule endpoints).
8. SSE dictionary synced with emitters in the same phase; UI renders rule
   attribution, never masked as ui-origin.
9. Retro window fixed: 2 weeks, metrics below, owner sign-off recorded.
10. Suppression: a terminal-failed automation assignment does not re-fire
    the same rule on the same task without owner re-arm; per (rule, task)
    ≤2 automation launches before manual re-arm.
11. Sequencing dependencies: ARCH-7 (reaper) live before or with S2 —
    `assignment.expired` is a v1 hook source; the ≥80 % Ф1 retro metric
    (ADR 0009 §11) achieved.

### 6. Budgets & kill-switch (starting values; revised at the 2-week retro)

Global ≤10 automation launches/day; per-rule ≤6/day; time-based rules
≤1 per 4 h; per-specialist concurrent 1; per-rule concurrent 2; suppression
per (rule, task) ≤2 before re-arm. Any budget hit emits SSE + audit —
silent stops are forbidden. Engine default-off
(`board_meta automation.enabled=false`); enabling is an explicit owner
action.

### 7. Three-clock discipline (extends ADR 0009 Am2 §6)

| Clock family | Columns | Reader | Writer |
| --- | --- | --- | --- |
| presence | `executors.last_seen` | resolution chain / TTL | executor heartbeat route |
| assignment | `task_assignments.claimed_at/heartbeat_at` | reaper (ARCH-7) | claim/start/heartbeat |
| schedule | `schedules.next_run_at`, `launches.run_at/attempted_at` | scheduler tick, journal | scheduler tick only |

Each background loop owns exactly one family and never writes another;
cross-family reads only via sanctioned APIs (`executor_alive()`); all
timestamps are `_now()` UTC ISO.

### 8. UI frame (React only)

`/system/automation` («Расписания | Правила | Журнал» + status banner) —
tail of convergence wave Ф3, strictly after the assignment trigger
(ARCH-8): "run now" reuses the «Взять в работу» state machine whole.
Capability-gated on the S1 API + OpenAPI pin in the same phase; without
ui-token the section is visible with disabled mutations and an explanation.
The condition editor is a triple of dependent selects over the server
meta-dictionary — a free-text condition input does not exist in the DOM.
Overview gets an "auto-launches today" line in the Agents block (rendered
only when launches exist). v1 cuts: no cron UI, no templates, no bulk, no
global kill-switch toggle (read-only), no audit viewer, no catch-up, no
local timezones, no charts.

### 9. Success metrics

S1: ≥60 % of created rules have ≥1 manual run within 2 weeks; 0 breaking
schema changes before S2; ≥90 % of manual rule-runs complete
queued → running → final report. S2 (2 weeks after enablement): ≥80 % of
automation launches complete without owner manual restart; missed <5 % of
due ticks; skipped ≤50 % per rule per week; 0 routine global-cap hits.

### 10. Out of scope (v1)

Outbound webhooks (SSRF contract on return: C-8), cron parser, catch-up,
remote executor targets (until R4), rule chaining, mnemos as mint
authority (L2), bulk rule operations, timezone support.

## Consequences

- Additive schema only (`IF NOT EXISTS`, no `SEED_VERSION` bump — the
  `task_assignments` precedent); automation assignments are ordinary rows —
  reaper, routing and CAS work on them with zero special cases (the core
  elegance of variant C/A).
- The server gains two more lifespan tasks (scheduler + ECA consumer) after
  S2; the `_loop_runner` helper also retires the existing `except: pass`
  antipattern in the profile refresher.
- Single-worker assumption restated (multi-worker would need the ECA queue
  and ticks redesigned).
- Residual risks dated 2026-09-19/20 in the Security verdict (confused
  deputy via owner, origin-classification regressions, ui-token compromise
  becomes a standing launch lever) — mitigated by disable-by-default,
  audit old→new and CI invariants; accepted for a single-owner lab.
