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
scripts/deploy.sh verify                 # сухой прогон гейтов 1-5
scripts/deploy.sh rollback <rev>         # откат на ревизию
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
   сначала repair. `--skip-history-gate` разрешён ТОЛЬКО подкоманде
   `repair`.
5. **Дрейф values**: live-значения релиза (`helm get values`) против
   git (`values.yaml` + намерение деплоя: `rootApp=app`,
   `image.tag=<текущий>`) по НЕ-секретным ключам (rootApp, image.tag,
   pollerBootstrap.caFile.enabled, networkPolicy.*, uiToken.enabled,
   memoryHostsAllowlist, ingress.* и др.). Расхождение = отказ:
   чинить надо состояние, а не протаскивать. Секретные ключи
   (existingSecret-ссылки) сверяются только по наличию ключа —
   значения не сравниваются и не печатаются.

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
```

Те же гейты (включая историю: откат по исправному релизу), затем
`helm rollback <rev> --wait --timeout 5m`, строка в JOURNAL.
Номер ревизии — `helm history vesmaro-eyes -n kube-agents`.
Откат не строит образ (только переключает релиз на существующую
ревизию).

## Repair (одноразовая выправка)

Сломанная история (`failed`/`pending-upgrade` после отвалившегося
`--atomic`) чинится:

```bash
scripts/deploy.sh repair --skip-history-gate
```

Что делает: гейты 1-3 и 5 (история пропущена флагом — это и есть
исключение), затем `helm upgrade` с ТЕКУЩИМ app-тегом из СВЕЖЕГО
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
   sync-version / реальное выравнивание values).
2. `--atomic` уже откатил неудачный upgrade — проверь
   `helm history` (последняя ревизия `deployed`?).
3. Нет — `scripts/deploy.sh repair --skip-history-gate`, затем
   разбор.
4. Лок «завис» (держатель умер): `fuser /run/vesmaro-deploy.lock`
   → pid держателя; мёртвый процесс лок освободит сам (fd закрыт
   ядром) — если не освободил, разберись с процессом, не удаляй файл
   вслепую.
