# RUNBOOK — миграция vesmaro-eyes на Helm-chart (SRE-1, SEC-3)

- Версия чарта: 1.1.0 · кластер: k3s `abyss-ai-agent` · namespace: `kube-agents`
- Дата подготовки: 2026-09-16; все факты о кластере — живые, read-only, того же дня
- Root cause прежней схемы (hostNetwork): ADR-0004 §5 +
  [`deploy/netpol-traefik-fix.md`](../../../deploy/netpol-traefik-fix.md)

## 0. Суть изменения

| Было (голые манифесты) | Стало (Helm, SEC-3) |
|---|---|
| `hostNetwork: true`, порт 8080 на хосте 192.168.1.72 | обычный под, ClusterIP :8080, трафик только через ingress |
| ingress без TLS | `https://vesmaro.abyss.lab`, самоподписанный cert (secret `vesmaro-eyes-tls`, 825d) |
| нет `VESMARO_BOARD_TOKEN` → мутации 503 (fail-closed) | токен генерит чарт при первой установке (randAlphaNum 48, lookup-переиспользование) |
| нет pod-политики | `vesmaro-eyes-netpol`: ingress только traefik (LAN — опционально, флаг), egress DNS + mnemos:8787 + LAN:8788 |
| `kubectl apply -f` | `helm install/upgrade` + adoption существующих ресурсов |

Условие работоспособности **до** установки чарта: патч чужой политики
`agentsnode-policies` (см. `deploy/netpol-traefik-fix.md`) — иначе traefik
снова 502 на ClusterIP-бэкенде.

## 1. Почему чарт встанет «поверх» текущего деплоя (adoption)

При release name **`vesmaro-eyes`** (обязательно) имена шаблонов чарта
совпадают с уже существующими bare-ресурсами:

| Ресурс в кластере | Имя чарта (release=vesmaro-eyes) |
|---|---|
| Deployment `vesmaro-eyes` | `vesmaro-eyes` |
| Service `vesmaro-eyes` | `vesmaro-eyes` |
| Ingress `vesmaro-eyes-ingress` | `vesmaro-eyes-ingress` |
| PVC `vesmaro-eyes-data` (local-path, Bound, 27h) | `vesmaro-eyes-data` |

Данные board.db лежат в PVC — **PVC не удаляем и не пересоздаём**, данные
мигрируют автоматически; ConfigMap `vesmaro-eyes-memories` в кластере
не существует (registry уже в SQLite на PVC, сид-файл больше не нужен).

Adoption = аннотации + лейбл на 4 ресурса, затем `helm install`. Прямого
`kubectl delete deployment` можно избежать — под будет пересоздан чартом уже
без hostNetwork (короткий рестарт ~1 мин, для лабы приемлемо).

> **Запрещено:** `helm upgrade` релиза `agentsnode-mnemos` и любые изменения
> его ресурсов из этого окна. Ресурсы mnemos-пода подняты вне-helm патчем —
> `helm upgrade mnemos-чарта` откатит CPU/память на values чарта. Чарт mnemos
> в этом окне не трогаем вообще. То же касается rollback'ов чужих релизов
> (`agentsnode-policies`): только точечный netpol-патч, см. §4.

## 2. Подготовка (вне кластера)

```bash
# 2.1. Токен записи: генерируется чартом. Если нужно заранее известное
#      значение — создать секрет руками и передать его через
#      --set boardToken.existingSecret=<name> (чарт тогда не создаёт свой).
# 2.2. TLS-сертификат (мутация! выполняется в deploy-окне):
./scripts/gen-tls-secret.sh              # secret vesmaro-eyes-tls, 825d
./scripts/gen-tls-secret.sh --check      # контроль срока
# 2.3. Версии в репо — единый источник (archcom C5):
./scripts/sync-version.sh --check        # web cache-bust = Chart = values = server/app.py
```

Браузерное предупреждение о самоподписанном сертификате для `vesmaro.abyss.lab`
— **принято как норма** для lab-домена (документировано, не баг). Продление —
повторный запуск `gen-tls-secret.sh` + `helm upgrade` не требуется (secret
подхватывается ingress автоматически), но помните: срок 825d истекает
~2028-12-19 (проверка: `./scripts/gen-tls-secret.sh --check`).

## 3. Deploy-окно (мутации, порядок соблюдать)

```bash
NS=kube-agents
CHART=deploy/chart/vesmaro-eyes

# ── Шаг 1. Патч чужой netpol (детали и rollback: deploy/netpol-traefik-fix.md)
kubectl get networkpolicy agentsnode-policies -n $NS -o yaml \
  > deploy/k8s/backup-netpol-$(date +%Y%m%d-%H%M).yaml
kubectl patch networkpolicy agentsnode-policies -n $NS \
  --type=json --patch-file deploy/k8s/netpol-traefik-fix-patch.yaml

# ── Шаг 2. TLS-секрет
./scripts/gen-tls-secret.sh

# ── Шаг 3. Adoption существующих ресурсов
for res in deployment/vesmaro-eyes service/vesmaro-eyes \
           ingress/vesmaro-eyes-ingress pvc/vesmaro-eyes-data; do
  kubectl -n $NS annotate $res \
    meta.helm.sh/release-name=vesmaro-eyes \
    meta.helm.sh/release-namespace=kube-agents --overwrite
  kubectl -n $NS label $res app.kubernetes.io/managed-by=Helm --overwrite
done

# ── Шаг 4. Установка
helm install vesmaro-eyes $CHART -n $NS

# ── Шаг 5. Проверка
kubectl -n $NS rollout status deployment/vesmaro-eyes --timeout=300s
kubectl -n $NS get pods -l app.kubernetes.io/name=vesmaro-eyes -o wide
# hostNetwork=false, IP из 10.42.x:
kubectl -n $NS get deploy vesmaro-eyes -o jsonpath='{.spec.template.spec.hostNetwork}{"\n"}'

curl -ksS https://vesmaro.abyss.lab/api/health | head -c 400   # ok:true + сервера
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST https://vesmaro.abyss.lab/api/tasks -H 'Content-Type: application/json' \
  -d '{"title":"smoke"}'                                        # 201/4xx, но не 503
# 503 = VESMARO_BOARD_TOKEN не долетел до пода; 401 = токен не совпал
# (значит секрет перезаписан другим значением — см. §7).
```

Проверка mnemos-пути (побочный эффект патча, ожидаемое восстановление):
`curl -ksS https://mnemos.abyss.lab/api/...` — ingress
`agentsnode-mnemos-ingress` снова отвечает через traefik.

Проверка нетворк-изоляции борда: с pod'а борда
`kubectl -n $NS exec deploy/vesmaro-eyes -- python3 -c ...` → доступ к
`agentsnode-mnemos:8787` есть; к `10.43.x:5432`/прочим портам — нет (egress
allow-list). LAN→pod:8080 напрямую закрыт (включается флагом
`networkPolicy.ingress.allowLan.enabled=true` на время диагностик).

## 4. Rollback

**Уровень 1 — откат релиза (данные целы):**

```bash
helm history vesmaro-eyes -n $NS
helm rollback vesmaro-eyes <prev-rev> -n $NS
```

**Уровень 2 — возврат к голым манифестам (hostNetwork-схема):**

```bash
helm uninstall vesmaro-eyes -n $NS   # PVC и board-token secret НЕ удалятся (helm.sh/resource-policy: keep)
kubectl -n $NS apply -f deploy/k8s/vesmaro-eyes.yaml   # манифест оставлен в репо как аварийный
kubectl -n $NS rollout status deployment/vesmaro-eyes
```

hostNetwork-порт 8080 при откате снова займётся подом на хосте — убедитесь,
что ничто другое его не держит.

**Netpol-патч откатывается ТОЛЬКО вместе с откатом борда** (или никогда):
собственный `vesmaro-eyes-netpol` и общий `agentsnode-policies` работают как
объединение; если откатить общий патч при helm-борде на ClusterIP — traefik
снова 502. Точечная команда отката — `deploy/netpol-traefik-fix.md` §4.

## 5. Реестр секретов (инвентарь)

| Секрет | Кто владеет | Ключи | Чарт |
|---|---|---|---|
| `vesmaro-eyes-mnemos` | вне-helm, вручную (см. `deploy/k8s/vesmaro-eyes.yaml`, шапка) | `MNEMOS_TOKEN` (`mnk_…`, totp_required=0) | только читает (existingSecret) |
| `vesmaro-eyes-laptop` | вне-helm, вручную | `MNEMOS_LAPTOP_TOKEN` | только читает (existingSecret) |
| `vesmaro-eyes-board-token` | **чарт** (lookup+randAlphaNum 48, keep при uninstall) | `VESMARO_BOARD_TOKEN` | создаёт/переиспользует |
| `vesmaro-eyes-ui-token` | **чарт** (lookup+randAlphaNum 48, keep при uninstall; ADR 0009 A1) | `VESMARO_UI_TOKEN` | создаёт/переиспользует |
| `vesmaro-eyes-tls` | `scripts/gen-tls-secret.sh`, 825d | `tls.crt`/`tls.key` (self-signed) | только читает (ingress.tls) |
| `ghcr-pull` | вне-helm (registry pull) | dockerconfigjson | только читает (imagePullSecrets) |

Правила: секреты чартом никогда не печатаются в логи; `helm template`
показывает СЛУЧАЙНЫЙ board-token (lookup вне кластера пуст) — rendered-вывод
**не применять руками**; при желании зафиксировать токен заранее —
`boardToken.existingSecret`.

## 6. Два борд-токена (сплит по ADR 0009 §2 A1)

С фазы ARCH-6 (серверная часть — ARCH-4) у борда два bearer-токена вместо
одного; назначение сплита — coarse action origin: утечка machine-токена не
даёт права создавать assignments (инъекционный вектор закрыт), агент не
может минтовать назначения.

| Токен | Секрет / ключ env | Кто пользует | Что может |
|---|---|---|---|
| **ui-token** | `vesmaro-eyes-ui-token` / `VESMARO_UI_TOKEN` | UI владельца (браузер, ноутбук) | только assignment-класс: создание и отмена назначений (POST /api/assignments, cancel). Task-мутации (CRUD задач, колонки) остались на board-токене — ui-класс расширяется волной Ф3 конвергенции |
| **machine-token** (он же legacy board-token) | `vesmaro-eyes-board-token` / `VESMARO_BOARD_TOKEN` | поллер и агенты (laptop, харнесы) | claim / start / heartbeat / complete / fail, reports, move своих задач, весь остальной write-API (task CRUD — до миграции классов) |

Оба секрета создаёт чарт при первом install (randAlphaNum 48); на upgrade
значение переиспользуется через `lookup` — `helm upgrade` НИКОГДА не
регенерирует существующий токен; оба переживают uninstall/rollback
(`helm.sh/resource-policy: keep`). `helm template` рендерит случайные
значения — вывод template вручную не применять (§5).

**Получить значения** (на машине оператора; не печатать в логи/чат):

```bash
kubectl -n kube-agents get secret vesmaro-eyes-ui-token \
  -o jsonpath='{.data.VESMARO_UI_TOKEN}' | base64 -d; echo
kubectl -n kube-agents get secret vesmaro-eyes-board-token \
  -o jsonpath='{.data.VESMARO_BOARD_TOKEN}' | base64 -d; echo
```

**Legacy-режим (отсутствие ui-токена).** Если `VESMARO_UI_TOKEN` не
прокинут в контейнер, сервер обслуживает оба канала токеном
`VESMARO_BOARD_TOKEN` и пишет warning при старте. В чарте включается
флагом `--set uiToken.enabled=false` (исчезают секрет и env; сам секрет в
кластере остаётся благодаря keep). Это escape-hatch для диагностики
сплита, не штатный режим. Голый аварийный манифест
`deploy/k8s/vesmaro-eyes.yaml` не содержит ни одного токена — там
fail-closed (мутации 503), как и до сплита.

**Ротация** (каждый токен независимо; чарт переиспользует значение из
кластера, поэтому ручная запись в секрет стабильна между upgrade):

```bash
NEW=$(openssl rand -hex 24)   # 48 символов, как у чарта
kubectl -n kube-agents patch secret vesmaro-eyes-ui-token \
  -p "{\"data\":{\"VESMARO_UI_TOKEN\":\"$(echo -n "$NEW" | base64)\"}}"
kubectl -n kube-agents rollout restart deployment/vesmaro-eyes
# затем раздать новое значение потребителю:
#   ui-token    → UI владельца (браузер / конфиг на ноутбуке)
#   board-token → конфиг поллера (~/.config/mnemos-eyes/poller.yaml) + конфиги агентов
```

Порядок: ui-token — в любой момент (потребитель один, владелец);
board-token — в тихий период: пока конфиги поллера/агентов не обновлены,
их запросы получают 401 (fail-closed), «полузабранных» assignments не
возникает — claim атомарен (ADR 0009 A4). Ротация с заранее известным
значением — через `uiToken.existingSecret` / `boardToken.existingSecret`
(§2.1).

## 7. Известные риски и операционные заметки

1. **`/api/health` медленный** — на каждый проб пингуются ВСЕ серверы
   registry (кластер + ноутбук по LAN). Тайминги проб в values выставлены с
   запасом (readiness 30s/12s timeout, liveness 90s/14s, startup до 120s).
   Если ноутбук надолго уходит офлайн и проба начинает флапать — временно
   отключите сервер `laptop` в UI борда. Дешёвый `/livez` — серверная задача
   (не SRE), заведена отдельно.
2. **Upgrade чужого `agentsnode-policies` затрёт патч** — после каждого
   `helm upgrade agentsnode-policies` проверить traefik-правило
   (`deploy/netpol-traefik-fix.md` §3, шаг 2) и пере-применить. Постоянное
   решение — внести правило в values чарта в его репозитории.
3. **mnemos-чарт не трогать**: helm upgrade откатит вне-helm патч ресурсов.
4. Egress-allow-list чарта фиксирует адреса store'ов (mnemos:8787 +
   LAN:8788). Новый сервер в registry борда с другим адресом **не заработает**,
   пока не расширен `networkPolicy.egress` (values) + `helm upgrade` — это
   осознанный SEC-3 компромисс.
5. `helm uninstall` не удаляет PVC и board-token (resource-policy keep) —
   данные борда и токен переживают переустановку; полное удаление — только
   вручную и осознанно.
6. Мультисерверный registry — SQLite на PVC (ConfigMap seed нужен только
   свежим инсталляциям: `memoryRegistry.configMap.create=true` + content в
   values, монтируется в `/config`, не затирая `/data`).

## 8. Версии (archcom C5)

Единственный источник версии — `server/app.py`
(`FastAPI(title="vesmaro-eyes", version=…)`). Распространение:

```bash
./scripts/sync-version.sh          # после бампа в app.py
./scripts/sync-version.sh 1.2.0    # бамп + распространение одной командой
./scripts/sync-version.sh --check  # CI-гейт на расхождение
```

Потребители: `web/index.html` (`?v=…` cache-bust),
`deploy/chart/vesmaro-eyes/Chart.yaml` (`version` + `appVersion`),
`deploy/chart/vesmaro-eyes/values.yaml` (`image.tag`). После смены версии —
пересборка образа и `helm upgrade vesmaro-eyes deploy/chart/vesmaro-eyes -n kube-agents`.
