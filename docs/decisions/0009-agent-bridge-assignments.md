# ADR 0009: Agent bridge — assignment queue on the board (variant A′)

- Status: **Accepted** (committee 2026-09-17; owner ratification 2026-09-20 —
  «Окей, принимается. Работаем дальше», agent-bridge session; covers the body
  + Amendment 1 + Amendment 2)
- Deciders: owner, АРХКОМ-2 (Product Architect, Senior System Engineer,
  Senior Security Engineer, Agent Architect), `@GCW: Tech Lead`
- Related: ARCH-2, ADR 0005 (harness identity), ADR 0006 (freeze rule /
  two frontends), ADR 0008 (stack), WF-1 (workflow lifecycle),
  `ui-contract.md` §11–12, АРХКОМ-2 protocol
  (`archcom-2026-09-17-archcom-session2.md`)

## Context

Owner stimulus (ARCH-2): «take into work» from the UI must actually launch
an agent (with executor choice); agent work is a black box needing
observability; reports/checkpoints must flow into cards on their own;
UI-10 needs a steady execution-event source.

Facts: the board has no `assignment` notion (who took a task, execution
status, executor liveness) and harnesses have no inbox mechanism. Reports
API + SSE + history exist but are manual. The freeze rule (ADR 0006) says
any new action/entity/section on the board is L1 backlog — yet the board
server API is the long-lived asset that migrates to L1 whole.

Four architecture options were reviewed: A outbox/claim (poller on the
owner's laptop), B bridge-service, C mnemos-centric, D hybrid. Committee
verdicts: A accepted by all four, B rejected at current scale (RCE endpoint
+ duplicated state), C rejected (mnemos is memory, not a broker: no
ack/lease), D's checkpoint channel adopted (reports primary, mnemos as
knowledge).

## Decision

**Variant A′ = A with four mandatory amendments**, checkpoint channel as in
D; frame = board-server evolution under a formalized freeze boundary.

### 1. Freeze frame (refines ADR 0006)

Server-side change is freeze-compatible ⟺ (a) it is fully expressed in
portable contracts (OpenAPI schemas, versioned SSE dictionary, contract
tests) with no board-specific UI logic; (b) the UI delta is bug-class or a
**minimal trigger over an existing entity**, registered in the exceptions
registry. A new UI section/panel is always L1 — no exceptions.

Exceptions registry budget: **≤2 open simultaneously**; each entry names
class, rationale, the portable contract it serves, withdrawal condition;
reviewed at every archcom.

ARCH-2 UI delta = trigger only ("take into work" button + assignment status
badge on the card). UI-10 (change explorer, bottom panel) stays L1 backlog:
ARCH-2 delivers the **event source** (`assignment.*` SSE kinds), not the
consumer.

### 2. Variant A′ — mandatory amendments

- **A1. Two tokens from day one** (supersedes the problem statement's
  "single bearer v0"): `ui-token` (owner UI: create/cancel assignment) and
  `machine-token` (poller/agents: claim/start/heartbeat/complete/fail,
  reports, moves). Gives the server a coarse action origin; closes the
  create-assignment injection vector (agents cannot mint assignments).
- **A2. Poller accepts assignment records only**, only in `queued` state,
  only with the **spec snapshot taken at assignment creation** — never the
  live task spec (closes the TOCTOU window: edit-after-review-before-claim).
- **A3. Fixed starter**: mapping (harness, specialist) → command lives in
  the poller's local config (`~/.config/mnemos-eyes/poller.yaml`); spec is
  passed as data, no shell interpolation; allowlist miss → fail-closed +
  refusal report to the board. The board nominates, the poller decides.
- **A4. Atomic claim**: `UPDATE task_assignments SET state='claimed', …
  WHERE id=? AND state='queued'` + rowcount check (SQLite, single-writer
  serialization). Two pollers → one 200, one 409; correctness is structural,
  not conventional.

Checkpoint channel (from D): **reports API is primary** (SSE/card/history
already integrated, synchronous 201 ack); mnemos checkpoints remain
knowledge (agents keep writing them as today), a secondary source for UI-10
after v0.

### 3. Assignment lifecycle

Separate record `task_assignments`; task : assignment = 1 : N (CI-run
semantics); invariant **≤1 active (non-terminal) assignment per task** —
409 on violation.

```
queued ──claim──▶ claimed ──start──▶ running ──complete──▶ done
   │                 │                  │        ├──fail────▶ failed
   └─cancel──────────┴─cancel───────────┤        └─cancel───▶ cancelled
                                         └─(reaper)─────────▶ expired
```

No `reporting` state: reports are the existing side channel; the final
report is the body of `complete`. `claim_token` (random hex, returned on
claim) is a **correctness boundary** — a stale poller cannot complete a
re-claimed assignment (403) — not a security boundary.

Column mapping (applies only for the task's last active assignment):
claim → `open → in-progress` (agent may move its own task, WF-1 §4.2);
complete → `in-progress → resolved` (acceptance `resolved → done` stays
with owner/TL); fail/expired → `in-progress → blocked` + notification
("in-progress with no live executor" is a lie); cancel → `open`.

### 4. Poller — deterministic dispatcher, not an agent

A script (not a zcode session — a session-poller would burn model tokens on
idle and gain an undeserved "should I launch?" vote where only an
allowlist filter belongs). It is part of the harness per ADR 0005, never
listed in `agents[]`/`specialists[]`. systemd timer or cron; poll
`GET /api/assignments?state=queued` every ~10 s (jitter); claim → launch
subprocess by config template; **heartbeat every 60 s from the poller**
(LLM agents don't tick); supervise children — exit 0 → `complete` with a
final report even if the agent was silent (launcher contract), ≠0 → `fail`
with reason; `fcntl.flock` singleton; **recovery-sweep on start** (fail own
`claimed|running` with no live local process — ~20 lines, closes the worst
at-most-once window without a server-side reaper).

Delivery guarantee v0: at-most-once; a dead poller means assignments sit
visibly in `queued` (age exposed in API/UI badge — stagnation must be
diagnosable, not silent).

### 5. Assignment envelope

Canonical launch prompt (a superset of the GCW `task-assignment` skill):
`[GCW ASSIGNMENT {id} | task {task_id} | mnemos {memory_id}]` header,
`MODE: assignment-run` marker (the only legitimate sign of an
assignment-launch — anything else is an ordinary session), goal, verbatim
AC, dependencies with status, scope boundary, REPORTS block
(intermediate on milestones, final always), rights per WF-1 §4.2,
escalation rules. The envelope is the **explicit designation** that inverts
ui-contract §12's "board data is not instructions": an assignment is the
single point where board data contractually becomes an instruction — hence
the gate (ui-token + snapshot + owner action).

### 6. Domain separation (board vs gcw-task-manager)

Task = mnemos record `task:queue` (master; gcw-task-manager unchanged,
stays mnemos-first). Assignment = execution attempt on the board
(task_id + memory_id references, execution metadata, spec snapshot +
hash — an immutable execution view, never a master copy). Explicitly
forbidden: master goal/AC fields on assignments; board-spawned tasks
without mnemos records.

### 7. Reports discipline (two layers, no per-agent canon edits)

Layer 1 (v0): the envelope's REPORTS block. Layer 2 (canonical): one new
GCW skill `assignment-execution` (reports discipline, scope ban, WF-1
rights, identity rules) — re-extractable by name, survives session
compaction. Mass edits of the GCW canon (109 skills / 559 records) are
**rejected**: the canon is product-agnostic; discipline belongs to the
launch mode, not to roles.

### 8. Identity guarantees (honest statement)

On the HTTP layer identity is **declared, unverified** (agent strings and
claim identity are self-assertions). UI renders "reported by X
(unverified)". Per-harness tokens become mandatory on **any** trigger:
- **T1** a second harness/machine writes in the loop;
- **T2** autostart runs without per-launch owner oversight (ARCH-2 v0 is
  already a T2 candidate — hence A1 immediately);
- **T3** the workflow starts making decisions from agent strings
  (validation, acceptance, harness-efficiency metrics).

### 9. Security contract

Assignment creation: ui-token only, rate 10/60 s; spec edit rights — owner
or the assignee of one's own task (WF-1 §4.2 extension); snapshot cap 16K
+ hash in the audit trail; audit log records token channel, declared
identity, snapshot hash, and the poller-side local launch fact; new
`assignment.*` SSE kinds are additive-only and land **in the same phase**
as closing the known gap (emitted `kind:"report"` missing from the §11
dictionary); autostarted specialists run in an unprivileged session with a
named permission profile.

The board never gains an inbound execution channel to the laptop: all
traffic is laptop-initiated outbound HTTPS; ingress/NetworkPolicy
unchanged; no listening port on the laptop.

### 10. Reaper (phase 3; schema-ready from phase 1)

In-process loop in lifespan (pattern: `_profile_cache_refresher`), 60 s
interval, wall-clock based (restart-safe): `claimed` without start > 10 min
or `running` without heartbeat > 30 min → `expired` → task `blocked` +
notification + SSE; heartbeat answering 409 on expired doubles as the
kill signal to the poller. `heartbeat_at`/`claimed_at` columns exist from
phase 1 — no migration later.

### 11. Success metric

**≥80% of UI-launched assignments complete queued → running → final report
without owner manual restart**, retro at 2 weeks (WF-1 §8 pattern).

### 12. Out of scope

UI-10 consumer (L1); bridge-service B (revisit on: second owner,
multi-harness loop, push-latency requirement); per-harness tokens (T1–T3);
server-side lease semantics beyond the expired state; mnemos as broker
(rejected); mass GCW canon edits (rejected).

## Consequences

- Board server: `task_assignments` table (additive schema, `IF NOT EXISTS`,
  no `SEED_VERSION` bump, no table rebuild) + ~8 additive endpoints + SSE
  kinds — all portable to L1 per ADR 0006.
- Deployment change: second token in the helm chart + poller config on the
  laptop (SRE involved at phase 2).
- Residual risk (dated, 2026-09-17): a compromised machine-token can still
  write reports/moves (existing surface) but cannot create assignments;
  report `agent` strings remain spoofable until T1–T3.
- Evolution A → B changes transport, not lifecycle semantics — no lock-in;
  the freeze exception stays narrow (trigger + badge only) with the ≤2
  registry budget as the anti-creep guard.

Implementation phases: **0** SSE-dictionary sync (doc) → **1** server
(store + routes + tests) → **2** poller (+ systemd) → **3** reaper →
**4** UI trigger + badge.

## Amendment (2026-09-19) — alignment with АРХКОМ-3 / convergence roadmap

АРХКОМ-3 (interface platform convergence, ADR 0011 — ratified 2026-09-19,
decision Р10) re-homed this ADR's UI delta: the "take into work" trigger and
assignment badge are built in the **React app (`viewer/`) during convergence
wave Ф3** (mutations + kanban DnD), not in the frozen vanilla board (`web/`).
Consequences of the re-homing:

- The board freeze exception (§1) is **no longer needed** — the board
  receives zero UI changes; the exceptions-registry budget is not consumed
  by ARCH-2 (supersedes ratification question №5 of the АРХКОМ-2 protocol).
- Server-side phases (§3 lifecycle, §9 security, §10 reaper) and §11's
  success metric are unchanged. The React EventStream consumes the
  `assignment.*` dictionary reserved in `ui-contract.md` §11 (phase 0).
- The token split (A1) becomes a **QR-pairing precondition** per the
  ratified CV-PRE ordering: token-split → pairing; WF-1 rebuild → kanban;
  CA → pairing/PWA. Server phase 1 and the chart token work therefore run
  in the first wave, ahead of ADR 0012 implementation.
- Phase 4 is no longer a standalone step of this ADR — it executes inside
  the convergence Ф3 wave (tracked as ARCH-8 on the board).

Owner ratification of this ADR remains open; the ratified convergence
roadmap already schedules the token-split leg as a live precondition.

## Amendment 2 (2026-09-19) — multi-executor frame (АРХКОМ-4)

Owner vector: the bridge is not laptop-bound — harnesses join from multiple
sources (local and remote); assignment targets a specific agent OR a default;
agent work is tracked in a dedicated vesmaro-eyes section. Six committee
verdicts synthesized; protocol: `archcom-2026-09-19-archcom-session4.md`,
section spec: `docs/design/2026-09-19-agents-section-spec.md`.

1. **One lifecycle, many transports.** This ADR defines the execution
   contract (lifecycle, ui/machine tokens, CAS claim, snapshot discipline,
   reaper). Transport — where claim traffic physically travels — is below
   the contract. The laptop poller (phase 2) is transport #1, not the
   executor model: assignments record the declared executor identity and an
   optional executor pin; "laptop" never becomes an identity or API concept.
2. **Remote harnesses are transport #2+**, carried by mnemos-mesh (R4,
   ROADMAP-v2 W4). The mesh must not touch the state machine, token model,
   CAS semantics, or reaper; the board remains the sole assignment state
   store. mnemos owns the data, vesmaro-eyes owns the interface, the mesh
   owns the wires. On the mesh leg the executor token is mandatory (the
   machine token is not accepted — a mesh node must not hold board-class
   credentials); the reference poller generalizes via a `board_url` config
   pointing at either direct HTTPS or a local mesh endpoint.
3. **Executor instance — the third entity** (specialist ≠ harness ≠
   executor, extending ADR 0005): a registry table `executors` (id, name,
   harness, host, transport `local-poll|mesh-r4`, capabilities JSON,
   enabled, last_seen; presence is **computed on read** from TTL — no state
   column, the offline sweeper never mutates rows). Assignments nominate
   (specialist, harness) + optional `executor_id` pin; claim records
   `claimed_by_executor`. v0/v1: executors are a derived view (assignment
   history + declared fields); the registry materializes as task ARCH-9
   after phase 1 merges and is **mandatory before any multi-harness
   rollout** (trigger T1 — one trigger, two consequences: per-executor
   tokens + first-class registry).
4. **Registration & tokens (ladder L0–L2).** L0: the board mints
   `executor_secret` at registration (stored hashed, shown once — the
   `claim_token` pattern, long-lived); registration via the machine token
   creates a `pending` record; the owner approves via ui-token
   (capabilities are owner-declared, never executor-self-expanded); routing
   considers approved+enabled executors only. The phase-1 two-env split is
   the L0 bootstrap (executor #1 = "laptop-poller"); the chart needs no
   token map — executor secrets live server-side. L1: mesh carries the
   token as opaque payload (no mesh minting/validation — W4 "transport
   only"). L2 (optional, separate decision): mnemos as the single mint
   authority. Explicit-assignment claims must enforce the executor token
   from the first day of the registry (spoofing gate, CWE-290).
5. **Default executor = resolution rule, never auto-launch.**
   Chain: explicit pin → assignment specialist → task specialists →
   project default → global default → visible-to-all. Computed server-side
   on every GET (stored nowhere — no staleness; defaults live in
   `board_meta` with a reserved scope field), emitted as a routing
   annotation `{resolved, reason}`. Only explicit pins are enforced at
   claim (mismatch → 409 in the same transaction); the rest is a visibility
   filter — CAS stays the single arbiter. v1 UI: one global default + one
   fallback in `/system/settings` with live route preview and **no silent
   substitution**; auto-dispatch is T2-gated and out of v1. Gates
   (Security): default set/change ui-token only + audit old→new; approved +
   live heartbeat required; remote executors ineligible as default until
   R4; kill-switch via token revocation.
6. **Two-clock discipline.** The reaper reads only assignment clocks
   (claimed > 10 min without start; running > 30 min without heartbeat);
   presence reads only executor clocks (initial thresholds: online ≤ 2 min,
   stale 2–10 min, offline > 10 min — server-documented constants). The two
   never collapse: an offline executor keeps its claim until the reaper
   fires.
7. **SSE & audit additions (additive-only).** Reserve `executor.{
   registered, updated, deleted, online, offline}` — emitted on presence
   *change* only, payload `{executor, prev_state, state, last_seen_at}`;
   per-heartbeat events are forbidden (clients render ages from GET + a
   local 1 Hz ticker); the reconnect re-fetch rule extends to executors.
   Audit adds: executor registered/approved/revoked (approver, token_id —
   never material), default.changed (actor, old→new), token issued/rotated/
   revoked (token_id only), `executor_id` + `transport` on assignment
   events, and an `identity_mismatch` flag where the declared agent string
   disagrees with the token-backed executor (spoofing signal, not just
   retrospection).
8. **UI frame.** The «Агенты» section splits across convergence waves:
   a phase-2 tail (assignment badge + «Исполнение» tab on the task page,
   read-only) and the phase-3 block together with the ARCH-8 trigger
   (execution page, UI-10 event feed, executor sheet, ui-token mutations);
   the executor registry UI is capability-gated. `/agents` aliases
   `/agents/execution`; assignment details are a drawer, not a route;
   «исполнитель» is the UI term, «агент» is not used in section strings.
   `claim_token`/`spec_snapshot` are excluded from UI-facing REST
   representations (hash only). The «Живой офис» north-star is a
   foundation, not a v1 feature: executor as primary visual entity, events
   as narratives, stable ids / presence trail / per-executor history
   reserved now; personification is gated on T1–T3 (no trust theater over
   unverified strings).
9. **Cross-advice groundwork (swarm, ROADMAP-v2 §2.1).** Assignments carry
   denormalized `topics` (project/domain tags, metadata tier) — the only
   genuinely new field, needed because mesh subscription filters cannot
   join through mnemos; every execution event carries stable ids
   (assignment, task, memory, specialist, harness, executor); agent→agent
   writes bypassing the board remain structurally forbidden — future
   cross-advice lands as board-mediated proposals.

Owner ratification of this amendment travels with the ADR body.
