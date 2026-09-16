# vesmaro-eyes — UI Contract (archcom-approved)

> Status: **Draft for archcom** (2026-09-16) — фиксирует стили, вложенности,
> навигацию и правила взаимодействия. Изменения через PR + archcom.
> Applies to: everything under `web/`, all future L1 viewer surfaces.

---

## 1. Entities & cards

| Entity | Card modal | Opened from |
| --- | --- | --- |
| Task | `#task-modal` (centered) | card click, ctx-menu, notif |
| Memory server (store) | `#srv-modal` | rail row click, ctx-menu |
| Memory group (cluster) | `#dd-modal` (cluster view) | rail row click, ctx-menu |
| Memory (session/знание) | `#dd-modal` (memory view) | pulse, task modal, drill lists |
| Tag / agent drill-down | `#dd-modal` (list view) | any tagchip / agent chip |
| Archive | `#dd-modal` (grouped view) | rail archive teaser |
| Specialist | `#dd-modal` (profile view) | rail roster click |

Rule: **every entity has a card**. New entities must ship with one.

## 2. Modal system

- **Centered modal over dimmed backdrop.** Only one full-screen stack at a
  time: opening a deeper card hides the backdrop of the previous one but
  keeps it mounted (the task stays visible behind a memory overlay).
- **Buttons, right-aligned in the head**: `← Назад` (hidden when the
  navigation stack is empty) · `⤢` maximize · `×` close.
- **Close semantics**: `×`/Esc closes the top modal; if an underlying modal
  exists in `modalHistory`, it is restored — no dead ends.
- **`⤢` maximize**: switches the modal to near-fullscreen (24px margins);
  file bodies get unrestricted scroll.
- **All content panes scroll inside their container.** The page itself
  never scrolls while a modal is open.

## 3. Cross-navigation

- Clicking a **tagchip** anywhere opens the tag drill-down (tasks + memory
  across all active servers).
- Clicking an **agent chip / mini-avatar** opens the agent activity card.
- Clicking a **memory title** in any list opens the memory card as an
  overlay; «← Назад» returns to the originating card (task, specialist,
  cluster, drill list).
- Navigation history is per-modal: `ddStack` (drill modal) and
  `modalHistory` (task modal). Closing a modal clears its stack.
- Rule: **new tabs are forbidden** — everything opens as an overlay.

## 4. Right rail (service panel)

Order (top → bottom): Хранилища · Кластеры памяти · Архив · Агенты·харнесы ·
Специалисты · Среды · **Пульс памяти** (last — its session lists are the
longest). Each block: header row (+ action button), compact rows, click →
card, right-click → context menu. The pulse accordion has its own scroll
(max-height 300px) and is collapsed by default.

## 5. Context menus (right-click)

Shared framework: header (name · meta) → **common block** → **type-specific
section**. Every action reports its outcome via a toast (see §6). Dangerous
actions are styled `danger` and require confirm.

## 6. Notifications & toasts

- **Toasts**: top-center stack; wording is action-bound ("laptop: связь в
  порядке · 109 ms", "T6: перемещена → готово"); `ok | err | info`.
- **Bell panel**: tabs Все / Рабочие (task lifecycle) / Системные (store
  ops, config); click → open related task; mark-read single/all; unread
  badge.
- Rule: **every state-changing action must produce either a toast (sync
  result) or a notification (persisted, visible in the panel)**.

## 7. Status semantics

- Store dot: **green** = enabled and reachable (cheap `GET /health` ping);
  red = enabled but unreachable; **an enabled store never turns red due to
  slow search** — deep probes are opt-in ("Проверить связь").
- Topbar SSE pill: green `live` (event stream connected), amber
  «переподключение» only while the socket is actually down.
- Auto-recovery: health loop re-pings stores every 30 s; a recovered store
  flips green without user action.

## 8. Design tokens

All colors/spacing/motion come from `styles/tokens.css` (obsidian-well
palette, teal iris, gold confidence, Lora for memory content). New UI must
consume tokens, not raw values. Max 1 ambient animation (breathing iris).

## 9. Data & cache rules

- Read-heavy views (specialist profiles) are **DB-cached server-side** and
  open instantly; background refresh keeps them current.
- Lists that can be long (sessions, memories) render grouped (project →
  accordion) with local scroll.
- Multi-server reads always merge with per-server provenance badges.