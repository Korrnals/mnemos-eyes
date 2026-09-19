# Вердикт Senior QA — АРХКОМ-3

## 1. Стратегия тестирования конвергенции — ACCEPT с поправками

- **Источник контракта BoardAdapter — OpenAPI борд-сервера**, не mnemos-снапшот (merge-API = другой wire).
- **Parity трёхуровневый, не пиксельный**: (1) wire-corpus equality (golden-фикстуры); (2) action-outcome equality (transition + notification/toast); (3) завершение daily-loop владельцем.
- **Golden-корпус снимается на Ф0** и привязывается к тегу (борд заморожен — фиксируем v1.3.x-поведение).
- Contract-тесты BoardAdapter — против реального борд-сервера (in-process TestClient, прод-shaped сид ~96 задач); MockAdapter — только для vitest-юнитов.
- E2e-смоук на проде после каждой фазы — read-only (health + read-корпус + SSE first-event-with-deadline + раздача /app); мутации на проде — hard rule нет; смоук = гейт деплоя в RUNBOOK (poll-with-deadline, без sleep).

## 2. Тестируемость QR-пейринга — ACCEPT

Матрица: state machine created→scanned→confirmed→issued + expired/revoked; нелегальные переходы 4xx; TTL-граница → 410; single-use; bounded attempts 429 (5/10мин exchange, 3/10мин creation); два конкурирующих exchange → ровно один issued; SSE-события с payload-контрактом; ревок → 401; sliding 30/hard 90; 6-е устройство → 409; device-токен на мутации → 403 (не 401); middleware порядок; в БД только code_hash; mnd_ в _SECRET_PATTERNS + тест маскирования.
E2e: один спек Playwright — headless-браузер как «устройство» (QR декодировать программно, проверить URL+t=code), второй контекст — доверенная сторона с SSE. Без эмуляции камеры.

## 3. Регрессионные риски IA — ACCEPT с поправками

- Роутинг: одна схема (history-API + fallback; QR-URL привести к ней); тест deep-link+F5 на роутах ур. 2–3; роуты не переименовывать между волнами.
- Состояние списка живёт в URL (фильтры/selection/searchParams); тест navigate→reload→restore.
- Scroll-restore мастер-детейл через браузерный BACK.
- **Bulk-минимум**: confirm с точным числом; per-item outcome report (частичный отказ не роняет батч и не молчит); audit per-entity; undo только где обратимо (задачи), для памяти — dry-run preview с provenance; SSE-гонка под выделением → skip+report. Клавиатурный путь через тот же confirm-гейт.

## 4. Метрики перехода — ACCEPT с поправками

Минимальная телеметрия, additive, без PII: (1) SSE-здоровье (reconnect/сессию + gap-счётчик); (2) 401-flake на первых мутациях после login (60с окно); (3) route first-meaningful-render (Performance API); (4) error-boundary/toast-rate; (5) **fallback-to-board counter** — главный parity-сигнал; ≈0 — численное условие входа в Ф4.

## 5. Прецеденты спринта → process-правила — ACCEPT

Оба дефекта (сканер inbox 260bec2, ghcr-секрет) — класс «зелёный CI ≠ релизный гейт»:
- **Recorded corpus вместо изобретённого дубля**: каждый новый wire-запрос к mnemos покрывается записанным реальным ответом (capture-once → replay); фейк не додумывает семантику.
- **Live-контур**: маркер @pytest.mark.live против настоящего mnemos, вне дефолтного прогона, обязателен в release-runbook до тега.
- **Release pre-flight job** в release.yml (проверка auth/пуш-прав на каждый push в main, no-op manifest) — секрет падает на PR, не на тег.
- **Rollback game-day**: предыдущий tag-образ + одна команда отката, прожата минимум один раз.

## Гейт-чеклист Ф0→Ф4

**Ф0**: контракт-тесты против реального борд-сервера; кодеген из OpenAPI борда + drift-guard; golden-фикстуры запинены; post-deploy smoke в RUNBOOK (read-only, без sleep); CI зелёный на multi-stage Node-сборке.
**Ф1**: state-matrix интерактивов (loading/error/empty/disabled); freeze-исключений борда = 0 по diff-скоупу; роуты заморожены + редиректы протестированы; i18n-полнота (линт); новый эндпоинт ⇒ схема+pin в той же фазе.
**Ф2**: wire-corpus equality на golden; deep-link/F5 на всех уровнях; scroll через BACK; SSE-parity ⊇ словаря борда (вкл. task.archived gap); read-only daily-loop зафиксирован; fallback-counter baseline снят.
**Ф3**: эквивалент каждой мутации + ошибочные состояния (409/429/423); bulk-минимум протестирован; assignment-триггер (ADR 0009 Ф4) машина состояний; мутационные e2e — staging/одноразовые; раунд фидбека владельца = гейт; план отката существует.
**Ф4**: pre-switch smoke (/ и /board оба health); rollback прорепетирован (game-day); deprecation-окно /board bug-fix only; неделя наблюдения (error-rate, SSE, fallback≈0); явная подпись владельца на переключение.

Поручения: поправки §1 в протокол до ратификации; матрица §2 → test-strategy 1.4.x; регресс-тест 260bec2 расширить на drill-роут (закрытие класса BE-13).
