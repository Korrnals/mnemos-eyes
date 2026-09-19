# Assignment poller — deploy & runbook (ADR 0009 phase 2, ARCH-5)

Лаптоп-нога agent-bridge: детерминированный диспетчер, который забирает
`queued`-назначения с борда и запускает локальные harness-процессы по
allowlist. Никакого LLM в решении о запуске нет — только точный матч
`(harness, specialist) → command` из локального конфига (A3).

```
board (vesmaro.abyss.lab)                 laptop
┌──────────────────────────┐   outbound HTTPS only (§9)
│ POST /api/assignments    │◄──────────────────────── poller (10 с ± 2 с)
│ claim/start/heartbeat/   │─────────────────────────► claim_token + snapshot
│ complete/fail + reports  │◄───────────────────────── heartbeats 60 с
└──────────────────────────┘                            complete/fail по exit
        │                                                │ envelope (stdin)
        │ SSE/UI badge                                   ▼
        ▼                                          harness subprocess
```

## Состав

| Файл | Назначение |
|---|---|
| `scripts/assignment_poller.py` | сам поллер (единственный исполняемый файл) |
| `poller.example.yaml` | пример конфига → `~/.config/mnemos-eyes/poller.yaml` (chmod 0600) |
| `vesmaro-assignment-poller.service` | systemd unit, `Restart=always` |
| `~/.local/state/mnemos-eyes/poller-audit.jsonl` | локальный аудит-лог запусков (создаётся сам) |
| `~/.local/state/mnemos-eyes/poller.lock` | flock-синглтон (создаётся сам) |

## Установка

1. Зависимости (python ≥ 3.10): `pip install --user httpx pyyaml`.
2. Конфиг:
   ```bash
   mkdir -p ~/.config/mnemos-eyes
   cp poller.example.yaml ~/.config/mnemos-eyes/poller.yaml
   chmod 0600 ~/.config/mnemos-eyes/poller.yaml
   $EDITOR ~/.config/mnemos-eyes/poller.yaml   # board_url, executor_name, allowlist
   ```
   TLS борда — лабораторный self-signed: положи CA в
   `~/.config/mnemos-eyes/lab-ca.crt` (ключ `ca_bundle` в конфиге; путь к
   отсутствующему файлу = отказ старта, а не тихое отключение проверки).
3. Токен — ТОЛЬКО окружение, никогда в конфиге и никогда в промпте агента:
   ```bash
   sudo install -m 0600 -o root -g root /dev/null /etc/vesmaro/poller.env
   echo 'VESMARO_BOARD_TOKEN=<machine-token>' | sudo tee /etc/vesmaro/poller.env >/dev/null
   ```
4. Скрипт и unit:
   ```bash
   sudo mkdir -p /opt/mnemos-eyes && sudo cp scripts/assignment_poller.py /opt/mnemos-eyes/
   sudo cp vesmaro-assignment-poller.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now vesmaro-assignment-poller
   ```
5. Проверка: `journalctl -u vesmaro-assignment-poller -f` — строка
   `poller start: board=… executor=… allowlist=N entr(y/ies)`.

Разовый прогон без systemd: `VESMARO_BOARD_TOKEN=… python3
scripts/assignment_poller.py --once` — **dry-run**: один цикл, по каждому
queued-назначению логируется решение (было бы запущено / allowlist miss),
без claim, без запуска детей и без мутаций борда (ребёнок, переживший
процесс, оставил бы claim_token в никуда).

## Окружение дочерних процессов

Дети запускаются с минимальным env (ADR 0009 §9, непривилегированный
профиль): только `PATH`, `HOME`, `TMPDIR`, `LANG` и
`VESMARO_BOARD_TOKEN`. Токен передаётся намеренно — блок REPORTS в
envelope требует от агента самостоятельной отправки отчётов; это
единственный креденшл, который получает ребёнок. SSH_AGENT, cloud-creds
и прочий user-env наследоваться НЕ должны. Расширять список
(`CHILD_ENV_KEYS` в `scripts/assignment_poller.py`) можно только
осознанно: каждый добавленный ключ выдаётся всем автозапускаемым
агентам из allowlist.

## Что делает поллер

- каждые 10 с (±2 с джиттер) читает `GET /api/assignments?state=queued`;
- allowlist-матч `(harness, specialist)`: промах → **skip + log + один
  refusal-report** на карточку задачи, назначение остаётся `queued`
  (fail-closed, A3);
- claim (machine-токен), в claim идёт собственный `executor_id` из
  конфига (пуст до ARCH-9) — пин назначения никогда не пробрасывается;
  из ответа берёт `claim_token` и `spec_snapshot` — работает ТОЛЬКО со
  снапшотом, живой spec не читает (A2);
- рендерит assignment envelope (ADR 0009 §5) и передаёт её агенту данными
  (stdin или `{envelope_file}`) — без shell-интерполяции содержимого spec;
- `start`, затем heartbeat каждые 60 с **от поллера**, пока процесс жив;
  409 на heartbeat (reaper/cancel опередили) → kill дочернего процесса;
- exit 0 → `complete`; если агент не написал свой final-report — поллер
  ставит fallback `exit 0, agent report above`; exit ≠0 → `fail` с
  `process exit N: <хвост stderr>`;
- на старте — recovery sweep: свои `claimed|running` FAIL-ятся
  **безусловно** (после рестарта claim_token-ы утеряны, завершить их
  некому — окно at-most-once закрывается здесь; проверки живости нет);
  если аудит-лог помнит pid и он всё ещё похож на нашу команду (точное
  совпадение argv0), сирота получает SIGTERM best-effort.

## Диагностика

| Симптом | Причина | Что смотреть |
|---|---|---|
| задания копятся в `queued`, возраст растёт | поллер не запущен / падает | `systemctl status vesmaro-assignment-poller`, `journalctl -u … -n 100` |
| `queued` висит, в журнале `allowlist miss` | specialist/harness не в локальном allowlist | `~/.config/mnemos-eyes/poller.yaml`, refusal-report на карточке |
| `queued` висит, `401` в журнале | неверный/протухший machine-токен | `/etc/vesmaro/poller.env`, токен в чарте |
| `claimed`/`running` висит после рестарта поллера | sweep не отработал | аудит-лог `outcome: sweep-failed`; `journalctl` строки `recovery sweep` |
| `running` без heartbeat > 30 мин | агент-процесс завис | heartbeat-409 kill; до фазы 3 (reaper) — `systemctl restart`, sweep закроет |
| `exit ...` в `failed`-причине | агент упал | хвост stderr в причине fail, полный лог — временные файлы удаляются после отчёта |
| второй инстанс не стартует, `rc=3` | flock-синглтон держит | `lsof ~/.local/state/mnemos-eyes/poller.lock` |

Аудит-лог (одна JSON-строка на событие):
`{ts, assignment_id, specialist, spec_hash, pid, outcome}` где outcome =
`launched | complete | failed | killed-409 | sweep-failed | refused |
launch-error | start-failed | unreported`.

## Безопасность

- machine-токен: только env (`VESMARO_BOARD_TOKEN`), 0600 на
  `/etc/vesmaro/poller.env`; в конфиге, промпте и логах его нет (в промпте
  названа только переменная окружения — значение наследуется процессом).
- весь трафик инициирует лаптоп (outbound HTTPS); входящего канала
  исполнения нет (ADR 0009 §9).
- команда запуска — argv-список из доверенного конфига; spec передаётся
  данными, shell не участвует.
- identity на HTTP-слое — declared/unverified (ADR 0009 §8): per-executor
  токены появляются по триггеру T1–T3 (ARCH-9).

## Известные ограничения (v0)

- Доставка at-most-once: погибший поллер = задания видимо сидят в
  `queued` (возраст виден в UI) — это диагностируемо, не тихо.
- Рестарт поллера убивает судьбу текущих запусков: sweep FAIL-ит их
  (claim_token утерян, завершить их корректно невозможно). Долгие задачи
  перезапускаются повторным назначением.
- mesh-транспорт (Amendment 2 §2) — задел: `board_url` это просто base URL,
  код не различает прямой HTTPS и локальный mesh-эндпоинт.
