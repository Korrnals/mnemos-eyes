# Decisions log

ADR-style records of significant decisions for `mnemos-eyes`. Each file is
one decision. The authoritative summary lives in [`../CHARTER.md`](../CHARTER.md)
§3; these files capture the _context and consequences_ behind each call.

| ADR | Title | Status |
| --- | --- | --- |
| [0001](0001-web-first-tauri-later.md) | Web-first SPA, Tauri 2.0 native shell later | Accepted |
| [0002](0002-data-layer-abstraction.md) | Isolated data-layer (`MemoryGateway`) | Accepted |
| [0003](0003-accent-typography-clusters.md) | Teal accent, Lora content font, clusters → L2 | Accepted |
| [0004](0004-task-board-v0.md) | Task board v0 — pivot of the first deliverable | Accepted |
| [0005](0005-harness-identity.md) | Harness identity — agents vs specialists | Accepted |
| [0006](0006-two-frontends-fate.md) | Fate of the two frontends (vanilla board vs React L1) | Accepted by committee — pending owner ratification |
| [0007](0007-merged-views-vs-mesh.md) | Merged views — board aggregation vs mnemos-mesh federation | Accepted by committee — pending owner ratification |
| [0008](0008-backend-stack.md) | Board backend stack — stay on Python/FastAPI (for now) | Accepted by committee — pending owner ratification |
| [0009](0009-agent-bridge-assignments.md) | Agent bridge — assignment queue on the board (variant A′) | Accepted |
| [0013](0013-scheduler-hooks-automation.md) | Scheduler & hooks — launch automation as a separate domain (SCHED-1, variant C) | Accepted |
| [0014](0014-owner-session-auth.md) | Owner session — server-verified login + stateless cookie (one login per browser, 6h idle TTL) | Accepted |
| [0010](0010-task-aggregation-engine.md) | Движок агрегации задач — два класса задач, mirror-таблица `task_inbox` | Accepted |
| [0011](0011-ui-convergence.md) | Конвергенция фронтендов в единое web-приложение (strangler Ф0–Ф4) | Accepted by committee — pending owner ratification |
| [0012](0012-qr-pairing-device-tokens.md) | QR-пейринг и device-токены (LAN-direct, `mnd_`) | Accepted by committee — pending owner ratification |
| [0015](0015-documentation-section.md) | Раздел документации (/docs) — markdown в бандле UI, без бэкенда | Accepted by committee |
| [0016](0016-docs-upstream-import.md) | Импорт документации апстрим-проектов в /docs — sync-пайплайн на зафиксированном SHA, хабы проектов, билингво | Accepted by committee — pending owner ratification |
| [0017](0017-docs-rendering-parity.md) | Паритет рендера документации с GitHub — mermaid, ограниченный raw HTML, баннеры | Accepted by committee — pending owner ratification |
| [0018](0018-connectivity-installation-release-discipline.md) | External-agent connectivity, installation trust anchor and release discipline | Accepted |
