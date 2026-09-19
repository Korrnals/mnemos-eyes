# ARCHCOM SESSION 2026-09-19 — vesmaro-eyes (совещание №4: мульти-исполнительский agent-bridge)

- **Созвал:** владелец (`@abyss`) — уточнение вектора: бридж не привязан к одному
  устройству; харнесы из разных источников (локальные + удалённые); назначение
  конкретному агенту ИЛИ по умолчанию; трекинг работы — отдельный раздел
  vesmaro-eyes. По предложению владельца в состав добавлены Дизайнер и
  Frontend-инженер.
- **Ведёт:** `@GCW: Tech Lead`
- **Участники:** Product Architect, Senior System Engineer, Senior Security
  Engineer, Agent Architect, UI/UX Designer, Senior Frontend Developer
- **Входные материалы:** ADR 0009 (+аддендум 2026-09-19), протокол АРХКОМ-2,
  mesh `ROADMAP-v2` (R1–R5, W4), mesh ADR-0018 (Q2/Q3), дизайн-концепт
  АРХКОМ-3, ui-contract §11, north-star «Живой офис» (mnemos `185a4bb4`)
- **Параллельно шли реализации:** ARCH-4 (Ф1 сервер, worktree
  `feat/ab-phase1-server`), ARCH-6 (chart токены, `feat/ab-tokens`)

---

## Повестка

1. Реестр исполнителей как сущность (schema/API/presence).
2. Default-executor: семантика, механика, UX.
3. Рамка «один lifecycle — много транспортов» + стык с R4/W4 меша.
4. Identity/токены в мульти-харнесном контуре (T1 сработал по плану).
5. Раздел «Агенты» в React: скоуп, волны, north-star «Живой офис».

## Вердикты участников

| Участник | Вердикт | Ядро |
| --- | --- | --- |
| Product Architect | рамка ACCEPT + Amendment 2 (paste-ready) | «один lifecycle — много транспортов»; laptop не просачивается в идентичность/API; реестр = производный вид до T1, first-class при T1 (один триггер — два следствия: per-harness токены + реестр); default = prefill, не автозапуск; north-star-дисциплина: персонификация гейтована T1–T3, никакого доверительного театра |
| Senior System Engineer | реестр ACCEPT (таблица + 5 эндпоинтов + 5 SSE) | presence вычисляемое (TTL), offline-свипер не мутирует строки; дисциплина двух часов (reaper↔presence); executor_secret hash+одноразовый показ; цепочка дефолта на GET без хранения, enforcement только explicit; R4: transport-метка, mesh = провод, executor_token обязателен на mesh-ноге; в Ф1 — только 2 DEFAULT ''-столбца + doc-резерв |
| Senior Security Engineer | ACCEPT с A1′-уровнем | T1 сработал по плану → per-executor токены при мульти-харнесной фазе обязательны; реестр = identity-гейт с owner-аппрувом (pending→approved, capabilities декларирует владелец); лестница L0/L1/L2 к ADR-0018 Q3-B; default = T2: гейты (ui-token only, approved+liveness, remote ineligible до R4, kill-switch); аудит +6 |
| Agent Architect | онтология ACCEPT | третья сущность executor-instance (claimed_by → FK); удалённый харнес = тот же поллер, egress через меш (reuse `Subscribe`); envelope environment-neutral (эндпоинты/токены — конфиг поллера, не промпт); default = пара (specialist, harness), не инстанс; под кросс-адвайс — денормализованные `topics` (единственное новое поле) + запрет agent→agent write |
| UI/UX Designer | спека раздела (см. `docs/design/2026-09-19-agents-section-spec.md`) | «исполнитель» как термин, «агент» в строках раздела не используется; `/agents` → алиас `/agents/execution`; полоса присутствия (зародыш офиса) + dense-список + лента UI-10; два часа визуализированы; «никакой тихой подмены»; 8 принципов фундамента «Живого офиса» |
| Senior Frontend Developer | расщепление волн, ~0.8–1.1 объёма | хвост Ф2: бейдж + вкладка «Исполнение» (read-only); Ф3 одним куском с ARCH-8: страница, лента, Sheet, ui-token; реестр capability-gated; claim_token/spec_snapshot исключить из REST-представления UI; запрет per-heartbeat SSE (локальный тикер 1 Гц); Idempotency-Key на create |

## Разрешённые расхождения

| Расхождение | Решение |
| --- | --- |
| Реестр: производный вид (PA) vs сущность сразу (SE/Sec/FE) | **Производный вид до T1; ARCH-9 (таблица+эндпоинты+апрув) материализует реестр, обязателен до мульти-харнесного rollout.** Ф1/Ф2 не блокируются; UI capability-gated |
| Enrollment: одноразовый код (Sec) vs machine-token регистрация (SE) | **Регистрация по machine-token создаёт `pending`; активирует владелец (ui-token).** Одноразовый enrollment-код — Enhancement, привязан к QR-волне (CV-PRE). Executor_secret минтит сервер — chart не хранит map токенов, машинный токен = бутстрап регистрации (снимает поправку Sec о list/map-форме chart) |
| Default scope: цепочка проект+глобальный (PA) vs один глобальный (Designer) | **v1 UI: один глобальный дефолт + один fallback** (`/system/settings`); цепочка разрешения — explicit → specialist → task.specialists → project → global (PA), вычисляется на GET (SE), `board_meta` с полем scope зарезервирован; проектный override — при ≥2 исполнителях с разной специализацией |
| Presence TTL: 300 с (SE черновой) vs 2/10 мин (Designer) | **online ≤ 2 мин / stale 2–10 мин / offline > 10 мин; константы документирует сервер** (meta/docs), UI не хардкодит; уточнение — при реализации ARCH-9 |
| SSE executor.*: 5 кейндов (SE) vs payload с prev_state (Designer) | **Кейнды SE, payload Designer**: `{executor, prev_state, state, last_seen_at}`; эмит только при смене состояния; per-heartbeat события запрещены |

## Решения сессии

Сводный результат — **ADR 0009 Amendment 2** (внесён коммитом этой сессии):
мульти-исполнительская рамка (транспорт-инвариантность, третья сущность,
токен-лестница L0–L2, default-гейты, два часа, SSE/аудит-добавления, UI-рамка
расщепления Ф2/Ф3). Спека раздела — отдельный дизайн-док.

Ключевые рамки:

1. **Один lifecycle — много транспортов.** Поллер ноутбука = транспорт №1,
   не модель исполнителя; R4/W4 меша = транспорт №2+ (только провод);
   state machine / CAS / ui-machine токены / snapshot / reaper — едины и
   мешу неприкосновенны.
2. **Executor-instance — третья сущность** (specialist ≠ harness ≠ executor):
   таблица `executors`, presence вычисляемое, атрибуция `claimed_by_executor`;
   assignment номинирует (specialist, harness) + опциональный пиннинг
   `executor_id`; enforcement explicit-назначений — с первого дня реестра.
3. **Токен-лестница**: L0 — борд минтует executor_secret (hash, одноразовый
   показ); Ф1-сплит = L0-bootstrap (executor #1 «laptop-poller»);
   L1 — mesh несёт токен opaque-payload'ем; L2 — mnemos как минт-авторитет,
   отдельным решением. Первый удалённый харнес = T1 (per-executor токены
   обязательны к этому моменту).
4. **Default = разрешение, не запуск**: цепочка вычисляется на GET; автодиспетчер —
   T2-гейт; гейты Security (ui-token, approved+liveness, remote ineligible до R4).
5. **Дисциплина двух часов**: reaper — только assignment-часы; presence — только
   executor-часы; никогда не схлопываются.
6. **Раздел «Агенты»**: Ф2-хвост (бейдж+вкладка) → Ф3 (страница+лента+Sheet
   вместе с ARCH-8); реестр capability-gated; спека — дизайн-док; north-star
   «Живой офис» — фундамент без преждевременного строительства; персонификация
   гейтована T1–T3.
7. **Кросс-адвайс-задел**: `topics`-денормализация в assignment (metadata),
   стабильные id в событиях, запрет agent→agent write в обход борда.

## Поручения по итогам

| # | Поручение | Ответственный | Состояние |
| --- | --- | --- | --- |
| 1 | ADR 0009 Amendment 2 (сводный) | TL | этой сессией, коммит ниже |
| 2 | Спека раздела «Агенты» → docs/design | Designer (вердикт) → TL (фиксация) | этой сессией |
| 3 | Ф1-включения (2 столбца + claim executor_id + §11-резерв) | SE → агент ARCH-4 | отправлено в ARCH-4 до мержа |
| 4 | ARCH-9: реестр исполнителей (таблица+эндпоинты+presence+цепочка+board_meta-дефолты; gates Security) | Senior System Engineer (+review Security) | задача создана, после мержа Ф1 |
| 5 | W4 position paper (mesh-репо): adds/must-not-touch/shape поллера/транспорт-агностик тест/стык реестра | Product Architect + SE | задача создана (project mnemos-mesh) |
| 6 | ARCH-8: расщепить на Ф2-хвост + Ф3 по вердикту FE, источник — дизайн-спека | Frontend | задача обновлена |
| 7 | Ратификация: ADR 0009 (тело + Amendment 2) — владельцем | owner | открыто |
| 8 | Skill `assignment-execution` (+ executor-awareness по AA) | Agent Architect | после ратификации, к Ф2 |
