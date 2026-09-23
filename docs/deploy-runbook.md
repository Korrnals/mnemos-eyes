# Deploy runbook — единственная дверь в прод (AGW-10, АРХКОМ-8 В3)

Любое изменение борда в проде проходит через **`scripts/deploy.sh`**.
Ручные `helm upgrade` / `podman build` мимо обёртки запрещены: каждый
инцидент деплоя (2026-09-21 формальный апгрейд без смены образа,
фолбэки rootApp 1.11.x–2026-09-22) был именно «руками, в обход».

Чарт-RUNBOOK (`deploy/chart/vesmaro-eyes/RUNBOOK.md` §11) остаётся
справочником по СЕМАНТИКЕ (почему `-f values.yaml --set image.tag
--set rootApp=app --atomic` в каждом апгрейде) — обёртка реализует её
механически и добавляет гейты.

## Команды

```bash
scripts/deploy.sh deploy                 # обычный деплой (дефолт)
scripts/deploy.sh deploy --allow-drift "<причина>"   # деплой с прощением
                                          # не-секретного дрейфа values
                                          # (НЕ нужен для релизного бампа —
                                          # см. гейт 5)
scripts/deploy.sh verify                 # сухой прогон гейтов 1-5
scripts/deploy.sh rollback <rev> [--skip-history-gate]   # откат на ревизию
scripts/deploy.sh repair [--skip-history-gate]   # выправка состояния
```

### Одним движением (pull + запуск)

Main едет между подготовкой и запуском — гейт 1 честно откажет, но
переподготовка операционно дорога. Запускай деплой одной командой,
чтобы между fetch и запуском не было зазора:

```bash
# из основного чекаута (владеет main):
git pull --ff-only origin main && scripts/deploy.sh deploy
# из worktree (не владеет main — гейт 1 требует лишь HEAD == origin/main):
git fetch origin && git switch --detach origin/main && scripts/deploy.sh deploy
```

Грязное дерево / незакоммиченные правки откажут раньше гейта 1 — это
штатно: коммить или стэшь.

## Гейты (порядок фиксирован)

1. **Preflight**: `git fetch origin`; HEAD обязан равняться
   `origin/main`, рабочее дерево чистое. Деплоится ровно то, что в
   main — никаких локальных правков и боковых веток.
2. **Версионный дрейф**: `scripts/sync-version.sh --check` — app.py,
   Chart.yaml и image.tag согласованы (archcom C5).
3. **Лок**: `flock -n /run/vesmaro-deploy.lock` — один деплой в момент
   времени; повторный запуск отказывает и называет держателя (pid +
   имя процесса), если тот определим. Протокол не дедлокируется: лок
   освобождается по выходу (trap). `/run` обычно не пишется без sudo:
   либо один раз создать файл
   `sudo install -m 0666 /dev/null /run/vesmaro-deploy.lock`, либо
   скрипт сам откатится на `$XDG_RUNTIME_DIR` с WARNING
   (сериализация тогда best-effort). Явный `VESMARO_DEPLOY_LOCK`
   не переспрашивается.
4. **История helm**: последняя ревизия релиза обязана быть
   `deployed`. Деплой поверх `failed`/`pending-upgrade` запрещён —
   сначала rollback/repair. `--skip-history-gate` разрешён ТОЛЬКО
   подкомандам `repair` и `rollback`.
5. **Дрейф values**: live-значения релиза (`helm get values`) против
   git (`values.yaml` + намерение деплоя: `rootApp=app`,
   `image.tag=<текущий>`) по НЕ-секретным ключам (rootApp, image.tag,
   pollerBootstrap.caFile.enabled, networkPolicy.*, uiToken.enabled,
   memoryHostsAllowlist, ingress.* и др.). Расхождение = отказ:
   чинить надо состояние, а не протаскивать.
   **Прощение релизного бампа** (бой 1.33.0, rev 67→68): при любом
   бампе версии live по определению несёт СТАРЫЙ тег — гейт сам
   узнаёт предыдущий релиз: дрейф ТОЛЬКО по `image.tag`, где live-тег
   равен appVersion текущей deployed-ревизии (`helm history`),
   прощается автоматически (лог `WAIVED — previous release, not manual
   drift`, в JOURNAL уходит нота `auto-waived`). Ручной `--set`
   постороннего тега и дрейф любых других ключей — отказ как раньше.
   Единственный аудируемый обход для них — `deploy --allow-drift
   "<причина>"` (см. «Откат»): прощает ТОЛЬКО не-секретный дрейф, все
   остальные гейты работают как обычно. Секретные ключи
   (existingSecret-ссылки) сверяются только по наличию ключа —
   значения не сравниваются и не печатаются; их дрейф не прощается
   вовсе.

После гейтов `deploy` строит и пушит образ
(`distrobox-host-exec podman`, тег из values/appVersion), делает
`helm upgrade … --atomic` и пишет строку в JOURNAL.

## JOURNAL (аудит-след)

`deploy/JOURNAL.md` — append-only, коммитится в репо. Формат строки:

```
дата-время | актор | действие | rev до>после | image tag | chart version | HEAD sha
```

- «актор» — ОС-пользователь, запустивший скрипт (`id -un`@`hostname -s`),
  а НЕ git-identity (`user.name`): деплой делает живой оператор или
  сессия, а не автор последнего коммита. Переопределяется
  `VESMARO_DEPLOY_ACTOR` для сессий/CI; SHA и ревизии всегда в строке —
  кто и что выехало.
- Коммит журнала уходит в main как `HEAD:main` — деплой из worktree с
  detached HEAD (не владеющего веткой main) всё равно доставляет
  строку в origin/main.
- JOURNAL читается как журнал расследований: хронология ревизий
  релиза против коммитов main.

## Откат

```bash
scripts/deploy.sh rollback <rev>
# если последняя ревизия failed/pending-upgrade (после отвалившегося
# --atomic) — откат на последнюю хорошую с явным пропуском гейта истории:
scripts/deploy.sh rollback <rev> --skip-history-gate
```

Те же гейты, затем `helm rollback <rev> --wait --timeout 5m`, строка в
JOURNAL. `--skip-history-gate` для rollback разрешён явно: откат на
ИЗВЕСТНУЮ хорошую ревизию — штатное восстановление при сломанной
истории (`deploy` и `verify` флаг по-прежнему не принимают). Номер
ревизии — `helm history vesmaro-eyes -n kube-agents`.
Откат не строит образ (только переключает релиз на существующую
ревизию). Тег в JOURNAL-строке берётся из live-значений целевой
ревизии (`helm get values --revision`), а не из git — журнал фиксирует,
что реально крутится, а не что в main.

### Жизнь после отката и релизный бамп

**Релизный бамп НЕ требует `--allow-drift`.** Бой 1.33.0 (rev 67→68)
вскрыл дизайн-баг: при любом смене версии live по определению несёт
старый тег, и гейт 5 отказывал на каждом релизе, превращая
исключение в рутину. Теперь гейт сам узнаёт предыдущий релиз: если
единственный дрейф — `image.tag`, и live-тег равен appVersion текущей
deployed-ревизии (`helm history`), деплой проходит БЕЗ флага — с
логом `WAIVED — previous release, not manual drift` и аудит-нотой
`auto-waived` в JOURNAL-строке. Ручной `--set` постороннего тега
(live ≠ appVersion deployed-ревизии) — отказ как раньше.

`--allow-drift` остаётся для НАСТОЯЩИХ исключений:

**После `rollback <rev>`** live-релиз законно несёт values СТАРОЙ
ревизии (прошлый `rootApp` и т.п.) — следующий обычный `deploy`
увидит дрейф против git и откажет. Это не тупик:

- `repair` не пересобирает образ — нужного тега может не быть в
  registry, а «закоммитить старые значения в git» ломает сам смысл
  гейта 5;
- дрейф `image.tag` после отката гейт прощает сам (см. выше);
  остальное (например, легаси `rootApp=board` у ревизии до эпохи
  `rootApp=app`) закрывается явным флагом:

```bash
scripts/deploy.sh deploy --allow-drift "выравниваю прод после rollback 41->39: live нёс rootApp=board"
```

Правила флага:

- прощает ТОЛЬКО отказ по разошедшимся не-секретным ключам; все
  остальные гейты (preflight, версия, лок, история) работают как
  обычно;
- дрейф секретных ключей (пропавший existingSecret и т.п.) не
  прощается никогда;
- причина ОБЯЗАНА быть непустой и пишется в JOURNAL-строку
  (`allow-drift: <причина>`) — анонимных прощений не бывает;
- разрешён только подкоманде `deploy` (verify/rollback/repair —
  ошибка аргументов).

Дальше деплой как обычно строит/пушит текущий образ и
`helm upgrade --atomic` выравнивает live к git.

## Repair (одноразовая выправка)

Сломанная история (`failed`/`pending-upgrade` после отвалившегося
`--atomic`) чинится:

```bash
scripts/deploy.sh repair --skip-history-gate
```

Что делает: гейты 1-3 и 5 (история пропущена флагом — исключение,
доступное repair и rollback), затем `helm upgrade` с ТЕКУЩИМ app-тегом из СВЕЖЕГО
чарта main (образ НЕ пересобирается — тег обязан уже жить в
registry), строка `repair` в JOURNAL. Это не «деплой новых фич», это
выравнивание chart/appVersion состояния. После repair — разбери
причину исходного падения по JOURNAL и `helm history`.

## Ручки окружения (ops/тесты, префикс VESMARO_DEPLOY_)

`GIT`, `HELM`, `SYNC_VERSION`, `PODMAN_HOST`, `LOCK`, `JOURNAL`,
`ACTOR`, `PYTHON`, `RELEASE`, `NAMESPACE`. Продуктовые значения —
дефолты скрипта; ручки нужны тестам (`tests/test_deploy_gates.py`,
фейковые git/helm/podman) и нестандартным окружениям.

## Чек-лист «деплой упал»

1. Прочитать отказ — гейты называют причину и средство (repair /
   sync-version / реальное выравнивание values / allow-drift).
2. `--atomic` уже откатил неудачный upgrade — проверь
   `helm history` (последняя ревизия `deployed`?).
3. Нет — откат на последнюю хорошую ревизию
   `scripts/deploy.sh rollback <rev> --skip-history-gate` либо
   `scripts/deploy.sh repair --skip-history-gate`, затем разбор.
4. После rollback следующий деплой упрётся в дрейф values (кроме
   `image.tag` — его гейт прощает сам как предыдущий релиз):
   `scripts/deploy.sh deploy --allow-drift "<причина>"`.
5. Лок «завис» (держатель умер): `fuser /run/vesmaro-deploy.lock`
   → pid держателя; мёртвый процесс лок освободит сам (fd закрыт
   ядром) — если не освободил, разберись с процессом, не удаляй файл
   вслепую. Если лок ушёл в fallback (`$XDG_RUNTIME_DIR` с WARNING)
   — ищи файл там же.
