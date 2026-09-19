# ARCHCOM SESSION 3 2026-09-19 — vesmaro-eyes (совещание №3: интерфейсная платформа)

- **Созвал:** владелец (`@abyss`)
- **Ведёт:** `@GCW: Tech Lead`
- **Участники:** Product Architect (вход `arch3-ui-platform-problem.md`),
  Senior UI/UX Designer (вход `2026-09-web-app-redesign-concept.md`),
  Senior System Engineer, Senior Security Engineer, Senior Frontend
  Developer, Senior QA Engineer (четыре вердикта `archcom3-verdicts/`)
- **Входные материалы:** два входных документа (платформа + IA/UX), четыре
  вердикта, ADR 0006/0009/0010, `ui-contract.md`, CHARTER §7–8, протоколы
  АРХКОМ-1/2

---

## Повестка

1. **Конвергенция IA** — целевая платформа интерфейса: вариант A (единое
   web-приложение в `viewer/`), strangler-фазы, судьба канбана, канон
   ai-brain-паттернов, BoardAdapter, auth (ADR 0011).
2. **QR-пейринг и device-токены** — LAN-direct протокол, TLS/CA-политика,
   токен-модель (ADR 0012).
3. **Путь к приложениям** — PWA-минимум, контрактные заделы (пагинация,
   ETag, Idempotency-Key), влияние на сервер и деплой.

## Предварительные позиции (Tech Lead)

- Конвергенция: вариант A, strangler Ф0–Ф4, канбан последним; freeze-правило
  ADR 0006 действует до parity-гейта; ADR 0006 — amend (end-state
  называется явно), ADR 0001 — подтвердить без изменений.
- BoardAdapter — единственная точка конвергенции (монополия merge-API,
  ADR 0007); типы из OpenAPI борда, не mnemos-словарь.
- QR-пейринг: LAN-direct (relay не наш случай), но с блокирующими
  поправками Security; жёсткое предусловие — токен-сплит ADR 0009 Ф1.
- Приложения: PWA-минимум сейчас, service worker — нет; lab-CA — предусловие
  пейринга, не опция.

## Решения сессии (комитет; четыре вердикта и два входа сведены TL)

Все решения ниже — **Accepted (owner ratified 2026-09-19; details delegated to Tech Lead)**.

1. **Конвергенция в единое React-приложение (ADR 0011).** Вариант A принят
   единогласно (четыре вердикта + оба входа). Новая IA строится в
   `viewer/`; борд — замороженный кокпит до parity-гейта Ф4. Поправки
   комитета: Ф0 расщеплён на Ф0a (деплой `/app`) и Ф0b (BoardAdapter
   read + SSE); Ф1 начинается с домена «Память» (re-parent существующих
   роутов + редиректы); внутри «Задач»: страница → Список → инбокс/архив →
   канбан DnD последним. Оценка фронта: 5–7 человеко-волн (таблица фаз —
   ADR 0011 §2). Риск регрессий до Ф4 ≈ 0: борд заморожен и живёт в
   проде, viewer на `/app`, откат Ф4 = вернуть ingress path.
2. **Судьба ADR 0006 — amend без смены сути.** Freeze-правило и
   конвергенционный гейт сохраняются дословно; end-state называется явно:
   единое React-приложение, борд — временный кокпит до Ф4;
   deprecation-окно `/board` (bug-fix only) после Ф4, затем снятие с
   ingress. Гейт (a) (mesh query-API, ADR 0007) не двигается — меняет
   внутренности BoardAdapter, не фазы. ADR 0001 (web-first, Tauri later) —
   подтверждён без изменений; нативные приложения — Not-doing.
3. **Канон ai-brain-паттернов — принят с поправкой.** Breadcrumbs +
   «← Назад», bulk (select → toolbar → confirm), scroll-restore, хоткеи с
   `inInput`-guard + `?`-шпаргалка. Поправки Frontend: scroll-restore —
   через `<ScrollRestoration/>` React Router, не ручной; **hash-роутер —
   REJECT**: маршрутизация = history API + server fallback, одна схема
   (QA); QR-вход — через fragment `#/pair?t=` с strip после первого
   exchange (токен никогда в query-string). i18n — собственный
   типизированный слой (~100 строк), не i18next; density-токены
   (`--row-h-*`, `--list-gap-*`, `--measure-scroll`) — additive к
   `tokens.css` + тумблер «компакт/комфорт». Эстетику ai-brain
   (GitHub-палитра, emoji-иконки, градиенты) — не принимать.
4. **Судьба канбана.** Канбан = вид №1 домена «Задачи» (`/tasks/board`) +
   переключатель «Список» (таблица: приоритет/возраст/проект/assignment,
   bulk, сортировки); **Home = «Обзор»** — сводка «что требует внимания»,
   не канбан (против повтора «один экран = одна проекция»). Колонки —
   линейка WF-1; группы-аккордеон персистентны; клавиатурный эквивалент
   DnD (WCAG 2.1.1). Технически: `@dnd-kit/core`+sortable (DragOverlay,
   pointer+keyboard сенсоры) — превышение бюджета 10KB gz обосновать
   письменно до первого коммита волны «Задачи»; при 100+ задач — свёрнутые
   группы + `content-visibility: auto` + один общий тикер 1 Hz; SSE
   `task.*` → точечный патч TanStack-кеша, не рефетч; виртуализация —
   только при >200 строк.
5. **BoardAdapter.** `BoardAdapter implements MemoryGateway` (+ расширения
   SSE, tasks) — единственная точка конвергенции. Типы генерировать из
   **OpenAPI борда** (не маппить mnemos-словарь), drift-guard; 2
   аддитивных эндпоинта: `GET /api/memories` (merged-список, limit+cursor)
   и `GET /api/tags` (агрегированный); SSE — отдельный EventStream-интерфейс
   в шлюзе; v0 честно объявляет metrics/traces/sessions unsupported. Auth:
   Ф0–Ф2 — открытые чтения; Ф3 — ui-token.
6. **Auth-рерайт.** Ф0 (аудит-пункт Security): purge `mnk_` из браузерного
   storage + тест отсутствия. Ф1: логин = ui-token (ADR 0009), AuthProvider
   переписать (~2–3 дня); `mnk_`/TOTP — серверная кухня борда (token_ref),
   из UI уходят.
7. **QR-пейринг и device-токены (ADR 0012) — принят с блокирующими
   поправками Security и SE.** LAN-direct (relay отвергнут; вне LAN =
   VPN); инициатор — доверенный клиент (ui-token), устройство лишь
   сканирует, подтверждение — снова на доверенной стороне. Блокирующие
   поправки: source-IP binding exchange; однократная выдача (confirmed →
   первый exchange выдаёт токен и гасит code); **verify НЕ в SSE** (только
   `GET /api/pairing/{id}` под ui-token; в notifications — факт без цифр);
   rate-limit exchange по pairing_id (после lookup валидного code) +
   per-IP на `/api/pairing/*`; идемпотентность exchange (202/410/200).
   Предусловие: токен-сплит ADR 0009 Ф1 строго раньше пейринга.
8. **Device-токены (`mnd_`).** Третий класс (расширение ADR 0009):
   read-only v0 (мутации → 403), hash-only в БД (SHA-256 без соли),
   sliding 30 д / hard 90 д, ≤5 активных; 6-е → **409 без авто-ревока**
   (явный выбор владельца; тест «авто-eviction невозможен»); `mnd_` в
   `_SECRET_PATTERNS` с первого дня; единый scope-middleware (класс по
   префиксу `mnd_`/`mnu_`/`mnm_` + таблица scopes) перед `_guard_write`.
   Честная позиция v0: чтения открыты → `mnd_` = идентичность/аудит/ревок
   + задел под scope, не барьер чтения.
9. **TLS: lab-CA — предусловие пейринга, не опция.** CA-ключ offline
   (только машина владельца, никогда в k8s secret; `--print-only`
   приватного CA-ключа запретить); CA ECDSA P-256 ~10 лет; leaf 825 д
   (SAN, EKU serverAuth, уникальный serial); установка CA на устройство с
   out-of-band сверкой SHA-256 fingerprint; HSTS вместе с CA-rollout, не
   раньше. mTLS вместо `mnd_` — отвергнут (iOS/PWA не умеют клиентские
   сертификаты); ACME — триггер (появится внешний доступ); HTTP в LAN —
   отвергнут.
10. **PAKE — REJECT для LAN v0.** Сопоставимую защиту дают human-gate ×2 +
    TTL + single-use + IP-binding. Триггеры пересмотра записаны (ADR
    0012 §8): relay-топология; пейринг вне LAN/VPN; хрупкость IP-binding.
11. **PWA-минимум — без service worker.** Manifest (start_url/scope
    параметром сборки — после Ф4 путь меняется), theme-color, иконки
    192/512 + maskable. Инвариант: SW не появляется без отдельного решения
    архкома; компенсатор — `Cache-Control: no-store` на всех `/api/*`.
    Offline-кеш данных — Not-doing до реального JTBD. Установка требует
    доверенный TLS (lab-CA, решение 9).
12. **Контрактные заделы API-first (SE).** Единый cursor-контракт (`limit`
    + opaque `cursor` → `next_cursor`, уникальный tiebreak `created_at
    DESC, id`, `truncated: true` при молчаливом капе; legacy
    offset/after_id не трогать — замороженный борд читает); Idempotency-Key
    на create-мутациях (replay-окно 24 ч); weak ETag (`/api/board`,
    `/api/notifications`, task-detail; НЕ на merged-прокси); инвариант
    монотонного `event_id`; same-origin без CORS; новый эндпоинт ⇒ схема +
    pin той же фазой. Недостающие аддитивные эндпоинты (инвентаризация
    SE): `GET /api/memories`, `GET /api/tags`, сквозная лента `GET
    /api/reports` (cross-task, cursor), cursor на inbox/pulse, глобальный
    q-поиск (tasks+inbox).
13. **Контрактные требования Ф0 (Security).** CSP (`default-src 'self';
    script-src 'self'; object-src 'none'; base-uri 'self';
    frame-ancestors 'none'; connect-src 'self'; img-src 'self' data:`) +
    `X-Content-Type-Options: nosniff` + `Referrer-Policy: no-referrer` +
    `Cache-Control: no-store` на `/api/*`; запрет
    `dangerouslySetInnerHTML` CI-гейтом (контент памяти = untrusted);
    перепроверка `VESMARO_APP_DIR` (path-join без traversal). Поправки
    `ui-contract.md` — отдельная задача по поручению; настоящий протокол
    контракт не переписывает.
14. **ARCH-2 Ф4 переносится в React (Ф3 конвергенции).** UI-триггер
    assignment строится в новом app; freeze-исключение борда не тратить
    (если конвергенция не успеет — вопрос на архком, не молча). ARCH-2
    Ф0–Ф1 — раньше пейринга.
15. **Быстрые победы борда — закрытый список.** (1) SSE-гэп
    `task.archived/unarchived` → `refreshBoard()` (дефект ui-contract §11);
    (2) a11y-фиксы; (3) синк `tokens.css`. Всё сверх — REJECT: срочная
    фича до parity идёт новой страницей в новый app (Ф1).
16. **Деплой.** Multi-stage Containerfile (node:22-alpine build →
    `dist/`), vite `base:'/app/'`, env `VESMARO_APP_DIR`, catch-all
    `/app/{path}` → `index.html` до mount StaticFiles; `index.html`
    no-cache, ассеты immutable; кодеген от закоммиченного
    `openapi-snapshot.json` (образ не требует сеть). Один Deployment /
    Ingress / NetworkPolicy; nginx-сайдкар отвергнут. `/board` снимается с
    ingress после deprecation-окна Ф4.

## Расхождения, разрешённые комитетом

| # | Расхождение | Позиции | Решение (канон разрешения) |
| --- | --- | --- | --- |
| Р1 | TTL и ротация пейринг-кода | дизайн: QR ≤2 мин + ротация; arch3: TTL 5 мин; Security: единый ≤3 мин, один code, ротация = хуже | **TTL 3 мин, один code, без ротации; renewal = новый pairing** (безопасность > удобство: ротация расширяет окно атаки и противоречит single-use) |
| Р2 | verify в SSE-payload | arch3 §8.3: verify в `pairing.requested`; Security + SE: `/api/events` неаутентифицирован, LAN увидит код | **verify только под ui-token (`GET /api/pairing/{id}`); SSE/notifications — факт без цифр** (блокирующая; безопасность > удобство) |
| Р3 | Service worker в PWA-минимуме | Frontend: минимальный SW (passthrough + offline-заглушка); Security: v0 без SW, инвариант | **Без SW; компенсатор `no-store` на `/api/*`** (безопасность > удобство; SW — только по решению архкома) |
| Р4 | Роутер | дизайн: hash-роутер (прецедент ai-brain); Frontend: REJECT; QA: одна схема | **history API + server fallback; QR-вход через fragment с strip** (инвариант «токены не в query-string» соблюдён) |
| Р5 | Поведение при лимите ≤5 устройств | arch3: 409 «с ревоком самой старой»; SE: без авто-ревока | **409 + явный выбор владельца, авто-ревока нет** (явность > автоматизм; тест «авто-eviction невозможен») |
| Р6 | Место ARCH-2 Ф4 (UI-триггер) | ADR 0009: триггер на борде (freeze-исключение); SE: в React | **В React Ф3; реестр исключений (бюджет ≤2) не тратить** (предусловия раньше следствий) |

Уточнение (не расхождение): идемпотентность exchange (SE) дополняет драфт
arch3 «повтор использованного code → 410»: повтор в `scanned` → 202 без
дубля событий; после `issued` → 410; повторный confirm → 200.

## Гейт-чеклисты Ф0–Ф4 (по вердикту QA, сокращённо)

- **Ф0**: контракт-тесты против реального борд-сервера; кодеген из OpenAPI
  борда + drift-guard; golden-фикстуры запинены; post-deploy smoke в
  RUNBOOK (read-only, без sleep); CI зелёный на multi-stage Node-сборке.
- **Ф1**: state-matrix интерактивов (loading/error/empty/disabled);
  freeze-исключений борда = 0 по diff-скоупу; роуты заморожены +
  редиректы протестированы; i18n-полнота (линт); новый эндпоинт ⇒ схема+pin
  той же фазой.
- **Ф2**: wire-corpus equality на golden; deep-link/F5 на уровнях 2–3;
  scroll через BACK; SSE-parity ⊇ словаря борда (вкл. gap
  `task.archived`); read-only daily-loop зафиксирован; baseline
  fallback-counter снят.
- **Ф3**: эквивалент каждой мутации + ошибочные состояния (409/429/423);
  bulk-минимум; assignment-триггер — машина состояний; мутационные e2e —
  staging/одноразовые; раунд фидбека владельца = гейт; план отката.
- **Ф4**: pre-switch smoke (`/` и `/board` оба health); rollback
  прорепетирован (game-day); deprecation-окно bug-fix only; неделя
  наблюдения (error-rate, SSE, fallback ≈ 0); явная подпись владельца.

Parity трёхуровневый (не пиксельный): wire-corpus equality → action-outcome
equality → завершение daily-loop владельцем. Метрики перехода (additive,
без PII): SSE-здоровье (reconnect/сессия + gap-счётчик), 401-flake первых
мутаций (60 с окно), route first-meaningful-render, error-boundary/toast
rate, **fallback-to-board counter** — главный parity-сигнал; ≈0 — численное
условие входа в Ф4.

## Поручения по итогам

| # | Поручение | Ответственный |
| --- | --- | --- |
| 1 | Ратификация ADR 0011 + ADR 0012 + amend ADR 0006 (одной пачкой) | owner |
| 2 | Поправки контрактов в `ui-contract.md`: SSE-словарь `pairing.*` (payload-аудит), cursor-контракт, Idempotency-Key, CSP/no-store/Referrer-Policy — отдельной задачей, до Ф0 | Tech Writer + System Engineer + Security |
| 3 | Драфт cursor + Idempotency-Key контрактов (вход для №2) | System Engineer |
| 4 | План WF-1 rebuild-миграции `tasks.col` (CHECK-rebuild: new + INSERT SELECT + swap, бэкап, без SEED_VERSION bump) — до кодирования канбана; эскалация до утверждения WF-1 | System Engineer |
| 5 | Спека BoardAdapter-контракта (маппинг + 2 эндпоинта + EventStream) — после ратификации | Frontend |
| 6 | Письменное обоснование dnd-kit (превышение 10KB gz) — до первого коммита волны «Задачи» | Frontend |
| 7 | lab-CA: `gen-tls-secret.sh` → CA + leaf (CA-ключ offline, запрет `--print-only` приватного ключа), fingerprint-сверка в UI/RUNBOOK; HSTS с CA-rollout | SRE/DevOps |
| 8 | Матрица QR-тестов → test-strategy 1.4.x; Playwright-спек пейринга (два контекста, QR декодируется программно) | QA |
| 9 | Регресс-тест 260bec2 расширить на drill-роут (закрытие класса BE-13) | QA |
| 10 | `mnk_`-purge из браузерного storage + тест отсутствия — аудит-пункт Ф0 | Frontend + Security |

---

> Протокол сведён TL по четырём вердиктам и двум входным документам;
> противоречий вне таблицы Р1–Р6 не обнаружено. Решения вступают в силу
> после ратификации владельца; до этого действует статус-кво ADR 0006.
