# 02 — Токены «Живая кора» v2

> Status: **v2.0, 2026-09-25**. Имена существующих токенов **заморожены**
> (ADR 0006, ui-contract §8) — нейро-слой только добавляет имена. Значения
> старых имён эволюционировали (§5); hex-якоря бренда сохранены: ирис `#1A8A96`,
> золото `#C9933A`. Все контраст-пары пересчитаны по WCAG 2.x relative luminance;
> расхождения с ресерч-дайджестом помечены и обоснованы.

---

## 1. Архитектура токенов

```
tokens.css
├── Страты (фоны)      canvas → base → well → elevated → overlay (+ scroll)
├── Ирис               dim / brand / bright / glow / solid-пары
├── Confidence         золото + dim
├── Статусы            success(live) / warning / error / info
├── Текст              primary / secondary / muted / inverse
├── Границы            subtle(декор) / border(≥3:1) / iris(тинт) + НЕЙРО: миелин
├── НЕЙРО-слой         canvas, focus, миелин, страт-тинты, синапсы, glow, микро-шкала
├── Типографика        замороженная шкала + НЕЙРО микро-шкала (caps/data/ui/body)
├── Плотность          row-h-пары, measure-scroll (канон v1 §3.3 концепта)
├── Радиус / тени      без изменений (лестница глубины v1)
└── Motion             замороженная лестница + НЕЙРО: enter/exit easing, impulse
```

Правила употребления:
- Новые значения **только через токены**; raw hex в компонентах запрещены.
- `--myelin-hairline` — декоративные разделители (0.5px). Всё, что отделяет
  интерактивный компонент или кодирует состояние, — `--color-border` (≥3:1).
- Страт-тинты `--strata-*` — только wash больших амбиентных поверхностей
  (canvas, hero-фон, подложки секций). **Запрещены** на карточках с текстом.
- Glow: blur ≤24px, opacity слоя ≤0.35, ≤2 источников свечения в вьюпорте.
  Свечение = активность данных (фокус, live, событийный импульс) — нигде больше.
- Все числа (id, счётчики, таймеры, провенанс) — `tabular-nums` через
  `--numeric-tnum` + `--font-mono` там, где это значения/ID.

## 2. Таблица цветов (dark, default)

| Токен | Значение | Роль / правило |
| --- | --- | --- |
| `--color-well-canvas` | `#090B0F` | НОВЫЙ. Дно колодца: canvas графа, hero. Не `#000`. |
| `--color-bg-base` | `#0D0F14` | Фон страницы. |
| `--color-bg-well` | `#12161D` | Карточки, панели, сайдбар. |
| `--color-bg-elevated` | `#161B23` | Поповеры, дроверы, инпуты. |
| `--color-bg-overlay` | `#1C222C` | Модалки, шторки (фон + backdrop-tint). |
| `--color-scroll-bg` | `#151A22` | «Пергамент» свитка (Lora-чтение). |
| `--color-iris-dim` | `#0E4A52` | Неактивные ирис-состояния. |
| `--color-iris` | `#1A8A96` | Бренд-графика, solid-заливки. Не мелкий текст (на well 4.4:1). |
| `--color-iris-bright` | `#4FC2CE` | Интерактивный текст-акцент, hover, импульс recall. |
| `--color-iris-glow` | `#4FC2CE40` | Гало (слой ≤0.35 opacity, ≤2 источников). |
| `--color-iris-solid` | `#1A8A96` | Заливка primary-кнопки (inverse-текст 4.7:1). |
| `--color-iris-solid-hover` | `#4FC2CE` | Hover заливки (9.1:1). |
| `--color-confidence` | `#C9933A` | Уверенность, запись агента, импульс write. |
| `--color-confidence-dim` | `#7A5520` | Приглушённый confidence. |
| `--color-success` | `#3FBF7F` | Live-пилюля, здоровый heartbeat. |
| `--color-warning` | `#D9A03F` | Деградация, таймауты. Не рядом с confidence в одном ряду. |
| `--color-error` | `#E0655C` | Ошибки, импульс error. |
| `--color-info` | `#4FC2CE` | Информационное = любопытство (= ирис яркий). |
| `--color-text-primary` | `#E6EDF3` | Чтение. |
| `--color-text-secondary` | `#9AA7B4` | Лейблы, подписи, таймстемпы. |
| `--color-text-muted` | `#7C8894` | Капс-лейблы, метаданные, placeholder, disabled. |
| `--color-text-inverse` | `#0D0F14` | Текст на light-поверхностях/заливках. |
| `--color-border-subtle` | `#1C232E` | Декоративные сепараторы (solid-замена миелина там, где нужен hex). |
| `--color-border` | `#5E687E` | Функциональный край (≥3:1 на base/well/elevated). |
| `--color-border-iris` | `#4FC2CE40` | Ирис-тинт краёв в hover-состояниях. |

### НЕЙРО-слой (dark)

| Токен | Значение | Роль |
| --- | --- | --- |
| `--color-focus` | `#4FC2CE` | Фокус-ринг 2px + offset 2px, никогда не перекрыт (WCAG 2.4.11/2.4.13). |
| `--focus-ring-width` / `--focus-ring-offset` | `2px` / `2px` | Единая геометрия фокуса. |
| `--myelin-hairline` | `rgb(230 237 243 / 0.07)` | Миелиновые линии 0.5px: сепараторы списков, рёбра покоя, сетка канваса. |
| `--myelin-strong` | `rgb(230 237 243 / 0.14)` | Усиленный миелин: hover-ребро, активный разделитель. |
| `--line-hairline` / `--line-myelin` | `0.5px` / `1px` | Толщины линий (браузер рисует 1px на DPR1 — допустимо). |
| `--strata-memory` | `rgb(79 194 206 / 0.05)` | Wash домена «Память» (канвас/hero). |
| `--strata-tasks` | `rgb(122 138 158 / 0.05)` | Wash «Задачи». |
| `--strata-agents` | `rgb(201 147 58 / 0.05)` | Wash «Агенты» (золото = запись агента — согласовано со словарём импульсов). |
| `--strata-docs` | `rgb(186 176 158 / 0.05)` | Wash «Документы» (тёплая бумага). |
| `--strata-system` | `rgb(122 138 158 / 0.035)` | Wash «Настройки/Система». |
| `--synapse-idle` | `rgb(122 138 158 / 0.35)` | Ребро/линия в покое. |
| `--synapse-recall` | `#4FC2CE` | Импульс: recall-попадание. |
| `--synapse-write` | `#C9933A` | Импульс: запись агента. |
| `--synapse-error` | `#E0655C` | Импульс: ошибка. |
| `--glow-iris` | `0 0 24px rgb(79 194 206 / 0.35)` | Свечение активного узла/фокуса. |
| `--glow-gold` | `0 0 24px rgb(201 147 58 / 0.30)` | Свечение записи/агента в активном действии. |
| `--glow-live` | `0 0 16px rgb(63 191 127 / 0.30)` | Live-пилюля SSE. |
| `--glow-error` | `0 0 16px rgb(224 101 92 / 0.30)` | Пилюля/узел ошибки. |
| `--text-caps` | `0.6875rem` (11px) | Капс-лейблы секций, tracking `--tracking-caps`. Не для длинного текста. |
| `--text-data` | `0.8125rem` (13px) | Плотные операционные данные (таблицы, ленты). |
| `--text-ui` | `0.9375rem` (15px) | Базовый UI-текст шелла. |
| `--text-body` | `1.0625rem` (17px) | Комфортный текст списков/карточек. |
| `--tracking-caps` | `0.04em` | Трекинг капс-лейблов (+4%). |
| `--numeric-tnum` | `tabular-nums` | Все числа выравниваются по разрядам. |
| `--ease-enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | Вход (раскрытия, всплытие). |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Выход (закрытие, уход). |
| `--duration-impulse` | `240ms` | Жизнь синапс-импульса (затухание ≤240ms). |

## 3. Светлая тема — ключевые значения

| Токен | Значение | Примечание |
| --- | --- | --- |
| `--color-well-canvas` | `#E6EAED` | Глубина в светлом = чуть темнее base. |
| `--color-bg-well` | `#FFFFFF`, base `#F5F6F8`, elevated `#EFF1F5`, overlay `#E4E7EF` | лестница инвертируется по свету, не по смыслу: well — самый светлый. |
| `--color-iris-bright` | `#136E79` | В светлом «яркий» темнее (AA для текста 5.9:1). |
| `--color-iris-solid` / hover | `#136E79` / `#0F5F6A` | inverse-текст 7.5:1 / 8.6:1. |
| `--color-confidence` / warning | `#8A5A17` | 5.9:1 на white. |
| `--color-success` / error / info | `#1D6E48` / `#8A2020` / `#136E79` | 6.2 / 9.1 / 5.9 на white. |
| `--color-text-muted` | `#636A80` | 4.8:1 на elevated. |
| `--color-border` | `#6A7488` | 4.7:1 на white. |
| `--color-focus` | `#0F5F6A` | Ринг 7.3:1 на white. |
| `--myelin-hairline` | `rgb(13 15 20 / 0.08)` | Тёмный миелин на светлом. |
| `--strata-*` | тёмные тинты тех же hue (см. tokens.css) | |
| `--synapse-*` | тёмные значения тех же ролей | словарь импульсов не меняется по смыслу |
| `--glow-*` | blur тот же, alpha ×~0.7 | светлая поверхность рассеивает меньше |

## 4. Контраст-пары (расчёт, WCAG 2.2 AA)

Метод: relative luminance по формуле WCAG; значение = (L1+0.05)/(L2+0.05).
Полные пары — в tokens.css-комментариях; ключевые:

**Dark (поверхности: base `#0D0F14` / well `#12161D` / elevated `#161B23` / canvas `#090B0F`):**

| Пара | base | well | elevated | Вердикт |
| --- | --- | --- | --- | --- |
| text-primary `#E6EDF3` | 16.2 | 15.3 | 14.6 | AA+ везде |
| text-secondary `#9AA7B4` | 7.8 | 7.4 | 7.0 | AA+ везде |
| text-muted `#7C8894` | 5.3 | 5.0 | **4.8** | AA везде (worst-case задан elevated) |
| iris-bright `#4FC2CE` | 9.1 | 8.6 | 8.2 | AA+ (интерактив/текст-акцент) |
| iris `#1A8A96` | 4.7 | 4.4 | 4.2 | текст — только на base; графика ≥3:1 везде |
| confidence `#C9933A` | 7.0 | 6.7 | 6.4 | AA+ |
| success `#3FBF7F` | 8.2 | 7.8 | 7.4 | AA+ |
| warning `#D9A03F` | 8.3 | 7.9 | 7.4 | AA+ |
| error `#E0655C` | 5.6 | 5.3 | 5.1 | AA+ |
| border `#5E687E` (non-text 1.4.11) | 3.4 | 3.2 | 3.1 | AA |
| focus-ринг `#4FC2CE` | 9.1 | 8.6 | 8.2 | AA+ (2.4.13) |
| text-inverse `#0D0F14` на iris-solid `#1A8A96` | 4.7 | — | — | AA |
| text-inverse на iris-solid-hover `#4FC2CE` | 9.1 | — | — | AA+ |
| text-primary на canvas `#090B0F` | 16.7 | — | — | AA+ |

**Light (white `#FFFFFF` / base `#F5F6F8` / elevated `#EFF1F5`):**
text-primary 16.5/15.3 · secondary 7.8/7.4 · muted 5.4/**4.8** · iris-bright(light) `#136E79` 5.9/5.3 ·
confidence 5.9 · success 6.2 · error 9.1 · border `#6A7488` 4.7/4.3 · focus `#0F5F6A` 7.3 — все AA.

**Отклонение от ресерча (зафиксировано):** tertiary `#6B7885` из дайджеста даёт
4.2:1 на base и 3.8:1 на elevated — ниже 4.5:1 для капс-лейблов 11–13px (это
нормальный текст по WCAG, large-text-льгота не применима). Принят `#7C8894`:
4.8:1 в худшем случае, иерархия secondary→muted (7.0→4.8) сохранена.

## 5. Отличия от v1 (значения, имена не тронуты)

| Токен | v1 | v2 | Почему |
| --- | --- | --- | --- |
| `--color-bg-well` | `#111520` | `#12161D` | charcoal вместо сине-фиолетового уклона (анти-клише «дефолтная сине-фиолетовая палитра»). |
| `--color-bg-elevated` | `#1a1f2e` | `#161B23` | там же. |
| `--color-bg-overlay` | `#22283a` | `#1C222C` | там же. |
| `--color-iris-bright` | `#22b5c4` | `#4FC2CE` | якорь ресерча ≈9:1; сильнее отличим от «дефолтного cyan». |
| `--color-iris-glow` / `-border-iris` | `#22b5c440` / `#1a8a9640` | `#4FC2CE40` | следует за iris-bright. |
| `--color-iris-solid-hover` | `#22b5c4` | `#4FC2CE` | согласованно. |
| `--color-success` | `#3aa070` | `#3FBF7F` | live-якорь ресерча (8.2:1). |
| `--color-warning` | `#b8852a` | `#D9A03F` | 8.3:1; отличнее от золота confidence по светлоте. |
| `--color-error` | `#e07575` | `#E0655C` | тёплый красный ресерча (5.6:1), менее розовый. |
| `--color-info` | `#1a8a96` | `#4FC2CE` | info встречается текстом на elevated — v1-значение давало 4.2:1 (fail). |
| `--color-text-primary` | `#e8eaf2` | `#E6EDF3` | нейтральнее, якорь ресерча. |
| `--color-text-secondary` | `#8a90a8` | `#9AA7B4` | там же (7.8:1). |
| `--color-text-muted` | `#8087a8` | `#7C8894` | AA-фикс tertiary (см. §4) на новой нейтральной оси. |
| `--color-border` | `#666e90` | `#5E687E` | ≥3:1 на новых charcoal-поверхностях. |
| `--color-border-subtle` | `#1e2438` | `#1C232E` | согласован с charcoal. |
| `--color-scroll-bg` / border | `#161b28` / `#1e2438` | `#151A22` / `#242931` | пергамент страты между well и elevated. |
| `--duration-iris` | `3000ms` | `5000ms` | окно ambient 4–6s (ресерч); ⚠ синхронизировать `viewer` tokens.test.ts при переносе. |

Без изменений: `--color-bg-base #0d0f14`, `--color-iris #1a8a96`, `--color-iris-dim #0e4a52`,
`--color-confidence #c9933a`, `--color-confidence-dim #7a5520`, `--color-text-inverse #0d0f14`,
вся типографическая шкала, spacing, density, radius, тени.

## 6. Готовый `tokens.css` (копировать как есть)

```css
/**
 * vesmaro-eyes — «Живая кора» v2 tokens (stand + viewer).
 * Dark theme («фосфорный колодец») default on :root; light on [data-theme="light"].
 * Frozen names preserved (ADR 0006 / ui-contract §8); the neuro layer only ADDS
 * names. Contrast pairs computed per WCAG 2.2 — see design/docs/02-TOKENS.md §4.
 */

/* ── Dark theme (default) ───────────────────────────────────────────── */
:root {
  /* Strata ladder — depth of the well (never #000) */
  --color-well-canvas: #090b0f;         /* NEW — graph/hero canvas floor */
  --color-bg-base: #0d0f14;             /* page background */
  --color-bg-well: #12161d;             /* cards, panels, sidebar */
  --color-bg-elevated: #161b23;         /* popovers, drawers, inputs */
  --color-bg-overlay: #1c222c;          /* modal sheets + backdrop tint */
  --color-scroll-bg: #151a22;           /* memory scroll "parchment" */
  --color-scroll-border: #242931;

  /* Iris accent (teal — depth; brand, not small text on well+) */
  --color-iris-dim: #0e4a52;
  --color-iris: #1a8a96;                /* brand anchor, solid fills */
  --color-iris-bright: #4fc2ce;         /* interactive text accent, ~9:1 on base */
  --color-iris-glow: #4fc2ce40;         /* halo; layer opacity ≤0.35, ≤2 sources */
  --color-iris-solid: #1a8a96;          /* fill with inverse text 4.7:1 */
  --color-iris-solid-hover: #4fc2ce;    /* fill hover, inverse text 9.1:1 */

  /* Confidence (gold — value, agent write) */
  --color-confidence: #c9933a;
  --color-confidence-dim: #7a5520;

  /* Status (never color-only — always text/shape too) */
  --color-success: #3fbf7f;             /* live */
  --color-warning: #d9a03f;
  --color-error: #e0655c;
  --color-info: #4fc2ce;

  /* Text */
  --color-text-primary: #e6edf3;
  --color-text-secondary: #9aa7b4;
  --color-text-muted: #7c8894;          /* worst-case 4.8:1 on elevated */
  --color-text-inverse: #0d0f14;

  /* Borders — dual system: myelin (decor) vs functional edge (≥3:1) */
  --color-border-subtle: #1c232e;       /* decorative only */
  --color-border: #5e687e;              /* interactive boundaries, ≥3:1 */
  --color-border-iris: #4fc2ce40;       /* iris hover edge tint */

  /* ── Neuro layer (new names) ──────────────────────────────────────── */
  --color-focus: #4fc2ce;               /* focus ring, never obscured */
  --focus-ring-width: 2px;
  --focus-ring-offset: 2px;

  --myelin-hairline: rgb(230 237 243 / 0.07);  /* 0.5px resting edges */
  --myelin-strong: rgb(230 237 243 / 0.14);    /* hover edge, active divider */
  --line-hairline: 0.5px;
  --line-myelin: 1px;

  --strata-memory: rgb(79 194 206 / 0.05);     /* canvas washes ONLY — never on */
  --strata-tasks: rgb(122 138 158 / 0.05);     /* text-bearing cards */
  --strata-agents: rgb(201 147 58 / 0.05);
  --strata-docs: rgb(186 176 158 / 0.05);
  --strata-system: rgb(122 138 158 / 0.035);

  --synapse-idle: rgb(122 138 158 / 0.35);     /* resting edge */
  --synapse-recall: #4fc2ce;                   /* recall hit pulse */
  --synapse-write: #c9933a;                    /* agent write pulse */
  --synapse-error: #e0655c;                    /* error pulse */

  --glow-iris: 0 0 24px rgb(79 194 206 / 0.35);
  --glow-gold: 0 0 24px rgb(201 147 58 / 0.30);
  --glow-live: 0 0 16px rgb(63 191 127 / 0.30);
  --glow-error: 0 0 16px rgb(224 101 92 / 0.30);

  /* Micro type scale (instrument density; frozen scale below stays) */
  --text-caps: 0.6875rem;               /* 11px caps labels + --tracking-caps */
  --text-data: 0.8125rem;               /* 13px dense operational data */
  --text-ui: 0.9375rem;                 /* 15px base UI */
  --text-body: 1.0625rem;               /* 17px comfortable lists/cards */
  --tracking-caps: 0.04em;
  --numeric-tnum: tabular-nums;

  /* Neuro motion additions */
  --ease-enter: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-exit: cubic-bezier(0.4, 0, 1, 1);
  --duration-impulse: 240ms;            /* synapse pulse lifetime ≤240ms */
}

/* ── Frozen core (names & values stable) ────────────────────────────── */
:root {
  --font-ui: "Inter Variable", "Inter", "Helvetica Neue", system-ui, sans-serif;
  --font-scroll: "Lora Variable", "Lora", "Georgia", serif;
  --font-mono: "JetBrains Mono", "Fira Code", monospace;

  --text-xs: 0.75rem;   /* 12px */
  --text-sm: 0.875rem;  /* 14px */
  --text-base: 1rem;    /* 16px */
  --text-md: 1.125rem;  /* 18px — memory scroll content */
  --text-lg: 1.25rem;   /* 20px */
  --text-xl: 1.5rem;    /* 24px */
  --text-2xl: 2rem;     /* 32px — scroll/hero titles */

  --leading-tight: 1.25;
  --leading-normal: 1.5;
  --leading-relaxed: 1.7;

  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;

  --space-1: 0.25rem;  --space-2: 0.5rem;  --space-3: 0.75rem; --space-4: 1rem;
  --space-5: 1.25rem;  --space-6: 1.5rem;  --space-8: 2rem;    --space-10: 2.5rem;
  --space-12: 3rem;    --space-16: 4rem;   --space-24: 6rem;

  --row-h-dense: 2rem;      --row-h-airy: 3.5rem;
  --measure-scroll: 72ch;
  --radius-sm: 4px;  --radius-md: 8px;  --radius-lg: 16px;
  --radius-xl: 24px; --radius-full: 9999px;

  --duration-instant: 80ms;   /* state tints */
  --duration-fast: 150ms;     /* micro 120–180 window */
  --duration-normal: 250ms;   /* reveal 240–400 window */
  --duration-slow: 400ms;     /* large reveal */
  --duration-stagger: 40ms;   /* per-item step (max 8 in chain) */
  --duration-iris: 5000ms;    /* ambient breath, 4–6s window (v2: was 3000ms) */

  --ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
  --ease-out: cubic-bezier(0, 0, 0.2, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1); /* drag/reorder only */
  --ease-breath: cubic-bezier(0.45, 0.05, 0.55, 0.95);
}

:root,
[data-density="comfortable"] {
  --row-h: 2.5rem;
  --list-gap: 1rem;
}
[data-density="compact"] {
  --row-h: var(--row-h-dense);
  --list-gap: 0.5rem;
}

/* Elevation — bark shadow ladder */
:root {
  --shadow-well: 0 1px 3px 0 rgb(0 0 0 / 0.4);
  --shadow-raised: 0 4px 12px 0 rgb(0 0 0 / 0.5);
  --shadow-float: 0 8px 24px 0 rgb(0 0 0 / 0.6);
  --shadow-modal: 0 16px 48px 0 rgb(0 0 0 / 0.7);
  --shadow-iris: 0 0 32px 8px var(--color-iris-glow);
}

/* ── Light theme («береста») ────────────────────────────────────────── */
[data-theme="light"] {
  --color-well-canvas: #e6eaed;
  --color-bg-base: #f5f6f8;
  --color-bg-well: #ffffff;
  --color-bg-elevated: #eff1f5;
  --color-bg-overlay: #e4e7ef;
  --color-scroll-bg: #fafbfc;
  --color-scroll-border: #dee1ea;

  --color-iris-dim: #9dd4db;
  --color-iris: #1a8a96;
  --color-iris-bright: #136e79;         /* "bright" flips darker in light — AA text */
  --color-iris-glow: #1a8a9620;
  --color-iris-solid: #136e79;
  --color-iris-solid-hover: #0f5f6a;

  --color-confidence: #8a5a17;
  --color-confidence-dim: #e8c98a;

  --color-success: #1d6e48;
  --color-warning: #8a5a17;
  --color-error: #8a2020;
  --color-info: #136e79;

  --color-text-primary: #1a1e2e;
  --color-text-secondary: #4a5268;
  --color-text-muted: #636a80;
  --color-text-inverse: #f5f6f8;

  --color-border-subtle: #dee1ea;
  --color-border: #6a7488;
  --color-border-iris: #1a8a9633;

  /* Neuro layer — light */
  --color-focus: #0f5f6a;
  --myelin-hairline: rgb(13 15 20 / 0.08);
  --myelin-strong: rgb(13 15 20 / 0.16);
  --strata-memory: rgb(26 138 150 / 0.06);
  --strata-tasks: rgb(74 82 104 / 0.05);
  --strata-agents: rgb(138 90 23 / 0.06);
  --strata-docs: rgb(138 124 96 / 0.06);
  --strata-system: rgb(74 82 104 / 0.035);
  --synapse-idle: rgb(74 82 104 / 0.35);
  --synapse-recall: #136e79;
  --synapse-write: #8a5a17;
  --synapse-error: #8a2020;
  --glow-iris: 0 0 24px rgb(19 110 121 / 0.25);
  --glow-gold: 0 0 24px rgb(138 90 23 / 0.22);
  --glow-live: 0 0 16px rgb(29 110 72 / 0.25);
  --glow-error: 0 0 16px rgb(138 32 32 / 0.22);

  --shadow-well: 0 1px 3px 0 rgb(0 0 0 / 0.2);
  --shadow-raised: 0 4px 12px 0 rgb(0 0 0 / 0.25);
  --shadow-float: 0 8px 24px 0 rgb(0 0 0 / 0.3);
  --shadow-modal: 0 16px 48px 0 rgb(0 0 0 / 0.35);
  --shadow-iris: 0 0 32px 8px var(--color-iris-glow);
}

/* ── Reduced motion: OS + user-level mirror ─────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-iris: 0ms;      /* breath off → static canvas tint */
    --duration-slow: 0ms;
    --duration-normal: 0ms;
    --duration-fast: 80ms;     /* opacity-only ≤80ms */
    --duration-impulse: 0ms;   /* pulses → static tint (see 06-MOTION §7) */
  }
}
[data-motion="reduced"] {
  --duration-iris: 0ms;
  --duration-slow: 0ms;
  --duration-normal: 0ms;
  --duration-fast: 80ms;
  --duration-impulse: 0ms;
}
```
