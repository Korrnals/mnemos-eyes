# Cortex Workspace — факт-файнд по механике сессий харнессов

Дата: 2026-09-22. Директива владельца: «видеть все сессии zcode/vscode/pi из одного
интерфейса И продолжать их удалённо БЕЗ дрифта — локальное открытие потом видит всё».

Это меморандум ФАКТОВ (read-only обследование), не дизайн. Дизайн — архитектор
(`docs/cortex-workspace-design.md`, ветка `docs/cortex-workspace-design`).
Секреты (токены, credentials) не вычитывались и не приводятся; структуры записей
показаны по ключам, контент транскриптов маскирован.

Обследование: ноут-хост (fedora + distrobox `ubuntu`, `vscode-box`) и кластер
k3s `abyss-ai-agent` (ns `kube-agents`, kubeconfig `~/.kube/agentsnode.yaml`).

---

## 1. Инвентарь харнессов (что реально стоит)

### Ноутбук (хост + два distrobox)

| Харнесс | Где живёт | Состояние |
|---|---|---|
| **zcode** (ZCode Electron 3.14.3 + runtime CLI 0.16.9) | distrobox `ubuntu`, `/opt/ZCode`; HOME стор в `/var/home/abyss/.distrobox/ubuntu/home/.zcode` | живой (GUI запущен, db mtime сегодня) |
| **VSCode 1.137.0 + GitHub Copilot Chat** (+ `ikaros.glm-for-vscode-copilot` — GLM-провайдер) | distrobox `vscode-box`, `~/.config/Code` (внутри бокса) | живой (chatSessions mtime сегодня) |
| **pi** (консольный агент, node v25.6.1) | distrobox `vscode-box`, `~/.pi` | установлен; активность ~до 2026-09-15/16 |
| GitHub Copilot CLI (шим в расширении) | `vscode-box`, `globalStorage/github.copilot-chat/copilotCli/` | вторичный, не глубоко (см. §4) |

Честные нули (искали — не установлены): `claude-code` (`~/.claude` нет),
`codex` (`~/.codex` нет), `gemini` (`~/.gemini` нет), `aider`, `opencode`
(`~/.config/opencode`, `~/.local/share/opencode` нет), Cursor / Windsurf /
VSCodium (`~/.config/*` нет). На хост-доме из агентного только `~/.vscode`
(пустой settings) и `~/.copilot/state/tasks` (пусто) — VSCode-данные целиком
внутри `vscode-box`.

Не харнессы (зафиксировано, чтобы не считать): `mira` — Rust-движок
виртуализации (не агент); `mira-session-archive`, `AgentsNode.worktrees`,
AutoFarm — рабочие снапшоты/репо, не сессии агентов.

### Кластер (k3s, ns `kube-agents`)

| Компонент | Факт |
|---|---|
| **hermes** (NousResearch hermes-agent) | pod `agentsnode-hermes-5ddfc94c8-mrtcs` Running (8h); данные PVC `agentsnode-hermes-data` 5Gi → `/opt/data`; backup CronJob каждые 12h → hostPath `/opt/hermes/backups` |
| mnemos | pod `agentsnode-mnemos` 2/2 Running (20h); PVC data 5Gi + vault 2Gi |
| omniroute, desktop | Running; к сессиям отношения не имеют |
| `hermes-bridge-mcp` (лаптоп, AgentsNode) | Phase 0: живой инструмент один — `hermes_recall_project`; list/get сессий + push task в очередь Hermes — ЗАПЛАНИРОВАНО (T004, ADR-0016) |

### Удалённые исполнители (vesmaro-eyes / mnemos-eyes board)

По ADR 0009/0013 (mnemos-eyes): executor — это регистрация (таблица
`executors`, ARCH-9, heartbeat `last_seen`, токены), а сессии запускаются
**обычным харнессом на хосте исполнителя**: скрипт-поллер (не модельная
сессия) опрашивает `GET /api/assignments?state=queued` (~10 c, jitter),
claim → launch. Транскриптов у борда нет; канал чекпоинтов — reports API +
SSE + history. Поле `harness` в сторе — enum-реестр: `zcode, hermes, pi,
copilot, claude-code, cursor…` (метаданные, не стор). ⇒ сессии исполнителей
= те же zcode/pi-сторы на удалённых хостах, читать надо per-host.

---

## 2. Матрица фактов

| Харнесс | Стор (фактический путь) | Формат | Session ID | Headless-возможность | Append извне | Внешняя видимость (что парсить) |
|---|---|---|---|---|---|---|
| **zcode** | `~/.zcode/cli/db/db.sqlite` (canonical; 1.65 ГБ, WAL) + `cli/exec/sess_*/call_*-stdout.log` (артефакты тула) + `cli/agents/sess_*/agent_*/` (сабагентские `metadata.json/output.txt/task.output`) + `cli/rollout/model-io-sess_*.jsonl` (сырой model IO) + `~/.zcode/v2/` (state, `tasks-index.sqlite`) | SQLite (таблицы `session`, `message`, `part`, `session_entry`, `session_input`, `todo`, `tool_usage`, `model_usage`, `turn_usage`); message/part.data = JSON | `sess_<uuid>`; сабагенты `sess_subagent_agent_<uuid>` c `parent_id` | **ДА, полный**: runtime CLI (`ELECTRON_RUN_AS_NODE=1 /opt/ZCode/zcode /opt/ZCode/resources/glm/zcode.cjs`): `-p/--prompt`, `--resume <sessionId>`, `-c/--continue` (последняя в cwd), `--mode build|edit|plan|yolo` (для -p дефолт yolo), `--json`, `--cwd`, `--surface terminal\|desktop`, `--attach`; субкоманда **`app-server`** = «Zcode Protocol stdio app server» (`--stdio`) — программируемый двусторонний драйв. Проверено headless: `commands list --json` → exit 0 | Через рантайм — ДА (headless-инстанс пишет в ту же БД, тот же session-id). Напрямую в sqlite — технически можно (WAL, busy_timeout 5000), но это схема с 22 миграциями и гонка с живым GUI; НЕ контракт | SQL read-only: `session(id,directory,title,time_*,parent_id)` — готовый список «сессия → проект → заголовок»; `message/part` — полный транскрипт; `session_entry` (workspace_checkpoint 12.5k) — чекпоинты; `session_input` — очередь вводов (status/promoted) |
| **VSCode Copilot Chat** | `~/.config/Code/User/workspaceStorage/<wsHash>/chatSessions/<uuid>.jsonl` (в vscode-box); `globalStorage/emptyWindowChatSessions/*.jsonl`; `chatEditingSessions/<uuid>/`; `state.vscdb` per-workspace; `globalStorage/github.copilot-chat/` (api.json, copilotCli-шим) | JSONL-конверт: `{"kind":0,"v":{version:3,sessionId,requests…}}` + инкрементальные `{"kind":1,"k":[…],"v":…}` | UUID = имя файла; wsHash → папка через `workspaceStorage/<hash>/workspace.json` | **НЕТ CLI**: `code --help` (1.137.0) не содержит chat/session-флагов. Продолжение — только в UI (Chat → предыдущие чаты) или через своё расширение | Формат внутренний (version-конверт), окна кэшируют в памяти; внешний append не проявится в открытом окне и не является контрактом — **продолжение извне сегодня невозможно** | Чтение тривиально: plain JSONL per session + workspace.json-маппинг папок; editing-сессии отдельными каталогами |
| **pi** | `~/.pi/agent/sessions/<mangled-cwd>/<ts>_<uuid7>.jsonl` (в vscode-box; 168 файлов) + `subagent-artifacts/*_transcript.jsonl` + `run-history.jsonl` + `context-mode/sessions/*.db` | JSONL event-log; первая запись `{"type":"session","version":"3","id","timestamp","cwd"}`; записи сцеплены `parentId` (дерево); далее `model_change`, `thinking_level_change`, … | uuid7 в имени файла И в первой записи («project session id») | **ДА, полный**: `pi -p/--print`, `-c/--continue`, `-r/--resume` (выбор), `--session <path\|id>` (частичный UUID), **`--session-id <id>` — точный ID, создаёт если нет**, `--fork`, `--session-dir <dir>`, `--mode text\|json\|rpc` (**rpc = stdio-протокол**), `-n/--name`, `--no-session` | Файл — append-only лог, внешний append технически тривиален, но записи сцеплены parentId и семантика принадлежит процессу; файловых блокировок не наблюдается; безопасный путь — драйвить сам pi (`-p --session-id <id>` / rpc) | Первая запись файла = id+cwd; имя каталога = проект; `run-history.jsonl` — сводка запусков {agent,task,taskHash,ts,status,duration} |
| **hermes (кластер)** | PVC `/opt/data`: `state.db` (sqlite: `sessions` 28, `messages` 2970, `messages_fts` FTS5, `gateway_routing`, `compression_locks`, `async_delegations`), `response_store.db`, `shared-state.db` (hosted rooms: политика+транскрипты), `kanban.db`, `sessions/` (request-дампы + `sessions.json` = LEGACY MIRROR routing-индекса), бекапы `/opt/hermes/backups` | SQLite + JSON-файлы; sessions: `id, source, user_id, session_key, chat_id, chat_type, thread_id, display_name, model, parent_session_id` (мессенджер-ориентированные) | внутренние id сессий + `session_key` (`agent:main:<platform>:…`) | Продолжение — через gateway/API (HTTP `hermes.kube-agents.svc:8642`, unix-сокет `gateway.sock`, дашборд :9119), Telegram-канал; push task в очередь — план T004 bridge | Н/П (не файловый на ноуте) — писать в живой sqlite pod'а извне = не контракт; путь — API/очередь | API/дашборд; mnemos-чекпоинты сессий (тег `hermes-default`) через `mnemos_recall_context`; бекапы hostPath; `state.db` читается read-only при exec в pod |
| **vesmaro-eyes executors** | На хостах-исполнителях — СТОЮ ЖЕ СТОРЫ zcode/pi (см. выше); у борда только реестр `executors` + `assignments(harness)` + reports/SSE | — | id сессий харнесса исполнителя | Запуск = headless-инстанс харнесса на хосте исполнителя (фактически zcode) | Как у соответствующего харнесса | per-host чтение сторов исполнителей; борд знает статус, но не транскрипты |

### Легаси/перенос zcode-сессий

Плагин `restore-legacy-sessions` (official, disabled by default): источник
ACP-эры `~/.zcode/v2/sessions/{workspaceHash}/{legacyTaskId}.json` (на этом
хосте ОТСУТСТВУЕТ — переносить нечего), приёмники —
`~/.zcode/v2/tasks-index.sqlite` и `~/.zcode/cli/db/db.sqlite`, с таймстемп-
бекапами перед записью. Факт: вендор сам считает оба стора переносимыми и
поддерживает импорт; `meta.acpSessionId` — реальный id задачи.

---

## 3. Ключевые механики для «продолжить без дрифта»

### zcode — единственный с полным контуром уже сегодня

- Продолжение с тем же id: `zcode.cjs --resume sess_<id> -p "<prompt>" --mode yolo --json`
  (или `-c` для последней в cwd) — пишет в тот же `db.sqlite`, в те же
  `session/message/part`. Локальный GUI открывает ту же сессию — дрифта нет,
  потому что стор один и home один (distrobox `ubuntu`).
- Программируемый драйв: субкоманда `app-server` (stdio, «Zcode Protocol») +
  `--surface terminal|desktop`. Это готовый транспорт для реле.
- Чекпоинты: `/fork [latest|checkpointId]`, `/rewind`, `session_entry.type=runtime/workspace_checkpoint` (12.5k записей) — есть точки ветвления/отката.
- Ограничение: стор однохостовый (файл + WAL), никакого сервера синхронизации нет ⇒ удалённое продолжение физически = запуск headless-инстанса там, где лежит `~/.zcode` (тот же distrobox/тот же home), либо экспорт-импорт.
- Наблюдение: таблица `session_input` (queued inputs, `status/promoted_*`) выглядит как входная очередь — потенциально канал «внешний актор ставит input, рантайм продвигает».

### pi — почти то же, проще формат

- `pi -p "<prompt>" --session-id <id>` — продолжить/создать с точным id;
  `--mode rpc` — stdio-драйв; `--session-dir` — переопределить каталог стора
  (можно указать на примонтированный путь). Стор — append-only JSONL с
  самоописанием в первой записи: внешний индексатор пишется тривиально.
- Формат сцеплен (`parentId`) — голый внешний append без учёта цепочки
  сломает дерево; блокировок на файлы не видно ⇒ конкурентная запись
  двух процессов в одну сессию не защищена.

### VSCode Copilot Chat — читается, не продолжается

- Внешний просмотр: парсинг `chatSessions/*.jsonl` (+ `workspace.json` для
  привязки к папке) — достаточно для «видеть все сессии».
- Продолжение извне НЕВОЗМОЖНО без нового процесса: ни CLI, ни стабильного
  формата-конверта; окно держит сессию в памяти. Варианты для архитектора:
  своё расширение VSCode (bridge), либо продолжение вести в zcode/pi, а
  vscode-сессии оставить read-only-историей.

### hermes — продолжение через API, не файлы

- Сессии в кластере (state.db в PVC), вход — Telegram / gateway API :8642 /
  очередь задач (планируемый push_task в bridge T004). Для «видеть» — API,
  дашборд, mnemos-чекпоинты и 12-часовые бекапы.

---

## 4. Ограничения обследования (честно)

- `~/.zcode/v2/credentials.json`, `auth.json` hermes, секреты kube — не читались.
- Copilot CLI-шим (`copilotCli/copilot`) не запущен: вложенный distrobox-enter
  из ubuntu-бокса падает на namespace; факт его существования и
  `copilotcli.session.metadata.json` (worktreeProperties) зафиксирован.
- Headless `-p` zcode/pi на живой модели не гонялся (политика — не жечь токены
  и не создавать сессии-мусор); проверен read-only headless-прогон
  `commands list --json` (exit 0) и полный `--help`-контракт обоих CLI.
- `--resume`-прогон не выполнялся по той же причине; контракт флага взят из
  help + grep рантайма.
- Кластер опрашивался read-only (get pods/pvc, exec ls/sqlite SELECT);
- Время актуальности: 2026-09-22 ~18:50 MSK; сессии zcode/VSCode живые
  (mtime сегодня), pi — последняя активность ~2026-09-15/16.
