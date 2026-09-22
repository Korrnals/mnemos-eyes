# Cortex Workspace — design paper for the archcom

- Status: **DESIGN — archcom input, not a decision** (owner directive 2026-09-22).
  Branch `docs/cortex-workspace-design`; do not merge before committee + owner.
- Author: `@GCW: Product Architect`. Fact base: `docs/cortex-workspace-facts.md`
  (parallel, Senior System Engineer) — **not yet on branch**; harness mechanics
  below are coded against the three generic shapes (CLI-headless / file store /
  API) and every concrete claim is marked `[FF]` (по факто-файлу).
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
  harness (zcode/vscode/pi), project/cwd, live/idle badge (presence TTL),
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
same file; reuses zcode-headless precedent (`--mode yolo -p`, env glob) with
a session-resume flag `[FF: zcode resume mechanics]`; vscode/pi legs need
their own headless/resume story `[FF]`. Cons: a bridge must run on EVERY
host (poller-pattern systemd unit; W4 loopback-ingress for remote nodes);
per-harness headless support varies `[FF]`; no access when host is off
(honest offline, like stores).

**Variant B — Transcript aggregator.** Read-only federation/poll of harness
stores (file-watcher/API per shape `[FF]`); writes go ONLY into Cortex-own
sessions (fresh relay sessions, still harness-store-backed).
Pros: drift impossible (reads can't fork); cheapest; works for harnesses
with no remote-attach story `[FF: vscode/pi store readability]`.
Cons: **"continue a vscode session from the phone" is NOT possible** — fixed
honestly: a foreign live session is a view, not a socket. Local transcript
formats become a parsing dependency `[FF]`.

**Variant C — Hybrid (recommended if `[FF]` confirms).** B for total
visibility (every node, every harness, always) + A for continuation
(zcode first — precedent exists; vscode/pi as their relay legs mature).

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
  harness auto-checkpoints already feed mnemos `[FF: which harnesses
  checkpoint when]` — Workspace renders, never writes, memory.
- **tasks** = assignment envelope already carries session-class execution;
  Workspace reuses task_id/memory_id stable ids and `topics` (Am2 §9) for
  subscribe-filtered awareness (attention budget, ROADMAP §2.1).

## 5. Questions for the archcom (recommendations inline)

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
   continuation via relay (A)** — minimal useful; vscode/pi join B-first,
   A-when-`[FF]`-allows. Primary success metric: **zero fork/drift
   incidents** in the 2-week retro + ≥3 cross-device continuations.
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
6. **`[FF]` blockers**: zcode resume-by-id, vscode/pi store readability +
   headless stories, harness auto-checkpoint coverage — facts file gates
   the A-leg matrix; Workspace phases re-scored against it at archcom.
