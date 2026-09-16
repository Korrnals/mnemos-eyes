# ADR 0004: Task board v0 — pivot of the first deliverable

- Status: **Accepted** (2026-09-15)
- Deciders: owner (`@abyss`), `@GCW: Tech Lead`
- Supersedes: none (amends CHARTER.md §2 scope ordering)

## Context

The original plan (SESSION-01) made the **L1 read-only memory viewer** the
first deliverable. On 2026-09-15 the owner re-ordered priorities: before the
full viewer, the project needs a **task board** — a single web page showing

- tasks and their statuses,
- the agent-executor attached to each task,
- the execution environment (ai-agent cluster, laptop, …),
- the specialists working on them,
- and the link of all of the above to **real mnemos/vesmaro memory**.

It must ship as a **container with a mounted volume**, deployed into the
`ai-agent` k3s cluster, giving permanent real-time access from the browser.

At the same time the product name changed: **mnemos → vesmaro** (owner
decision 2026-09-15, archcom rounds 3–4). This repo keeps the directory name
`mnemos-eyes` until the rebrand wave lands; the product is called
**vesmaro-eyes**.

## Decision

1. **Board v0 ships before L1.** It is a *fast probe*, not a replacement for
   the L1 stack: vanilla ES-module SPA (no build step) + FastAPI + SQLite
   (WAL) on a mounted volume + SSE live updates.
2. **Column names mirror the mnemos workflow state machine**
   (`open → in-progress → blocked → resolved → done`), keeping task and
   memory lifecycles compatible for the later "task = memory" graduation.
3. **The board server is the only mnemos client.** The browser never sees
   mnemos credentials; the server holds a `mnk_` bearer token
   (`totp_required=0`) minted for the board, and proxies a narrow read-mostly
   surface (`/tags`, `/search`, `/memories`, stats, pulse).
4. **Honest-memory principle.** When a linked memory id cannot be resolved
   (404 — e.g. the memory lives in the laptop store, not the cluster store),
   the UI says so explicitly instead of hiding the link.
5. **Deployment follows the working cluster pattern**: in the `abyss-ai-agent`
   k3s cluster, traefik can only reach **hostNetwork** endpoints (verified:
   pod-IP backends give 502). The board therefore runs `hostNetwork: true`
   behind `vesmaro.abyss.lab`, mirroring `agentsnode-hermes-desktop`.

   **Root cause (установлен read-only спайком 2026-09-16):** 502 на
   pod-IP/ClusterIP бэкендах вызывает не node firewall, а NetworkPolicy
   `agentsnode-policies` (namespace `kube-agents`, чарт 0.1.8), которая
   разрешает ingress к подам с лейблом `part-of=agentsnode` только из своего
   namespace и из LAN `192.168.1.0/24`; traefik (kube-system, pod-IP
   10.42.x) под оба правила не попадает и получает REJECT (k3s embedded
   kube-router netpol). hostNetwork-бэкенды работают потому, что
   netpol-энфорсмент привязан к veth пода и на hostNetwork-поды не
   распространяется; node firewall к проблеме отношения не имеет.
   Доказательная матрица: traefik→mnemos pod-IP = refused, traefik→pod без
   лейбла (omniroute) = OK, kube-agents-под→mnemos = 401 (транспорт жив),
   борд(hostNetwork, LAN)→mnemos = OK. **Целевой фикс (SRE-1):** добавить в
   политику ingress-правило `from: kube-system / app.kubernetes.io/name=traefik`,
   после чего борд переводится на Helm+ingress без hostNetwork; до правки
   политики миграция на ClusterIP воспроизведёт 502.
6. **Local dev** runs the same image via podman-compose with a project-dir
   bind mount (`./data:/data`) for fast iteration.

## Consequences

- L1 viewer tasks (T1–T7) remain the next milestone; the board already
  tracks them.
- The board is LAN-trust read/write (optional `VESMARO_BOARD_TOKEN` gates
  mutations); it must never be exposed beyond the lab boundary as-is.
- Memory links in the seed are real IDs from the laptop store; they render
  as "not found" in the cluster store until mnemos-mesh federation connects
  the two stores.
- Images are published to `ghcr.io/korrnals/vesmaro-eyes`.