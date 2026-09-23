---
title: Развёртывание и первый запуск
slug: deploy
category: getting-started
order: 1
last_verified: "1.19.0"
---

# Развёртывание и первый запуск

Эта страница доводит борд от пустого кластера до открытого в браузере
рабочего места. Вы установите helm-чарт, получите токены, проверите
здоровье борда и сделаете первый вход. При рабочем кластере процедура
занимает 15–20 минут.

Борд — это один контейнер: сервер API, база SQLite на томе (PVC) и
интерфейс. Внешняя зависимость — один или несколько серверов памяти
mnemos, к которым борд ходит по HTTP со своим токеном `mnk_…`. Токен
никогда не покидает сервер борда.

## Что нужно до установки

- Кластер Kubernetes/K3s с Helm 3 и работающим ingress-контроллером
  (в K3s это traefik). Примеры используют namespace `kube-agents`.
- Токен сервера памяти mnemos с `totp_required=0` (значение вида
  `mnk_…`). Его выдаёт mnemos.
- Сам mnemos к этому моменту уже работает. Если это ещё не так —
  установка описана в импортированном ранбуке апстрима:
  [установка mnemos](/docs/mnemos/admin/runbooks/install).
- Адрес, по которому борд будет отвечать: далее в примерах —
  `board.example.com` (замените на свой).
- Склонированный репозиторий: чарт и скрипты лежат в нём.

## Шаг 1. Namespace и секрет с токеном mnemos

Секрет создаётся вне Helm и не удаляется вместе с релизом:

```bash
kubectl create namespace kube-agents

kubectl -n kube-agents create secret generic vesmaro-eyes-mnemos \
  --from-literal=MNEMOS_TOKEN=mnk_…
```

## Шаг 2. TLS-сертификат

Готовый скрипт создаёт самоподписанный сертификат сроком на 825 дней:

```bash
./scripts/gen-tls-secret.sh          # секрет vesmaro-eyes-tls
./scripts/gen-tls-secret.sh --check  # контроль срока — в любой момент
```

Браузерное предупреждение о самоподписанном сертификате для lab-домена —
принятое нормальное поведение, не баг. Продление — повторный запуск
скрипта; ingress подхватит новый секрет сам.

## Шаг 3. Файл значений

Сохраните как `my-values.yaml` и поправьте под себя:

```yaml
imagePullSecrets: []            # образ публичный на ghcr, логин не нужен

# Корень сайта отдаёт единое приложение (канбан, агенты, автоматизация).
rootApp: app                    # значение по умолчанию в чарте — board (старый борд)

mnemos:
  cluster:
    url: http://mnemos.memory.svc:8787   # сервисный адрес mnemos внутри кластера
  laptop:
    enabled: false              # второе (LAN) хранилище: включить + секрет

ingress:
  enabled: true
  className: traefik            # в k3s traefik уже есть; замените на свой
  host: board.example.com
  tls:
    enabled: true
    secretName: vesmaro-eyes-tls

persistence:
  storageClass: local-path      # класс хранилища кластера

# SEC-1: белый список хостов, куда борду разрешено ходить за памятью.
# Расширяйте при подключении новых хранилищ.
memoryHostsAllowlist: "mnemos.memory.svc,localhost,127.0.0.1"

# Одноразовый посев реестра хранилищ при первом старте. Дальше реестр
# живёт в базе борда и правится через API.
memoryRegistry:
  configMap:
    create: true
    content:
      servers:
        - name: main
          url: http://mnemos.memory.svc:8787
          token_env: MNEMOS_TOKEN
          primary: true

# Токен-сплит: интерфейс получает свой токен, агенты — свой.
uiToken:
  enabled: true
```

Три значения, которые чаще всего забывают: `ingress.host` (адрес борда),
`memoryHostsAllowlist` (без нужного хоста в списке хранилище не
подключится) и `mnemos.cluster.url` (адрес именно сервисный, изнутри
кластера).

## Шаг 4. Установка

Имя релиза `vesmaro-eyes` менять не стоит: от него зависят имена ресурсов,
а чарт переиспользует свои секреты между обновлениями.

```bash
helm install vesmaro-eyes deploy/chart/vesmaro-eyes \
  -n kube-agents -f my-values.yaml

kubectl -n kube-agents rollout status deployment/vesmaro-eyes --timeout=300s
```

## Шаг 5. Достаньте токены

Чарт сам генерирует токены (48 случайных символов) и переиспользует их при
каждом обновлении — в том числе после `helm uninstall`. Достаньте оба и
положите в менеджер паролей:

```bash
# токен интерфейса (мутации из UI) — его вводят в окне входа
kubectl -n kube-agents get secret vesmaro-eyes-ui-token \
  -o jsonpath='{.data.VESMARO_UI_TOKEN}' | base64 -d

# машинный токен (поллер, агенты) — см. страницу «Агенты и поручения»
kubectl -n kube-agents get secret vesmaro-eyes-board-token \
  -o jsonpath='{.data.VESMARO_BOARD_TOKEN}' | base64 -d
```

Инвентарь секретов на один взгляд:

| Секрет | Кто создаёт | Что внутри |
| --- | --- | --- |
| `vesmaro-eyes-mnemos` | оператор, вручную | токен хранилища памяти `mnk_…` |
| `vesmaro-eyes-board-token` | чарт, автоматически | машинный токен: поллер, отчёты агентов |
| `vesmaro-eyes-ui-token` | чарт при `uiToken.enabled=true` | токен мутаций интерфейса |
| `vesmaro-eyes-tls` | `scripts/gen-tls-secret.sh` | самоподписанный сертификат ingress |

Механика классов токенов и правила гигиены — на странице
[Токены и доступ](tokens.md).

## Шаг 6. Проверка

```bash
# здоровье: ok:true + список хранилищ
curl -ksS https://board.example.com/api/health | head -c 400

# дымовая мутация без токена: ожидаем 4xx/503, но не 5xx
curl -sS -o /dev/null -w '%{http_code}\n' \
  -X POST https://board.example.com/api/tasks \
  -H 'Content-Type: application/json' -d '{"title":"smoke"}'
```

- `200` у `/api/health` и `ok:true` — борд жив и видит хранилища.
- `503` на мутации — токен не долетел до пода; `401` — секрет перезаписан
  другим значением.
- `502` от ingress — сетевая политика, см.
  [Устранение неполадок](troubleshooting.md).

## Шаг 7. Первый вход

Откройте `https://board.example.com`. Примите предупреждение сертификата
(«Дополнительно → Перейти на сайт»), если браузер его покажет. Слева —
панель доменов: Обзор, Память, Задачи, Агенты, Система. Внизу панели —
версия приложения: сверьте, что она совпадает с установленным тегом.

Что делать дальше человеку за клавиатурой — [Первый вход для члена
семьи](first-login.md).

## Если кластера нет: Docker Compose

Для пробы на одной машине достаточно Docker:

```bash
git clone https://github.com/Korrnals/mnemos-eyes.git && cd mnemos-eyes
export MNEMOS_URL=http://your-mnemos-host:8787
export MNEMOS_TOKEN=mnk_…
docker compose up -d
# → http://localhost:8090
```

База при этом лежит в `./data/` и переживает пересборку контейнера.
Значение `VESMARO_BOARD_TOKEN` в compose-файле — стартовая заглушка для
разработки: для чего-либо дальше localhost подставьте своё.

## Данные и удаление

База борда живёт на PVC с политикой `helm.sh/resource-policy: keep`:
`helm uninstall` не удаляет ни данные, ни токены. Полное удаление — только
вручную и осознанно. Перед любым рискованным действием с кластером
снимайте копию — [Бэкап и восстановление](backup-restore.md).

## См. также

- [Первый вход для члена семьи](first-login.md)
- [Токены и доступ](tokens.md)
- [Обновление борда](upgrade.md)
