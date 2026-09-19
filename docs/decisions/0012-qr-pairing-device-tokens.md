# ADR 0012: QR-пейринг и device-токены

- Status: **Accepted by committee — pending owner ratification** (2026-09-19)
- Deciders: АРХКОМ-3 — Product Architect, Senior UI/UX Designer, Senior
  System Engineer, Senior Security Engineer, Senior Frontend Developer,
  Senior QA Engineer; ведёт `@GCW: Tech Lead`; ратификация — владелец
- Related: ADR 0009 (токен-сплит ui/machine — предусловие Ф1), ADR 0011
  (Ф0 `/app` — предусловие UI пейринга; CSP/no-store Ф0), ADR 0004
  (LAN-trust), ADR 0006 (freeze-рамка), `ui-contract.md` §11
  (SSE-словарь), `arch3-ui-platform-problem.md` §4/§8 (драфт),
  `2026-09-web-app-redesign-concept.md` §6 (UX/терминология), вердикты
  Security/SE/QA АРХКОМ-3, протокол АРХКОМ-3

## Context

Стимул владельца: подключение к интерфейсу через QR-код «наподобие zcode».
Референс zcode (Web Remote Control) исследован: relay-топология нужна там,
потому что управляемая сторона (desktop) сидит за NAT. У нас управляемая
сторона — борд-сервер за ingress в LAN (`vesmaro.abyss.lab`); устройство
того же контура достигает его напрямую. Облачный relay не нужен и был бы
шагом назад по приватности (трафик памяти через третьи руки).

Сегодня понятия device-сессии в системе нет: подключение = знать URL,
принять self-signed warning, вручную вставить токен. TLS — self-signed
secret (`vesmaro-eyes-tls`, «browser warning is accepted»), что прямо
ограничивает и пейринг, и PWA. Вердикты АРХКОМ-3: Security — ACCEPT с
1–2 блокирующими поправками; SE — ACCEPT с жёстким предусловием
(токен-сплит ADR 0009 Ф1); QA — ACCEPT (полная тест-матрица). Все поправки
включены в Decision; расхождения (TTL/ротация, verify в SSE, авто-ревок)
разрешены комитетом — протокол АРХКОМ-3, Р1/Р2/Р5.

## Decision

### 1. Топология: LAN-direct

Устройство → ingress → борд-сервер напрямую (как любой браузер). Relay —
отвергнут: новая инфраструктура и трафик памяти через третью сторону;
сценарий «вне LAN» закрывает VPN, не relay. Инициатор пейринга — всегда
доверенный (аутентифицированный, ui-token) клиент; устройство лишь
сканирует; подтверждение — снова на доверенной стороне. Два действия
владельца (создать + подтвердить) обязательны; «автопринятие» не
предусматривается.

### 2. Протокол (LAN-direct, с поправками комитета)

1. `POST /api/pairing` (ui-token; rate 3/10 мин на клиента) →
   `201 {pairing_id, code, verify, expires_at}`: code — 128-bit urlsafe,
   single-use, TTL 3 мин (§6); verify — 4 цифры для сверки экранов.
2. UI рисует QR: `https://vesmaro.abyss.lab/#/pair?t=<code>` — токен в
   **fragment**, не в query-string (не попадает в серверные логи и
   referrer); страница после первого exchange вычищает `t` из history.
3. Устройство открывает URL → `POST /api/pairing/exchange {code,
   device_name}`: пока не подтверждён → `202 {status:
   "awaiting_confirmation", verify}` (verify — для сверки на экране
   устройства; семантика — §3.5); повтор в `scanned` → `202`
   идемпотентно, без дубля SSE-событий. Сервер: `created → scanned`,
   эмитит SSE `pairing.requested` (без verify — §3.3).
4. Доверенный клиент получает SSE-событие → панель «запрос подключения:
   device_name (self-asserted, unverified), source IP, код verify»
   (verify — через `GET /api/pairing/{id}` под ui-token) →
   `POST /api/pairing/{id}/confirm {allow}`; повторный confirm → `200`
   идемпотентно.
5. Устройство повторяет exchange → `200 {device_id, device_token (mnd_…),
   scope, expires_at}`; **выдача однократна** — code гасится,
   последующие exchange → `410`. Device-token живёт в хранилище
   устройства (PWA/приложение), шлётся как `Authorization: Bearer mnd_…`.

Отказ/таймаут — честные состояния («Пейринг истёк — начните заново»),
без молчаливого зависания. A11y: флоу не требует сканера — ручной ввод
code в той же сессии; QR с alt-описанием.

### 3. Блокирующие поправки Security (без них протокол не ратифицируется)

1. **Source-IP binding exchange**: первый exchange биндит pairing →
   client IP; повторные exchange и выдача токена — только с него (иначе
   403 + SSE-событие). Закрывает гонку выдачи (CWE-362) вместе с
   однократностью (§2.5). IPv6 privacy-адреса — раздел RUNBOOK.
2. **Выдача однократна**: confirmed → первый exchange выдаёт токен и гасит
   code; у атакующего с фото QR нет «равных шансов на опрос».
3. **verify НЕ в SSE-бродкаст и stored notifications**: `/api/events` не
   аутентифицирован — LAN-стрим увидел бы код; verify — только через
   `GET /api/pairing/{id}` под ui-token (и в ответе exchange самому
   устройству); в notification — факт события, без цифр. Payload-аудит
   `pairing.*`: без code/verify/device_token — всегда.
4. **Rate-limit**: ключ exchange = **pairing_id после lookup валидного
   code** (иначе memory-DoS на `RateLimiter._events`), 5 попыток/10 мин;
   создание — 3/10 мин на клиента; плюс глобальный per-IP лимит на
   `/api/pairing/*`.
5. **Честная семантика verify**: анти-ошибка (disambiguation / wrong-server
   UX), НЕ криптодоказательство — PAKE нет, verify возвращается каждому,
   предъявившему code (CWE-345). Real-защита от QR-fishing = human-gate ×2
   + TTL + single-use + IP-binding. Confirm никогда не принимает цифры
   как input (CWE-307 превентивно).
6. device_name cap ≤64, рендер как текст (stored-XSS превентивно);
   identity-паттерн ADR 0009 §8: self-asserted → «unverified» до первого
   сеанса.

### 4. Идемпотентность и порядок работ (SE)

- exchange = poll: повтор в `scanned` → `202` без дубля событий; после
  `issued` → `410`; повторный confirm → `200`.
- **Предусловие: токен-сплит ADR 0009 Ф1 (ui/machine) строго раньше
  пейринга** — иначе общий `VESMARO_BOARD_TOKEN` поллера подтверждает
  устройства сам.
- UI пейринга — в React-приложении после Ф0 (ADR 0011): делать его
  freeze-исключением борда = истраченный впустую бюджет реестра (≤2).
- Тайминг: серверные контракты (pairing/devices + SSE + лимитеры + тесты)
  — в 1.4.x после ADR 0009 Ф1.

### 5. Device-токены (`mnd_`) — третий класс (расширение ADR 0009)

| Класс | Кто | Права | TTL |
| --- | --- | --- | --- |
| ui | браузер владельца | полный UI-контур | сессия |
| machine | поллер/харнесы | assignments, reports | длинный, по ADR 0009 |
| **device** | спаренные устройства | v0 — read-only; мутации → 403 (токен валиден, прав нет); store-ops/валидация — никогда; scope `tasks` — отдельным решением архкома по триггеру (первый реальный сценарий мутаций с устройства) | sliding 30 д при активности, hard 90 д |

- Лимит **≤5 активных** device-сессий; 6-е → `409` с явным выбором
  владельца — **без авто-ревока** (расхождение с драфтом arch3 «ревок
  самой старой» разрешено в пользу SE; тест «авто-eviction невозможен»).
- Хранение: hash-only в БД (SHA-256 без соли); префикс `mnd_`; маскирование
  в логах (`_SECRET_PATTERNS`, `security.py`) с первого дня + тест
  маскирования (урок SEC-2). `DeviceSession`: `id, name, scope,
  created_at, last_seen_at, expires_at, state (active|expired|revoked)`
  + UA/IP/last_seen.
- Ревок в один шаг из основного клиента: `GET /api/devices` (список без
  токенов), `DELETE /api/devices/{id}` → SSE `pairing.revoked`; ревок всех
  устройств = reset (по образцу zcode). Отзыв необратим — только новый
  пейринг.
- Единый scope-middleware: класс токена по префиксу
  (`mnd_`/`mnu_`/`mnm_`) + таблица «класс → разрешённые роуты»,
  constant-time, перед `_guard_write`. Префиксы вводятся всем классам
  токенов.
- `mnk_`/TOTP остаются серверной кухней борда (token_ref per store):
  устройство их не видит и TOTP не проходит — идентичность устройства =
  device-session, выданная пейрингом.
- Честная позиция v0: чтения открыты (за ingress TLS) → `mnd_` — в первую
  очередь идентичность/аудит/ревок + задел под scope, а не барьер чтения.
  Компрометация mnd_ = read-scope всего корпуса; ревок-путь (hash-only,
  DELETE, sliding/hard TTL, проверка в middleware) достаточен.
- Pairing отключён (503), если ui-token не настроен — fail-closed (по
  образцу `_guard_write`).

### 6. TTL и ротация

Единый TTL пейринга = **3 мин** (code, QR, verify). Один code на pairing —
**ротация отвергнута** (расхождение «дизайн: QR ≤2 мин + ротация» ↔
«Security: ≤3 мин, один code» разрешено в пользу Security: ротация
расширяет окно атаки и противоречит single-use); renewal = новый pairing.
UX: QR контраст ≥3:1 к подложке, экран не затемняется (wake-lock по
возможности), TTL-дуга; «истёк — начните заново» — явно.

### 7. TLS: lab-CA — обязательное предусловие пейринга (не опция)

Self-signed + пейринг эксплуатирует обученную привычку принимать warning:
DNS-spoof → MITM-прокси → перехват exchange (CWE-35). `gen-tls-secret.sh`
расширяется до CA + leaf:

1. **CA-ключ offline**: только машина владельца, шифровано; никогда в k8s
   secret; `--print-only` приватного CA-ключа запретить; `--print-ca` —
   только cert.
2. CA ECDSA P-256, ~10 лет (basicConstraints critical CA:true); leaf —
   825 дней, SAN, EKU serverAuth, уникальный serial.
3. Установка CA на устройство — с out-of-band сверкой SHA-256 fingerprint
   (UI/RUNBOOK); часть «ритуала подключения устройства».
4. **HSTS вместе с CA-rollout, не раньше** (иначе блокировка до установки
   CA).
5. mTLS вместо `mnd_` — отвергнут (iOS/PWA не умеют клиентские
   сертификаты). ACME/Let's Encrypt — триггер: появится внешний доступ
   (lab-домен `.abyss.lab` не подходит; DNS-01). HTTP в LAN для v0 —
   отвергнут (bearer/device-токены в открытом канале).

### 8. PAKE — REJECT для LAN v0

Избыточен: сопоставимую защиту дают human-gate ×2 + TTL + single-use +
IP-binding (вердикт Security). Триггеры пересмотра: (1) relay-топология;
(2) пейринг вне LAN/VPN; (3) хрупкость IP-binding (например, ротация
адресов в контуре ломает binding).

### 9. Контрактные требования Ф0 (ко всем ответам сервера; вместе с ADR 0011 §11)

CSP: `default-src 'self'; script-src 'self'; object-src 'none'; base-uri
'self'; frame-ancestors 'none'; connect-src 'self'; img-src 'self' data:`;
`X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`;
`Cache-Control: no-store` на всех `/api/*`. Инварианты: токены никогда в
query-string; URL с id — documented risk (single-owner LAN) +
Referrer-Policy. `mnk_` purge из браузерного storage (+ тест отсутствия) —
аудит-пункт Ф0. Поправки `ui-contract.md` — отдельная задача по поручению
АРХКОМ-3.

### 10. Черновики контрактов (из arch3 §8 с поправками комитета)

#### 10.1 Pairing lifecycle

```
created ──scan──▶ scanned ──confirm──▶ confirmed ──exchange──▶ issued
   │                 │                                        │
   └──── TTL 3 мин ──┴──────────▶ expired ◀── TTL ────────────┘
   любой шаг до issued: revoke (владелец) ─▶ revoked
```

`PairingRequest`: `id`, `code_hash` (сам code открыто не хранится),
`verify` (4 цифры), `state (created|scanned|confirmed|issued|expired|
revoked)`, `scope` (v0: `read`), `created_by` (ui-identity),
`device_name?`, source-IP binding, `created_at`, `scanned_at?`,
`confirmed_at?`, `expires_at`. Переходы эмитятся в SSE (§10.3) и
дублируются notifications (system) — аудит без нового инструмента.

#### 10.2 REST-эндпоинты

| Метод и путь | Auth | Семантика |
| --- | --- | --- |
| `POST /api/pairing` `{device_name?}` | ui-token | создать; rate 3/10 мин; `201 {pairing_id, code, verify, expires_at}` |
| `GET /api/pairing/{id}` | ui-token | статус + verify для доверенной стороны (единственный источник цифр помимо ответа exchange устройству) — поправка SE |
| `POST /api/pairing/exchange` `{code, device_name}` | нет; rate по pairing_id 5/10 мин + per-IP | не подтверждён / повтор в `scanned` → `202 awaiting_confirmation` (+verify); подтверждён, первый раз → `200 {device_id, device_token: mnd_…, scope, expires_at}` (выдача однократна); невалиден/истёк → 404/410; чужой IP → 403 + SSE |
| `POST /api/pairing/{id}/confirm` `{allow: bool}` | ui-token | scanned → confirmed / revoke; повтор → `200` идемпотентно; rate 3/10 мин |
| `DELETE /api/pairing/{id}` | ui-token | cancel/ревок до issued |
| `GET /api/devices` | ui-token | список device-сессий (без токенов) |
| `DELETE /api/devices/{id}` | ui-token | ревок; SSE `pairing.revoked` |

#### 10.3 SSE-словарь `pairing.*` (additive-only, payload-аудит)

| kind | Payload | Эмиттер |
| --- | --- | --- |
| `pairing.requested` | `pairing_id, device_name?` + notification (факт) | exchange при `created→scanned` |
| `pairing.confirmed` | `pairing_id, device_name?` | confirm |
| `pairing.revoked` | `pairing_id \| device_id` + notification | revoke / ревок устройства |
| `pairing.expired` | `pairing_id` | TTL-sweep (in-process, по образцу фоновых циклов) |

Без code/verify/device_token в payload — всегда (§3.3). Резервирование в
словаре `ui-contract` §11 той же фазой, что эмиттеры (правило
`assignment.*`, ADR 0009 фаза 0); известный gap `kind:"report"` закрыть
той же фазой.

#### 10.4 Ограничения v0

code: 128-bit urlsafe, single-use, TTL 3 мин; verify: 4 цифры; ≤5 активных
device-сессий (6-е → 409 без авто-ревока); scope device v0 = read: `GET
/api/tasks*`, `GET /api/memories/*`, `GET /api/events`, `GET
/api/health`; мутации → 403; pairing 503 без настроенного ui-token.

### 11. Тестируемость (QA, матрица)

State machine: легальные переходы + нелегальные → 4xx; TTL-граница → 410;
single-use; bounded attempts → 429 (5/10 мин exchange, 3/10 мин creation);
два конкурирующих exchange → ровно один `issued`; нарушение IP-binding →
403 + SSE; ревок device-токена → 401; sliding 30/hard 90; 6-е устройство
→ 409; device-токен на мутации → 403 (не 401); порядок middleware (scope
перед `_guard_write`); в БД только `code_hash`; `mnd_` в
`_SECRET_PATTERNS` + тест маскирования. E2E: один Playwright-спек —
headless-браузер как «устройство» (QR декодируется программно, проверка
URL + `t=code`), второй контекст — доверенная сторона с SSE; без эмуляции
камеры.

## Alternatives rejected

- **Cloud-relay (модель zcode)** — новая инфраструктура, трафик памяти
  через третью сторону; управляемая сторона у нас не за NAT.
- **PAKE** — для LAN v0 (§8, с записанными триггерами пересмотра).
- **mTLS вместо device-токенов** — iOS/PWA не поддерживают клиентские
  сертификаты.
- **HTTP в LAN для v0** — plaintext-токены в открытом канале.
- **ACME сейчас** — lab-домен не подходит; зафиксирован триггер перехода.
- **verify как фактор аутентификации; авто-ревок старейшего устройства;
  ротация code** — отвергнуты (Security/SE; протокол Р1/Р2/Р5).

## Consequences

- **Server**: 2 аддитивные таблицы (`pairing_requests`, `device_sessions`;
  hash-only, `IF NOT EXISTS`, без SEED_VERSION bump), TTL-sweep в lifespan,
  ~6 роутов + scope-middleware (~60 строк: constant-time, таблица «класс →
  роуты», до `_guard_write`), rate-limiter'ы по устоявшемуся паттерну;
  single-worker uvicorn консистентен.
- **UI**: `/system/devices` в домене «Система» (IA дизайн-концепта);
  термины дизайн-спеки §6.1 — источник истины для UI-строк; флоу:
  «Подключить» → QR + код → сверка + одобрение на доверенной стороне →
  список устройств → отзыв.
- **RUNBOOK**: раздел «подключение устройства» — lab-CA, сверка
  fingerprint, ревок, IPv6 privacy.
- **Честные остаточные риски**: чтения открыты → `mnd_` не барьер чтения;
  SSE неаутентифицирован → минимум metadata в payload; QR-fishing
  остаточно закрыт IP-binding + однократной выдачей (не сверкой цифр).
- Ратифицируется одной пачкой с ADR 0011 и amend ADR 0006.

## Out of scope

scope `tasks` для device (решение архкома по триггеру); service
worker/offline; ACME; relay; PAKE; bulk-операции с устройства.
