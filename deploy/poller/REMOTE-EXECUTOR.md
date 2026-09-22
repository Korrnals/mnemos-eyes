# Remote executor onboarding — VPS (enrollment runbook)

Подключение удалённого исполнителя (VPS) к борду через enrollment-флоу
(ADR 0009 Amd 2 §4 supplement, PR #46). API-уровень: UI-кнопка minting-а
появится позже — пока всё через curl. Установка самого поллера —
[README.md](README.md) (§ Установка, § systemd unit); здесь только то,
что отличается для удалённой машины.

## 1. Модель

- Исполнитель ВСЕГДА работает только на своей машине: outbound-поллинг,
  **ноль входящих портов** (ADR 0009 §9). VPS — просто второй исполнитель
  в реестре борда; разницы с ноутбуком для борда нет.
- Ноутбук не участвует в работе VPS и не хранит о нём ничего, кроме
  записи в реестре борда (`GET /api/executors`). Конфиги, секрет и
  allowlist живут только на VPS.

## 2. Сеть

- **Рекомендуемый путь — VPN-оверлей** (hysteria в этом проекте; живой
  тест планируется на VPS `vpn.us`, план E2E — борд
  `t-1790065380697-8bcf`). Требование одно: `board_url` из poller.yaml
  должен **резолвиться и отвечать с VPS** (проверка — шаг 4б).
- Альтернатива «публичная экспозиция борда» — **НЕ рекомендуется**:
  read-эндпоинты сейчас открыты (same boundary as `GET /api/board`),
  hardening-задача на борде. До её закрытия борд наружу интернета не
  выставляем.

## 3. TLS

TLS борда — лабораторный CA (self-signed). На VPS:

1. Доставь лабораторный CA-сертификат на VPS любым каналом, сверь
   fingerprint **out-of-band** (личный канал с владельцем, не по сети
   доставки файла):
   ```bash
   openssl x509 -in /etc/vesmaro/lab-ca.crt -noout -fingerprint -sha256
   # сверь вывод с владельцем борда
   ```
2. `ca_bundle` в poller.yaml **обязателен**: без него поллер пойдёт в
   системное доверенное хранилище и отвергнет лабораторный сертификат;
   путь к отсутствующему файлу — отказ старта (fail-closed, не тихое
   отключение проверки).

## 4. Enrollment-флоу (API)

Роли: **владелец** — машина с ui-токеном; **VPS** — подключаемая машина.
Все команды копипаст-безопасны — плейсхолдеры угловыми скобками, `$BOARD_URL`
в экспорте (в лабе это `https://vesmaro.abyss.lab`, с VPS — адрес,
резолвящийся через оверлей).

### 4а. Владелец: mint одноразового токена

```bash
curl -sS -X POST "$BOARD_URL/api/executors/enrollment" \
  -H "Authorization: Bearer <ui-token>" \
  -H "Content-Type: application/json" \
  -d '{"label":"vps-1","harness_hint":"zcode"}'
```

`201` → в ответе `token` (`mne_…`) и `enrollment.expires_at`. Свойства
токена: **одноразовый**, TTL **15 минут**, живых (state `created`) —
**≤ 3** (четвёртый mint → `409`). Передай `mne_…`-токен на VPS по
личному каналу. Не пригодился / протух — отозвать (idempotent, `200`;
уже использованный → `409`):

```bash
curl -sS -X DELETE "$BOARD_URL/api/executors/enrollment/<enrollment_id>" \
  -H "Authorization: Bearer <ui-token>"
```

### 4б. VPS: регистрация с enrollment-токеном

```bash
export BOARD_URL="https://<board-через-оверлей>"
curl -sS -X POST "$BOARD_URL/api/executors" \
  -H "Authorization: Bearer mne_<…>" \
  -H "Content-Type: application/json" \
  -d '{"name":"vps-1","harness":"zcode","host":"vps-1","transport":"local-poll"}'
```

`201` → `{ok, executor, executor_secret}`. **`executor_secret`
показывается ровно один раз** — сохрани сразу; `executor.id` из ответа
тоже понадобится (шаг 4в). Ошибки:

| Код | Причина |
|---|---|
| `401` | токен неизвестен (`enrollment token required or invalid`) |
| `410` | токен expired / used / revoked — причина в тексте, mint новый (4а) |
| `422` | неизвестный `harness`/`transport` |
| `409` | дубликат `name` в реестре |
| `429` | rate-limit (10/60 с) или переполнен лимит open-pending |

### 4в. VPS: конфигурация поллера

Установка поллера и юнита — [README.md](README.md) § Установка; отличия
для VPS (systemd-вариант `/opt`, не laptop user-unit):

1. Секрет → env-файл, **никогда** в конфиг и промпт (имя переменной —
   исторический контракт `CHILD_ENV_KEYS`, не переименовывать):
   ```bash
   sudo install -m 0600 -o root -g root /dev/null /etc/vesmaro/poller.env
   echo 'VESMARO_BOARD_TOKEN=<executor_secret>' | sudo tee /etc/vesmaro/poller.env >/dev/null
   ```
2. `~/.config/mnemos-eyes/poller.yaml` (chmod 0600) — ключевые поля
   относительно laptop-варианта:
   - `board_url` — адрес, резолвящийся с VPS (§2);
   - `executor_id` — **`executor.id` из ответа 4б**: presence-пиггибэк
     борда тикает `last_seen` только при совпадении токен-идентичности с
     этим полем — пустое значение = исполнитель вечно `offline`;
   - `executor_name` — `vps-1` (совпадает с `name` из 4б);
   - `ca_bundle` — путь к лабораторному CA (§3);
   - `allowlist` — см. §5.
3. Разовый dry-run до юнита: `VESMARO_BOARD_TOKEN=<executor_secret>
   python3 scripts/assignment_poller.py --once` — один цикл, без claim и
   запуска детей (см. README § Установка п.5). До approve в журнале
   будет `403` на machine-операциях — **это ожидаемо** (pending-токен не
   пускается в machine loop); сам факт, что борд отвечает, сеть
   подтверждает.

### 4г. Владелец: approve + enable (два отдельных действия)

Поллер стартовал → исполнитель появился в реестре в состоянии `pending`.
Подтверждение и включение — **разные PATCH** (approve ≠ enable;
диспетчеризация требует `approved` **И** `enabled`):

```bash
curl -sS -X PATCH "$BOARD_URL/api/executors/<executor_id>" \
  -H "Authorization: Bearer <ui-token>" -H "Content-Type: application/json" \
  -d '{"state":"approved"}'
curl -sS -X PATCH "$BOARD_URL/api/executors/<executor_id>" \
  -H "Authorization: Bearer <ui-token>" -H "Content-Type: application/json" \
  -d '{"enabled":true}'
```

`executor_id` — из реестра (`GET /api/executors`, открытое чтение) или
ответа 4б. Отзыв исполнителя — тот же PATCH c `{"state":"revoked"}`
(kill-switch: токен перестаёт пускать в machine loop немедленно).

## 5. Allowlist

Команда в локальном poller.yaml VPS должна вести на **реально
установленный** на этой машине харнес (для zcode — см. README
§ zcode launcher: полный путь к обёртке, без плейсхолдеров). Промах
`(harness, specialist)` — fail-closed: поручение остаётся `queued` в
очереди борда, на карточку уходит один refusal-report. Перед approve
прогони dry-run (4в п.3) и убедись, что решение по тестовому
назначению — «было бы запущено», а не `allowlist miss`.

## 6. Checklist верификации

1. **Реестр**: `GET /api/executors` (с любой машины) — VPS виден,
   `state: pending`.
2. **Approve + enable** (4г) — оба PATCH отдали `200`.
3. **Presence**: в реестре `presence: online` в течение минуты
   (поллер тикает ~10 с; борд считает online при тике ≤ 120 с).
   Если `offline` при живом юните — почти всегда пустой/чужой
   `executor_id` в poller.yaml (4в п.2).
4. **Сквозной тест**: назначь VPS тестовое поручение (pin на его
   `executor_id`) → в журнале поллера claim → у ребёнка heartbeat →
   на карточке финальный отчёт → задание `done`.

## 7. Ссылки

- [README.md](README.md) — установка поллера, юниты, диагностика,
  zcode launcher.
- RUNBOOK чарта §11 (`deploy/chart/vesmaro-eyes/RUNBOOK.md`) —
  конвенция helm upgrade / image.tag при апгрейдах борда.
- E2E-план живого теста на `vpn.us` — борд `t-1790065380697-8bcf`.
- ADR 0009 §9 (security contract, outbound-only) и Amd 2 §4
  (enrollment-токены) — `docs/decisions/0009-agent-bridge-assignments.md`.
