# Cortex Workspace — design paper for the archcom

- Status: **DESIGN — archcom input, not a decision** (owner directive 2026-09-22).
  Branch `docs/cortex-workspace-design`; do not merge before committee + owner.
- Author: `@GCW: Product Architect`. Fact base — **on branch**:
  `docs/cortex-workspace-facts.md` (branch `docs/cortex-workspace-facts`,
  Senior System Engineer, 2026-09-22) + standards research
  `docs/cortex-harness-research.md` (branch `docs/cortex-harness-research`,
  `@GCW: Researcher`). Every `[FF]` (по факто-файлу) placeholder of the draft
  is resolved below against the fact file; what the facts do NOT cover stays
  marked `[GAP: …]` — no invented facts.
- Related: ADR 0005/0006/0009 (+Am2)/0011/0012/0014; `ui-contract.md` §11;
  mesh ROADMAP-v2 §2.1–§2.3, §5 W3/W4; `docs/settings-design-note.md`;
  `deploy/poller/zcode-headless.sh` (headless precedent).

## 0. Directive and the invariant

Owner (verbatim intent): a Cortex section for tasks and sessions — pick
connected agents (zcode-style), talk/steer; see ALL sessions from ALL
connected nodes/hosts (zcode/vscode/pi — no console-hopping); work from
anywhere (phone → Cortex → session). **Main invariant — NO DRIFT:** work done
via Cortex is visible on later local open (vscode/zcode) and vice versa;
Cortex COMPLEMENTS, never replaces, working "the old way". Tech Lead's
formula: one source of truth per session = the harness store on its host;
**Cortex = view + relay, never a fork.** This is ROADMAP-v2 §2.3 exactly:
cockpit over autopilot — components stay self-sufficient.

## 1. Product form

**Workspace** — new L1 viewer section (`/workspace`, nav domain; the existing
`/sessions` mnemos-record view keeps its name — Workspace sessions are
harness sessions, term in UI: «сессия харнесса» or rename pass later).

- **Session list** (left): one row per harness session across nodes — host,
  harness (zcode/vscode/pi; hermes via its gateway API — facts §1),
  project/cwd, live/idle badge (presence TTL),
  age, last line preview. Filters: host, harness, project, live-only,
  linked-task. Grouped by node (executor), like Agents/Execution today.
- **Agent/session picker**: zcode-style — choose executor (from the
  `executors` registry, capability `session-relay`) → session: new, or
  resume an existing one from the list.
- **Chat panel** (center): streaming output (SSE-fed), input box, stop.
  Read-only mode renders the transcript with a clear "чужая сессия — только
  чтение" state — never a fake input.
- **Task binding** (right/drawer): session ↔ task card (assignment id,
  memory_id); reports/checkpoints flow into the card as today (ADR 0009).
- **Roles**: owner (full: read everywhere, steer own/relayed sessions);
  phone = paired device (`mnd_`, ADR 0012) — v0 read + limited actions
  (§3); no multi-owner (out of scope).

## 2. Architecture — drift-free variants

Drift = two stores both claiming to be the session. Every variant below
keeps exactly one store: the harness store on its host.

**Variant A — Relay model.** Cortex → bridge-executor on the host → headless
instance of the SAME harness with the SAME session-id; the harness writes
its own store; Cortex only renders the stream back.
Pros: drift impossible **by construction**; the local-vs-Cortex view is the
same file; the zcode leg is fact-confirmed end-to-end — `zcode.cjs --resume
sess_<id> -p "<prompt>" --mode yolo --json` writes the same
`~/.zcode/cli/db/db.sqlite` the GUI reads (same session-id, same home), and
the `app-server` subcommand (stdio, «Zcode Protocol») is the programmable
drive; pi is symmetric (`-p --session-id <id>` — exact-id resume-or-create,
`--mode rpc` = stdio protocol); hermes continues via its gateway API / task
queue (T004), not file relay; vscode has NO headless/resume surface at all
(no chat/session flags in `code --help`, 1.137.0) — its leg is read-only
until our own extension exists. Cons: a bridge must run on EVERY host
(poller-pattern systemd unit; W4 loopback-ingress for remote nodes);
per-harness drive surface varies (full: zcode/pi; API: hermes; none:
vscode); pi has no file locks — the relay must be the sole writer of a
session (bare append breaks the `parentId` chain); no access when host is
off (honest offline, like stores).

**Variant B — Transcript aggregator.** Read-only federation/poll of harness
stores — per-shape readers, now concrete (facts §2): zcode = read-only SQL
over `db.sqlite` (`session` → project/title/times, `message`/`part` → full
transcript, `session_entry` → checkpoints; WAL, never write — a
22-migration schema racing a live GUI is not a contract); vscode =
`chatSessions/<uuid>.jsonl` + `workspace.json` folder mapping; pi =
self-describing JSONL (first record = id+cwd) + `run-history.jsonl` run
index; hermes = gateway API / read-only `state.db` via pod exec. Writes go
ONLY into Cortex-own sessions (fresh relay sessions, still
harness-store-backed).
Pros: drift impossible (reads can't fork); cheapest; store readability
fact-confirmed for all four — including the two with no remote-attach story
(vscode readable-but-frozen; pi readable, idle since ~2026-09-16).
Cons: **"continue a vscode session from the phone" is NOT possible** — fixed
honestly: a foreign live session is a view, not a socket; for vscode it is
stronger still — external continuation is impossible by construction (no
CLI, version-envelope cached in the open window, external append is not a
contract). Local transcript formats become a parsing dependency —
concretely: vscode's internal version-3 envelope with incremental `kind:1`
patches, pi's `parentId`-chained event log, zcode's sqlite schema (migrations
must be tracked per runtime upgrade).

**Variant C — Hybrid (recommended — fact base confirms the legs).** B for
total visibility (every node, every harness, always) + A for continuation
(zcode and pi — full headless resume confirmed for both; vscode stays a
read-only view — no continuation surface exists; hermes continues via its
own API tier).

| Owner case | A only | B only | C (hybrid) |
| --- | --- | --- | --- |
| Continue my zcode session from phone | yes (relay) | no (read-only) | **yes** |
| Evening review of everything (all hosts) | only relayed hosts | **yes** | **yes** |
| See pi/vscode sessions without touching them | only if bridged | **yes** | **yes** |
| Never drift / never fork | yes | yes | yes |
| Host offline → honest offline state | yes | yes (last sync) | yes |

## 3. Boundaries — three-tier action model (settings-note pattern)

- **Tier A — safe (observe, with node consent):** list sessions, read
  transcripts of REGISTERED nodes (registration + owner approval IS the
  consent, ADR 0009 Am2 L0–L2 ladder), presence, live stream view,
  session→task/memory links. Read scope mirrors device-token v0 reality
  (LAN reads already open; `mnd_` is identity/audit/revoc, not a read wall).
- **Tier B — gated (confirm / per-action token):** continue/steer OWN
  session via relay = ui-token + typed confirm (assignment-class action);
  **inject into a LIVE FOREIGN session** = the hard case: pairing-style
  TWO human gates (sender ui-token + owning host confirm), per-session
  relay token (claim_token pattern), full audit, rate-limited. v1 ships
  NONE of this — inject is v2+ behind Q2.
- **Tier C — never (not even asked):** modify/rewrite another host's
  transcripts; harness configs, provider credentials, topology, store
  surgery (Tier C of settings-note verbatim); bypassing the owning
  harness's own gate. Transcripts are evidence — append-only via harness.

## 4. Integration with what exists

- **executors + pairing = the relay bridge (A).** One registered executor
  per host gains capability `session-relay`; the reference poller
  generalizes into a host bridge (same systemd unit family, same L0–L2
  token ladder, executor token only — no board-class creds off-host).
  Remote nodes ride W4: loopback ingress half = relay endpoint on the
  host, mesh never parses payloads ("transport only").
- **presence** = live/idle badges straight from executor TTL (two-clock
  discipline untouched: presence never implies session liveness).
- **SSE** = all streams. Reserve additive-only `session.{listed,updated,
  closed}` kinds (same-phase rule, ADR 0009 phase-0 pattern); no
  per-heartbeat events; chat output streams over an authenticated
  channel, NOT the unauthenticated `/api/events` (pairing §3.3 lesson).
- **memory (mnemos)** = session context: session row links memory_id;
  harness→mnemos auto-checkpoint coverage per facts: hermes confirmed
  (sessions checkpointed under tag `hermes-default`, recall via
  `mnemos_recall_context`); zcode checkpoints are INTERNAL (`session_entry`
  workspace_checkpoint, 12.5k rows) — no mnemos feed observed; pi — nothing
  observed. `[GAP: zcode/pi→mnemos auto-checkpoint — none seen in the
  fact-find; if absent, Workspace links memory_id manually per session]`
  — Workspace renders, never writes, memory.
- **tasks** = assignment envelope already carries session-class execution;
  Workspace reuses task_id/memory_id stable ids and `topics` (Am2 §9) for
  subscribe-filtered awareness (attention budget, ROADMAP §2.1).

## 5. Standards — protocol spine for the host bridge (research verdict)

Input: `docs/cortex-harness-research.md` (`@GCW: Researcher`, primary
sources verified 2026-09-22). The owner's hint («у vscode-команды есть
протокол») resolves to **Agent Client Protocol (ACP)** — which is **Zed's
protocol, not VS Code's**. Verdict below; **final ratification = archcom
Q7**, not this paper.

**ACP is alive and is the de-facto open standard** for client↔agent
communication as of 09.2026: JSON-RPC 2.0 over stdio («LSP for agents» —
sessions, streaming updates, permissions, plan/diff rendering); launched
2025-08-27 (Zed × Google for Gemini CLI); neutral `agentclientprotocol`
org, JetBrains lead maintainer since 2026-02-18; 46 listed agents; native
IDE clients = Zed + JetBrains (+ Qt Creator plugin); official Rust/TS SDKs
at 1.0.0; agent registry; v1 stabilized monthly; v2 DRAFT since 2026-07-20.
**VS Code has NO first-party harness protocol** — it bets on MCP + a
closed Chat Extension API; Remote Tunnels is a transport, not an agent
protocol; ACP in VS Code = community extensions only (native = open FR
microsoft/vscode#265496). Notably, GitHub Copilot CLI itself speaks ACP
(public preview, 2026-01-28) — Microsoft's own agent does, VS Code does not.

**Adopt — hybrid A+C (protocol layer; composes with Variant C, the
architecture layer): ACP v1 shapes as the host bridge's agent-facing
contract.** Native ACP where a harness speaks it, adapters where it
doesn't, all normalized to one shape: `session/new`, `session/load`,
`session/list`, `session/resume`, `session/close`, `session/delete` →
relay verbs (`session/resume` = our exact-id continuation, no
fork); `session/update` → SSE `session.*` kinds (additive-only rule
holds); `session/request_permission` → Tier-B typed-confirm gates;
`authenticate` where the agent requires login. Thin view-only clients are
conforming (Cursor's minimal example runs with fs callbacks disabled) —
Cortex-as-view is legal ACP.

**What this means for Cortex.** Our differentiators — multi-host
aggregation, mnemos memory binding, task binding, ownership tiers,
presence — live ABOVE the client↔agent protocol layer: ACP replaces none
of them, and none of them need an own protocol. Fleet tiers as of the
facts: **zcode** — not ACP-listed; own stdio protocol (`app-server`,
«Zcode Protocol») + full headless resume → custom-drive tier; **pi** —
upstream `pi-acp` adapter exists, but native headless (`--session-id`,
rpc) already covers us → adapter optional; **vscode** — no protocol
surface at all → store-read tier; **hermes** — ACP-listed upstream, but
our deployment's surface is the gateway API/queue (T004) → API tier.
⇒ **no v1 leg needs ACP**; it earns in on NEW harness onboarding
(claude-code/codex/gemini-lineage/cursor would join through one contract
and registry metadata instead of N bespoke adapters).

**Honest limitations.**
- **stdio-only in v1** (client spawns the agent; NDJSON JSON-RPC on
  stdin/stdout; remote HTTP/WS transport = open RFD). Our case is
  remote/multi-host by definition → the relay layer (poller-family host
  bridge + W4 loopback ingress) stays OURS: ACP rides inside the host
  bridge, it does not replace the relay transport. Research: this
  matches, not hurts, extend-the-poller.
- **Adapter-level resume is uneven** (goose: fork/resume not yet exposed
  over ACP; ACP session-id ≠ native id) → keep the `(harness, host,
  native-id)` identity triple and add an `acp_session_id ↔ native_id`
  mapping table. `[GAP: claude-agent-acp / codex-acp resume coverage —
  matters only when those harnesses onboard]`
- **ACP ≠ transcript federation**: history depth via `session/list` is
  agent-dependent → Variant B store-readers stay per-harness, unaffected.
- **Attach-to-live-foreign-session is not an ACP scenario** (the client
  spawns the agent) → consistent with v1's own/relayed-only scope;
  foreign inject stays v2+ behind Q2.
- **v2 churn**: draft since 2026-07-20 → gate behind `protocolVersion`
  negotiation; re-examine at v2 stabilization and when the HTTP/WS RFD
  lands (could then replace bespoke W4 relay framing).
- **Naming**: an ACP agent literally named «Cortex Code» already exists —
  collision check owed in the Workspace naming pass (owner-level call).

**Why not our own protocol** (research Strategy B — rejected). The layer's
whole value is ecosystem gravity (46 agents, two IDE vendors native, CN
segment adoption, harness-drives-harness already in production via
goose/OpenHands); an own protocol re-creates the N×M glue ACP removed,
costs spec maintenance, buys nothing — our value-add sits above it, and
the inner contract can simply mirror ACP shapes (that mirroring IS the
A+C hybrid). Prior art validates the case without becoming a dependency:
Happy (mobile ACP client — the phone→session case), Orca (fleet cockpit +
phone approvals), goose ACP-providers, ACP Kit WS/HTTP bridges.

## 6. Questions for the archcom (recommendations inline)

1. **Relay infrastructure**: dedicated bridge service per host vs extending
   the reference poller into a host agent? **Rec: extend the poller**
   (transport #1.5 in ADR 0009's "many transports" frame — no new state
   custody, reaper/two-clocks untouched; bridge-service rejected at this
   scale before, ADR 0009 B).
2. **Permission model for live-session inject**: adopt pairing-style two
   human gates + per-session token? **Rec: adopt for v2; v1 ships NO
   foreign-session inject** — own-session relay (ui-token) + read-only
   foreign views cover the directive's cases.
3. **v1 scope**: **Rec: read-only aggregation (B) + zcode session
   continuation via relay (A)** — minimal useful; facts re-scored the
   legs: pi's A-leg is ready too (`--session-id` + rpc) — fast-follow on
   the same pattern; vscode is B-forever (no continuation surface, facts
   §3); hermes = API tier, read via gateway. Primary success metric:
   **zero fork/drift incidents** in the 2-week retro + ≥3 cross-device
   continuations.
4. **Freeze/viewer**: Workspace = new L1 viewer section, vanilla `web/`
   untouched → **no freeze-exception entry** (settings-note §0 precedent).
   Out-of-scope list: transcript editing, cloud relay (ADR 0012 stands —
   outside-LAN = VPN), multi-owner, inject-into-foreign (v2), autostart
   beyond existing T2 gates.
5. **SSE + identity**: reserve `session.*` dictionary now; session-id
   namespace = (harness, host, native-id) triple — never a global re-mint
   (stable ids per swarm §2.1); chat stream authentication channel —
   new authenticated SSE or POST-poll? **Rec: authenticated SSE scope,
   decided with ADR 0014 (owner session cookie).**
6. **`[FF]` blockers — CLOSED by the fact file** (was: zcode resume-by-id,
   vscode/pi store readability + headless stories, harness auto-checkpoint
   coverage). Resolutions: zcode resume-by-id = YES (same sqlite, same
   session-id — drift impossible by construction); pi = YES (`--session-id`,
   rpc mode); vscode = readable YES / continuable NO; hermes = API tier;
   mnemos-checkpoint = hermes yes, zcode/pi unobserved (the one fact-side
   `[GAP]`, §4; the adapter-resume `[GAP]` in §5 is research-side, future
   onboarding only). **Закрыт ресёрчем + факто-файлом; к archcom — только
   ратификация пересчитанной A-leg матрицы** (Variant C already accepted
   by the owner).
7. **Standards (new)**: ratify ACP v1 as the host bridge's agent-facing
   normalization contract — hybrid A+C: ACP-shaped spine + per-harness
   adapters as limbs (§5)? **Rec: adopt as CONTRACT SHAPE, not as a
   transport commitment** — v1 legs stay native-drive/store-read (zcode
   `app-server`, pi rpc, vscode JSONL read, hermes API); ACP earns in on
   new harness onboarding + registry metadata; stdio-only transport rides
   inside our relay layer anyway. SDK pinned at 1.0.x, v2 behind
   `protocolVersion` negotiation, revisit at HTTP/WS RFD landing.

## 7. Committee amendments — 2026-09-23 (ratified text, archcom protocol 2026-09-23-cortex-workspace-phase1)

Ratified: Variant C, phase 1 = B-aggregation + zcode-relay; ACP as contract
shape only. The following amendments are binding parts of the phase-1 charter:

1. **Phone leg (resolves the §1/§3 phone ambiguity):** the owner's phone is
   an ordinary browser with the owner-session cookie over VPN — ui-class
   (transcripts, Tier-B steer of own sessions, authenticated chat SSE).
   `mnd_` stays metadata-only for non-owner devices; transcripts are
   ui-class, never persisted on the board. Security conditions: same
   lab-CA TLS-ingress path (no plain-http through the VPN overlay);
   one-command device-loss ritual (rotate ui-token + DELETE) in RUNBOOK;
   documented browser hygiene (no account-sync). Step-up (WebAuthn)
   trigger: any exposure extension beyond owner devices.
2. **Relay is a separate mode of the poller family** (own flag/unit file,
   same token ladder) — never code inside the claim loop. Recovery
   semantics: relay sessions survive executor restarts (assignment-sweep
   must not fail them); per-session writer mutex; drain ritual before
   runtime updates. Revisit trigger: relay load starves the claim loop
   → extract the bridge into its own unit (reconfiguration, not refactor).
3. **Chat transport:** poller→board POST chunks `(session_id, seq)` with
   ingest binding (chunk only into a session registered to that executor;
   foreign triple → 403 + audit), seq monotonicity gap=hold, size/rate
   caps; in-memory bounded ring-buffer (no disk spill, wipe on eviction)
   as the only GET-tail source; browser consumes authenticated per-session
   SSE (cookie per ADR 0014, re-validation on flush, lifetime ≤ cookie
   Max-Age, logout tears streams); dictionary `session.*` events stay in
   `/api/events` as metadata-only (clamped, masked preview). Cross-check
   monitor: chunk tail vs store tail.
4. **Security gates split by "before the surface exists":**
   - Before the first relay smoke run: provenance-only continuation
     (A-leg = relay-origin or typed-confirm adoption only); prompt via
     stdin/JSON or app-server — never argv (log hash+length, spool 0600
     + purge); loopback bind + W4-only reachability + `session-relay`
     capability default OFF; ingest leg of the SSE gate; read-only store
     opening; in-memory ring discipline.
   - Before owner-facing UI: foreign-triple 404 on the send path (server
     side, not UI hiding); full SSE delivery gate (re-validation,
     payload metadata-only); recorded decision "mnd_ gets no transcripts
     in v1"; host-identity binding 1:1 with loud conflict refusal,
     "unverified" render for self-asserted names; parser caps, zcode
     reader excludes rollout/model-io, anti-write-path tests per reader
     family; ACP gate reduced to "shapes are internal, no network ACP"
     (SDK pin + adapter review = gate of the first real adapter).
   - Inject (v2, separate pre-code threat model): second gate on a channel
     the sender does not control; confirm bound to prompt hash+length;
     `claim_token` per ADR 0012 §3.
5. **Hermes leg deferred to T004** (pod-exec reader would be throw-away
   code; directive does not require it). Visibility metric is per-harness;
   hermes is a known-gap until T004.
6. **Naming:** UI says «сессия харнесса» from day one; «Cortex» remains an
   internal codename until the owner checks the external «Cortex Code»
   collision — owner-level check before any external use of the name.
7. **Acceptance gates (retro window starts after core components 1–5 are
   accepted, runs to ≥5 continuations or 4 weeks):** visibility ≥95%
   per-harness (list) with audit script / full transcript ≥90% diagnostic;
   ≥5 working relay continuations, ≥2 from the phone over VPN ≤5 min,
   audit events carry device-class + network-path + session-host; zero
   drift incidents WITH a detector (definition committed before the
   window; counter runs from the first relay deployment); time-to-continue
   p50≤60 s / p95≤120 s LAN, ≤5 min VPN, SSH baseline measured pre-phase;
   boundary checklist — zero fake-input, offline host visible ≤30 s,
   vscode dead-end counter from day one, freshness ≤60 s p95.

   > **Note 2026-09-24 (rev.2):** the sequencing language in this
   > amendment — «retro window starts after core components 1–5 are
   > accepted» and the horizontal component phasing it rests on — is
   > **superseded by ADR 0016 rev.2 vertical slices** (retro window after
   > slice 3; success measure = North Star). The gate list itself survives
   > as diagnostics/release-blockers. Same for the amendment-2 relay mode
   > and amendment-3 chat transport: superseded by the rev.2 sections
   > (separate `vesmaro-session-relay.service` unit; store-tail GET chat).
   > Status map for all eight amendments: ADR 0016 rev.2 §7.

8. **Pre-phase checklist:** manual SSH-path baseline; pilot hysteria call
   from the owner's phone; owner decision on the 6-hour cookie lifetime
   (phone re-login cadence); fact-check app-server vs stdin prompt (one
   hour, read-only) before component 4.

Phase 1 starts only after the owner ratifies **ADR 0016 rev.2**
(decisions page at the end of the ADR).

## Appendix A — Онбординг и экран покрытия (rev.2 product additions)

Added by the improvement round of 2026-09-24. Normative text = ADR 0016
rev.2 («Продуктовые добавки», slice table); this appendix is the design
elaboration. If the two diverge, ADR 0016 rev.2 wins.

### A.1 Coverage screen — «что я вижу и чего пока нет» (slice 1)

A persistent block of the Workspace first screen (not a separate page):
one row per source, each row = what you get + why not more.

| Источник | Что видно | Чего нет и почему |
| --- | --- | --- |
| zcode (хосты со сканером) | список сессий (срез 1), полный транскрипт (срез 2) | — |
| vscode | метаданные + превью (срез 2) | полный транскрипт — known-gap (конверт-v3, kind:1-патчи); продолжение невозможно по построению — чтение only |
| pi | список сессий (срез 2) | — |
| hermes | ничего | отложено до T004 (pod-exec-ридер = выбрасываемый код) |
| удалённые хосты | когда появится W4 loopback-ingress | до этого — known-gap, честно показанный |

Rendering rule: a gap is always a visible row with a reason and a
horizon («закроется в T004»), never a silently empty list. The screen is
the standing answer to «а где всё остальное?».

### A.2 Onboarding card — 3 кейса (slice 1)

First-open card on the Workspace screen. Each case links to the surface
that delivers it and renders disabled-with-horizon until its slice
lands:

1. «Вечером посмотреть, что делалось» → список сессий + дайджест
   (срез 1–2).
2. «Досмотреть живую сессию» → read-only транскрипт / live-tail чужой
   сессии (срез 2 + шаг 1.5), без руления.
3. «Начать с телефона» → новая сессия через реле (срез 3), затем —
   продолжение существующей.

### A.3 Digest feed (slice 2)

«Активное за 24ч + открытые todo + ждут владельца» — derived from the
session listing + assignments (ADR 0009). Почти бесплатно: новые ридеры
не нужны.

### A.4 Product gate «60 секунд»

Cold-open acceptance for slices 1–2: the owner, within 60 seconds of
opening, can say what is alive and what was being done. Fixed by
screenshot + the owner's own words — not a questionnaire.

### A.5 Friction metrics (diagnostics, not North Star)

- Phone re-login share: threshold >30% → cookie-TTL revisit with
  numbers (owner decision (б) in ADR 0016 rev.2).
- `mnd_` wall with an explanation: what is forbidden, why, what to do —
  not a bare 403.
- «Заблокировать устройство» button (device-loss ritual, one click).
- vscode dead-end funnel: counted from day one; the «продолжить тему в
  zcode» button is a post-window step at baseline ≥3–5 dead-ends/week.

### A.6 Live-tail (step 1.5, after slice 2)

Read-only tail of someone else's live session through the same
authenticated GET transcript path (seq cursor, redaction choke-point,
`session.transcript_viewed` audit). Provenance gates untouched — read
path only, never a fake input.
