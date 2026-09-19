# Вердикт Senior System Engineer — АРХКОМ-3

Прочитано: app.py (1830 строк), store.py (схема/миграции), security.py, Containerfile, chart (values/ingress/netpol), viewer gateway, ADR 0007/0009/0010, ui-contract §10–12.

## 1. BoardAdapter + конвергенция Ф0–Ф4 — ACCEPT с поправками

Инвентаризация merge-API против целевой IA:

| Домен | Состояние | Вердикт |
|---|---|---|
| Канбан-мувы, create/patch/delete | есть | готово к Ф3 |
| Отчёты per-task | есть | готово |
| Сквозная лента отчётов | НЕТ | нужен GET /api/reports (cross-task, cursor) |
| Inbox + adopt | есть, list без пагинации | аддитивный cursor |
| Архив | есть limit/offset/total | готово |
| Уведомления | есть after_id (это и есть курсор — задокументировать) | готово |
| Пульс | capped min(limit,20) без продолжения | лента требует продолжения |
| Поиск | capped 25, только память | глобальный q-поиск tasks+inbox |
| Записи /memory | НЕТ GET /api/memories (merged list) | главный пробел Ф0–Ф2 |
| Теги /memory/tags | НЕТ GET /api/tags (только drill) | нужен агрегированный |
| Специалисты, stores, stats, SSE | есть | готово |

BoardAdapter v0 честно объявляет metrics/traces/sessions unsupported. Auth: Ф0–Ф2 читают открыто; Ф3 = ui-token логин в React.

**Единый пагинационный контракт**: `limit` + opaque `cursor` → `next_cursor: string|null`; сортировка с уникальным tiebreak (`created_at DESC, id`); `truncated: true` при молчаливом капе. Legacy offset/after_id не трогать (замороженный борд читает). Merged-эндпоинты: cursor кодирует per-store состояние; v1 вправе отдать next_cursor=null+truncated=true.

SSE: `assignment.*` зарезервированы — правильно; `pairing.*` резервировать той же фазой, что эмиттеры; закрыть gap kind:"report".

## 2. QR-пейринг серверно — ACCEPT с поправками; жёсткое предусловие

Реализуемо дёшево: 2 аддитивные таблицы (pairing_requests, device_sessions, hash-only, IF NOT EXISTS, без SEED_VERSION bump), TTL-sweep в lifespan, rate-limiter'ы по паттерну, ~6 роутов + middleware классов токенов (~60 строк: constant-time, таблица «класс → разрешённые роуты», до _guard_write). Single-worker uvicorn консистентен.

Поправки:
- (а) verify НЕ в SSE-бродкаст и stored notifications (SSE без авторизации — LAN увидит код); verify только через GET /api/pairing/{id} под ui-token; в notification — факт, без цифр.
- (б) Честная семантика verify: анти-ошибка, не криптодоказательство (нет PAKE). Зафиксировать словами.
- (в) Идемпотентность exchange как poll: повтор в scanned → 202 без дубля событий; после issued → 410; повторный confirm → 200 идемпотентно.
- (г) **Предусловие: токен-сплит ADR 0009 Ф1 (ui/machine) СТРОГО раньше пейринга** — иначе общий BOARD_TOKEN поллера подтверждает устройства сам.
- (д) exchange per-IP лимит; ≤5 устройств → 409 с явным выбором, без авто-ревока; mnd_ в _SECRET_PATTERNS с первого дня.

Четвёртый класс кредов — не перегруз: пользователь касается ui-сессии и mnd_; mnk_/TOTP уходят из UI с конвергенцией. Оговорка: reads открыты → mnd_ в v0 = идентичность/аудит/ревок + задел под scope.

## 3. Статика viewer в deploy — ACCEPT: multi-root в образе борда

Один Deployment/Ingress/NetPol — отдельный юнит проигрывает по всем осям. Containerfile multi-stage (node:22-alpine: npm ci && build → COPY dist), vite base:'/app/', env VESMARO_APP_DIR + catch-all @app.get("/app/{path:path}") → index.html ДО mount StaticFiles; index.html no-cache, ассеты immutable; codegen viewer от закоммиченного openapi-snapshot.json (образ не требует сеть).

## 4. API-first: дёшево сейчас / дорого потом

Делать сейчас: (1) cursor-контракт на новых эндпоинтах и additive на старых; (2) **Idempotency-Key на create-мутациях** (таблица key→response, replay-окно 24ч, ~50 строк); (3) weak ETag на /api/board, /api/notifications, task-detail (If-None-Match→304; НЕ на merged-прокси); (4) инвариант монотонного event_id (для будущего Last-Event-ID). НЕ сейчас: /api/v2 (политика: breaking → тогда v2). Same-origin без CORS — принцип.

## 5. Связь с ARCH-2

ARCH-2 Ф1 и arch3 Ф0 коммутативны. Порядок: ARCH-2 Ф0–Ф1 раньше пейринга; **ARCH-2 Ф4 (UI-триггер assignment) перенести в React (arch3 Ф3)**, если успели — freeze-исключение борда не тратить.

**Скрытая мина: WF-1 не аддитивен на схеме** — tasks.col CHECK constraint требует table-rebuild (new + INSERT SELECT + swap, без SEED_VERSION bump, с бэкапом). React-канбан строить сразу по финальной линейке колонок. Эскалация до утверждения WF-1.

Поручения SE: драфт cursor + Idempotency-Key контракта в ui-contract ДО Ф0; спланировать rebuild-миграцию tasks.col.
