"""Board seed: real mnemos-eyes / vesmaro program tasks.

Task canon (GCW Task Manager style) — every task carries:
  - id          short slug (T*, RB-*, TB-*)
  - title       imperative: verb + object + purpose (RU interface, EN terms ok)
  - summary     «что и зачем» — 1–3 предложения
  - spec        контекст + acceptance criteria (чек-лист «— [ ]»)
  - agents      agent-executors (slugs)
  - specialists @GCW-роли или owner
  - env         где исполняется: cluster | laptop | local | cloud
  - project     slug проекта
  - memory_ids  реальные id памятей mnemos (лаптопный стор)
  - mnemos_tags теги по контракту tag-contract

Every ``memory_ids`` entry is a REAL mnemos memory id (verified via the
mnemos MCP channel on 2026-09-15).
"""

from __future__ import annotations

from typing import Any

SEED_VERSION = "3"

TM_STYLE = (
    "Канон таски (GCW Task Manager): title = глагол + объект + цель; "
    "summary = что и зачем; spec = контекст + acceptance criteria чек-листом."
)

SEED_TASKS: list[dict[str, Any]] = [
    {
        "id": "TB-1",
        "col": "in-progress",
        "title": "Достроить борд v0.3: центральные модалки, управление хранилищами, кластеры",
        "summary": "Операционный кокпит vesmaro-программы: задачи × статусы × агенты × среды × живая память. "
                   "v0.3 = замечания владельца от 2026-09-15: модалка задачи по центру, полный CRUD хранилищ, "
                   "кластеры памяти как интерфейсная сущность, канон тасок.",
        "spec": TM_STYLE + "\n\nКонтекст: владелец подтвердил подключение к vesmaro.abyss.lab.\n\n"
               "Acceptance criteria:\n"
               "— [x] задача открывается центральным модальным окном (правая панель — служебная)\n"
               "— [x] хранилища: окно с состоянием/подключением, add/edit/delete из UI (реестр в БД)\n"
               "— [x] действия хранилища: подключить/отключить, пауза, перезагрузка, синк, проверка\n"
               "— [x] кластеры памяти: создание/удаление групп, объединение хранилищ, merged-виды\n"
               "— [x] канон тасок применён к сиду (title/summary/spec+AC/tags)\n"
               "— [ ] фидбек владельца по v0.3",
        "agents": ["zcode"],
        "specialists": ["@GCW: Tech Lead"],
        "env": "cluster",
        "project": "mnemos-eyes",
        "memory_ids": ["25cdc0e9-1912-4217-aaf0-0e7c48912df1"],
        "mnemos_tags": ["project:mnemos-eyes", "agent:zcode", "mnemos:session"],
    },
    {
        "id": "T6",
        "col": "in-progress",
        "title": "Подключить L1 viewer к живому mnemos: HttpAdapter + auth flow",
        "summary": "Backend-гейт (CORS + auth/2FA) снят 2026-06-17. Осталось подключить HttpAdapter "
                   "к живому API с mnk_ bearer токенами и TOTP для удалённых сессий.",
        "spec": "Контекст: бэкенд-сессия mnemos завершена (HEAD 4331a22, make verify зелёный).\n\n"
               "Acceptance criteria:\n"
               "— [ ] Authorization: Bearer mnk_… работает в HttpAdapter\n"
               "— [ ] TOTP-флоу для remote-сессий (POST /auth/verify)\n"
               "— [ ] CORS allow-list включает origin вьюера\n"
               "— [ ] смоук на живом mnemos зелёный",
        "agents": ["zcode"],
        "specialists": ["@GCW: Senior Frontend Developer", "@GCW: Tech Lead"],
        "env": "cluster",
        "project": "mnemos-eyes",
        "memory_ids": ["25cdc0e9-1912-4217-aaf0-0e7c48912df1"],
        "mnemos_tags": ["project:mnemos-eyes", "agent:zcode", "mnemos:decision"],
    },
    {
        "id": "RB-1",
        "col": "blocked",
        "title": "Провести день регистраций vesmaro: org+плейсхолдеры → PyPI/npm → домены → MCP-директории",
        "summary": "Имя vesmaro подтверждено владельцем как финальное. Ждём «да» на runbook, затем "
                   "однодневное окно регистраций по фазам A→B→C→D. Репо уже перенесено в vesmaro/vesmaro.",
        "spec": "Контекст: runbook ~/.gcw/architectural-committee/2026-09-15-vesmaro-registration-runbook.md; "
               "хронология одного дня 09:00–11:00; защитный пакет vesm*-пятёрка (PyPI+npm+GH-org).\n"
               "Блокер: push токена Korrnals не имеет org vesmaro в Repository access (403).\n\n"
               "Acceptance criteria:\n"
               "— [ ] владелец дал «да» на runbook\n"
               "— [ ] фаза A: GitHub org + 5 плейсхолдеров-org\n"
               "— [ ] фаза B: PyPI+npm одним сеансом (Trusted Publishers)\n"
               "— [ ] фаза C: домены (.com+.dev минимум, Cloudflare at-cost)\n"
               "— [ ] фаза D: MCP-директории после волны доков",
        "agents": ["zcode"],
        "specialists": ["@GCW: Tech Lead", "owner"],
        "env": "laptop",
        "project": "mnemos",
        "memory_ids": [
            "86ce17e7-1099-4e94-aa1b-eba431522560",
            "bc6a6504-b269-41d2-b30f-0c28e0974efc",
            "9917a27d-5f1c-4f11-aa8b-fce513789a61",
            "754f83a7-466e-4a42-a884-76382c7ea6d4",
        ],
        "mnemos_tags": ["project:mnemos", "agent:zcode", "mnemos:decision", "naming"],
    },
    {
        "id": "RB-2",
        "col": "blocked",
        "title": "Завершить подготовительную волну ребрендинга: mis-spawn тест, плейсхолдеры, мониторинг",
        "summary": "Обязательная подготовка перед днём регистраций: LLM mis-spawn тест (4–5 моделей), "
                   "placeholder-пакеты через scripts/rebrand-placeholder.sh, еженедельный мониторинг vesm*/mnem*.",
        "spec": "Контекст: требование раунда-3 архкома; контракт 2026-09-14-mnemos-rename-contract.md.\n\n"
               "Acceptance criteria:\n"
               "— [ ] LLM mis-spawn тест 4–5 моделей пройден (однострочники)\n"
               "— [ ] placeholder-пакеты vesm*-пятёрки подготовлены\n"
               "— [ ] cron-мониторинг vesm*/mnem* настроен",
        "agents": ["zcode"],
        "specialists": ["@GCW: Tech Lead", "@GCW: Senior Security Engineer"],
        "env": "laptop",
        "project": "mnemos",
        "memory_ids": ["754f83a7-466e-4a42-a884-76382c7ea6d4"],
        "mnemos_tags": ["project:mnemos", "agent:zcode", "mnemos:decision", "rebrand-plan"],
    },
    {
        "id": "T1",
        "col": "open",
        "title": "Заскаффолдить L1 viewer: Vite + React + TS + Tailwind + shadcn",
        "summary": "Каркас приложения по docs/architecture.md: ESLint/Prettier, структура папок, "
                   "коммит «chore: scaffold L1 viewer». Борда v0 остаётся операционным кокпитом.",
        "spec": "Контекст: React 19 + Vite + TanStack Query v5; дизайн-токены уже проверены на борде.\n\n"
               "Acceptance criteria:\n"
               "— [ ] структура папок = docs/architecture.md §2\n"
               "— [ ] ESLint+Prettier зелёные\n"
               "— [ ] dev-server поднимается, IrisLogo виден",
        "agents": ["zcode"],
        "specialists": ["@GCW: Senior Frontend Developer"],
        "env": "laptop",
        "project": "mnemos-eyes",
        "memory_ids": ["25cdc0e9-1912-4217-aaf0-0e7c48912df1"],
        "mnemos_tags": ["project:mnemos-eyes", "agent:zcode", "mnemos:session"],
    },
    {
        "id": "T2",
        "col": "open",
        "title": "Реализовать MemoryGateway: HttpAdapter + MockAdapter по ADR 0002",
        "summary": "Изолированный слой данных: MockAdapter с фикстурами позволяет строить UI до "
                   "полного бэка; DI на бутстрапе; свап адаптеров через env/Tauri-детект.",
        "spec": "Контекст: gateway-интерфейс в docs/architecture.md §4.\n\n"
               "Acceptance criteria:\n"
               "— [ ] интерфейс MemoryGateway соответствует спецификации\n"
               "— [ ] MockAdapter покрывает все L1-вью фикстурами\n"
               "— [ ] DI на бутстрапе, ни одного fetch вне gateway/",
        "agents": ["zcode"],
        "specialists": ["@GCW: Senior Frontend Developer"],
        "env": "laptop",
        "project": "mnemos-eyes",
        "memory_ids": [],
        "mnemos_tags": ["project:mnemos-eyes", "agent:zcode", "mnemos:session"],
    },
    {
        "id": "T4",
        "col": "open",
        "title": "Перенести дизайн-систему в код: токены, темы, IrisLogo, breathing",
        "summary": "Токены (teal iris / gold confidence / Lora) из docs/design-system.md в "
                   "src/styles/tokens.css; IrisLogo + дыхание 3s с reduced-motion.",
        "spec": "Контекст: токены уже обкатаны на борде v0 (obsidian well).\n\n"
               "Acceptance criteria:\n"
               "— [ ] tokens.css = design-system.md без расхождений\n"
               "— [ ] тёмная/светлая темы переключаются, выбор персистится\n"
               "— [ ] не больше 1 ambient-анимации одновременно",
        "agents": ["zcode"],
        "specialists": ["@GCW: Senior Frontend Developer"],
        "env": "laptop",
        "project": "mnemos-eyes",
        "memory_ids": [],
        "mnemos_tags": ["project:mnemos-eyes", "agent:zcode", "mnemos:session"],
    },
    {
        "id": "T3",
        "col": "open",
        "title": "Включить codegen openapi-typescript из mnemos /openapi.json",
        "summary": "scripts/codegen.sh на живую схему; сгенерированные типы коммитятся; "
                   "CI-гард на дрейф схемы.",
        "spec": "Acceptance criteria:\n"
               "— [ ] npx openapi-typescript … --immutable-types отрабатывает\n"
               "— [ ] src/types/openapi.d.ts закоммичен, «DO NOT EDIT» шапка\n"
               "— [ ] CI падает при расхождении схемы",
        "agents": ["zcode"],
        "specialists": ["@GCW: Senior Frontend Developer"],
        "env": "laptop",
        "project": "mnemos-eyes",
        "memory_ids": [],
        "mnemos_tags": ["project:mnemos-eyes", "agent:zcode", "mnemos:session"],
    },
    {
        "id": "T5",
        "col": "open",
        "title": "Собрать L1 страницы по component-inventory на MockAdapter",
        "summary": "Поиск (FTS+semantic), список памятей, «свиток» детали, инспектор тегов, "
                   "панель статуса, A2A-сессии, трейсы, empty/loading/error, layout+IrisLogo.",
        "spec": "Контекст: 30+ компонентов в docs/component-inventory.md; lazy-роуты.\n\n"
               "Acceptance criteria:\n"
               "— [ ] все L1-компоненты реализованы и работают на MockAdapter\n"
               "— [ ] staleTime-таблица из architecture.md §6 применена\n"
               "— [ ] навигация без layout-shift",
        "agents": ["zcode"],
        "specialists": ["@GCW: Senior Frontend Developer"],
        "env": "laptop",
        "project": "mnemos-eyes",
        "memory_ids": [],
        "mnemos_tags": ["project:mnemos-eyes", "agent:zcode", "mnemos:session"],
    },
    {
        "id": "T7",
        "col": "open",
        "title": "Прогнать a11y-аудит (WCAG 2.2 AA) и perf-бюджет на L1",
        "summary": "Скиллы a11y-audit + frontend-perf-budget на страницах L1; "
                   "фиксы по находкам без подавлений.",
        "spec": "Acceptance criteria:\n"
               "— [ ] WCAG 2.2 AA — ноль критических находок\n"
               "— [ ] perf-бюджет соблюдён (размер чанков, LCP)\n"
               "— [ ] lint-подавлений нет — только исправления",
        "agents": ["zcode"],
        "specialists": ["@GCW: Senior Frontend Developer"],
        "env": "laptop",
        "project": "mnemos-eyes",
        "memory_ids": [],
        "mnemos_tags": ["project:mnemos-eyes", "agent:zcode", "mnemos:session"],
    },
    {
        "id": "MSH-1",
        "col": "open",
        "title": "Связать сторы laptop⇄cluster федерацией mnemos-mesh",
        "summary": "Оба стора уже видны борду как отдельные серверы; federation даст сквозные "
                   "ссылки на памяти (RB-1/RB-2 перестанут показывать 404 в кластерном борде).",
        "spec": "Контекст: mnemos-mesh (Go) в ../mnemos-mesh; у обоих сторов включён auth; "
               "лаптопный LAN-бинд 8788 с токеном vesmaro-eyes-board.\n\n"
               "Acceptance criteria:\n"
               "— [ ] peer-пара laptop⇄cluster зарегистрирована\n"
               "— [ ] контрольный seed виден с обеих сторон\n"
               "— [ ] drawer RB-1 резолвит 4 памяти без 404",
        "agents": ["zcode"],
        "specialists": ["@GCW: Senior System Engineer", "@GCW: SRE/DevOps"],
        "env": "cluster",
        "project": "mnemos-mesh",
        "memory_ids": [],
        "mnemos_tags": ["project:mnemos-mesh", "agent:zcode", "mnemos:open-question"],
    },
]