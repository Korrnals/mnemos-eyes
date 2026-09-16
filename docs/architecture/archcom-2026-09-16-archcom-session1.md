# ARCHCOM SESSION 2026-09-16 — vesmaro-eyes (совещание №1 по продукту)

- **Созвал:** владелец (`@abyss`)
- **Ведёт:** `@GCW: Tech Lead`
- **Участники:** Product Architect, Senior System Engineer, Senior Security
  Engineer, Senior Frontend Developer, Senior QA Engineer
- **Входные материалы:** 4 ревью (frontend/qa/architect/security), ADR
  0004–0008, ui-contract.md, трекер (23 задачи)

---

## Повестка

1. **ADR 0006** — судьба двух фронтендов (vanilla-борд vs React L1).
   Рекомендация TL: вариант C (freeze rule) — борд фризится на фичи,
   новые фичи только в L1; переносится доки/токены/API, DOM-код — нет.
2. **ADR 0007** — merged views: борд-агрегация vs mesh-федерация.
   Рекомендация TL: mesh = репликация, борд = query-time агрегация;
   при появлении query-API у mesh — борд-мерж становится адаптером.
   Плюс: зафиксировать протокол заголовков профиля-индекса.
3. **ADR 0008** — стек бэкенда борда: остаться на Python/FastAPI
   (обоснование в ADR), триггер пересмотра записан явно.
4. **ui-contract.md** — промоция до Accepted. Открытые пункты: SSE-схемы
   payload'ов, state-machine модального стека, a11y-требования, граница
   «enforced сервером / на совести клиента».
5. **ADR 0005 (harness identity)** — enforcement частичный (PATCH без
   валидации, BE-5): подтвердить ADR + требование тест-пина (QA-1).
6. **SEC-3** — граница доверия: решение владельца **Helm-chart + ingress**
   вместо hostNetwork (закрывает P1-находку «мутации без auth на
   host-порту»). Задача SRE-1 зарегистрирована.
7. **Роадмап** — каркас Phase 1–4 (стабилизация → L1 scaffold → mesh →
   конвергенция), TL-5.

## Предварительные позиции (Tech Lead)

- ADR 0006: **C + freeze rule** — борд = bug-fix only, фичи в L1.
- ADR 0007: **mesh = репликация, борд = query-агрегация** до появления
  query-API у mesh; API-поверхность борда не меняется.
- ADR 0008: **остаёмся на Python**; триггер пересмотра записан.
- ui-contract: **принять с доработкой** (SSE-схемы + a11y-раздел +
  state-machine) — доработку ведёт Frontend + Tech Writer.
- ADR 0005: **подтвердить**, enforcement достраивается (BE-5 + pin-тест QA-1).
- SRE-1 (Helm + ingress): **принять**, SEC-3 закрывается границей ingress.

## Вопросы владельцу (для решения на сессии)

1. Утвердить ADR 0006 вариант C + freeze rule?
2. Утвердить ADR 0008 (стек Python) с триггером пересмотра?
3. ui-contract: принять как v1 с доработкой SSE-схем и a11y-раздела?
4. Приоритет спринта 1: SEC-1/2 → BE-1/4 → FE-1 → QA-1 → SRE-1?
5. Роадмап Phase 1–4: утвердить?

## Решения сессии (комитет, 4 вердикта сведены TL)

1. **ADR 0006 — AMEND→принят (на ратификации владельца).** Вариант C +
   freeze rule. Поправки комитета:
   - bug-class формально определён (дефект против ui-contract/одобренного
     поведения v0.3–v0.9 = борд; любое новое действие = L1 backlog);
   - реестр freeze-исключений (однострочник в трекере, TL решает);
   - fixes-only включает a11y-фиксы и синк tokens.css;
   - **конвергенционный гейт**: «mesh query-API ∨ L1 parity по daily loop
     владельца — что раньше»; parity-чеклист ведёт TL; метрика фриза:
     100% feature-запросов → L1, net feature surface борда = 0;
   - в переносимый пакет добавлен **версионированный SSE-словарь**.
2. **ADR 0007 — AMEND→принят (на ратификации).** mesh = репликация, борд =
   query-агрегация; **монополия борд-мерж API до появления query-API у
   mesh** (L1 не строит собственный multi-probe); merge-UX прогрессивный
   (per-store timeout, partial results через SSE, fan-out bounded — BE-6);
   протокол заголовков профиля — **версионированный additive-only**
   (`profile-index:v1`), текст готовит Tech Writer; security-условия:
   URL-валидация и egress-политика — часть design merge-слоя; mTLS mesh —
   в threat-model MSH-1.
3. **ADR 0008 — AMEND→принят (на ратификации).** Python остаёмся;
   триггеры: >5 stores ИЛИ p95 merged-view >2 с; + четвёртый триггер
   (Architect): p95 >10 с на текущем масштабе после progressive-митигаций —
   сработавший триггер оценивается архкомом явно, никогда молча.
4. **SEC-3 — ACCEPT+AMEND (Security):** Helm+ingress закрывает только
   сетевой слой; **_guard_write fail-closed обязателен** (chart генерирует
   токен), NetworkPolicy, TLS. SRE-1 дополнена.
5. **Роадмап Phase 1–4 — ACCEPT с гейтами:** Gate 1→2 = OpenAPI-схемы +
   QA-1 контракт-тесты + SRE-1 закрыл SEC-3; Gate 2→3 = L1 потребляет
   /api/memories/*, второй мерж-слой = veto; Gate 3→4 = конвергенционный
   гейт ADR 0006. Deferrals: борд-фичи, Tauri, L2/L3, i18n.
6. **Спайк traefik (System Engineer) — блокер старта SRE-1:** repo
   фиксирует симптом (pod-IP 502), не root cause; спайк 1–2 ч до работ.

## Поручения по итогам

| # | Поручение | Ответственный |
| --- | --- | --- |
| 1 | OpenAPI-схемы board API + контракт-тесты (Gate 1→2) | TL + QA |
| 2 | Текст протокола заголовков профиля v1 + SSE-словарь (версионированные разделы ui-contract) | Tech Writer |
| 3 | BE-4 (1 строка + регресс-тест) — берёт System Engineer следующим спринтом | System Engineer |
| 4 | SRE: traefik-спайк до старта SRE-1; результат — в ADR 0004/SRE-1 | SRE/DevOps |
| 5 | Ратификация ADR 0006/0007/0008 владельцем | owner |