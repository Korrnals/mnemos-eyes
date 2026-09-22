# ADR 0014: Сессия владельца — серверная верификация входа + stateless-cookie (один вход на браузер)

- Status: **Proposed** (комитет 2026-09-22, условно —
  **ждёт ратификации владельца**)
- Deciders: АРХКОМ — Product Architect, Senior Security Engineer,
  Senior System Engineer; председатель и инженерный владелец решения —
  `@GCW: Tech Lead`; Product Analyst не привлекался (требование владельца
  процитировано дословно и является прямым продуктовым входом);
  ратификация — владелец
- Related: ADR 0009 (токен-сплит ui/machine — ратифицирован, не
  пересматривается), ADR 0012 (device-токены `mnd_` — header-леги,
  cookie их не открывает), протокол комитета
  (`~/.gcw/architectural-committee/2026-09-22-owner-session-auth.md`),
  контракт (`~/.gcw/architectural-committee/2026-09-22-owner-session-auth-contract.md`)

## Context

Инцидент владельца (2026-09-22, дословно): «Когда я авторизовался — я НЕ ХОЧУ
авторизовываться ЕЩЁ где-либо в текущем интерфейсе! Это БЕССМЫСЛЕННО!»
Сценарий: вход показал успех, первая же мутация выбросила на повторный вход,
повторная вставка той же строки не принималась.

Корни подтверждены по коду (main 1.13.1):

1. **Ложный успех входа.** `uiTokenGate.submitToken()`
   (`viewer/src/features/ui-token/uiTokenGate.ts:109`) сохраняет любую
   непустую строку без серверной проверки и эмитит `loginStored` — отказ
   отложен до первой мутации.
2. **Сессия = вкладка.** Токен живёт в sessionStorage — каждая новая вкладка
   требует вход заново.
3. **Путаница двух секретов.** Владелец вставил board-токен вместо ui
   (секреты `vesmaro-eyes-board-token` и `vesmaro-eyes-ui-token` похожи
   именами) — интерфейс не помог различить.

Требование владельца декомпозируется в три проверяемых: вход проверяется
сервером у порога; один вход действует на все вкладки рабочей сессии
браузера; ни один экран, кроме окна входа, не требует копировать секрет.

Сплит токен-классов ADR 0009 ратифицирован и **не пересматривается** —
комитет решает только владельческую сессию поверх сплита. Отсюда рамка
«маршрут у порога + одна сессия на браузер»: Ф1 (серверная верификация) и
Ф2 (сессия шире вкладки) одной волной, Ф3 («одно лицо» документов) той же
волной.

## Decision

Мы строим вход владельца по принципу «маршрут у порога + одна сессия на
браузер»: `POST /api/auth/ui-token` проверяет токен сервером, принятый токен
живёт в stateless-cookie `vesmaro_ui` — один вход на браузер, все вкладки,
никаких повторных вставок. Два коммита, один деплой.

### 1. Ф1 — verify у порога: `POST /api/auth/ui-token`

- Контракт: `UiTokenVerifyIn { token: str (1..512) }`,
  `UiTokenVerifyOut { ok: bool, token_class: "ui" | "legacy" }` (`legacy` =
  single-token режим, ui обслуживается board-токеном — честный
  `_token_classes()`, `server/app.py:4098`).
- Сравнение: `hmac.compare_digest` тела против `_token_classes()["ui"]`;
  401 при несовпадении с класс-осведомлённым детейлом (аналог
  `_token_mismatch_detail`, `app.py:4146`); 503 fail-closed при пустом
  классе.
- Лимитеры плоские, по паттерну `_pairing_ip_limiter` (`app.py:4292`):
  per-IP 10/60s + global 60/60s; ключ — реальный client IP (`--proxy-headers`
  + RUNBOOK §10.1 уже работают).
- Инварианты: токен не эхоится в ответе и не логируется (даже усечённо);
  только POST; тело ≤512 символов; без CORS-заголовков. Энтропия ui-токена —
  главная защита (warning в лог при `VESMARO_UI_TOKEN` < 20 символов —
  открытый вопрос №2 контракта, одна строка в Ф1).
- Место: `server/app.py`, рядом с pairing-блоком; роутов `/api/auth/*` на
  сервере сегодня нет — пространство пустое (конфликт имён с TOTP-контрактом
  устранён выбором имени, см. Alternatives rejected).

### 2. Ф2 — stateless-cookie `vesmaro_ui`

- Ставится успехом verify: `Set-Cookie: vesmaro_ui=<token>; HttpOnly;
  SameSite=Strict; Path=/; Secure` — **Secure по схеме запроса** (деплой —
  plain http 8090, `compose.yaml:24-25`; безусловный флаг дал бы молчаливую
  петлю на http). Session-cookie (без Max-Age); `Max-Age ≤ 24h` — отдельное
  решение владельца.
- Снимается серверным `DELETE /api/auth/ui-token` (без guard):
  `Set-Cookie: vesmaro_ui=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/`
  + 204. HttpOnly-cookie из JS нечитаема и неудаляема — клиентского logout
  не существует.
- Чтение «cookie ИЛИ Authorization-header» — врезка **внутри**
  `_guard_write`/`_guard_ui_write` (`app.py:4112`/`4181`), не отдельным
  middleware: при отсутствии заголовка и настроенном ui-классе проверяется
  `_cookie_ui_ok(request)` (compare_digest значения cookie против
  ui-токена). Fail-closed порядок 503→401 сохраняется байт-в-байт;
  `_guard_machine_write` (`app.py:4213`) не трогается.

  ```
  запрос → Authorization присутствует?
    ├── да → только header-нога (401 с cross-class детейлом — как сегодня)
    └── нет → ui-класс настроен?
          ├── нет → 503 (fail-closed, без изменений)
          └── да → cookie vesmaro_ui == ui-токен? (compare_digest)
                ├── да → доступ
                └── нет → 401
  ```

- **Правило детерминизма** — фолбэков нет:

| Запрос | `Authorization` | Нога |
| --- | --- | --- |
| ui-мутация | присутствует | только header, включая cross-class детейл |
| ui-мутация | отсутствует | только cookie (`_cookie_ui_ok`) |
| machine-класс | любой | `_guard_machine_write` — cookie не открывает |

- **reports-роут**: условие выбора ноги (`app.py:2705`) расширяется
  `... or _cookie_ui_ok(request)` — иначе cookie-only запрос уходит в
  machine-guard → 401.
- **Viewer**: boot-гидрация — `hasUiToken()` = header-токен ИЛИ live-cookie
  (boot-проба `GET /api/auth/ui-token` → 204); gate остаётся синхронным
  (инжекция). Re-probe в ветке 401 перед открытием окна: 200 → окно не
  открывать, queued run переигрывается cookie-ногой (иначе ротация токена
  повторит инцидент mid-flight).
- **Диалог входа**: pending-состояние (verify в полёте, submit disabled) и
  два различимых текста отказа — «отказ у порога» (невалидная строка или
  чужой класс) vs «сессия истекла» (ротация mid-flight). Токен при отказе
  не сохраняется, `loginStored` не эмитится.
- CSRF: `SameSite=Strict` + `Secure` + проверка Origin; double-submit —
  overkill.

### 3. Ф3 — «одно лицо»

Board-токен уходит из владельческой документации (RUNBOOK, подсказки UI):
владелец видит только ui-команду получения токена; board-токен = серверная
кухня (поллер/агенты). Диалог входа показывает секрет-имя
`vesmaro-eyes-ui-token` в hint.

### 4. Не затронуто (проверено по коду)

Поллер (header-лег), device-токены `mnd_` (header-классификация в
`device_scope_guard`), SSE (`/api/events` открыт; same-origin EventSource
несёт cookie, но не нуждается), legacy single-token режим (честный
`_token_classes()`), TauriAdapter — чистый стаб
(`viewer/src/gateway/TauriAdapter.ts:80-82`), риска сегодня нет.

## Alternatives rejected

- **localStorage для сессии** — JS-читаемый секрет против инварианта
  АРХКОМ-3 §5.3; без выгоды против stateless-cookie.
- **sessionStorage как целевое состояние** — воспроизводит paste-риск
  каждой новой вкладкой; это и есть источник жалобы владельца.
- **Серверная сессия с store/rotation** — лишний механизм при
  stateless-cookie: ротация ui-токена инвалидирует cookie мгновенно и
  авторитетно; «именно там живут баги» (Security), цена без выгоды (SE).
  Особое мнение PA (logout обязателен в скоупе волны) выполнено серверным
  `DELETE` в Ф2.
- **`POST /api/auth/verify`** — имя занято ратифицированным TOTP-контрактом
  (`viewer/src/gateway/auth.ts:191` — фаза 2, `challenge_id` + `code`);
  коллизия создала бы новую путаницу классов.
- **Экспоненциальный per-IP lockout** — за traefik вся household-LAN за
  одним NAT-IP: per-IP экспонента = DoS против владельца одной залипшей
  вкладкой. Отложено; триггер возврата — метрики атак или выход за
  single-owner LAN.
- **PAKE / OAuth / multi-user SSO** — вне вопроса (single-owner LAN,
  скоуп-аут PA).

## Consequences

- **Server** (~140 строк без тестов: ~80 Ф1 + ~60 Ф2): verify-роут +
  лимитеры + модели; `_cookie_ui_ok` + врезки в два guards + reports-условие
  (`app.py:2705`) + Set-Cookie/DELETE. Итого ~700 строк с тестами, один
  ревью-цикл (обязательный серверный проход code-reviewer), два коммита,
  один деплой. Гейты: pytest `tests/test_auth_ui_token.py` (9 кейсов) +
  cookie-нога.
- **Viewer**: gate verify-инжекция (ложный успех исчезает — `loginStored`
  только после 200 от verify), boot-гидрация, re-probe при 401, диалог с
  pending и двумя текстами отказа, logout-флоу через `DELETE`, i18n.
  Гейты: vitest gate+flow, live-smoke владельцем.
- **Документы (Ф3)**: RUNBOOK «одно лицо»; deploy-заметка владельцу.
- **Миграция**: вкладки, открытые до выката, просят один перелогин;
  header-лег сохранён — открытые вкладки работают до закрытия браузера.
- **Метрика успеха** (PA, дословно): ноль ложных успехов входа; ровно один
  вход на рабочую сессию браузера; ни один экран кроме окна входа не
  требует вставить секрет.
- **Честные остаточные риски** (принятые):
  - in-tab XSS злоупотребление — ни одно хранилище его не решает; решают Ф1
    и гигиена (жёсткий CSP Ф0, без CDN-зависимостей);
  - кража cookie = полный replay до ротации — HttpOnly закрывает
    JS-экфильтрацию, TLS — канал, ротация секрета = мгновенная инвалидация;
  - плоский лимитер не остановит распределённый brute-force — 128-битная
    энтропия токена главная защита, триггер возврата экспоненты записан;
  - session-cookie умирает с браузером — «запомнить меня» вынесено в
    отдельное решение владельца.

## Out of scope

Мультиюзер / SSO / PAKE; «запомнить меня» между рестартами браузера
(следствие выбора session-cookie; `Max-Age ≤ 24h` — отдельно по требованию
владельца); управление board-токеном в UI; Tauri-клиент — стаб, но
построение «cookie ИЛИ header» уже совместимо с custom-protocol fetch
(заметка на Фазу-2, сегодня риска нет).

## References

- Mnemos (решение комитета): `aca451bd-42d3-440d-9f52-cb15fb77b03b`
  (tags: `project:mnemos-eyes`, `mnemos:decision`, `committee`)
- Протокол АРХКОМ:
  `~/.gcw/architectural-committee/2026-09-22-owner-session-auth.md`
- Архитектурный контракт:
  `~/.gcw/architectural-committee/2026-09-22-owner-session-auth-contract.md`
- ADR 0009 (`0009-agent-bridge-assignments.md`) — токен-сплит ui/machine
- ADR 0012 (`0012-qr-pairing-device-tokens.md`) — device-токены;
  pairing-лимитеры как паттерн для verify
