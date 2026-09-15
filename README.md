# mnemos-eyes → vesmaro-eyes

> _«Взгляд в себя — в свои мысли.»_ — the eyes gazing into the well of memory.

**vesmaro-eyes** (repo directory still `mnemos-eyes` until the rebrand wave,
task RB-1 on the board) is the graphical companion to the mnemos long-term
memory engine. Where the engine is the well (storage, search, MCP,
provenance, traces), this project is the **eye that looks into it** — and,
since v0, also the **cockpit that steers the work**: a live task board wired
to real agent memory.

---

## Status

🟢 **Task board v0 shipped** (2026-09-15) — live in the `ai-agent` cluster at
`http://vesmaro.abyss.lab`. L1 read-only memory viewer is next (see the board).

- First deliverable: **task board v0** — tasks × statuses × agent-executors ×
  execution environments × specialists, with live links into real mnemos
  memory. [ADR 0004](docs/decisions/0004-task-board-v0.md) records the pivot.
- Session brief: [`docs/sessions/SESSION-02-task-board-v0.md`](docs/sessions/SESSION-02-task-board-v0.md).

---

## The task board (v0)

```text
┌──────────┬─────────────┬───────────┬──────────┬──────┐   ┌───────────────────┐
│  открыто │  в работе   │ блокир.   │ решено   │готово│   │ Пульс памяти      │
│  T1..T7  │  T6, TB-1   │ RB-1, RB-2│          │      │   │ (live mnemos)     │
└──────────┴─────────────┴───────────┴──────────┴──────┘   │ Специалисты · СРЕДЫ│
        drag & drop between columns  ·  SSE live updates    └───────────────────┘
```

- **Columns = mnemos workflow states** (`open → in-progress → blocked →
  resolved → done`) — task and memory lifecycles speak the same language.
- **Every card carries**: agent-executor, execution environment (cluster /
  laptop / local / cloud), specialists, and a count of linked memories.
- **Task drawer** renders the linked memories as "scrolls" straight from the
  live mnemos store; unresolved ids are shown honestly (404), never hidden.
- **Memory search in the drawer** attaches new memories to tasks live.
- **Пульс памяти rail** shows the live store stats (and honestly says when
  the connected store holds no memories of this project yet).
- **SSE** pushes board changes to every open tab in real time.

### Run (container, bind volume)

```bash
# local — image from ghcr, board DB in ./data
mkdir -p data
podman run -d --name vesmaro-eyes -p 8090:8080 \
  -v "$(pwd)/data:/data" \
  -e MNEMOS_URL=http://host.containers.internal:8787 \
  -e MNEMOS_TOKEN=mnk_... \
  ghcr.io/korrnals/vesmaro-eyes:0.1.3

# or build + compose
podman-compose up -d --build
# → http://localhost:8090
```

### Deploy (ai-agent k3s cluster)

```bash
./deploy/apply.sh          # apply manifests, wait for rollout
# → http://vesmaro.abyss.lab   (add to /etc/hosts → 192.168.1.72)
```

The board's mnemos bearer token is managed out-of-band in the
`vesmaro-eyes-mnemos` secret — see
[`docs/sessions/SESSION-02-task-board-v0.md` §3](docs/sessions/SESSION-02-task-board-v0.md).

---

## Architecture (v0)

```text
Browser SPA (vanilla ES modules, design tokens from docs/design-system.md)
        │  fetch + SSE
        ▼
FastAPI board server  ──  SQLite WAL on a mounted volume (/data/board.db)
        │  narrow proxy /api/mnemos/* (bearer mnk_… stays server-side)
        ▼
mnemos HTTP API (in-cluster: agentsnode-mnemos:8787)
```

No build step: `web/` is served as-is; iterate by editing files and
refreshing. The L1 viewer (React/TS/Vite per `docs/architecture.md`) remains
the next milestone and will reuse the design system proven here.

---

## The metaphor

- **mnemos** = _Mnemosyne_, titaness of memory; **vesmaro** = the new product
  name (owner decision 2026-09-15; rebrand wave tracked as RB-1/RB-2).
- **eyes** = the gaze that recollects — the UI motif is an **eye / iris /
  well**: the search focus is the pupil, memories surface from depth, and in
  idle the interface quietly "breathes".

---

## Quick links

- 📜 [Project Charter](docs/CHARTER.md) — original scope, decisions, stack
- 🗂️ [Decisions log](docs/decisions/) — ADRs (0004 = board pivot)
- 🎨 [Design system](docs/design-system.md) — tokens, motion budget
- 🧭 [Session 02 — task board v0](docs/sessions/SESSION-02-task-board-v0.md)

## Ecosystem

```text
mnemos        → the memory engine (storage, API, MCP, traces)   [../mnemos]
mnemos-mesh   → cross-store federation (laptop ⇄ cluster)
vesmaro-eyes  → the eye + the cockpit                             (this repo)
```