# Волна 4: Подключение внешних агентов — карточка, provisioner, агент v2

> Status: **Дизайн утверждён ТЛ, security-ревью пройдено (7 P2-правок вморготипированы
> ниже), реализация начата (M2 WIP — см. feat/provisioner)**. 2026-09-23.
> Автор концепта: Senior System Engineer (сессия agents-section); правки: security-ревью.
> Рамка: ADR 0009 §9 (outbound-only) + Amd 2 §4 + enrollment (2026-09-22) + bootstrap.sh.

## Реакция на фидбек владельца

Enrollment-флоу «токен → сам дойди до VPS → сам выполни команду» = «пользователь в тупике».
Планка: минимальные телодвижения. Видение владельца: карточка = хост/агент/SSH; лёгкий
агент, который сам ставится, сам находит харнесы и берёт на себя работу с ними; борд = ЦУП.
РЕШЕНО владельцем: агент = полноценный лёгкий сервис на **Go**, отдельный репозиторий
`vesmaro/vesmaro-agent` (протокол-первый: PROTOCOL.md v0.1 заморожена), python-поллер —
legacy ноутбука в переходный период.

## A. Карточка подключения

Поля: имя (1..120 unique), хост IP/FQDN (strict regex), SSH-порт (default 22), способ входа
(ssh-config алиас | приватный ключ+passphrase | пароль), харнес (комбобокс словаря ИЛИ
«Не знаю — агент найдёт сам»), board_url_for_host (https-only, префилл оверлей-адресом),
host-key fingerprint (опционально strict). Ключевое отличие от mint-диалога: enrollment-токен
создаётся НЕЯВНО (атомарно с job'ом) и в SSH-пути никогда не показывается пользователю —
едет к хосту внутри SSH-сессии.

Стейт-машина карточки: draft → queued → connecting → installing → watching → done(=pending
в реестре; дальше существующие approve/enable). watching не гадает по имени: job поллит
enrollment-строку до executor_id (CAS уже пишет его). failed финален для job, retry = новый
job (токен переиспользуется если created+живой, иначе новый mint).

Ошибки по шагам (typed, человекочитаемо): ssh.unreachable / ssh.auth_failed /
ssh.host_key_mismatch (MITM-предупреждение, retry вслепую запрещён) / ssh.sudo_required
(bootstrap = root-операция; sudo -n префлайт) / bootstrap.exit.2-5 (расшифровка + stderr
хвост) / bootstrap.timeout (10 мин) / register.timeout.

## B. Provisioner (SSH-разовая установка)

Размещение: **модуль на борде** (вариант α; asyncssh, worker в lifespan). Эскалация (β)
sidecar — зафиксирована: первый внешний контур или второй оператор борда. Один источник
истины: provisioner выполняет РОВНО команду из REMOTE-EXECUTOR.md Путь 1
(`curl -kfsSL <board>/api/poller/bootstrap.sh | sudo bash -s -- --url --token mne_ --name
[--harness]`), ничего не дублирует.

Контракты: POST /api/executors/provision (ui-token, 202 {job_id, enrollment_id}; тело:
{name?, host, port=22, auth:{kind:password|key, secret, passphrase?}|{kind:alias},
harness_hint?, board_url_for_host?, expected_host_key_fingerprint?, reuse_enrollment_id?};
атомарный mint enrollment; токен НЕ возвращается; 503 если provisioner.disabled) ·
GET /api/executors/provision/{job_id} (ui; {state, steps[], host_key_fingerprint?,
enrollment:{state, executor_id?}}) · SSE provisioning.{created,progress,ok,failed}
(additive; НИКОГДА токен/креды/пароли).

Хранение: таблица provision_jobs (аддитивно, без SEED_VERSION): id, host, port, auth_kind,
key_fingerprint, host_key_fingerprint, harness_hint, board_url_for_host, enrollment_id,
state, error_code, timestamps. **Ноль секретных колонок.**

Anti-spray (security P2-5): cap 2 одновременных jobs глобально; дедуп — один active job на
host:port; cooldown повторных jobs по хосту; rate-limit POST жёстче общего ui-лимита;
password-auth — отдельный helm-флаг, **default off** (с sudo -n префлайтом password-login в
v1 малоценен).

Security-модель: SSH-креды **transit-only** (память asyncio-таски, никогда SQLite/логи/SSE/
аудит; рестарт борда → живые jobs failed(code=provisioner.restarted) — per-operation gate
структурный, retry невозможен без повторного ввода). Host-key: TOFU + pin в job-строке с
показом владельцу, повторный коннект enforce pin (mismatch → fail; **pin по identity
(host,port)**, re-pin — отдельное owner-действие с old→new + аудит host_key_repinned;
mismatch-серия — сигнал MITM surfaced владельцу). Command injection: SSH exec — shell-посредник
(argv-массива нет, признаётся); двухслойная защита — regex-валидация полей (host — строгий
FQDN/IP charset, инвариант «host только в connect(), никогда в command string»; asyncssh не
парсит -o-опции) + shlex.quote каждого аргумента; тело установщика всегда с бордового роута.
Amd 3 к ADR 0009: **install-time SSH channel ≠ execution channel** — одноразовый,
owner-triggered, только фиксированный provisioning-шаблон (никогда произвольный exec);
runtime outbound-only не тронут. Гигиена транзита: core dumps off в контейнере, asyncssh
DEBUG запрещён в проде, APM include_local_variables=False, креды в узкой области таски с
redacted __repr__, job timeout ограничивает residence. Аудит: provisioning.created (host,
auth_kind — без материала), host_key_pinned (fingerprint), ok/failed (exit-код + stderr ≤200
после mask_secrets; порядок mask→truncate, не наоборот).

## C. Агент v2 — самообнаружение (эволюция поллера → Go-сервис)

Принцип: эволюция, не новый daemon. Реализация перенесена в **vesmaro/vesmaro-agent (Go)**:
discovery-фаза при старте и по расписанию — shutil.which-эквивалент по встроенной карте
harness→кандидаты + discovery.extra из конфига (произвольные харнесы). Отчёт — новый
machine-лег POST /api/executors/{id}/discovery (identity-match как heartbeat; discovered в
ОТДЕЛЬНУЮ колонку `executors.discovered`, capabilities по-прежнему owner-declared —
«never self-expanded» соблюдён буквально: мутацию делает сервер под owner-политикой
`capabilities_source: owner|auto-discovered`). unknown-имена дропаются сервером + аудит
discovery.rejected (борд-сторона). version агента — VERSION handshake при enroll.

Автоallowlist (ядро UX): три варианта, выбран (3) — **локальный флаг
`allowlist_autodiscover: true`, пишет сам поллер в свой конфиг**: гейт остаётся локальным и
fail-closed (борд не может дописать allowlist — нет входящего канала, конфиг 0600 root);
найденное = установлено тем же админом = транзитивное owner-авторство (трактовка A3 — в
Amd 3, на ратификацию). Guardrails: автодобавляются только имена из встроенной карты И
живого словаря борда; команда = [bin_path] exact absolute (glob-метасимволы отвергаются);
specialists:["*"]; cap 32 (переполнение = degraded-статус + событие, не молчаливая обрезка);
MANAGED-блок с маркерными делимитерами, атомарная запись, YAML-проверка после записи,
никогда не затирает user-owned записи; каждый автодопуск — в poller-лог. bootstrap.sh v2
пишет флаг свежим инсталляциям; UPDATE-путь конфиг не трогает.

Репозиторий агента: критерии выделения ≥2 из — внешний оператор борда; релизный цикл
агента отстал от борда (skew на практике); нужен статический бинарь+подпись; внешний
контрибьютор. До тех пор артефакты из основного репо... ОБНОВЛЕНО решением владельца:
репо выделено сразу (vesmaro/vesmaro-agent), артефакты — релизами агента.

## D. UX-поток

SSH-путь (дефолт): карточка (3 поля) → «Подключить» → прогресс-лента по SSE с
таймстампами (отпечаток хоста на первом шаге) → «Ожидает вашего одобрения» → approve-панель
показывает registered_via, used_ip, host-key fingerprint, блок «Обнаружено на хосте» с
«Применить» → «Включить» → live: presence online, версии агента и харнесов. Суммарно: 3
поля, 2-3 кнопки, ноль консоли, ноль yaml. Self-service путь (без SSH из контура) — экран
сегодняшнего токена, без регресса f40bd04.

## Security-ревью (2026-09-23): вердикт «реализовывать с правками», 7 P2 вморготипированы

P2-1 strict без owner-supplied fingerprint = косметический TOFU (provenance префилла
подписывать в UI) · P2-2 pin по identity host:port, re-pin = owner-действие old→new +
инвалидация pending этого хоста · P2-3 mask_secrets → потом truncate (порядок в контракте
job.error) · P2-4 гигиена транзита (core dumps off, asyncssh DEBUG off, APM locals off,
redacted repr, job timeout, 4xx без эха кредов, autocomplete=off) · P2-5 анти-spray
(см. B) · P2-6 fail-loud переполнение allowlist-блока + exact paths + маркерные делимитеры
+ YAML-проверка · P2-7 discovery unknown дроп + аудит + cap + dedupe; auto-discovered слабее
owner-declared по доверию — зафиксировано. Top-3 отсутствующего: анти-spray, job
timeout+memory hygiene, транспортная гигиена карточки — все включены выше.

## Оценки и порядок

A карточка UI 1.5-2д · B provisioner 3-4д · C агент v2 (Go) 2-3д · D интеграция+доки
1-1.5д. Порядок: C-сервер(лег) → B provisioner → A карточка → D; либо параллельно
A+B / C при двух специалистах. E2E vpn.us (hysteria-оверлей, Pi) — после D.

## Вопросы владельцу — РАТИФИЦИРОВАНЫ ТЛ (2026-09-23), вето права

1. Provisioner на борде (α) — УТВЕРЖДЕНО. 2. Автоallowlist default-on fresh — УТВЕРЖДЕНО
(воля владельца из формулировки «сам находит и берёт на себя»). 3. Root/NOPASSWD v1 —
УТВЕРЖДЕНО (собственные VPS владельца).

## Addendum (решение ТЛ, 2026-09-23): provisioner доставляет CA по SSH-каналу и использует
## curl --cacert

Итог security-ревью WIP-реализации (M2): provisioner-путь обязан быть безопаснее ручного
Пути 1. Исполнение: CA-сертификат борда доставляется на таргет ПО SSH-КАНАЛУ (SFTP-запись
в job-scoped `/tmp/vesmaro-lab-ca-<job>.crt`, 0600 attrs + контрольный chmod), внешний
curl запускается с `--cacert` и БЕЗ `-k`; борд без настроенного `VESMARO_TLS_CA_FILE`
честно валит job (ca.unavailable) — downgrade на unpinned TLS невозможен. **Ручной Путь 1
не трогаем** (его bounded `-k`-окно для CA-only с печатью отпечатка и проверкой CA:TRUE —
известный, задокументированный риск): отдельный риск-тикет владельцу, бэклог.

Попутно зафиксировано ревью (реализация 2026-09-23): pin по identity (host, port) с
repin-роутом `?port=` и инвалидацией живых job'ов identity (pin.invalidated); fingerprint —
строго канон ssh-keygen (SHA256:base64-без-паддинга), hex64-вход нормализуется; ноль
производных ssh-пароля в БД/API (CWE-759); транспорт на client_factory + SSHClient-подкласс
`validate_host_public_key(host, addr, port, key)` (арность сверена с asyncssh 2.24.0,
закреплён в requirements); sudo -n префлайт отдельным exec → ssh.sudo_required; install-нога
со своим таймаутом → bootstrap.timeout.