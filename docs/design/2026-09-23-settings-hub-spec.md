# Спека «Хаб настроек: /system/settings как страница секций» — v0

> Status: **проект на ратификацию** (2026-09-23, UI/UX Designer). Дизайн-спека,
> не UI-код. Опирается на: AGW-3 (`ExecutionSettingsPage.tsx:14-22` — «further
> sections join as sibling blocks»), ADR 0013 §6/§8 (бюджеты, kill-switch,
> UI-рамка: «without ui-token the section is visible with disabled mutations
> and an explanation»), ADR 0014 (owner-session вместо paste-токена). Сценарий
> владельца: «/system/settings — где проработка и доработка конфигураций и
> сеттингов?» — сейчас там одна секция, а серверный контракт автоматизации
> (`GET/PUT /api/automation/settings`) вовсе без интерфейса.

## 0. Диагноз (по коду, 1.19.0)

| Факт | Где | Следствие |
| --- | --- | --- |
| `/system/settings` рендерит только `ExecutionSettingsPage`: h1 «Настройки» + одна секция «Исполнение» (пара default/fallback, `scope:""`, 422-гейты вербатим) | `viewer/src/app/routes.tsx:275-284`, `viewer/src/features/agents/ExecutionSettingsPage.tsx` (213 строк) | страница-заглушка по построению — секции-сиблинги предусмотрены, но не заведены |
| Сервер отдаёт `GET /api/automation/settings` (OPEN-read: `{ok, enabled, cap_global_per_day}`) и `PUT` (ui-token, аудит `automation.settings.changed` old→new, частичная семантика) | `server/app.py:3952-3958, 3961+`; модель `AutomationSettingsBody` `server/app.py:1533-1535`; стор `server/store.py:4014-4060` | контракт живой, интерфейса нет вовсе |
| Дефолты: `enabled=false` (C-1 disable-by-default), cap = `AUTOMATION_DEFAULT_GLOBAL_CAP = 10`, клэмп `1..1000`; невалидный cap → `AutomationValidationError "cap_global_per_day must be an int in 1..1000"` | `server/store.py:345-347, 4020-4024, 4034-4036`; ADR 0013 §6 | **Заметка**: докстринг `store.py:4016` говорит «cap=20/day» — протухший комментарий, реально 10; поправить строку при реализации |
| `GET /api/automation/status` честно отдаёт `engine:false` (константа S1), `daily_used` (запуски без «manual» за сегодня) | `server/app.py:3924-3949` | источник честной пометки «движок ещё не работает» и счётчика «использовано сегодня» |
| FE-адаптер умеет `automationStatus`/schedules/hooks/launches, но **не имеет** `get/putAutomationSettings`; OpenAPI-типы уже запинены | `viewer/src/gateway/BoardAdapter.ts:142-150, 368-382`; `viewer/src/types/board-openapi.d.ts:1344-1364, 6032-6071` | единственный FE-гэп: два метода адаптера + mock-паритет |
| На `/system/automation` выключатель/лимит показаны **read-only** (v1-cut ADR 0013 §8: «no global kill-switch toggle»), с честнойengine-off строфой, gated на `!engine` (P2-3) | `viewer/src/features/automation/AutomationPage.tsx:29-33, 136-165` | тумблеру нужен дом: хаб, а не баннер автоматизации — см. §1.2 |
| Интерфейсные preference рассыпаны осознанно: `vesmaro.lang` (RU|EN в шапке), `vesmaro.density` (кнопка в шапке), `vesmaro.boardStyle` (тумблер на /tasks), `vesmaro.sidebarCollapsed` (кнопка сайдбара) | `viewer/src/i18n/index.ts:26`; `viewer/src/components/density-provider.tsx:25`; `viewer/src/features/tasks/tasksViewPrefs.ts:24`; `viewer/src/layout/Shell.tsx:34`; шапка — `viewer/src/layout/TopBar.tsx:83-100` | **не мигрируем** — настройки живут на месте использования; хаб даёт только перекрёстные ссылки |
| Без ui-токена секции читаемы, мутации отключены, одна честная строка (`automation.mutation.disabledNote`) — паттерн уже есть | `AutomationPage.tsx:171-176`, `viewer/src/i18n/ru.ts:1053`; сессия — `useSessionControl` (`AutomationPage.tsx:62-83`) | единый readonly-паттерн для обеих секций хаба |

Итого: хуб — это **композиция существующего** (Исполнение) + **одна новая
форма** (Автоматизация, ровно по серверному контракту) + **статичные
ссылки** (Интерфейс). Ни одного нового цвета, шрифта, токена.

## 1. IA хаба

### 1.1 Состав

Единственный h1 «Настройки» (переиспользуем значение `nav.systemSettings`,
`ru.ts:707`); три секции-сиблинга с якорями `#execution`, `#automation`,
`#interface`. Роут не меняется. Существующая секция «Исполнение» выносится
из `ExecutionSettingsPage.tsx` как блок без изменения поведения (тесты
`ExecutionSettingsPage.test.tsx` остаются зелёными после композиции).

| Секция | Источник | v0 |
| --- | --- | --- |
| **Исполнение** (`#execution`) | существующий блок `ExecutionSettingsPage.tsx:112-168` | перенести как есть: пара селектов с «видим, но недоступен + причина», save через ui-token, 422-тексты вербатим |
| **Автоматизация** (`#automation`) | новая форма по `GET/PUT /api/automation/settings` §2 | тумблер + дневной лимит + счётчик дня |
| **Интерфейс** (`#interface`) | статичные ссылки, форм нет | язык/плотность → шапка; вид доски → /tasks; сайдбар → сам сайдбар |

**Не входит в v0** (и почему): миграция интерфейсных preference (владелец
явно оставил их на местах — хаб только показывает, где они); security/токены
(серверные env-токены и pairing — RUNBOOK/`/system/devices`-зона, не форма в
UI); device-скоп настроек (не существует; устройства сами живут на
`/system/devices`, `navItems.ts:136`); project-overrides исполнения
(`scope:""` зарезервирован, AGW-3); аудит-вьюер и редактирование правил
(ADR 0013 §10; правила — на `/system/automation`).

### 1.2 Разрешение конфликта с ADR 0013 §8

Cut «no global kill-switch toggle (read-only)» относился к странице
`/system/automation` — баннер там **остаётся read-only** и получает ссылку
«изменить в настройках» → `/system/settings#automation`. Тумблер впервые
появляется в хабе. Это осознанная поправка UI-рамки ADR: записать в
Consequences при ратификации (docs-sync), контракт сервера не меняется.

```
┌ /system/settings ────────────────────────────────────────────────┐
│ Настройки                                          (h1, один)    │
│ ┌ Исполнение ─────────────────────────────── #execution ┐       │
│ │ [Исполнитель по умолчанию ▾] [Запасной исполнитель ▾] │       │
│ │ строки реестра видимы; недоступные — disabled + причина│       │
│ │                                  [Сохранить]          │       │
│ └───────────────────────────────────────────────────────┘       │
│ ┌ Автоматизация ─────────────────────────── #automation ┐       │
│ │ [(!) Движок не включён: настройка сохранит намерение…] │       │
│ │ Автоматизация включена                     [выкл ◯——]  │       │
│ │ Лимит авто-запусков в день  [ 10    ]                  │       │
│ │ От 1 до 1000; сегодня использовано 0 из 10.            │       │
│ │                                  [Сохранить]          │       │
│ └───────────────────────────────────────────────────────┘       │
│ ┌ Интерфейс ─────────────────────────────── #interface ─┐       │
│ │ Эти настройки живут на месте использования:           │       │
│ │ · Язык — RU|EN в шапке   · Плотность — кнопка в шапке │       │
│ │ · Вид доски — тумблер на /tasks · Сайдбар — кнопка …  │       │
│ └───────────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────────┘
```

Стиль секций — существующий well-паттерн (`rounded-md border-border-subtle
bg-well p-4 shadow-well`, как в `ExecutionSettingsPage.tsx:114`). Единственный
акцент страницы — warning-бейдж «Движок не включён» (существующий `Badge
variant="warning"`, `AutomationPage.tsx:140`); он же несёт честность S1.

## 2. Форма «Автоматизация» — ровно по серверному контракту

| Поле | Контракт | Контрол | Валидация |
| --- | --- | --- | --- |
| Выключатель | `enabled: bool`, дефолт `false` (`store.py:4023`) | нативный `input[type=checkbox][role=switch]` + label (в `components/ui` свитча нет — не создаём библиотечный, стилизуем существующими токенами) | нет — булево |
| Дневной лимит | `cap_global_per_day: int`, `ge=1, le=1000` (`app.py:1535`), дефолт `10` (`store.py:347`) | `input[type=number][min=1][max=1000][step=1]` | клиент: целое 1..1000 → инлайн-ошибка `automation.settings.capError`; сервер: 422 текст вербатим в тост |
| Счётчик дня | `daily_used` + `daily_cap` из `GET /api/automation/status` (`app.py:3940-3941`) | read-only helper-текст под полем лимита | — |

**PUT-семантика**: одна кнопка «Сохранить» на секцию шлёт **оба** поля
(`{enabled, cap_global_per_day}` — сервер частичная: `None`-поля не трогает,
аудит только по факту изменения, `store.py:4040-4059`, так что полный payload
безопасен). `dirty`-модель — как в «Исполнении» (P3-6b): до первой правки
показаны загруженные значения; при 422 форма возвращается к загруженным
значениям, тост — серверный текст. Кнопка disabled пока `saving` либо
`isPending` загрузки. Честность S1: строфа «движок не включён» рендерится
пока `status.engine === false` (гейт `!engine`, паттерн P2-3 из
`AutomationPage.tsx:136-144`) — владелец видит, что тумблер сохраняет
намерение, а не вооружает движок сегодня.

## 3. Стейт-матрица секций (обе секции, единый контракт)

| Состояние | Условие | Вид |
| --- | --- | --- |
| loading | `isPending` запроса секции | текст `role="status"` (паттерн `automation.statusLoading`); контролы не показываются |
| error загрузки | `isError` | `EmptyState variant="error"` + кнопка «Повторить» (`common.retry`) — существующий паттерн обеих страниц |
| readonly без сессии | `useSessionControl` пуст / нет mutation-капабилити | секция читаема целиком, «Сохранить» disabled, одна строка `role="note"` `automation.mutation.disabledNote` (переиспользуем существующий ключ; ADR 0013 §8, ADR 0014) |
| no-capability | источник без agents/automation капабилити | вырождается **секция**, не страница: «Исполнение» → существующий `AgentsUnsupported`-текст; «Автоматизация» скрывается со строкой-примечанием; «Интерфейс» показывается всегда (шапка/доска существуют всюду) |
| empty | реестр исполнителей пуст | селекты с единственным «— не задан —» (сегодняшнее поведение); для автоматизации N/A — значения всегда есть |
| dirty | правка без сохранения | «Сохранить» активна; защиты навигации нет и в «Исполнении» — не добавляем (честно фиксируем как v0-ограничение) |
| saving | мутация в полёте | кнопка → «Сохраняем…», disabled |
| saved | 200 | тост-ok с detail (ключи §4); кэш инвалидируется |
| error сохранения | 4xx/422 | тост с серверным текстом вербатим; форма на загруженных значениях (P3-6b) |

## 4. Микрокопии (готовые строки; `viewer/src/i18n/ru.ts` / `en.ts`)

Существующие переиспользуем: `agents.settings.*` (`ru.ts:768-780`),
`automation.mutation.disabledNote` (`ru.ts:1053`), `common.retry`.
Новые ключи:

| Ключ | RU | EN |
| --- | --- | --- |
| `automation.settings.title` | `Автоматизация` | `Automation` |
| `automation.settings.enabledLabel` | `Автоматизация включена` | `Automation enabled` |
| `automation.settings.engineOffNote` | `Движок пока не работает (S1): настройка сохранит решение и заработает вместе с движком.` | `The engine is not running yet (S1): this preference is stored now and takes effect when the engine ships.` |
| `automation.settings.capLabel` | `Лимит авто-запусков в день` | `Daily auto-launch cap` |
| `automation.settings.capHint` | `От 1 до 1000; сегодня использовано {{used}} из {{cap}}.` | `1–1000; {{used}} of {{cap}} used today.` |
| `automation.settings.capError` | `Введите целое число от 1 до 1000.` | `Enter a whole number from 1 to 1000.` |
| `automation.settings.save` / `.saving` | `Сохранить` / `Сохраняем…` | `Save` / `Saving…` |
| `automation.settings.saved` | `Настройки автоматизации сохранены` | `Automation settings saved` |
| `automation.settings.savedDetail` | `выключатель и дневной лимит обновлены` | `kill-switch and daily cap updated` |
| `automation.settings.saveFailed` | `Не удалось сохранить настройки автоматизации` | `Failed to save automation settings` |
| `settings.hub.interfaceTitle` | `Интерфейс` | `Interface` |
| `settings.hub.interfaceHint` | `Эти настройки живут на месте использования:` | `These preferences live where you use them:` |
| `settings.hub.prefLang` | `язык — RU|EN в шапке` | `language — RU|EN in the top bar` |
| `settings.hub.prefDensity` | `плотность — кнопка в шапке` | `density — the button in the top bar` |
| `settings.hub.prefBoardStyle` | `вид доски — тумблер на странице задач` | `board style — the toggle on the tasks page` |
| `settings.hub.prefSidebar` | `сайдбар — кнопка на самом сайдбаре` | `sidebar — the button on the sidebar itself` |
| `automation.banner.settingsLink` | `изменить в настройках` | `change in Settings` |

Тон: от пользователя, активный залог, конкретика («сохранит решение», а не
«параметры будут применены»).

## 5. A11y и стиль

- **Связки формы**: каждый контрол — `label` + `htmlFor`; hint и ошибка
  лимита — `aria-describedby` (hint всегда, error при наличии), при ошибке
  `aria-invalid="true"` (WCAG 3.3.1/3.3.3, 1.3.1).
- **Свитч**: нативный checkbox c `role="switch"` и видимым текстовым
  состоянием рядом (вкл/выкл) — состояние не только цветом (1.4.1);
  клавиатура — Space, фокус-кольцо проекта (`outline-iris-bright` 2px/offset
  2, не перекрывается — 2.4.11/2.4.7).
- **Цели** ≥24×24 (2.5.8): свитч и кнопки — существующие размеры проекта
  (`h-9` контролы).
- **Иерархия**: один h1 на страницу; секции — h2 c `aria-labelledby`
  (паттерн существующей секции); якоря `#execution/#automation/#interface`
  дают deep-link вход (прицел с `/system/automation`).
- **Стиль**: ноль новых цветов/шрифтов/токенов; сетка и отступы —
  существующие `space-y`/`max-w-3xl` из `ExecutionSettingsPage.tsx:107`;
  смелость страницы — ноль (настройки не должны быть смелыми), единственный
  акцент — warning-бейдж движка.

## 6. Критерии приёмки (проверяемые, Mock-адаптер) и срез

1. `/system/settings` = ровно один h1 «Настройки» + три секции; пункт меню
   и роут не изменились (`navItems.ts:132`, `routes.tsx:277`).
2. «Исполнение»: поведение parity — существующие тесты
   `ExecutionSettingsPage.test.tsx` зелёные после выноса секции без правок
   ассертов (кроме селекторов-обёрток).
3. «Автоматизация» при загрузке показывает серверные значения (mock:
   `enabled=false`, `cap=10` — дефолты `store.py`).
4. Сохранение шлёт `PUT` c обоими полями; на сервере появляется аудит
   `automation.settings.changed` old→new (расширение
   `tests/test_api_automation.py`).
5. cap = 0 / 1001 / «abc» → инлайн-ошибка, PUT не уходит; 422 от сервера →
   тост с текстом «cap_global_per_day must be an int in 1..1000», форма на
   загруженных значениях.
6. Строфа «движок не включён» видна при `status.engine===false` и исчезает
   при `true` (unit на оба ветвления, P2-3).
7. Без сессии: обе секции читаемы, «Сохранить» disabled, одна строка
   `automation.mutation.disabledNote` (ADR 0013 §8).
8. Счётчик «сегодня использовано 0 из 10» берётся из
   `/api/automation/status` (S1: честный 0).
9. Кросс-ссылки: все четыре preference-строки ведут к реальным аффордансам
   (шапка ×2, /tasks, сайдбар); баннер `/system/automation` содержит ссылку
   «изменить в настройках» → `/system/settings#automation`.
10. A11y: label/description/error-связки, `aria-invalid`, клавиатурный
    свитч, фокус-кольца видимы, цель ≥24px, состояние свитча не только
    цветом.

**Срез (~0.3 волны, сервер не трогаем)**: (а) адаптер
`get/putAutomationSettings` + mock-паритет гейтов (типы уже запинены в
`board-openapi.d.ts`); (б) композиция хаба + вынос секции «Исполнение»;
(в) форма «Автоматизация» по §2-§3; (г) i18n §4 + ссылка в баннере
автоматизации; (д) тесты §6. Попутно одна строка: протухший докстринг
`store.py:4016` («20» → фактические 10).

**Не делаем**: миграцию preference в хаб; секции security/токены/device;
project-overrides; аудит-вьюер; редактирование правил из хаба; новые
цвета/шрифты/токены; защиту от ухода с dirty-формы; изменение
серверного контракта.

---

## Self-review дизайнера (протокол two-pass)

**Пасс 1 (план)**: хаб = Исполнение (перенос) + Автоматизация (новая форма)
+ Интерфейс (ссылки).

**Пасс 2 (самокритика)**: «не "настройки ради настроек"?» — нет: у каждой
секции есть владелец-вопрос («кто исполняет», «сколько автоматизации
позволено», «где крутить интерфейс»); миграция preference отвергнута именно
потому, что перенос контроля ради полноты страницы ломает
recognition-over-recall (настройка языка в шапке доступнее, чем в хабе).
Отвергнуто в пассе 2: тумблер на баннере `/system/automation` — дублировал
бы источник истины и ломал v1-cut ADR; одна большая форма на обе секции —
разные контракты, разные гейты ошибок; табы вместо скролла секций — три
секции не переживают таб-навигацию, скролл честнее и deep-linkable якорями.
Anti-slop: переиспользуем well-паттерн и warning-бейдж, ноль новых токенов,
идентично-карточный SaaS-кит не возникает — секции разной структуры.
**Открытые допущения**: (1) полный PUT-обеих-полей вместо диффа — при veto
владельца меняется на частичный payload, UI не меняется; (2) ссылка баннера
автоматизации — минимальная правка чужой страницы; если владелец хочет
полную ревизию баннера — отдельный проход; (3) поправка UI-рамки ADR 0013 §8
нуждается в ратификации (§1.2) — до неё тумблер не реализовывать.
