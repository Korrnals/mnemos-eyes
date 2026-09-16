# vesmaro-eyes — Project Charter

> Авторитетная запись согласованных решений по GUI-компаньону mnemos.
> Владелец: `@GCW: Tech Lead`. Дизайн-система — `@GCW: Senior Frontend Developer`.
> Продукт: **vesmaro-eyes**. Репозиторий: **mnemos-eyes**
> (`github.com/Korrnals/mnemos-eyes`; запланирован переезд в org `vesmaro` —
> задача RB-1 на борде, статус blocked).
> Status: **борд v1.0.0 задеплоен** и живёт на `http://vesmaro.abyss.lab`;
> релиз `ghcr.io/korrnals/vesmaro-eyes:1.0.0` в ghcr. Это не design phase.
> Следующий этап разработки — **L1 viewer** (см. §7: Phase 2 «L1 scaffold»
> после закрытия Phase 1 «стабилизация»).

---

## 1. Purpose & vision

`vesmaro-eyes` — **графический интерфейс и операционный кокпит движка
долгосрочной памяти mnemos**. Он позволяет человеку _заглянуть в_ память,
которую накапливают агенты: искать, читать, понимать происхождение каждого
факта и наблюдать память вживую.

Design north star: **«взгляд в себя — в свои мысли»**. Спокойно, красиво,
lore-driven, никогда не отвлекает.

---

## 2. Scope

### Живёт сейчас: task board (v1.0.0)

Первым деливераблом стал **борд задач** (pivot — [ADR 0004](decisions/0004-task-board-v0.md)):
канбан, зеркалящий state machine mnemos (`open → in-progress → blocked →
resolved → done`), карточки с harness/specialist-провенансом, мульти-серверная
память (по отдельности или merged в кластеры), SSE live updates. Задеплоен
в кластер (`http://vesmaro.abyss.lab`). По [ADR 0006](decisions/0006-two-frontends-fate.md)
(принят комитетом, на ратификации) борд заморожен по фичам: только bug-fix
и a11y-фиксы, новые фичи — в L1.

### MVP = **L1 — Read-only Viewer**

Следующий релиз — **viewer**, а не редактор. Он должен уметь:

- **Search** памяти: full-text (FTS5) + semantic (vector), единая строка поиска.
- **Browse** записей памяти: контент, теги, provenance/source, confidence, таймстемпы.
- **Inspect тегов** и tag-контракта.
- **View status / health**: счётчики, здоровье стора, состояние пайплайна.
- **Cluster graph**: визуализация связанных воспоминаний.
- **A2A sessions**: список и разбор agent-to-agent сессий.
- **Traces**: просмотр захваченных трейсов / состояния компакции.

### Out of MVP (later milestones)

- **L2 — Curator**: правка / merge / удаление памяти, управление тегами,
  одобрение вывода пайплайна.
- **L3 — Operator**: запуск пайплайна, политики/расписания, DLQ, ingest.
- Отложено решением архкома (2026-09-16): борд-фичи, Tauri, L2/L3, i18n.

Роадмап L2/L3 принадлежит совместно с `@GCW: Product Architect`, если скоуп растёт.

---

## 3. Decisions (agreed)

| # | Decision | Rationale |
| --- | --- | --- |
| **D1** | **Отдельный репозиторий** `mnemos-eyes` (`github.com/Korrnals/mnemos-eyes`), sibling к `mnemos`. Переезд в org `vesmaro` запланирован (RB-1, blocked — план, не свершившийся факт). | Чистое разделение ответственности; UI эволюционирует независимо от движка. |
| **D2** | **Имя продукта** = `vesmaro-eyes`; имя репозитория = `mnemos-eyes` (переименование — в волне ребрендинга, RB-1). Внутренний lore может ссылаться на _Mnemosyne / Anamnesis_. | Связность экосистемы с `mnemos` важнее отдельного имени. |
| **D3** | **MVP = L1 read-only viewer.** | Быстрое доказательство ценности; минимальный риск; никаких деструктивных операций в v1. |
| **D4** | **Стек L1 = React + TypeScript + Vite + TanStack Query + Tailwind/shadcn.** | Зрелый, быстрый, гибкий в дизайне, большой пул талантов и инструментария. |
| **D5** | **Web-first сейчас, Tauri 2.0 native shell позже** (отложено архкомом). | Web SPA выходит быстрее; Tauri добавляет desktop + mobile + local-first, переиспользуя ~90% фронтенда. |
| **D6** | **Изолированная абстракция слоя данных** (`MemoryGateway` с `HttpAdapter` и будущим `TauriAdapter`). | Снимает lock-in «web vs native»; один и тот же UI-код в обоих режимах. |
| **D7** | **Типы генерируются автоматически** из `/openapi.json` mnemos через `openapi-typescript`. | Единый источник истины; никакого ручного дрифта между API и UI-типами. |
| **D8** | **Auth обязателен; 2FA (TOTP) для remote/mobile-доступа.** | См. §5 — локальный desktop опирается на ОС + опциональный app-lock; 2FA оправдана, как только память доступна по сети. |
| **D9** | **Дизайн lore-driven** (глаз / ирис / колодец, «взгляд в себя»), красивый, но не отвлекающий, с лёгкой «живой» анимацией. | Дифференциатор; совпадает с метафорой памяти. |

Журнал решений: [`docs/decisions/`](decisions/) — ADR 0001–0008.
Статусы честно: ADR 0004 (board pivot), 0005 (harness identity) — **Accepted**;
ADR 0006 (судьба двух фронтендов), 0007 (merged views vs mesh), 0008 (стек
бэкенда борда) — **приняты комитетом, ожидают ратификации владельца**
(поручение №5 архкома 2026-09-16).

---

## 4. Architecture (high level)

Текущее состояние (борд v1.0.0): vanilla ES-modules SPA (`web/`, zero build)
+ FastAPI board server (`server/`, SQLite WAL на примонтированном томе) +
узкий серверный прокси к одному или нескольким mnemos API — см. README,
раздел Architecture.

Целевая архитектура L1 (React):

```text
┌─────────────────────────────────────────────┐
│  React + TS UI  (presentation, lore, motion) │
└───────────────────┬─────────────────────────┘
                    │  calls
┌───────────────────▼─────────────────────────┐
│  MemoryGateway  (interface — clean boundary) │
└───────┬───────────────────────────┬─────────┘
        │ web mode                  │ desktop / mobile
┌───────▼─────────┐         ┌───────▼──────────────┐
│  HttpAdapter    │         │  TauriAdapter        │
│  → mnemos API   │         │  → Rust → SQLite      │
└─────────────────┘         └──────────────────────┘
```

- **Сначала:** только `HttpAdapter` → mnemos HTTP API.
- **Позже:** добавить `TauriAdapter` → Rust core читает стор in-process
  (API не выставляется в сеть).

Детальная фронтенд-архитектура и структура папок — у
`@GCW: Senior Frontend Developer` (см. [`docs/architecture.md`](architecture.md)
и [`docs/architecture/ui-contract.md`](architecture/ui-contract.md)).

---

## 5. Auth & security posture

- **Весь доступ аутентифицирован.** Никакого анонимного чтения, даже на loopback.
- **2FA (TOTP)** обязательна для **remote/mobile-доступа** (телефон → домашний mnemos).
- **Локальный desktop (Tauri)** может опираться на защиту ОС + опциональный in-app lock.
- Текущая поза борда — **LAN-trust** ([ADR 0004](decisions/0004-task-board-v0.md)):
  борд-сервер — единственный держатель mnemos-токенов; находки ревью SEC-1..4
  в трекере; SEC-3 закрывается переходом на Helm + ingress вместо hostNetwork
  (задача SRE-1), write-guard — fail-closed.
- **Окончательный threat model** — у `@GCW: Senior Security Engineer`
  до написания любого auth-кода.

---

## 6. Prerequisites on `mnemos` (backend work)

Трекаются отдельными PR в репо `mnemos`, владельцы —
`@GCW: Senior System Engineer` и `@GCW: Senior Security Engineer`:

1. **CORS** (конфигурируемый allow-list) — нужен для прямого браузерного
   доступа к mnemos API из SPA L1.
2. **AuthN/AuthZ** (токены `mnk_…`; TOTP 2FA для remote) — живёт в mnemos;
   борд ходит под выделенным токеном (`totp_required=0`), секрет — только
   в k8s secret.
3. **`/openapi.json`** стабильный и документированный (FastAPI отдаёт) —
   кормит кодогенерацию `openapi-typescript`; OpenAPI-схемы board API —
   часть Gate 1→2 (§7).
4. (Phase Tauri) **read API surface**, достаточный для `TauriAdapter`,
   читающего SQLite напрямую.

> Борд обходит CORS серверным прокси (bearer остаётся server-side) — поэтому
> CORS не блокирует текущий деплой, но остаётся условием прямого доступа
> браузерного L1 к mnemos API.

---

## 7. Roadmap

Каркас Phase 1–4 — решение №5 архкома от 2026-09-16
([протокол](architecture/archcom-2026-09-16-archcom-session1.md)):
стабилизация → L1 scaffold → mesh → конвергенция.

| Phase | Deliverable | Gate на вход |
| --- | --- | --- |
| **Phase 1 — стабилизация** (текущая: ветка `feat/sprint-1-stabilization`) | Приоритет спринта: SEC-1/2 → BE-1/4 → FE-1 → QA-1 → SRE-1 | — |
| **Phase 2 — L1 scaffold** | Каркас L1 viewer (React+TS+Vite); OpenAPI-схемы board API + контракт-тесты (TL + QA) | **Gate 1→2** = OpenAPI-схемы + QA-1 контракт-тесты + SRE-1 закрыл SEC-3 |
| **Phase 3 — mesh** | Федерация mnemos-mesh (MSH-1); борд-мерж остаётся query-агрегацией, монополия борд-мерж API до появления query-API у mesh (ADR 0007) | **Gate 2→3** = L1 потребляет `/api/memories/*`; второй мерж-слой = veto |
| **Phase 4 — конвергенция** | Сведение двух фронтендов по конвергенционному гейту ADR 0006 | **Gate 3→4** = «mesh query-API ∨ L1 parity по daily loop владельца — что раньше» |

Deferrals (архком): борд-фичи, Tauri, L2/L3, i18n.

---

## 8. Reference: prior art

Старый прототип `ai-brain` (`../ai-brain/src/ai_brain/web/`) — **только
референс**, не кодовая база для переиспользования. Полезные сигналы:

- **Information architecture**: dashboard, memories, raw, knowledge, tags,
  watcher, graph, jobs, add — карта фич для выборки в L1/L2/L3.
- **Design tokens**: GitHub-style система CSS-переменных dark/light
  (стартовая точка, не финальная lore-driven эстетика).
- **i18n**: паттерн переключателя RU/EN.

Код на vanilla JS **не портируем**; стартуем чисто на согласованном стеке.
