# ARCHCOM SESSION 2026-09-20 — vesmaro-eyes (совещание №5: планировщик и хуки / SCHED-1)

- **Созвал:** владелец (`@abyss`) — директива 2026-09-20: «интересная тема с хуками и
  планировщиком — стоит добавить в интерфейс и проработать их функциональность»
- **Ведёт:** `@GCW: Tech Lead`
- **Участники:** Product Architect (автор записки), Senior System Engineer,
  Senior Security Engineer, Senior Frontend Developer
- **Входные материалы:** `sched1-scheduler-hooks-problem.md` (main@3e5510a),
  ADR 0009 (+Amendment 2), протоколы АРХКОМ-4, ADR 0011, код Ф1 (server/)
- **Итог:** ADR 0013 (draft, pending owner ratification); ниже — сводка.

---

## Вердикты

| Участник | Вердикт | Ядро |
| --- | --- | --- |
| Product Architect | вариант C, защита | «правило как макрос» — «Запустить сейчас» даёт ценность в S1 без T2; календарная цена этапности ≈ 0 (серверное окно занято ARCH-9, UI после Ф3); T2-гейт — чеклист с named owners и датой (ретро Ф1 ≥80%); финальные позиции по всем 8 открытым вопросам; метрики S1/S2; каркас ADR 0013 |
| Senior System Engineer | ACCEPT C + поправки А-1/А-2 | А-1: дефолт source_allowlist зависит от действия (notify — всем кроме automation; create — только ui+server, machine — явный per-rule opt-in): `assignment.failed` эмитит machine-роут, иначе хук-перезапуск либо мёртв, либо открывает «агент дёргает свой перезапуск». А-2: живость цели в момент срабатывания (skipped(inactive-executor), не минт в мёртвую очередь). Полный DDL (journal-first, partial unique indexes, enabled=0 default, next_run_at только сервер), ECA-очередь, 5 слоёв anti-loop, бюджеты в SQL, три часа таблицей; S1 без зависимостей; ARCH-7 нужен до S2 |
| Senior Security Engineer | ACCEPT (финал: безусловный) | T2-чеклист 6→10 (rate на принципал, red-team инъекция, fire-storm дрель, suppression) — как CI-инварианты, не разовая проверка; контракты C-1…C-8 (disable-by-default, origin из класса токена при записи, closed allowlist полей — machine-записываемые включая task.moved в v1 не триггерят create, immutable launches, SSRF-контур на возврат webhooks); бюджеты ≤10/сутки глобально + 2 нагрузки |
| Senior Frontend Developer | S1-UI — хвост Ф3 | строго после assignment-триггера (та же state-машина «Взять в работу»); capability-gated; **мета-словарь условий — блокер для формы** (fields/ops/values enums от сервера); синхронный run-now; журнал cursor; SSE минимум (rule.changed один kind + scheduler.launched в UI-10); free-text контрол «не существует в DOM»; оценка S1-UI 0.8–1.1, S2-UI +0.3–0.4 |

## Разрешённые расхождения

| Расхождение | Решение |
| --- | --- |
| S1 до или после ARCH-9 (SE: зависимостей нет; PA: после, избегая churn store.py) | **Жёсткой зависимости нет** (SE); последовательно — после ARCH-9 (аргумент PA о churn), ветвить от main; при сдвиге ARCH-9 — S1 стартует раньше |
| SSE по skipped/missed (FE: не в UI-10; SE: missed «должен кричать») | `scheduler.missed` → notification + SSE (но не в ленту исполнения UI-10); `skipped` — только журнал/re-fetch |
| Чеклист T2 (PA 6 пунктов vs Security 10) | **10 пунктов Security**, расширенные зависимостью ARCH-7 (событие-источник expired); T2.2–T2.6 — CI-инварианты |
| Пауза отдельной колонкой | Нет: `enabled=0` = per-rule kill-switch; двух булевых колонок не заводить (SE) |

## Решения сессии

1. **Вариант C**: S1 (контракты + CRUD ui-token + «Запустить сейчас» = не-T2) →
   S2 (движок in-process, вариант A записки) строго под T2-чеклистом,
   default-off, явный opt-in владельца. B отвергнут всеми четырьмя
   (ломает A1, уводит энфорсмент гейтов из траст-домена сервера).
   Хуки — board-internal ECA; outbound webhooks — вне v1.
2. **Контракты S1** — по §5 записки с дельтами SE (см. ADR 0013 §Decision).
3. **Security-контракт** — C-1…C-8 обязательны; сужение source-условий
   (действие-зависимый allowlist) — норма, не рекомендация.
4. **Метрики** (PA): S1 — живость правил ≥60%, 0 breaking схемы до S2;
   S2 — ≥80% автозапусков без до-старта, missed <5%, skipped ≤50%,
   0 штатных срабатываний глобального cap.
5. **Порядок в портфеле**: ARCH-9 → W4PAPER (параллельно) → Ф2/Ф3 не
   смещаются → S1 (серверное окно №2) → S2 (T2-гейт) → S1-UI (после Ф3).

## Поручения

| # | Поручение | Ответственный |
| --- | --- | --- |
| 1 | ADR 0013 (draft) — синтез committee | TL (этой сессией) |
| 2 | SCHED-1-S1: схемы + CRUD + журнал + run-now + тесты (от main) | Senior System Engineer |
| 3 | SCHED-1-S2: движок + ECA + бюджеты — под T2-чеклистом (10 п.), Security-ревью до включения | Senior System Engineer + Security |
| 4 | SCHED-1-UI: /system/automation — хвост Ф3 после ARCH-8-триггера | Senior Frontend Developer |
| 5 | Ратификация ADR 0013 (+ ADR 0009 пачкой) | owner |
