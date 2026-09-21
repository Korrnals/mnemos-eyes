# SESSION: mnemos-eyes — Unified App: Assignment-UI + QR (Phase 5)

> **How to start this session:** tell the agent
> _"проинициализируй сессию из `docs/sessions/SESSION-03-unified-app.md`"_.
> The agent (Tech Lead, team mode) reads this file, restores context from the
> checkpoint + board, and dispatches the waves below to GCW specialists.

- **Project:** `mnemos-eyes` (product: **vesmaro-eyes**)
- **Repo:** `git@github.com:Korrnals/mnemos-eyes.git`, local
  `/var/home/abyss/LABs/Projects/Project-Mnemos/mnemos-eyes`
- **Session owner / orchestrator:** `@GCW: Tech Lead` (решения делегированы
  владельцем; эскалация — только genuinely спорное)
- **Prod:** `https://vesmaro.abyss.lab` — **единое React-app на `/`**
  (1.11.4, `rootApp=app`), `/board` — запасной (fallback до ~2026-09-27)
- **Status:** 🟢 готова к старту (задачи на борде, стеки созрели)

---

## 1. Context to restore (read first, in order)

| Что | Где | Зачем |
| --- | --- | --- |
| Checkpoint mnemos | `mnemos_recall_context(project=mnemos-eyes)` | Полная картина прошлых сессий, уроки, доступы |
| Борд | `https://vesmaro.abyss.lab` (или `/board`) | Трекер: открытые CV-6/7, BE-13/15, OPS-1, хвосты |
| ADR 0009 + Amendment 1/2 | `docs/decisions/0009-agent-bridge-assignments.md` | Assignment-контракты, ui/machine токены, executor-реестр |
| ADR 0012 | `docs/decisions/0012-qr-pairing-device-tokens.md` | QR-пейринг протокол + секьюрити-поправки (source-IP binding и др.) |
| ADR 0010, 0011 | `docs/decisions/` | Агрегация задач; конвергенция (Ф0-Ф4 done) |
| Протоколы архкомов | `docs/architecture/archcom-*.md` (1-5) | Решения и поправки комитетов |
| RUNBOOK | `deploy/chart/vesmaro-eyes/RUNBOOK.md` | §8 токены, §9 Ф4-переключение; деплой-протокол |
| Executors API | `server/app.py` (ARCH-9 трек: registry, presence, routing) | Серверная база для CV-6 |

## 2. Working rules (выстраданные, не нарушать)

1. **Командный режим**: волны через Agent tool (`gcw-*`), зоны не пересекаются
   (server/ ∥ viewer/ ∥ docs/), коммитит оркестратор, squash-PR в main.
2. **Параллельные сессии владельца работают через git worktree** (main может
   быть занят!). Всегда: `git fetch` → rebase на `origin/main` из своей ветки,
   тег — только после merge, версию — свою поверх его (`sync-version.sh N`).
3. **Деплой-протокол** (после коллизий): `helm upgrade vesmaro-eyes
   deploy/chart/vesmaro-eyes -n kube-agents --set rootApp=app --set
   image.tag=<ЯВНО>`; после rollout СВЕРЯТЬ образ в поде
   (`kubectl get deploy -o jsonpath='{...image}'`) и при странностях
   `helm get values` (чужие `--set` персистят!). Владельцу после серии
   деплоев напоминать Ctrl+R.
4. **Живые пробы против фейков** (урок сканера): новые wire-запросы —
   recorded-corpus с реального mnemos; после релиза — live-smoke на проде.
5. **Тесты перед каждой волной**: `PYTHONPATH=/tmp/qadeps:/tmp/secdeps
   /usr/bin/python3 -m pytest tests/ -q --deselect
   tests/test_assignment_poller.py::TestEndToEndAgainstRealApp` (базлайн ~611
   + 2 деселекта — poller-e2e ждёт своих путей) и `cd viewer && npm run test`
   (базлайн 448). Гейт заморозки `TasksLayout.freeze.test.tsx` — святое.
6. **Секреты**: ui-токен = `kubectl -n kube-agents get secret
   vesmaro-eyes-ui-token -o jsonpath='{.data.VESMARO_UI_TOKEN}' | base64 -d`
   (мутации UI); никогда не печатать значения.
7. **Отчёт владельцу**: по-простому, чеклист-«TODO», без жаргона; решения TL
   принимает сам.

## 3. Goal

Сделать единое приложение операционным центром **исполнения** (не только
просмотра): задания агентам из UI, живые статусы исполнителей, и открыть
дорогу устройствам (QR-пейринг → PWA).

## 4. Waves (по приоритету; задачи уже на борде)

### Wave 1 — CV-6: Assignment-UI (главная, ADR 0009 Ф4 в React)
- Домен **«Агенты»** оживает: список executors (реестр ARCH-9, presence
  executor.online/offline из SSE), карточка исполнителя.
- Из карточки задачи: **«Отдать исполнителю»** → выбор executor/specialist →
  POST assignment (ui-класс) → статусная лента задания (queued→claimed→
  running→complete/fail, SSE `assignment.*`), чекпоинты/отчёты исполнителя
  текут в карточку задачи.
- Совместимость с поллером владельца (systemd, machine-токен) — не ломать.
- Wave 1b (параллельно, server): сквозная лента отчётов `GET /api/reports`
  (BE- verdict gap), если ещё не сделана треком владельца.

### Wave 2 — CV-7: lab-CA → QR-пейринг → PWA (ADR 0012, по этапам)
1. **lab-CA** (предусловие): расширение `gen-tls-secret.sh` — CA ECDSA P-256,
   offline CA-ключ ТОЛЬКО на машине владельца (требуется его участие —
   предупредить заранее), fingerprint-сверка при установке на устройство,
   HSTS вместе с rollout.
2. **Pairing-сервер**: эндпоинты по ADR 0012 c секьюрити-поправками
   (source-IP binding, однократная выдача, verify НЕ в SSE, rate-limit по
   pairing_id); таблицы pairing_requests/device_sessions.
3. **Pairing-UI**: `/system/devices` — QR, подтверждение с IP устройства,
   список устройств + ревок.
4. **PWA-минимум**: manifest + иконки, БЕЗ service worker (инвариант архкома).

### Wave 3 — хвосты и операционка (в любую паузу)
- **BE-15**: стабилизация queryFn-идентичности в useTasks-хуках (убрать
  observerOptionsUpdated-шум), расмокать 4 теста «cycles forever».
- **BE-13**: тег-дрилл → GET /memories?tags= (сиблинг-дефект сканера).
- **OPS-1** (~после 27.09): почистить `tasks_backup_wf1` +
  `/data/board.db.pre-wf1`; вердикт владельца по снятию `/board` с ingress.
- **BE-14**: quick-wins старого борда — низкий приоритет (борд в deprecation).

## 5. Owner touchpoints (когда нужен владелец)

- lab-CA: генерация/хранение CA-ключа на его машине + установка CA на
  устройство со сверкой fingerprint.
- Снятие `/board` (~27.09, после недели наблюдения Ф4).
- Хвосты: ратификация ARCHCOM-4/5 (его протоколы), GitHub Actions billing,
  RB-1/2 (ребрендинг org vesmaro — blocked), тикет в mnemos про
  `serve --config` (нужен VESMARO_CONFIG env).

## 6. Definition of done (сессии)

- [ ] Assignment-UI: создание задания из карточки, live-статусы, отчёты
      исполнителя в карточке — живой прогон с реальным поллером.
- [ ] lab-CA развёрнута, QR-пейринг: телефон владельца подключен, ревок
      проверен.
- [ ] PWA устанавливается на устройство владельца.
- [ ] BE-15/BE-13 закрыты; OPS-1 выполнена или запланирована датой.
- [ ] Все волны — через PR + live-smoke; чекпоинт сессии записан.

## 7. First action when session starts

Tech Lead: (1) recall чекпоинта + борд (сверить актуальные колонки/задачи —
параллельные сессии могли двинуть), (2) проверить git-состояние и версию
прода (`kubectl get deploy vesmaro-eyes -o jsonpath='{...image}'`),
(3) подтвердить у владельца порядок волн (по умолчанию: CV-6 → CV-7),
(4) запустить Wave 1 двумя агентами (server ∥ viewer).
