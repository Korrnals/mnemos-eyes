# Вердикт Senior Security Engineer — АРХКОМ-3

## 1. QR-пейринг драфт — ACCEPT с поправками (1–2 блокирующие)

Threat-model:
- **QR-fishing — главный пробел**: code = bearer-секрет целиком в QR; заявленная «сверка verify» от перехвата НЕ работает — verify возвращается каждому, предъявившему code (CWE-345). Verify закрывает только disambiguation/wrong-server UX.
- **Гонка выдачи** (CWE-362): после confirm токен получает первый опросивший — у атакующего с фото QR равные шансы.
- SSE-spoofing: /api/events неаутентифицирован — metadata (device_name, verify по драфту) утекает LAN-стримом; инжекция невозможна.
- Replay/перебор: code single-use + TTL + 410 достаточно; 128-bit перебор бесперспективен. Инвариант: verify никогда не фактор аутентификации, confirm не принимает цифры как input (CWE-307 превентивно).
- Компрометация mnd_: read-scope = весь корпус; дельта против открытых reads — креда 30/90d вне сервера; ревок-путь (hash-only, DELETE /api/devices/{id}, sliding 30/hard 90, проверка в middleware) достаточен.

Поправки в протокол:
1. **[блокирующая] Source-IP binding exchange**: первый POST /api/pairing/exchange биндит pairing → client IP; повторные exchange и выдача только с него (иначе 403 + SSE-событие). IPv6 privacy — в RUNBOOK.
2. **[блокирующая] Выдача однократна**: confirmed → первый exchange выдаёт токен и гасит code (последующим 410).
3. Verify убрать из SSE payload (только pairing_id, device_name; code/device_token — никогда).
4. Confirm-панель показывает source IP рядом с self-asserted device_name («unverified»-паттерн).
5. Синхронизировать доки: единый TTL ≤3 мин, один code на pairing (ротация = хуже), renewal = новый pairing; терминология design/arch3.
6. Rate-limit key exchange = pairing_id после lookup валидного code (иначе memory-DoS на RateLimiter._events) + глобальный per-IP на /api/pairing/*.
7. QR URL через fragment #/pair?t= + strip t из history после первого exchange.
8. device_name cap ≤64, рендер как текст (stored-XSS превентивно).

**PAKE для LAN v0 — избыточен**: ту же защиту дают human-gate ×2 + TTL + single-use + IP-binding. Триггеры пересмотра: relay-топология, пейринг вне LAN/VPN, хрупкость IP-binding.

## 2. TLS/CA-политика — ACCEPT; lab-CA = предусловие пейринга, не опция

Self-signed + пейринг эксплуатирует обученную привычку принимать warning: DNS-spoof → MITM-прокси → перехват exchange (CWE-35). Поправки к gen-tls-secret.sh:
1. **CA-ключ offline** (только машина владельца, шифровано; никогда в k8s secret; --print-only приватного CA-ключа запретить; --print-ca только cert).
2. CA ECDSA P-256 ~10 лет (basicConstraints critical CA:true); leaf 825d, SAN, EKU serverAuth, уникальный serial.
3. Установка CA на устройство с out-of-band сверкой SHA-256 fingerprint (UI/RUNBOOK).
4. **HSTS вместе с CA-rollout, не раньше**.
5. mTLS вместо mnd_ — отвергнуть (iOS/PWA клиентские сертификаты не умеют); ACME-триггер корректен; вне LAN = VPN.

## 3. Классы кредов — ACCEPT четвёртый класс; консолидация отвергается

Разные revocation-плоскости и lifecycle (mnd_ many-instance DB-backed hash-only; ui/machine singleton env). Поправки: единый scope-middleware (класс по префиксу + таблица scopes перед _guard_write); префиксы всем классам (mnd_/mnu_/mnm_); SHA-256 без соли; DeviceSession с UA/IP/last_seen; тест «авто-eviction невозможен».

## 4. Конвергенция/страницы — ACCEPT с поправками

1. URL с id: принять как documented risk (single-owner LAN) + `Referrer-Policy: no-referrer` на все ответы + инвариант «никогда токены в query-string».
2. Bulk: серверно одна audit-notification на операцию с count+id (не N); typed-confirm >10; idempotency-key на bulk; bulk-delete памяти — отдельное решение архкома.
3. PWA: v0 = manifest без SW; инвариант «SW не появляется без решения архкома»; при появлении network-first/no-store на /api/*. Компенсатор сейчас: **Cache-Control: no-store на всех /api/**.
4. mnd_ в localStorage: LAN-lab приемлемо при строгом CSP; httpOrigin+SameSite=Strict — future-hardening после Ф4.

## 5. Аудит-хвосты после конвергенции

1. XSS: запретить dangerouslySetInnerHTML CI-гейтом; контент памяти = untrusted (отравленная запись = stored-XSS); markdown-рендер только sanitize+CSP.
2. **CSP отсутствует полностью**: ввести с Ф0 — default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; connect-src 'self'; img-src 'self' data: + X-Content-Type-Options: nosniff + Referrer-Policy: no-referrer.
3. **mnk_ из браузера**: viewer зеркалирует mnk_ в localStorage (auth.ts AUTH_STORAGE_KEY) — против целевого «mnk_ не покидает сервер»; аудит-пункт Ф0: purge + тест отсутствия mnk_ в браузерном storage.
4. Перепроверить VESMARO_APP_DIR (path-join без traversal).
5. SSE-словарь pairing.*: payload-аудит (без code/verify/token).
6. /board после Ф4 снять с ingress.

Итог: кластеры ACCEPT; поправки §1.1–2 и §2.1 внести в arch3 до ратификации; CSP/no-store — в контрактные требования Ф0. No findings at ASVS L2 beyond listed.
