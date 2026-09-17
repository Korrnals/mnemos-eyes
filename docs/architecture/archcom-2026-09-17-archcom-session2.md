# ARCHCOM SESSION 2026-09-17 — vesmaro-eyes (совещание №2: agent bridge / ARCH-2)

- **Созвал:** владелец (`@abyss`) — задача ARCH-2: архком + архитектура + контракты
- **Ведёт:** `@GCW: Tech Lead`
- **Участники:** Product Architect, Senior System Engineer, Senior Security
  Engineer, Agent Architect (Frontend не приглашён: UI-фаза — минимальный
  триггер, разбирается после решения комитета)
- **Входные материалы:** `arch2-agent-bridge-problem.md` (v0), ADR
  0005/0006/0008, WF-1 (`workflow-lifecycle-proposal.md`), `ui-contract.md`
  §11–12, протокол АРХКОМ-1

---

## Повестка

1. **Рамка freeze (записка §3):** эволюция борда (исключение) vs фича L1 vs
   отдельный компонент.
2. **Вариант механики (§4):** A outbox/claim / B bridge-сервис / C
   mnemos-centric / D гибрид.
3. **Контракты (§5):** assignment lifecycle, идентичность, поток чекпоинтов,
   SSE, security, лимиты.
4. **Открытые вопросы (§6):** №1–№6.

## Вердикты участников

| Участник | Вердикт | Суть поправок |
| --- | --- | --- |
| Product Architect | рамка **(i) ACCEPT с условиями**; вариант **A + D-канал** | формализованный тест границы freeze; бюджет реестра исключений ≤2; UI-дельта — только триггер, UI-10 = L1; launcher-контракт обязателен (поллер постит final по exit code); метрика успеха ≥80% цикла без ручного до-старта |
| Senior System Engineer | **ACCEPT A + D-канал** (AMEND narrow) | claim = CAS-UPDATE (структурная атомарность, двойной поллер безопасен); состояние `reporting` выброшено; `claim_token` как correctness-граница; полная схема + 8 эндпоинтов + маппинг колонок + фазы 0–4 + recovery-sweep поллера |
| Senior Security Engineer | **ACCEPT A′ = A + A1–A4 (обязательные)** | два токена с первого дня (ui/machine); поллер принимает только queued-assignment со snapshot spec; запуск через фиксированный стартер без shell-интерполяции; атомарный claim; сценарий инъекции через spec оценён как высокореалистичный (TOCTOU); identity = declared/unverified + триггеры T1–T3 |
| Agent Architect | **AMEND A** | поллер = детерминированный dispatcher-скрипт (не агент, не zcode-сессия); heartbeat — обязанность поллера (LLM не тикает); канонический assignment envelope (MODE-маркер); разведение доменов «assignment = запуск, не задача» (1:N); reports-дисциплина = конверт + один skill `assignment-execution`; массовые правки канона — REJECT |

## Решения сессии (4 вердикта сведены TL)

1. **Рамка — (i), эволюция борда, с формализованной границей.** Серверное
   изменение freeze-совместимо ⟺ (а) целиком выражено в переносимых
   контрактах (OpenAPI-схемы, версионированный SSE-словарь, контракт-тесты),
   без борд-специфичной UI-логики; (б) UI-дельта — bug-class или минимальный
   триггер над существующей сущностью, зарегистрированный в реестре.
   Новая секция/панель UI — всегда L1. **Бюджет реестра исключений: ≤2
   одновременно открытых**, каждое с классом/rationale/обслуживаемым
   контрактом/отзыв-условием, ретро на каждом архкоме. UI-дельта ARCH-2 =
   триггер (кнопка «взять в работу» + бейдж статуса assignment); UI-10 —
   L1 backlog (ARCH-2 даёт источник событий, не потребителя).
2. **Вариант A′ = outbox/claim + поллер на ноутбуке, с обязательными
   поправками A1–A4** (см. ADR 0009): два токена; snapshot spec при создании
   assignment; фиксированный стартер; атомарный claim. Канал чекпоинтов —
   как в D: reports API primary, mnemos-чекпоинты остаются знанием.
   B отвергнут на текущем масштабе (RCE-эндпоинт + двойное состояние);
   C отвергнут (mnemos — память, не брокер: нет ack/lease).
3. **Assignment lifecycle:** отдельная запись, 1:N на задачу, инвариант ≤1
   активного (409 при нарушении): `queued → claimed → running → done |
   failed | cancelled | expired`; состояние `reporting` исключено.
   Маппинг колонок: claim → `open→in-progress`; complete → `resolved`
   (приёмка `→done` — только владелец/TL, WF-1 §4.2); fail/expired →
   `blocked` + notification; cancel → `open`. Маппинг — только для
   последнего активного assignment задачи. `claim_token` — correctness-граница.
4. **Поллер — dispatcher-скрипт** (не агент): systemd timer/cron, опрос ~10 с
   с jitter, allowlist + маппинг (harness, specialist)→команда в локальном
   конфиге, heartbeat 60 с от поллера, супервизия детей (exit 0 → complete с
   final-отчётом, даже если агент молчал; ≠0 → fail с reason),
   flock-singleton, recovery-sweep на старте. Поллер — часть харнеса
   (ADR 0005), не роль: не появляется в `agents[]`/`specialists[]`.
5. **Assignment envelope** — канонический формат промпта запуска (надмножество
   skill `task-assignment`), маркер `MODE: assignment-run` — единственный
   легитимный признак assignment-запуска. Assignment — единственная точка,
   где данные борда по контракту становятся инструкцией (инверсия правила
   §12 ui-contract), поэтому гейт: создание только ui-token + snapshot +
   действие владельца.
6. **Разведение доменов:** задача = mnemos-запись `task:queue` (мастер;
   gcw-task-manager не меняется, mnemos-first); assignment = запуск на борде
   (ссылки + execution-метаданные + spec snapshot с hash — иммутабельный
   вид исполнения, не мастер-копия). Запрещены: мастер-поля goal/AC в
   assignment; задачи борда без mnemos-записи.
7. **Reports-дисциплина двухслойно:** v0 — блок REPORTS в конверте; канонически
   — один новый GCW skill `assignment-execution`. Массовая правка канона
   (109 skills / 559 записей) — REJECT: канон product-agnostic.
8. **Identity:** declared/unverified на HTTP-слое, UI помечает
   «reported by X (unverified)». Два токена (ui/machine) — с первого дня.
   Per-harness — по триггерам T1 (второй харнес-писатель) / T2 (автозапуск
   без поштучного контроля — v0 уже кандидат, поэтому A1 немедленно) /
   T3 (workflow решает по agent-строкам).
9. **Security-контракт:** создание assignment — только ui-token (10/60 с);
   права на spec — owner или assignee своей задачи (расширение WF-1 §4.2);
   snapshot cap 16K + hash в аудите; аудит-лог (канал токена, declared
   identity, snapshot hash, факт локального запуска); `assignment.*`
   additive-only + закрытие gap `kind:"report"` в той же фазе; автозапуск —
   в непривилегированной сессии.
10. **Reaper — фаза 3** (поля `heartbeat_at`/`claimed_at` — в схеме с фазы 1):
    claimed без start > 10 мин или running без heartbeat > 30 мин → expired →
    задача blocked + notification + SSE. **Метрика успеха:** ≥80% запусков из
    UI проходят queued → running → final report без ручного до-старта
    владельцем; ретро через 2 недели. Зависший `queued` видим (возраст).

## Разрешённые расхождения комитетa

| Расхождение | Решение | Основание |
| --- | --- | --- |
| TL «один bearer v0» vs Security «два токена с первого дня» | **два токена** | дёшево (второй env var), закрывает инъекцию через create-assignment; ARCH-2 v0 — кандидат триггера T2; TL принял поправку |
| SE/AA «поллер тянет живой spec при claim» vs Security «snapshot при создании» | **snapshot** | закрывает TOCTOU (правка spec после просмотра до claim); конфликт с «assignment без мастер-копии» снят: snapshot = иммутабельный execution view + hash, мастер остаётся в task.spec/mnemos |
| Security «reaper по intermediate-keep-alive» vs SE+AA «heartbeat от поллера» | **heartbeat** | LLM-агент не имеет таймера; intermediate — семантический канал вех, heartbeat — инфраструктурный |

## Вопросы владельцу (ратификация)

1. Утвердить ADR 0009 (вариант A′, рамка (i) с тестом границы и бюджетом
   реестра ≤2)?
2. Таймауты reaper: claimed 10 мин / heartbeat 30 мин — подтвердить или
   изменить?
3. Инвариант «≤1 активный assignment на задачу» — подтвердить?
4. Разделение токенов (ui/machine) с первого дня — подтвердить деплой-изменение
   (второй env в chart + конфиг поллера)?
5. Запись в реестр freeze-исключений: ARCH-2 UI-триггер (кнопка + бейдж).

## Поручения по итогам

| # | Поручение | Ответственный | Фаза |
| --- | --- | --- | --- |
| 1 | Синк SSE-словаря §11 с кодом: `kind:"report"` + словарь `assignment.*` | TL / Tech Writer | 0 — сразу |
| 2 | Сервер: таблица `task_assignments` + 8 роутов + SSE + лимитеры + тесты | Senior System Engineer | 1 |
| 3 | Поллер `scripts/assignment_poller.py` + конфиг + envelope-рендер | Senior System Engineer (+ SRE: systemd unit) | 2 |
| 4 | Reaper in-process + состояние expired + notification о застрявшем queued | Senior System Engineer | 3 |
| 5 | UI-триггер: кнопка «взять в работу» (specialists[] + harness) + бейдж | Senior Frontend Developer | 4 |
| 6 | Skill `assignment-execution` в каноническом GCW-репо | Agent Architect | после ратификации |
| 7 | Ратификация ADR 0009 + ответы на вопросы 1–5 | owner | — |
