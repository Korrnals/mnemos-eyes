# vesmaro-eyes

> _«Взгляд в себя — в свои мысли.»_ — the eyes gazing into the well of memory.

**vesmaro-eyes** is the operational cockpit and GUI companion for the
[**mnemos**](../mnemos) long-term memory engine. Where the engine is the
well (storage, search, MCP, provenance), **vesmaro-eyes is the eye that
looks into it** — and the cockpit that steers the work: a live task board
wired to real agent memory.

---

## What it does

- **Task board** — kanban columns mirroring the mnemos workflow state
  machine (`open → in-progress → blocked → resolved → done`), drag & drop,
  filters, SSE live updates across all open tabs.
- **Multi-server memory** — connect several mnemos engines (cluster,
  laptop, remote…) and browse them **individually or merged into memory
  clusters** (groups). Every pulse item and search hit carries a
  per-server provenance badge.
- **Task cards** — agents (harnesses), execution environments,
  specialists, linked memories rendered as scrolls straight from the live
  stores, history & checkpoints timeline, memory search and attach.
- **Tag drill-down** — click any tag to see every task and memory tied to
  it, across all connected servers.
- **Specialist cards** — composition indexed from GCW plugins
  (instructions / skills / rules / triggers), refine loop with
  @GCW: Agent Architect.
- **Notification center** — working (task lifecycle) and system (store
  ops) notifications, archive with project grouping.
- **Context menus** everywhere, honest status indicators, dark & light
  themes, reduced-motion support.

> Design lore: _obsidian well_ — teal iris gaze, Lora for memory content,
> the interface quietly breathes. See [`docs/design-system.md`](docs/design-system.md).

---

## Quick start

### Docker Compose (simplest)

```bash
# 1. clone
git clone https://github.com/Korrnals/mnemos-eyes.git && cd mnemos-eyes

# 2. point it at your mnemos server + token
export MNEMOS_URL=http://your-mnemos-host:8787
export MNEMOS_TOKEN=mnk_...   # a mnemos API token (totp_required=0)

# 3. up
docker compose up -d
# → http://localhost:8090
```

> Podman works the same (`podman-compose up -d`). The board database lives
> in `./data/` (bind mount) — survives rebuilds.

### Kubernetes (Helm chart — SRE-1, coming in 1.1)

The board is currently deployed in our cluster via manifests
([`deploy/k8s/vesmaro-eyes.yaml`](deploy/k8s/vesmaro-eyes.yaml) +
[`deploy/apply.sh`](deploy/apply.sh)). A full Helm chart is the next
ops milestone (**SRE-1** on the board) — tracked, not yet published.

Quick cluster install from the manifest:

```bash
kubectl -n <your-namespace> apply -f deploy/k8s/vesmaro-eyes.yaml
# then patch the mnemos token secret:
kubectl -n <ns> patch secret vesmaro-eyes-mnemos \
  --type merge -p '{"stringData":{"MNEMOS_TOKEN":"mnk_..."}}'
```

---

## Connecting memory servers

The board watches **one or several mnemos engines**, individually or
merged into **memory clusters** (groups). Servers are managed in the UI
(rail → Хранилища → «+»); the registry lives in the board DB.

Token resolution per server: `env:<VAR>` → `file:<path>` → `plain:<token>`
(plain is deprecated — prefer env/file). Tokens never leave the server
and are never returned by the API.

See [`docs/sessions/SESSION-02-task-board-v0.md`](docs/sessions/SESSION-02-task-board-v0.md)
for the full runbook (token minting, LAN bind, troubleshooting).

---

## Architecture

```text
Browser SPA (vanilla ES modules, design tokens from docs/design-system.md)
        │  fetch + SSE
        ▼
FastAPI board server  ──  SQLite WAL on a mounted volume (/data/board.db)
        │  narrow proxy /api/memories/* (bearer mnk_… stays server-side)
        ▼
one or more mnemos HTTP APIs (8787/8788 …)
```

- Zero build step — `web/` is served as-is; edit and refresh.
- Multi-store merge, profile cache and scope switching live server-side
  (`server/app.py`); the browser never sees credentials.
- Design decisions: [ADR 0004](docs/decisions/0004-task-board-v0.md)
  (board pivot), [ADR 0005](docs/decisions/0005-harness-identity.md)
  (harnesses ≠ specialists), [ADR 0006–0008](docs/decisions/) — frontends
  fate, merged views vs mesh, backend stack.

## API (quick reference)

| Endpoint | What |
| --- | --- |
| `GET /api/board` | full board (columns, tasks, counts) |
| `POST/PATCH/DELETE /api/tasks…` | task CRUD + `/move`, `/archive`, `/unarchive` |
| `GET /api/tasks/{id}/history` | unified timeline (board events + memory) |
| `GET /api/memories/servers` | declared servers + groups + health |
| `GET /api/memories/pulse?scope=…` | merged pulse (all / group / server) |
| `GET /api/mnemos/search?q=…&scope=…` | merged memory search |
| `GET /api/notifications` | notification center |
| `GET /api/events` | SSE stream (live updates) |

## Security posture

Designed as a **LAN-trust** tool: the board server is the only holder of
mnemos credentials; write-token gating (`VESMARO_BOARD_TOKEN`) and ingress
TLS are the pre-conditions for anything beyond a trusted LAN (see
[ADR 0004](docs/decisions/0004-task-board-v0.md) and the security review
findings in the tracker: SEC-1..4).

## Docs

- 📜 [Charter](docs/CHARTER.md) · 🗂 [ADR log](docs/decisions/) ·
  🎨 [Design system](docs/design-system.md) · 🧭 [UI contract](docs/architecture/ui-contract.md)
- 🪵 [Session 02 — board build log](docs/sessions/SESSION-02-task-board-v0.md)
- 🏛 [Archcom session 1 protocol](docs/architecture/archcom-2026-09-16-archcom-session1.md)

## Ecosystem

```text
mnemos        → the memory engine (storage, API, MCP, traces)
mnemos-mesh   → cross-store federation (Go transport)
vesmaro-eyes  → the eye + the cockpit                       (this repo)
```

---

_The metaphor: **mnemos** = Mnemosyne, titaness of memory; **vesmaro** =
the product name (rebrand wave in progress); **eyes** = the gaze that
recollects — the iris breathes while you work._