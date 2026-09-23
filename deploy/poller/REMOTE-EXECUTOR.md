# Remote executor onboarding — VPS (enrollment runbook)

Подключение удалённого исполнителя (VPS) к борду через enrollment-флоу
(ADR 0009 Amd 2 §4 supplement, PR #46). Два пути:

- **Путь 1 — одна команда** (по умолчанию): борд отдаёт собственный
  установщик и рантайм-артефакты — всегда в версиях работающего борда;
- **Путь 2 — руками** (диагностика, воздушные зазоры, недоверие к
  curl-pipe): ниже, без сокращений.

Оба пути требуют enrollment-токен (одноразовый `mne_…`, TTL 15 мин,
≤3 живых) — mint из UI: Реестр → «Добавить исполнителя».

## Путь 1 — одна команда

На экране токена в UI собрана готовая строка (origin подставлен, токен
на экране маскируется — в копируемой строке он полный, копирование —
осознанный акт). С AGW-9 (АРХКОМ-8 В1) в строку вшит **якорь доверия**
`--expect-fp` — отпечаток лаб-CA в каноне борда (`ca_fingerprint` из
ответа `/api/executors/enrollment`, формат `SHA256:<base64>` — тот же,
что печатает ssh-keygen):

```bash
curl -kfsSL https://<board>/api/poller/bootstrap.sh | sudo bash -s -- \
  --url https://<board> --token mne_… \
  --expect-fp SHA256:<ca_fingerprint> [--name vps-1] [--harness zcode]
```

Якорь — принудительная сверка ДО любого пиннинга: скачанный (или
pre-placed) CA обязан дать ровно этот отпечаток, иначе установка
прерывается, скачанный CA удаляется (fail-closed). Подменённый CA
ломает установку, а не создаёт исполнителя на чужом борде. Если флаг
не передан (env-синоним: `VESMARO_EXPECT_FP`), скрипт печатает
отпечаток и требует ВВЕСТИ подтверждённое с владельцем значение в
промпте на `/dev/tty` (stdin занят пайпом установки); пустой ввод,
EOF или несовпадение — отказ. Ни якоря, ни tty (автоматический прогон)
— отказ с пояснением: unattended-установка обязана нести якорь явно.

`-k` во внешнем фетче — честно и ограниченно: текст установщика публичен
и не содержит секретов, а лаб-TLS самоподписан — оболочка ему ещё не
доверяет (курица-яйцо, которое этот скрипт существует, чтобы разорвать).
Всё, что скрипт делает дальше (артефакты, регистрация, сам поллер),
ездит на ЗАПИННЕННОМ лабораторном CA, сверином с якорем.

**Путь параноика** (не дефолт) — двухшаговый с ручной сверкой текста
САМОГО установщика перед запуском:

```bash
curl -kfsSL https://<board>/api/poller/bootstrap.sh -o bootstrap.sh
curl -kfsSL https://<board>/api/poller/artifacts/bootstrap.sh.sha256
# сверка текста установщика out-of-band (с владельцем борда):
[ "$(cat bootstrap.sh.sha256)" = "$(sha256sum bootstrap.sh | cut -d' ' -f1)" ] \
  || echo "ОТКАЗ: текст установщика не совпадает с заявленным бордом хэшем"
less bootstrap.sh   # прочитай то, что сейчас выполнишь от root
sudo bash bootstrap.sh --url https://<board> --token mne_… \
  --expect-fp SHA256:<ca_fingerprint>
```

**Остаточный риск (честная пометка):** до появления подписи установщика
окно подмены текста самого `bootstrap.sh` между фетчем и запуском НЕ
закрыто полностью — роут `bootstrap.sh.sha256` едет по тому же каналу,
что и скрипт, и защищает только от ПОСЛЕДОВАТЕЛЬНОЙ подмены (атакующий,
контролирующий канал, может подменить оба файла согласованно). Полное
закрытие — подпись установщика ключом, отличным от транспортного канала;
якорь `--expect-fp` при этом защищает самое ценное (секрет исполнителя
и пиннинг CA) уже сегодня.

`--url` — адрес, резолвящийся **с VPS** (VPN-оверлей может отличаться от
LAN-адреса борда в браузере). Скрипт сам: preflight (python ≥ 3.10,
systemd, curl, openssl, root), доставку лабораторного CA, venv + deps,
регистрацию по токену (`executor_secret` → `/etc/vesmaro/poller.env`
0600, никогда не в конфиге и не в stdout), конфиг (executor_id из ответа
— грабля №1, пустой = вечно offline), systemd system unit, вердикт
(pending → approve+enable в реестре; offline → проверь --url и
journalctl).

TLS-внутри честно: первую попытку скрипт делает в системное доверие
(машины, уже доверяющие лаб-CA, проходят без единого `-k`); если доверия
нет — РОВНО ОДИН `curl -k` повтор, только для CA (публичный материал),
с проверкой `CA:TRUE`; затем обязательный якорь `--expect-fp` (тихая
сверка) или печать отпечатка в каноне `SHA256:<base64>` + промпт на
`/dev/tty` (см. Путь 1). Всё дальнейшее (артефакты, регистрация,
поллер) ездит на ЗАПИННЕННОМ CA (fail-closed). Воздушный зазор: положите
CA руками в `/etc/vesmaro/lab-ca.crt` — `-k`-ветка внутри не выполнится
(placement — уже out-of-band акт; при заданном `--expect-fp` файл всё
равно проходит сверку).

Повторный запуск с уже потраченным токеном и существующей установкой —
**UPDATE**: свежие артефакты, пользовательский allowlist и executor_id
сохраняются (`.bak`), unit рестартует. Это же путь обновления поллера.
Ротация секрета — revoke+delete исполнителя на борде и новый запуск с
тем же `--name`.

Маркер установки: `/etc/vesmaro/poller-bootstrap.json`. Exit-коды:
0 ок · 2 аргументы · 3 окружение · 4 отказ регистрации · 5 systemd.

## Путь 2 — руками

Установка самого поллера —
[README.md](README.md) (§ Установка, § systemd unit); здесь то,
что отличается для удалённой машины и что делает руками, когда
curl-pipe не проходит.

## Путь 2, §1. Модель

- Исполнитель ВСЕГДА работает только на своей машине: outbound-поллинг,
  **ноль входящих портов** (ADR 0009 §9). VPS — просто второй исполнитель
  в реестре борда; разницы с ноутбуком для борда нет.
- Ноутбук не участвует в работе VPS и не хранит о нём ничего, кроме
  записи в реестре борда (`GET /api/executors`). Конфиги, секрет и
  allowlist живут только на VPS.

## Путь 2, §2. Сеть

- **Рекомендуемый путь — VPN-оверлей** (hysteria в этом проекте; живой
  тест планируется на VPS `vpn.us`, план E2E — борд
  `t-1790065380697-8bcf`). Требование одно: `board_url` из poller.yaml
  должен **резолвиться и отвечать с VPS** (проверка — шаг 4б).
- Альтернатива «публичная экспозиция борда» — **НЕ рекомендуется**:
  read-эндпоинты сейчас открыты (same boundary as `GET /api/board`),
  hardening-задача на борде. До её закрытия борд наружу интернета не
  выставляем.

## Путь 2, §3. TLS

TLS борда — лабораторный CA (self-signed). На VPS:

1. Доставь лабораторный CA-сертификат на VPS любым каналом, сверь
   fingerprint **out-of-band** (личный канал с владельцем, не по сети
   доставки файла). Канон борда — `SHA256:<base64>` (поле
   `ca_fingerprint` из ответа `/api/executors/enrollment`); openssl-форма
   печатается командой ниже:
   ```bash
   openssl x509 -in /etc/vesmaro/lab-ca.crt -noout -fingerprint -sha256
   # сверь вывод с владельцем борда
   ```
2. `ca_bundle` в poller.yaml **обязателен**: без него поллер пойдёт в
   системное доверенное хранилище и отвергнет лабораторный сертификат;
   путь к отсутствующему файлу — отказ старта (fail-closed, не тихое
   отключение проверки).

## Путь 2, §4. Enrollment-флоу (API)

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

`201` → в ответе `token` (`mne_…`), `enrollment.expires_at` и
`ca_fingerprint` (AGW-9) — отпечаток лаб-CA в каноне `SHA256:<base64>`
для `--expect-fp` в команде установки (пустая строка = CA не смонтирован
на борде — свери отпечаток по Путь 2 §3). Свойства
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

## Путь 2, §5. Allowlist

Команда в локальном poller.yaml VPS должна вести на **реально
установленный** на этой машине харнес (для zcode — см. README
§ zcode launcher: полный путь к обёртке, без плейсхолдеров). Промах
`(harness, specialist)` — fail-closed: поручение остаётся `queued` в
очереди борда, на карточку уходит один refusal-report. Перед approve
прогони dry-run (4в п.3) и убедись, что решение по тестовому
назначению — «было бы запущено», а не `allowlist miss`.

## Путь 2, §6. Checklist верификации

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

## §7. Ссылки

- [README.md](README.md) — установка поллера, юниты, диагностика,
  zcode launcher, bootstrap.sh (исходник установщика).
- RUNBOOK чарта §11 (`deploy/chart/vesmaro-eyes/RUNBOOK.md`) —
  конвенция helm upgrade / image.tag при апгрейдах борда.
- E2E-план живого теста на `vpn.us` — борд `t-1790065380697-8bcf`.
- ADR 0009 §9 (security contract, outbound-only) и Amd 2 §4
  (enrollment-токены) — `docs/decisions/0009-agent-bridge-assignments.md`.
