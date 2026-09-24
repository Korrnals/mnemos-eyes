---
title: Справочник конфигурации — `mesh.yaml`
---

# Справочник конфигурации — `mesh.yaml`

Каждое поле `~/.mnemos/mesh.yaml`: тип, значение по умолчанию и
описание. Имена полей следуют `internal/config/config.go`; загрузчик
сначала применяет дефолты, затем базовую структурную проверку (объём
M2). Полная валидация схемы (формы ACL, формат отпечатков, таймауты
подключения) появится в M5.

> **Аудитория:** операторы, пишущие `mesh.yaml`. Для управляемого
> первого запуска — [первый запуск](mnemos-mesh/user/getting-started).

---

## Расположение файла

| По умолчанию | Переопределение |
|---|---|
| `~/.mnemos/mesh.yaml` | `mnemos-mesh serve --config PATH` |

Если `--config` пуст, загрузчик использует `~/.mnemos/mesh.yaml`.

---

## Поля верхнего уровня

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `node_id` | string | *(обязательно)* | id пира этого узла. Привязан к CN mTLS-сертификата (критерий 3, архитектура §7). Используется как `peer_id` в проверке ACL и в `federation_access_log`. Пусто → `ErrEmptyNodeID`. |
| `listen` | string | `:8443` | Адрес gRPC-слушателя для пиров (mTLS), `host:port`. |
| `unix_socket` | string | `/run/mnemos/core.sock` | Путь Unix-сокета меш↔mnemos. Сокет создаёт меш, mnemos к нему подключается. |
| `mtls` | объект | *(обязательно)* | Настройки mTLS — ниже. |
| `peers` | список | `[]` | Реестр пиров — ниже. |
| `mnemos` | объект | *(дефолты)* | Поведение подключения меш→mnemos — ниже. |
| `logging` | объект | `info` / `json` | Уровень и формат структурированного журнала — ниже. |
| `metrics` | объект | *(пусто)* | Опциональный Prometheus-слушатель — ниже. |

---

## `mtls`

Настройки mTLS: приватный CA + зафиксированные отпечатки (критерий 3).

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `ca_cert` | string | *(обязательно)* | Путь к PEM-сертификату приватного CA. Добавляется в пул CA клиента; `ClientAuth = RequireAndVerifyClientCert`. Пусто → `ErrNoMTLSCerts`. |
| `node_cert` | string | *(обязательно)* | Путь к PEM-сертификату этого узла (клиент+сервер). CN **обязан** совпадать с `node_id`. |
| `node_key` | string | *(обязательно)* | Путь к приватному mTLS-ключу этого узла. |
| `peer_fingerprints` | map[string]string | `nil` | Зафиксированные отпечатки пиров, `peer_id → "sha256:<hex>"`. mTLS-слушатель сверяет сертификат каждого подключающегося пира с этой картой **после** проверки CA (защита от скомпрометированного CA). Пусто = только проверка CA (часть тестов M2). Битые записи → `ErrFingerprintFormat` на старте. |
| `rotation_days` | int | `90` | Период ротации сертификатов (дни). M2 читает поле, но не действует — ротация появится в M5. |

### Формат отпечатка

```text
sha256:<lowercase-hex>
```

Вычисление:

```bash
openssl x509 -in node.pem -noout -fingerprint -sha256 | sed 's/://g'
```

Уберите двоеточия и префикс `sha256 Fingerprint=`, затем добавьте
префикс `sha256:`. Загрузитель приводит hex к нижнему регистру.

---

## `peers[]`

Реестр пиров. Каждая запись описывает одного удалённого пира меша.

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `id` | string | *(обязательно)* | A2A-id пира; совпадает с привязкой CN сертификата. |
| `address` | string | *(обязательно)* | mTLS gRPC-адрес меша пира, `host:port`. |
| `fingerprint` | string | `""` | Зафиксированный отпечаток сертификата пира (`sha256:<hex>`). На этапе загрузки конфига опционален (формат проверит M5); фактическую проверку mTLS в M2 выполняет `mtls.peer_fingerprints`. |
| `projects` | list[string] | `[]` | Per-peer ACL — разрешённые проектные скоупы. Меш **передаёт** их в RPC; **проверяет** их mnemos как шлюз (критерий 5). Меш НЕ инспектирует контент ради ACL. |

> **ACL — на стороне mnemos.** Меш передаёт в RPC `peer_id` +
> `project_scope` и фильтры запроса; mnemos сверяет их со своим
> per-peer конфигом, прежде чем вернуть какую-либо запись. Не
> реализуйте проверку ACL в меше — жёсткое правило 4 в
> [CONTRIBUTING.md](https://github.com/Korrnals/mnemos-mesh/blob/331ef3a785c1a74fb9f8972ff93cd6db5a8fc174/CONTRIBUTING.md).

---

## `mnemos`

Канал меш→mnemos (W2.5: транспорт выбирается явно, ADR-0019, вариант 1).

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `transport` | string | `unix` | Транспорт ядра: `unix` (AF_UNIX-сокет на той же машине по пути `unix_socket`) или `tcp` (сетевой gRPC+mTLS). Явный выбор — **автофолбэка нет**. |
| `address` | string | `""` | Обязательно для `transport: tcp` — host:port gRPC ядра (порт mnemos-core 8790; сайдкар фазы 1 слушает `127.0.0.1`). На unix-плече отвергается. |
| `core_fingerprint` | string | `""` | Опционально (только `tcp`): зафиксировать сертификат сервера ядра, `sha256:<64 hex>` — усиление поверх обязательной проверки цепочки mesh-CA. На unix-плече отвергается. |
| `dial_timeout` | duration | `2s` | Таймаут установления соединения с локальным mnemos (Unix-сокет или TCP — по `transport`). |
| `heartbeat_interval` | duration | `30s` | Периодичность проб `Heartbeat`. M2 читает поле, но heartbeats пока не планирует (M3+). |

На tcp-плече меш предъявляет свой `mtls.node_cert` и проверяет
сертификат сервера ядра по `mtls.ca_cert` — тот же доверенный
материал, что и на пир-плече. `doctor` и `/healthz` проверяют
настроенное плечо.

Длительности — строки Go `time.Duration`: `2s`, `30s`, `1m`, `500ms`.

---

## `logging`

Уровень и формат структурированного журнала.

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `level` | string | `info` | Уровень журнала. M2 принимает `debug` / `info` / `warn` / `error`. |
| `format` | string | `json` | Формат журнала. M2 поддерживает `json`; `text` запланирован на M5. |

---

## `metrics`

Опциональный Prometheus-подобный слушатель сбора метрик.

| Поле | Тип | По умолчанию | Описание |
|---|---|---|---|
| `listen` | string | `""` | Адрес слушателя сбора, `host:port`. Пусто = выключен. Пример по умолчанию: `127.0.0.1:9100`. |

M2 метрик ещё не отдаёт — слушатель заработает в M5 (production
hardening).

---

## Дефолты

Применяются при пропущенных полях. Загрузчик заполняет дефолты
**до** структурной проверки, поэтому даже пустой файл упадёт на
`node_id` и путях mTLS-материала.

```go
Listen:     ":8443"
UnixSocket: "/run/mnemos/core.sock"
Logging:    {Level: "info", Format: "json"}
Mnemos:     {DialTimeout: 2s, HeartbeatInterval: 30s}
MTLS:       {RotationDays: 90}
```

---

## Структурные проверки (объём M2)

Загрузчик выполняет минимум структурных правил, нужный заглушке для
старта. Полная валидация (формы ACL, формат отпечатков, досягаемость
пиров) отложена на M5.

| Проверка | Ошибка при провале |
|---|---|
| `node_id` непустой | `ErrEmptyNodeID` |
| `mtls.{ca_cert, node_cert, node_key}` присутствуют | `ErrNoMTLSCerts` |
| `listen` непустой (дефолт `:8443`) | заполняется |
| `unix_socket` непустой (дефолт `/run/mnemos/core.sock`) | заполняется |
| `mnemos.dial_timeout` ненулевой (дефолт `2s`) | заполняется |
| `mnemos.heartbeat_interval` ненулевой (дефолт `30s`) | заполняется |

### Поиск пира

`cfg.PeerByID(id string) *Peer` — возвращает настроенного пира по id
или `nil`, если не найден. Используется сервером FederationPeer для
определения ACL-полей подключающегося пира.

---

## Полный пример

```yaml
# ~/.mnemos/mesh.yaml — конфигурация узла меша
node_id: mnemos-A
listen: 0.0.0.0:8443
unix_socket: /run/mnemos/core.sock

mtls:
  ca_cert: /etc/mnemos-mesh/ca.pem
  node_cert: /etc/mnemos-mesh/node.pem
  node_key: /etc/mnemos-mesh/node.key
  peer_fingerprints:
    mnemos-B: sha256:abcdef0123456789...
  rotation_days: 90

peers:
  - id: mnemos-B
    address: b.example.invalid:8443
    fingerprint: sha256:abcdef0123456789...
    projects: ["project-mnemos"]

mnemos:
  dial_timeout: 2s
  heartbeat_interval: 30s

logging:
  level: info
  format: json

metrics:
  listen: 127.0.0.1:9100
```

---

## См. также

- [Первый запуск](mnemos-mesh/user/getting-started) — управляемый разбор
- [Модель безопасности](mnemos-mesh/admin/security) — mTLS, ACL, ключи
- [Архитектура](https://github.com/Korrnals/mnemos-mesh/blob/331ef3a785c1a74fb9f8972ff93cd6db5a8fc174/docs/architecture.md) — полный дизайн системы
- [`internal/config/config.go`](https://github.com/Korrnals/mnemos-mesh/blob/331ef3a785c1a74fb9f8972ff93cd6db5a8fc174/internal/config/config.go) — исходник загрузчика
