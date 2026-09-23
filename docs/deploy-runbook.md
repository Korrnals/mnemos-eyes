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
scripts/deploy.sh verify                 # сухой прогон гейтов 1-5
scripts/deploy.sh rollback <rev> [--skip-history-gate]   # откат на ревизию
scripts/deploy.sh repair [--skip-history-gate]   # выправка состояния
```

## Гейты (порядок фиксирован)

1. **Preflight**: `git fetch origin`; HEAD обязан равняться
   `origin/main`, рабочее дерево чистое. Деплоится ровно то, что в
   main — никаких локальных правков и боковых веток.
2. **Версионный дрейф**: `scripts/sync-version.sh --check` — app.py,
   Chart.yaml и image.tag согласованы (archcom C5).
3. **Лок**: `flock -n /run/vesmaro-deploy.lock` — один деплой в момент
   времени; повторный запуск отказывает и называет держателя (pid +
   имя процесса), если тот определим. Протокол не дедлокается: лок
   освобождается по выходу (trap).
4. **История helm**: последняя ревизия релиза обязана быть
   `deployed`. Деплой поверх `failed`/`pending-upgrade` запрещён —
   сначала rollback/repair. `--skip-history-gate` разрешён ТОЛЬКО
   подкомандам `repair` и `rollback`.
5. **Дрейф values**: live-значения релиза (`helm get values`) против
   git (`values.yaml` + намерение деплоя: `rootApp=app`,
   `image.tag=<текущий>`) по НЕ-секретным ключам (rootApp, image.tag,
   pollerBootstrap.caFile.enabled, networkPolicy.*, uiToken.enabled,
   memoryHostsAllowlist, ingress.* и др.). Расхождение = отказ:
   чинить надо состояние, а не протаскивать. Единственный
   аудируемый обход — `deploy --allow-drift "<причина>"` (см.
   «Откат»): прощает ТОЛЬКО не-секретный дрейф, все остальные гейты
   работают как обычно. Секретные ключи (existingSecret-ссылки)
   сверяются только по наличию ключа — значения не сравниваются и не
   печатаются; их дрейф не прощается вовсе.

После гейтов `deploy` строит и пушит образ
(`distrobox-host-exec podman`, тег из values/appVersion), делает
`helm upgrade … --atomic` и пишет строку в JOURNAL.

## JOURNAL (аудит-след)

`deploy/JOURNAL.md` — append-only, коммитится в репо. Формат строки:

```
дата-время | актор | действие | rev до>после | image tag | chart version | HEAD sha
```

- «актор» — `user@host` (переопределяется `VESMARO_DEPLOY_ACTOR` для
  сессий/CI; SHA и ревизии всегда в строке — кто и что выехало).
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

### Жизнь после отката: `deploy --allow-drift "<причина>"`

После `rollback <rev>` live-релиз законно несёт values СТАРОЙ
ревизии (прошлый `image.tag`, прошлый `rootApp`) — следующий обычный
`deploy` увидит дрейф против git и откажет. Это не тупик:

- `repair` не пересобирает образ — нужного тега может не быть в
  registry, а «закоммитить старые значения в git» ломает сам смысл
  гейта 5;
- поэтому единственный аудируемый обход — явный флаг:

```bash
scripts/deploy.sh deploy --allow-drift "выравниваю прод после rollback 41->39: live нёс tag 1.31.0/rootApp=board"
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
4. После rollback следующий деплой упрётся в дрейф values — это
   ожидаемо: `scripts/deploy.sh deploy --allow-drift "<причина>"`.
5. Лок «завис» (держатель умер): `fuser /run/vesmaro-deploy.lock`
   → pid держателя; мёртвый процесс лок освободит сам (fd закрыт
   ядром) — если не освободил, разберись с процессом, не удаляй файл
   вслепую.
