# SESSION: mnemos-eyes — Task Board v0 (vesmaro-eyes)

> **How to start this session:** tell the agent
> _"проинициализируй сессию из `docs/sessions/SESSION-02-task-board-v0.md`"_.
> Owner order (2026-09-15): board first, L1 viewer after.

- **Project:** `mnemos-eyes` (product name: **vesmaro-eyes**; repo rename
  lands with the rebrand wave — see task RB-1 on the board)
- **Session owner / orchestrator:** `@GCW: Tech Lead`
- **Status:** ✅ v0 shipped (2026-09-15) — live at `http://vesmaro.abyss.lab`
- **Decision record:** [ADR 0004](../decisions/0004-task-board-v0.md)

---

## 1. What shipped (v0)

- **Board SPA** (`web/`) — vanilla ES-modules, zero build step, obsidian-well
  design tokens from `docs/design-system.md` (teal iris, Lora scroll font,
  breathing iris, dark/light themes, reduced-motion support).
- **Board server** (`server/`) — FastAPI + SQLite WAL on a mounted volume,
  SSE fan-out (`/api/events`), narrow authenticated mnemos proxy
  (`/api/mnemos/*`), board CRUD + drag&drop moves.
- **Seed** (`server/seed.py`) — real program tasks: L1 viewer T1–T7,
  rebrand RB-1/RB-2, board itself TB-1; memory links are real mnemos ids.
- **Container** — `Containerfile` + `compose.yaml` (bind volume `./data`);
  image `ghcr.io/korrnals/vesmaro-eyes:0.1.3`.
- **Cluster deploy** — `deploy/k8s/vesmaro-eyes.yaml` + `deploy/apply.sh`;
  k3s namespace `kube-agents`, ingress `vesmaro.abyss.lab`, PVC
  `vesmaro-eyes-data` (local-path), hostNetwork pattern (traefik here can
  only reach hostNetwork endpoints — verified; see ADR 0004 §5).

## 2. Access

| What | Value |
| --- | --- |
| Board (cluster) | `http://vesmaro.abyss.lab` (add to `/etc/hosts` → `192.168.1.72`) |
| Board (local compose) | `http://localhost:8090` |
| Board API | `/api/board`, `/api/health`, `/api/events` (SSE) |
| mnemos link | in-cluster `http://agentsnode-mnemos:8787` with board bearer |

## 3. mnemos token management (server-to-server)

The board authenticates to mnemos with a dedicated `mnk_` token
(`totp_required=0`). It lives **only** in the k8s secret
`vesmaro-eyes-mnemos` (key `MNEMOS_TOKEN`) and is **not** in the manifest —
`kubectl apply` cannot wipe it.

```bash
# mint (once, or after revocation)
kubectl -n kube-agents exec deploy/agentsnode-mnemos -- \
  mnemos auth token create --name vesmaro-eyes-board --no-totp
# patch secret (token shown once)
kubectl -n kube-agents patch secret vesmaro-eyes-mnemos \
  --type merge -p '{"stringData":{"MNEMOS_TOKEN":"mnk_..."}}'
kubectl -n kube-agents rollout restart deploy/vesmaro-eyes
```

## 4. Verified facts (2026-09-15)

- Cluster mnemos (`agentsnode-mnemos:8787`) is a **separate store** (47
  memories: hermes/umbra). The vesmaro-program memories (86ce17e7, bc6a6504,
  9917a27d, 754f83a7) live in the **laptop store** — the board honestly
  shows "память не найдена (404)" for them until mnemos-mesh federation
  connects the stores.
- mnemos hybrid search vectorizes on CPU: ~4–7 s per query. Timeouts are
  tuned accordingly; `/api/health` reports honest latency.
- The cluster's traefik cannot reach pod-IP/ClusterIP backends (502 on
  mnemos ingress too). Working pattern = hostNetwork pods
  (`agentsnode-hermes-desktop`, now `vesmaro-eyes`).

## 5. Next steps

1. **Federation** — connect laptop ⇄ cluster mnemos stores (mnemos-mesh) so
   board memory links resolve cluster-side.
2. **L1 viewer** (T1–T7) — the board stays the operational cockpit.
3. Board v0.1 candidates: task create/edit UI in the drawer, column WIP
   limits, filter by agent/env/specialist, task→workflow graduation into a
   real mnemos memory.