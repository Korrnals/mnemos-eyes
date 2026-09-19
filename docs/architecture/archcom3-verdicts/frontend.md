# Вердикт Senior Frontend Developer — АРХКОМ-3

Замеры по коду: web/js/app.js — 3018 строк; board.css 1135; 22 модальных open*-флоу; viewer ~9.5K строк TS/TSX, 21 тест-файл.

## 1. Конвергенция в viewer/ — ACCEPT с поправками

Объём реален, но конечен: ~40% борда — рендер-шаблоны, умирающие вместе с IA (модальный стек, рельса, инлайн-HTML). Переносится поведение: канбан (DnD+группы+WF-1), страница задачи (4 таба), инбокс/adopt, архив, отчёты, draft/edit, SSE-слой, контекст-меню.

Оценка: **5–7 человеко-волн**:

| Фаза | Содержание | Оценка |
|---|---|---|
| Ф0a | Деплой /app (multi-stage Containerfile, history-fallback, VESMARO_APP_DIR) | 0.3 |
| Ф0b | BoardAdapter read + SSE-хук + контракт-тесты | 0.7–1 |
| Ф1 | Оболочка (sidebar/breadcrumbs/топбар/i18n/density) + домен «Память» | 1–1.5 |
| Ф2 | Задачи read-only (страница задачи, Список, инбокс-чтение, архив) | 1–1.5 |
| Ф3 | Мутации: move/edit/draft/adopt + канбан DnD + SSE-оптимистик | 1.5–2 |
| Ф4 | Переключение /, deprecation /board | 0.3 |

Риск регрессий до Ф4 ≈ 0 (борд заморожен, viewer на /app, откат Ф4 = вернуть ingress path). BoardAdapter — не блокер, но главный содержательный риск Ф0: нужны 2 малых аддитивных эндпоинта (GET /api/memories limit+cursor, GET /api/tags); типы генерировать из OpenAPI БОРДА, не маппить mnemos-словарь; SSE — отдельный EventStream-интерфейс в шлюзе.

Поправки: Ф0 расщепить на Ф0a/Ф0b; Ф1 начинать с домена «Память» (страницы уже есть — re-parent + редиректы); внутри Задач: страница → Список → инбокс/архив → канбан DnD последним; auth-рерайт явно в плане Ф1 (mnk_/TOTP уходит, логин = ui-token, AuthProvider переписать ~2–3 дня).

## 2. Канон ai-brain-паттернов — ACCEPT с поправками

Breadcrumbs/back, bulk (select→toolbar→confirm), hotkeys с inInput-guard, `?`-шпаргалка — да. Scroll-restore — через `<ScrollRestoration/>` React Router, не ручной. **Hash-роутер — REJECT как реализация** (история API + server-fallback уже спланированы). i18n свой слой (~100 строк, типизированные ключи), не i18next; density-токены `--row-h-*` additive.

## 3. Судьба канбана — ACCEPT

Вид №1 домена «Задачи» + переключатель «Список»; Home = «Обзор». DnD: `@dnd-kit/core`+sortable (DragOverlay, pointer+keyboard сенсоры) — превышение порога 10KB gz обосновать письменно (primary-поверхность, touch/клавиатура). 100+ задач: свёрнутые группы + `content-visibility: auto` + один общий тикер 1 Hz; SSE task.* → точечный патч TanStack-кеша, НЕ refreshBoard-рефетч. Виртуализация — только при >200 строк.

## 4. PWA-минимум — ACCEPT

manifest (start_url/scope параметром сборки — после Ф4 путь меняется), theme-color, иконки 192/512+maskable, минимальный SW = passthrough + offline-заглушка. Offline-кеш данных — отвергнуть до реального JTBD. TLS/lab-CA — жёсткое предусловие установки.

## 5. Быстрые победы в борде — ACCEPT закрытый список

(1) SSE-гэп task.archived/unarchived → refreshBoard (дефект ui-contract §11, часы); (2) a11y-фиксы; (3) синк tokens.css. Всё сверх — REJECT: срочная фича до parity идёт новой страницей в новый app (Ф1).

Поручения фронтенду после ратификации: спека BoardAdapter-контракта (маппинг + 2 эндпоинта); обоснование dnd-kit до первого коммита волны Задачи.
