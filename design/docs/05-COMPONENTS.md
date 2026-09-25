# 05 — Компоненты стенда: инвентарь, анатомия, state-матрицы

> Status: **v2.0, 2026-09-25**. Канон: каждый интерактивный компонент несёт
> hover / focus / active / disabled / error / loading / empty. Пропуск состояния —
> блокер ревью. Реализация — за frontend-разработчиком; здесь — контракт вида.

## 1. Инвентарь

| Компонент | Где | Матрица |
| --- | --- | --- |
| Shell (топбар/сайдбар/крошки) | всюду | `03` §3–5 |
| Кнопка (primary/secondary/ghost/danger) | всюду | §2.1 полная |
| Чип-тег | записи, поиск, фильтры | §2.2 полная |
| Карточка памяти (строка-списка и свиток) | обзор, записи, поиск, пульс | §2.3 полная |
| Пилюля статуса (live/busy/break, assignment) | топбар, агенты, хранилища | §2.4 полная |
| Поле ввода (поиск, формы, палитра) | всюду | §2.5 полная |
| Терминал-панель | рабочий стол | §2.6 полная |
| Узел графа + ребро | обзор-канвас | §2.7 полная |
| Bulk-тулбар | записи, список задач | наследует кнопки; состояния: появление/скрытие/confirm |
| Сегмент-контрол (режимы поиска, РУС/ORIG) | поиск, документы | как кнопки + selected-состояние |
| Окно (рабочий стол) | рабочий стол | default/focused/dragging/minimized/closing |
| Док-пилюля | рабочий стол | hover/active/disabled(«скоро»)/tooltip |
| Дров/модал | палитра, подключение, confirm | open/focus-trap/Esc/error/loading |
| Скелетон | все списки | shimmer ≤1.06 opacity, без blur |
| Toast | всюду (канал обратной связи) | success/error/info: авто-скрытие 4s, hover — пауза |
| Шпаргалка хоткеев | `?` | модал, таблица, поиск по ней не нужен |

## 2. Полные матрицы ключевых компонентов

### 2.1 Кнопка

Анатомия: [иконка 16px?] [лейбл `--text-ui` medium] ; высоты 32px (dense) / 40px
(comfortable); радиусы `--radius-md`; min-width по контенту; цель ≥24×24 всегда.

| Состояние | Primary | Secondary | Ghost | Danger |
| --- | --- | --- | --- | --- |
| default | fill `--color-iris-solid`, текст inverse | контур `--color-border`, текст primary | текст `--color-iris-bright` | fill `--color-error`/12%, текст error, край error/40% |
| hover | fill hover (9.1:1) | фон `--myelin-strong` | фон `--myelin-hairline` | fill error/20% |
| focus-visible | ринг `--color-focus` 2px/2px — все варианты | | | |
| active | fill `--color-iris` (темнее на 1 ступень) | фон `--strata-*` wash | текст primary | fill error/28% |
| disabled | fill `--color-bg-elevated`, текст muted, без тени; **пояснение почему** в tooltip | | | |
| loading | лейбл «Назначаем…» + спиннер 16px; повторный клик заблокирован | | | |
| error | возвращается в default + toast error с конкретикой | | | |

Правило: primary-кнопка на странице одна (или ни одной); разрушающее — всегда
с confirm-модалом, текст которого называет последствие и число.

### 2.2 Чип-тег

Анатомия: [#?имя] `--text-caps`/`--text-sm`; высота 22–24px; радиус `--radius-full`;
фон `--color-bg-elevated`, текст `--color-text-secondary`; счётчик — mono muted.

| Состояние | Вид |
| --- | --- |
| default | как в анатомии |
| hover | текст primary, фон `--myelin-strong`, курсор pointer (клик = фильтр) |
| focus-visible | ринг; чип — `<button>`, не `<span>` |
| active/выбран | фон `--strata-memory`, текст `--color-iris-bright`, точка ✓ |
| disabled | текст muted, без hover, tooltip «Фильтр недоступен здесь» |
| removable | ×-цель 16×16 (кликабельная зона 24×24), confirm не нужен (обратимо) |
| confidence-вариант | точка золота + число 0.xx слева; цвет — всегда с числом |

### 2.3 Карточка памяти

Анатомия строки: [☑?] [точка confidence + 0.xx] [заголовок `--text-body`]
[чипы ≤3 + «+N»] [провенанс mono `--text-caps` «agb · mnemos-01 · 2 ч»].
Свиток-версия: `--color-scroll-bg` + `--radius-lg` + Lora.

| Состояние | Вид |
| --- | --- |
| default | фон well; миелин-низ; hover — только в интерактивных списках |
| hover | фон `--myelin-hairline` поверх; `--shadow-raised` только у results поиска |
| focus-visible | ринг на всей строке (цель-строка) |
| selected | край 2px `--color-iris` слева + wash `--strata-memory` |
| active/открыта | свиток справа; строка — selected-вид |
| loading | скелетон строк (5) |
| empty | приглашение «Добавить запись» (см. 04 §2) |
| error | строка-ошибка с «Повторить» |
| stale | «запись исчезла из источника», muted, действия disabled с пояснением |
| live-update | при всплытии нового — импульс recall по краю карточки, 240ms, max 1/сек |

### 2.4 Пилюля статуса

Анатомия: [точка 8px] [текст `--text-caps` caps]; высота 24px; радиус full;
фон — tint 12% своего статуса; текст — сам статус-цвет (все ≥5:1).

| Состояние | Вид | Словарь |
| --- | --- | --- |
| live | точка `--color-success` + `--glow-live` + «live» | зелёный ТОЛЬКО от реального SSE-соединения |
| reconnecting | точка warning + «подключаемся…» | авто-восстановление до 30 с |
| broken | точка error + «нет связи» + кнопка «Переподключить» | красный не от медленного поиска |
| busy (assignment) | точка ирис + пульс точки 1.4s, «▸2 running» | пульс пока heartbeat свежий; >10 мин — warning |
| queued | полый контур точки, «в очереди N мин» | stagnation виден честно |
| terminal (done/failed/expired) | приглушённая, заштрихованная точка, tooltip причины | |
| reduced-motion | пульс → статический тинт, glow остаётся (не движение) | |

Правило: пилюля никогда не цветом одним — текст обязателен.

### 2.5 Поле ввода

Анатомия: высота 40px (32 dense); фон `--color-bg-elevated`; край 1px
`--color-border`; placeholder `--color-text-muted`; иконка слева опциональна.

| Состояние | Вид |
| --- | --- |
| default | как в анатомии |
| hover | край `--myelin-strong` → solid-эквивалент |
| focus («зрачок») | край `--color-iris-bright` 1.5px + `--shadow-iris` + glow-слой ≤0.35; placeholder исчезает |
| active/typing | caret `--color-iris-bright`; debounce-индикатор — точка, не спиннер |
| disabled | фон base, текст muted, tooltip почему |
| error | край `--color-error` 1.5px + текст ошибки под полем (не цветом одним: префикс «Ошибка:») |
| readonly | фон base, край subtle, tooltip «Только чтение» |
| с ошибкой валидации | live-валидация после первого blur (не на каждом символе) |

### 2.6 Терминал-панель

Анатомия: фон `--color-bg-base`; текст `--font-mono` 13px `--color-text-primary`;
prompt «mnemos@well:~$» — `--color-iris-bright`; ошибка — `--color-error` строкой;
выход команды — secondary.

| Состояние | Вид |
| --- | --- |
| default/фокус | окно focused-вид; caret мигает 1s step-end |
| busy | команда печатается честно (сечатая печать 8–16ms/символ); ввод заблокирован визуально (курсор стоит) |
| error команды | `bash: xyz: команда не найдена; введите help` — красной mono-строкой, НЕ тостом |
| help | таблица команд стенда (ls, cat, cd, clear, help) |
| history | ↑/↓ по истории; `clear` очищает |
| reduced-motion | печать мгновенная (без посимвольной анимации), текст появляется сразу |
| a11y | контейнер `role="log"` `aria-live="polite"`; ввод — настоящий input |

### 2.7 Узел графа + ребро (canvas)

Анатомия узла: точка r=2–4px (по возрасту/весу), ядро `--color-iris` / золото
для agent-узлов; glow-спрайт только у активного узла (предрендер offscreen,
`globalCompositeOperation:'lighter'`). Ребро: 0.5px `--synapse-idle`.

| Состояние | Вид |
| --- | --- |
| idle | миелин-ребро, тихий узел |
| hover (спотлайт) | узел + смежные рёбра ярче; прочие притухают до 40%; тултип DOM (не canvas): имя, возраст, уверенность |
| focus (клавиатурой) | узел в фокус-обводке (кольцо `--color-focus` 2px) — граф управляется стрелками |
| active/выбран | glow `--glow-iris`, рёбра к соседям — `--myelin-strong` |
| импульс recall | бегущая точка `--synapse-recall` по ребру, ≤240ms, ТОЛЬКО на событие ленты |
| импульс write | то же, `--synapse-write` (золото) |
| импульс error | то же, `--synapse-error` |
| reduced-motion | импульсы → мгновенный статический тинт ребра на 1.5s |
| perf | ≤300 узлов, DPR cap 2, пауза по `document.hidden`, <50fps → 150 узлов и без glow |

## 3. Сквозные правила

- Иконки: lucide-стиль, stroke 1.5px, размеры 16/20/24; в кнопках 16px слева
  от лейбла; никогда emoji.
- Тени: лестница v1 (`--shadow-well→modal`) — glow и тень не смешиваются в одном
  элементе.
- Toast — единственный канал «действие→подтверждение» (канон ui-contract §6):
  каждая мутация что-то отвечает пользователю.
- Числа и id — mono + tnum; RU-подписи — Inter; содержание памяти — Lora.
