# ADR 0011: Конвергенция фронтендов в единое web-приложение

- Status: **Accepted by committee — pending owner ratification** (2026-09-19)
- Deciders: АРХКОМ-3 — Product Architect, Senior UI/UX Designer, Senior
  System Engineer, Senior Security Engineer, Senior Frontend Developer,
  Senior QA Engineer; ведёт `@GCW: Tech Lead`; ратификация — владелец
- Related: ADR 0001 (web-first), ADR 0002 (MemoryGateway), ADR 0006 (freeze
  + конвергенционный гейт — amend), ADR 0007 (монополия merge-API),
  ADR 0009 (ui/machine-токены; ARCH-2 Ф4), ADR 0010 (inbox/adopt), ADR 0012
  (QR-пейринг, device-токены), WF-1 (workflow lifecycle), `ui-contract.md`
  §1–12, протокол АРХКОМ-3 (`archcom-2026-09-19-archcom-session3.md`)

## Context

Стимул владельца: vesmaro-eyes вышел за рамки дашборда — нужна архитектура
полноценной веб-утилиты над сервером памяти (страницы/вкладки/подпрограммы,
задел на приложения). ADR 0006 отвечал «когда переносить канбан», но не «на
чём строить всё остальное»: борд заморожен, viewer не развёрнут и говорит
на чужом wire-контракте (mnemos, а не merge-API борда).

Факты (входы АРХКОМ-3): каркас viewer оплачен и не игрушечный — роутер с
lazy-чанками, шлюз с тремя адаптерами и тестами, auth-стейт-машина с TOTP,
дизайн-токены, openapi-codegen с drift-guard. Борд — прод v1.3.2,
feature-frozen; его переносимое ядро (merge-API, SSE-словарь, онтология,
токены) запинено OpenAPI + контракт-тестами. Дизайн-концепт доказал предел
дашборд-паттерна: IA из 5 доменов (~20 страниц, ~10 флоу) не вмещается в
экран + рельса + модальный стек, а URL-first IA в борде невозможна без
крупнейшего нарушения freeze. Четыре вердикта — ACCEPT с поправками
(включены ниже); расхождения разрешены комитетом (протокол АРХКОМ-3,
Р1–Р6).

## Decision

### 1. Вариант A: единое React-приложение в `viewer/`

Целевая картина: shell (роутер, навигация, дизайн-система, auth, пейринг,
PWA-обвязка) + домены-страницы по IA дизайн-концепта: **Обзор** (Home,
`/`) + Память / Задачи / Агенты / Хранилища / Система; вложенность ≤3
уровней; пустой слот не рендерится. Новые домены с первого дня живут
только здесь; реестр freeze-исключений борда = 0 (кроме закрытого списка
§8). Каждая платформенная способность (QR-пейринг, PWA, deep links,
offline-задел) строится один раз — иначе при эволюции обоих фронтендов
каждая строится дважды.

### 2. Strangler-фазы (канбан последним), оценки фронта

| Фаза | Содержание | Оценка | Гейт/выход |
| --- | --- | --- | --- |
| Ф0a | Деплой `/app`: multi-stage Containerfile, history-fallback, `VESMARO_APP_DIR` | 0.3 | владелец видит `/app` рядом с бордом |
| Ф0b | BoardAdapter read + SSE-хук + контракт-тесты | 0.7–1 | контракт-тесты зелёные; golden-корпус запинен |
| Ф1 | Оболочка (sidebar/breadcrumbs/топбар/палитра/хоткеи/i18n/density) + домен «Память» + auth-рерайт | 1–1.5 | первый домен принят владельцем |
| Ф2 | Задачи read-only: страница задачи, «Список», инбокс-чтение, архив | 1–1.5 | read-parity по чеклисту TL |
| Ф3 | Мутации: move/edit/draft/adopt + канбан DnD + SSE-оптимистик + assignment-триггер (ARCH-2 Ф4) | 1.5–2 | раунд фидбека владельца = гейт (b) ADR 0006 |
| Ф4 | Переключение `/` → app; deprecation `/board` | 0.3 | подпись владельца |

Итого 5–7 человеко-волн. Риск регрессий до Ф4 ≈ 0: борд заморожен и живёт
в проде, viewer на `/app`, откат Ф4 = вернуть ingress path. Порядок внутри
домена «Задачи»: страница → Список → инбокс/архив → канбан DnD последним.

### 3. Судьба ADR 0006 — amend без смены сути

Freeze-правило и конвергенционный гейт сохраняются дословно; меняется
end-state: (а) единое React-приложение, борд — временный кокпит до Ф4;
(б) parity-чеклист TL становится планом миграции канбана: read-parity
(выход Ф2) открывает канбан-миграцию Ф3, гейт (b) — раунд фидбека
владельца на полном daily-loop — выход Ф3; (в) после Ф4 —
deprecation-окно `/board` (bug-fix only), затем снятие с ingress. Гейт
(a) (mesh query-API, ADR 0007) не двигается: он меняет внутренности
BoardAdapter, не фазы. ADR 0001 подтверждён без изменений: web-first
доказан; Tauri — Phase 2 без изменений (local-first = отдельный JTBD);
нативные приложения — Not-doing.

### 4. Канон ai-brain-паттернов

Принять (доказаны ежедневным использованием владельца): **breadcrumbs +
«← Назад»** (последний крамб — не ссылка); **bulk** (select → toolbar →
confirm с точным числом); **scroll-restore** (возврат из детали в ту же
точку списка); **хоткеи с `inInput`-guard** (`/`, `Ctrl+K`, `j/k`, `x`,
`g`-префикс) + `?`-шпаргалка. Поправки Frontend: scroll-restore — через
`<ScrollRestoration/>` React Router, не ручной; **hash-роутер — REJECT**:
маршрутизация = history API + server fallback, одна схема (QA); QR-вход —
fragment `#/pair?t=` с strip после первого exchange — токен никогда не
попадает в query-string. i18n — собственный типизированный слой (~100
строк), не i18next; density-токены (`--row-h-dense/airy`,
`--list-gap-dense/airy`, `--measure-scroll`) — additive к `tokens.css`;
тумблер «компакт/комфорт» двигает только операционный режим. Эстетику
ai-brain (GitHub-палитра, emoji-иконки, градиенты) — не принимать.

### 5. Судьба канбана

Канбан остаётся, но перестаёт быть главным экраном: **вид №1 домена
«Задачи»** (`/tasks/board`) + переключатель **«Список»** (таблица:
приоритет/возраст/проект/assignment, bulk, сортировки). **Home =
«Обзор»** — сводка «что требует внимания» по доменам; на Обзоре нет
графиков ради графиков, блок без содержания не рендерится. Колонки —
финальная линейка WF-1; группы-аккордеон по проектам персистентны;
клавиатурный эквивалент DnD (контекст-меню «Переместить в…» + пункт в
странице задачи) — WCAG 2.1.1. Технически: `@dnd-kit/core`+sortable
(DragOverlay, pointer+keyboard сенсоры) — превышение бюджета 10KB gz
обосновать письменно до первого коммита волны «Задачи» (primary-поверхность,
touch/клавиатура); при 100+ задач — свёрнутые группы +
`content-visibility: auto` + один общий тикер 1 Hz; SSE `task.*` →
точечный патч TanStack-кеша, не рефетч всей доски; виртуализация — только
при >200 строк.

### 6. BoardAdapter — единственная точка конвергенции

`BoardAdapter implements MemoryGateway` (+ расширения: SSE, tasks).
Конвергенция идёт только через борд-сервер (монополия merge-API, ADR
0007): собственный multi-probe в L1 запрещён. Требования: типы
генерировать из **OpenAPI борда** (не маппить mnemos-словарь) +
drift-guard; 2 аддитивных эндпоинта сервера — `GET /api/memories`
(merged-список, limit+cursor) и `GET /api/tags` (агрегированный); SSE —
отдельный EventStream-интерфейс в шлюзе; v0 честно объявляет
`metrics/traces/sessions` unsupported. Auth: Ф0–Ф2 — открытые чтения;
Ф3 — ui-token.

### 7. Auth-рерайт (ui-token)

После конвергенции фронт аутентифицируется только у борд-сервера:
`mnk_`/TOTP — серверная кухня (token_ref per store), из UI уходят. Ф0
(аудит-пункт Security): purge `mnk_` из браузерного storage + тест
отсутствия. Ф1: логин = ui-token (ADR 0009), AuthProvider переписать
(~2–3 дня). Device-токены (`mnd_`) — ADR 0012.

### 8. Быстрые победы борда — закрытый список

(1) SSE-гэп `task.archived/unarchived` → `refreshBoard()` (дефект
ui-contract §11); (2) a11y-фиксы; (3) синк `tokens.css`. Всё сверх —
REJECT: срочная фича до parity идёт новой страницей в новый app (Ф1).

### 9. PWA-минимум

Manifest (start_url/scope параметром сборки — после Ф4 путь меняется),
theme-color, иконки 192/512 + maskable. **Без service worker** — инвариант
«SW не появляется без решения архкома»; компенсатор — `Cache-Control:
no-store` на всех `/api/*`; при будущем появлении SW — network-first на
`/api/*`. Offline-кеш данных — Not-doing до реального JTBD. Установка
требует доверенный TLS: lab-CA (ADR 0012) — жёсткое предусловие.

### 10. Гейт-чеклисты Ф0–Ф4 (QA, сокращённо; полный текст — вердикт QA и протокол АРХКОМ-3)

- **Ф0**: контракт-тесты против реального борд-сервера (in-process
  TestClient, прод-shaped сид); кодеген из OpenAPI борда + drift-guard;
  golden-фикстуры запинены (борд заморожен — фиксируем v1.3.x-поведение,
  привязка к тегу); post-deploy smoke в RUNBOOK (read-only, poll-with-
  deadline, без sleep); CI зелёный на multi-stage Node-сборке.
- **Ф1**: state-matrix интерактивов (loading/error/empty/disabled);
  freeze-исключений борда = 0 по diff-скоупу; роуты заморожены +
  редиректы протестированы; i18n-полнота (линт); новый эндпоинт ⇒ схема+pin
  той же фазой.
- **Ф2**: wire-corpus equality на golden; deep-link+F5 на уровнях 2–3;
  scroll-restore через BACK; SSE-parity ⊇ словаря борда (вкл. gap
  `task.archived`); read-only daily-loop зафиксирован; baseline
  fallback-counter снят.
- **Ф3**: эквивалент каждой мутации + ошибочные состояния (409/429/423);
  bulk-минимум (confirm с точным числом, per-item outcome, audit
  per-entity); assignment-триггер (ARCH-2 Ф4) — машина состояний;
  мутационные e2e — staging/одноразовые; раунд фидбека владельца = гейт;
  план отката существует.
- **Ф4**: pre-switch smoke (`/` и `/board` оба health); rollback
  прорепетирован (game-day); deprecation-окно bug-fix only; неделя
  наблюдения (error-rate, SSE, fallback ≈ 0); явная подпись владельца.

Parity трёхуровневый (не пиксельный): wire-corpus equality (golden) →
action-outcome equality (переход + notification/toast) → завершение
daily-loop владельцем. Метрики перехода (additive, без PII): SSE-здоровье
(reconnect/сессия + gap-счётчик), 401-flake первых мутаций (60 с окно),
route first-meaningful-render, error-boundary/toast rate,
**fallback-to-board counter** — главный parity-сигнал; ≈0 — численное
условие входа в Ф4.

### 11. Контрактные заделы (API-first: дёшево сейчас, дорого потом)

- **Пагинация**: единый контракт `limit` + opaque `cursor` →
  `next_cursor: string|null`; сортировка с уникальным tiebreak
  (`created_at DESC, id`); `truncated: true` при молчаливом капе; новые
  эндпоинты — cursor с рождения; inbox/pulse — аддитивные cursor-параметры
  (merged-эндпоинты: cursor кодирует per-store состояние, v1 вправе отдать
  `next_cursor=null` + `truncated=true`); legacy offset/`after_id` не
  трогать (замороженный борд читает; `after_id` задокументировать как
  курсор).
- **Недостающие аддитивные эндпоинты** (инвентаризация SE): `GET
  /api/memories`, `GET /api/tags`, сквозная лента `GET /api/reports`
  (cross-task, cursor), глобальный q-поиск (память + задачи/inbox
  проекции).
- **Idempotency-Key** на create-мутациях (таблица key→response,
  replay-окно 24 ч); на bulk-операциях — обязательна.
- **Weak ETag** (`If-None-Match` → 304) на `/api/board`,
  `/api/notifications`, task-detail; НЕ на merged-прокси.
- **Монотонный `event_id`** — инвариант с первого дня (задел
  SSE-resumption v2: Last-Event-ID/персистентный журнал — заявленное
  направление, не обязательство).
- **Same-origin без CORS** — принцип: приложение и API за одним origin;
  внешние клиенты ходят через ingress-контур с токенами.
- Новый эндпоинт ⇒ OpenAPI-схема + pin-тест той же фазой (урок
  `kind:"report"`-gap).
- **Контрактные требования Ф0 (Security)**: CSP (`default-src 'self';
  script-src 'self'; object-src 'none'; base-uri 'self';
  frame-ancestors 'none'; connect-src 'self'; img-src 'self' data:`),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `Cache-Control: no-store` на `/api/*`; запрет
  `dangerouslySetInnerHTML` CI-гейтом; контент памяти = untrusted
  (markdown-рендер только sanitize+CSP); URL с id — documented risk
  (single-owner LAN); перепроверка `VESMARO_APP_DIR` (path-join без
  traversal).
- Поправки `ui-contract.md` (SSE-словарь, cursor, Idempotency-Key,
  security-заголовки) — отдельная задача по поручению АРХКОМ-3; настоящий
  ADR контракт не переписывает.

### 12. Предусловия и смежные треки

- **WF-1 CHECK-rebuild до кодирования канбана**: `tasks.col` CHECK
  constraint не аддитивен на схеме — table-rebuild (new + INSERT SELECT +
  swap, с бэкапом, без SEED_VERSION bump); React-канбан строится сразу по
  финальной линейке WF-1. Эскалация — до утверждения WF-1.
- **ARCH-2 (ADR 0009)**: Ф0–Ф1 (сервер + поллер) — раньше пейринга;
  **Ф4 (UI-триггер assignment) переносится в React** — выполняется в Ф3
  конвергенции; freeze-исключение борда не тратить (если конвергенция не
  успеет — вопрос на архком, не молча).
- **QR-пейринг (ADR 0012)**: строго после токен-сплита ADR 0009 Ф1;
  UI пейринга — в React после Ф0.

## Alternatives rejected

- **B. Эволюция обоих фронтендов** — вечные два стека; каждое платформенное
  требование владельца = дилемма «freeze-исключение или ждать L1»; бюджет
  реестра исключений (≤2) исчерпается первыми же запросами; токен-модель и
  auth-UX в двух клиентах.
- **C. Статус-кво ADR 0006** (решение отложено до конвергенционного гейта)
  — устранено стимулом: гейт отвечает «когда переносить канбан», но не
  «где строить всё остальное»; проблема «нет целевой платформы интерфейса»
  остаётся открытой.
- Крупные правки борда (роутер в замороженный борд, наведение IA на
  рельсе/модальном стеке) — крупнейшее нарушение freeze и двойная работа.

## Consequences

- **Deploy**: multi-stage Containerfile (node:22-alpine: `npm ci && build`
  → COPY `dist/`), vite `base:'/app/'`, env `VESMARO_APP_DIR`, catch-all
  `@app.get("/app/{path:path}")` → `index.html` до mount StaticFiles;
  `index.html` no-cache, ассеты immutable; кодеген от закоммиченного
  `openapi-snapshot.json` (образ не требует сеть). Один Deployment /
  Ingress / NetworkPolicy; nginx-сайдкар отвергнут (логика ADR 0008).
  `/board` снимается с ingress после deprecation-окна.
- **Server**: аддитивные эндпоинты/таблицы по фазам (§6, §11; пейринг —
  ADR 0012); в сборку образа приходит Node-стейдж.
- **Не переносится**: DOM/JS борда (CHARTER §8). Переносятся: контракты
  (OpenAPI, SSE-словарь), токены, онтология, поведение v0.3–v0.9
  (parity-чеклист TL, владелец чеклиста — TL по ADR 0006).
- **Риски**: потеря одобренного поведения канбана (6 раундов) — митигируется
  трёхуровневым parity + golden-корпусом (снимается на Ф0, привязка к
  тегу) + раундом фидбека владельца на Ф3; BoardAdapter — главный
  содержательный риск Ф0 (контракт-тесты против реального сервера, не
  MockAdapter).
- ADR 0006 amend, ADR 0012 и настоящий ADR ратифицируются одной пачкой.
