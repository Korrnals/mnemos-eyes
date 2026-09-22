# Enrollment удалённых исполнителей — серверный контракт (фаза 1)

- Статус: **Accepted** (владелец, 2026-09-22; реализация — ветка
  `feat/enrollment-server`)
- Дополняет: ADR 0009 Amendment 2 §4 (лестница регистрации L0–L2)
- Паттерн: ADR 0012 (одноразовые токены) — hash-only, single TTL,
  single-use CAS, payload-аудит, лимитеры
- Связанные: ARCH-9 (реестр исполнителей), `ui-contract.md` §11
  (словарь `enrollment.*`), `deploy/poller/README.md`

## Проблема

Единственный бутстрап нового исполнителя — машина-токен
(`VESMARO_BOARD_TOKEN`) на `POST /api/executors`. Для арендованного VPS
это мастер-ключ в `/etc/vesmaro/poller.env` на неконтролируемой машине:
компрометация VPS = весь machine-класс моста. Enrollment-токен сужает
blast radius до «один pending-исполнитель за человеческим гейтом approve».

## Решение (кратко)

`mne_`-токен: 128-bit urlsafe, одноразовый (CAS `created→used` в той же
транзакции, что INSERT исполнителя), TTL 15 мин, scope = только регистрация.
Хранение hash-only (unsalted sha256). Зарегистрировавшийся — обычный
pending-исполнитель: capabilities пустые (owner-declared), routing не видит
до approved+enabled. Человеческий гейт = существующий approve, второго
confirm-шага в протоколе НЕТ (главное отличие от pairing'а).

## Контракты

| Метод и путь | Auth | Семантика |
| --- | --- | --- |
| `POST /api/executors/enrollment` `{label?: ≤64, harness_hint?: ≤60, name_hint?: ≤120}` | ui | `201 {enrollment: {…}, token: "mne_…"}` — token только здесь. Rate 3/10 мин/клиент; живых ≥3 → `409` без авто-ревока; 422 неизвестный harness_hint; 503 fail-closed без ui-токена |
| `GET /api/executors/enrollment` | ui | список (created + терминальные), без hash/токена |
| `DELETE /api/executors/enrollment/{id}` | ui | revoke живого → SSE `enrollment.revoked`; повторный revoke → `200` идемпотентно; used/expired → `409`; unknown → `404` |
| `POST /api/executors` (существующий) | machine **или** `Bearer mne_…` | регистрация. Лег mne_: unknown → `401 "enrollment token required or invalid"`; expired/used/revoked → `410` с причиной; успех → pending-исполнитель + `executor_secret` (один раз) |

Состояния токена: `created → used | expired | revoked`; терминальные
финальны. TTL-sweep ездит в цикле pairing-sweeper (60 с, stagger 45 с).

Аудит (board events): `enrollment.created/used/revoked/expired`,
`token_id` = хвост hash −8, при used — `used_ip` и `executor_id`.
SSE-словарь — `ui-contract.md` §11; `enrollment.used` — без дублирующего
notification (покрыт существующим `executor.registered` со spam-guard'ом).

Хранение: таблица `enrollment_tokens` (аддитивно, без SEED_VERSION bump);
в `executors` — колонка `registered_via` ('' = machine-лег,
`enrollment:<id>` = mne_-лег; отдаётся в `GET /api/executors` — владелец
сверяет происхождение в момент approve).

Маскирование: `mne_…` в `_SECRET_PATTERNS` (`security.py`) с первого дня
(урок SEC-2).

## Транспортная нейтральность

Enrollment-команда параметризована `BOARD_URL`; контракт не знает путь до
борда (LAN / VPN / будущее). Рекомендованный транспорт для VPS — VPN-узел
(wireguard/tailscale); публичная экспозиция борда — отдельная волна
hardening (reads открыты, TLS lab-CA). Executor_secret кладётся в
`VESMARO_BOARD_TOKEN`-переменную поллера (env-имя — контракт поллера,
значение — не мастер-ключ; сервер различает класс по lookup'у hash).
Алиас `VESMARO_EXECUTOR_TOKEN` — отдельная мелкая задача вне фаз.

## Threat model (кратко)

Утечка токена до использования → максимум один фейковый pending
(single-use + TTL + квота 3 + rate 10/60 с на регистрацию); ему нужны
владельческие approve + capabilities + enable. Утечка после — инертен (410).
Approve-панель показывает `registered_via` + `used_ip` — сверка с
ожидаемым VPS обязательна; слепой approve = раскрытие spec-снапшотов
заданий машине предъявителя.

## Фазы

0. Словарь `enrollment.*` в ui-contract §11 (сделано этой же веткой).
1. Сервер (таблица, роуты, guard, sweep, аудит, маскирование, тесты).
2. UI (AGW-4+): «Добавить исполнителя» → форма (label, harness, транспорт
   local-poll; mesh-r4 до R4 задизейблен) → токен + TTL-дуга + bootstrap-блок
   (env + poller.yaml + curl + systemd, кнопки копирования) → статус токена
   по SSE. RUNBOOK «подключение удалённого исполнителя» (VPN, lab-CA,
   scp артефактов поллера).
