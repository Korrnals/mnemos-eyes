/* data.js — «Живая кора» stand demo fixtures (RU). Plausible mnemos-project data.
 * Every record: id, title, confidence (0–1), tags, provenance (who·where·when),
 * age label, and scroll content for the master-detail view. */
(function () {
  "use strict";

  const memories = [
    {
      id: "T-128",
      title: "UI-10 проводник",
      conf: 0.92,
      tags: ["ui", "agents"],
      prov: "agb · mnemos-01 · 2 ч",
      age: 2,
      kind: "задача",
      content: [
        "Решение по задаче UI-10: проводник проектов открывает дерево слева, редактор в центре, панель агентов справа. Три колонки — не догма: на узких экранах панель агентов уезжает вниз.",
        "Ключевое правило: правки агента подсвечиваются золотом в дереве и во вкладках редактора. Конфликт двух писателей — блокер, бейдж «конфликт», не цветом одним.",
        "Открытый вопрос: что показывать в панели агентов, когда пишет больше двух агентов. Черновик — очередь правок по времени, свежие сверху.",
      ],
    },
    {
      id: "T-121",
      title: "Пейринг QR",
      conf: 0.74,
      tags: ["pairing"],
      prov: "owner · abyss · 1 д",
      age: 24,
      kind: "задача",
      content: [
        "Пейринг устройства к колодцу памяти — через QR: устройство показывает код, владелец сканирует с телефона. Ручной ввод ключа остаётся запасным путём для headless-хостов.",
        "Замечание с ревью: QR должен жить не дольше 90 секунд, после — перегенерация. Иначе код, засветившийся на скриншоте, живёт вечно.",
      ],
    },
    {
      id: "M-204",
      title: "Решение по пейрингу: QR вместо ручного ввода",
      conf: 0.88,
      tags: ["pairing", "security"],
      prov: "owner · abyss · 3 ч",
      age: 3,
      kind: "решение",
      content: [
        "Выбрали QR-пейринг: меньше ручных ошибок, ключ не проходит через буфер обмена. Токен устройства одноразовый, живёт 90 секунд, хранится только на устройстве.",
        "Ссылка на задачу: T-121. Связанные записи: heartbeat-контракт агентов (M-215) — там тот же принцип «секрет не живёт дольше сессии».",
      ],
    },
    {
      id: "M-189",
      title: "Почему борд задач заморожен",
      conf: 0.81,
      tags: ["tasks", "process"],
      prov: "owner · abyss · 1 д",
      age: 26,
      kind: "заметка",
      content: [
        "Борд заморожен на время рефакторинга сессий: перетаскивание карточек конфликтовало с автопереносами агентов. Разморозить после того, как assignment получит единственного владельца.",
        "Признак разморозки: в журнале исполнений нет событий «перенял задачу» за неделю.",
      ],
    },
    {
      id: "M-215",
      title: "Heartbeat-контракт агентов",
      conf: 0.95,
      tags: ["agents", "contract"],
      prov: "core · mnemos-01 · 5 ч",
      age: 5,
      kind: "контракт",
      content: [
        "Агент шлёт heartbeat каждые 30 секунд, пока держит assignment. Молчание дольше 10 минут — предупреждение у строки; дольше 30 — исполнение считается потерянным и уходит обратно в очередь.",
        "«reported by X» — честная идентичность: подпись агента никогда не маскируется под владельца. Непроверенные отчёты помечаются «unverified».",
      ],
    },
    {
      id: "M-177",
      title: "Выбор шрифтов: Inter, Lora, JetBrains Mono",
      conf: 0.9,
      tags: ["ui", "design"],
      prov: "owner · abyss · 6 д",
      age: 144,
      kind: "решение",
      content: [
        "Три семейства и ни одним больше: Inter — интерфейс, Lora — содержание записей («свиток»), JetBrains Mono — числа, id, провенанс и терминал. Позиция запятых в числах выравнивается tabular-nums.",
        "Отказ: системный стек как основной — теряется характер «приборного кокпита»; как fallback — обязателен.",
      ],
    },
    {
      id: "M-156",
      title: "Лестница страт коры: пять уровней глубины",
      conf: 0.86,
      tags: ["ui", "design"],
      prov: "owner · abyss · 7 д",
      age: 168,
      kind: "решение",
      content: [
        "Глубина интерфейса = слои коры: canvas (дно колодца) → base → well → elevated → overlay. Чем глубже поверхность, тем она темнее; в светлой теме лестница инвертируется по свету, не по смыслу.",
        "Страт-тинты запрещены на карточках с текстом — иначе читались бы как статус. Только wash больших амбиентных поверхностей.",
      ],
    },
    {
      id: "M-201",
      title: "SSE-лента: контракт переподключения",
      conf: 0.93,
      tags: ["sync", "contract"],
      prov: "core · mnemos-01 · 8 ч",
      age: 8,
      kind: "контракт",
      content: [
        "Разрыв соединения — не молчание: пилюля в топбаре переходит в «подключаемся…» на 30 секунд, потом честное «нет связи» с кнопкой «Переподключить». Лента при разрыве не рисует событий — пустота честнее выдуманных данных.",
        "После восстановления лента дозапрашивает пропущенное окно, а не притворяется, что ничего не было.",
      ],
    },
    {
      id: "M-148",
      title: "Мнемос-ID в отчётах: сноски вместо тела",
      conf: 0.79,
      tags: ["process", "reporting"],
      prov: "owner · abyss · 12 д",
      age: 288,
      kind: "заметка",
      content: [
        "Идентификаторы записей и SHA в отчётах владельцу уходят в сноски, не в тело текста. Тело — человеческим языком: «в чём проблема / что мешает / что делать».",
        "Правило проверено на трёх проектах: отчёты с ID в теле перестают читать после второй страницы.",
      ],
    },
    {
      id: "M-233",
      title: "Схема провенанса: кто · где · когда",
      conf: 0.91,
      tags: ["memory", "contract"],
      prov: "agb · mnemos-01 · 30 мин",
      age: 1,
      kind: "контракт",
      content: [
        "Каждая запись несёт тройку провенанса: кто написал (владелец или агент), где (сервер или сессия), когда (человеческий возраст). Числа — mono, подписи — капс.",
        "Провенанс — часть записи, а не украшение: без него «уверенность» ничего не стоит.",
      ],
    },
    {
      id: "M-219",
      title: "Словарь импульсов: событие → цвет → место",
      conf: 0.94,
      tags: ["design", "motion"],
      prov: "owner · abyss · 1 ч",
      age: 1,
      kind: "решение",
      content: [
        "Импульс по ребру бежит только на реальное событие: recall — ирис, запись агента — золото, ошибка — тёплый красный. Цвет импульса всегда дублируется текстом в ленте. Импульс без события — блокер ревью.",
        "Затухание — не дольше 240 мс; glow budget: не больше двух источников свечения в кадре.",
      ],
    },
    {
      id: "M-241",
      title: "Теги памяти: первая сотня",
      conf: 0.68,
      tags: ["memory", "tags"],
      prov: "agb · mnemos-02 · 3 д",
      age: 72,
      kind: "заметка",
      content: [
        "Черновик тег-словаря: домены (ui, agents, sync, security), процессы (reporting, review), дизайн (design, motion). Синонимы склеиваются алиасами: «агенты» = agents.",
        "Уверенность низкая — словарь ещё не утверждён владельцем.",
      ],
    },
  ];

  const servers = [
    { name: "mnemos-01", status: "ok" },
    { name: "mnemos-02", status: "ok" },
    { name: "abyss-lab", status: "ok" },
    { name: "seal-vault", status: "warn" },
  ];

  const counters = {
    total: "12 483",
    tags: 342,
    pulsesHour: 37,
    waiting: 3,
  };

  const waiting = [
    { id: "W-12", title: "Утвердить тег-словарь (M-241)", cta: "Разобрать" },
    { id: "W-11", title: "Разморозить борд после рефакторинга сессий", cta: "Разобрать" },
    { id: "W-9", title: "Подтвердить пейринг нового устройства", cta: "Разобрать" },
  ];

  const agents = [
    { id: "agb", desc: "писатель записей", status: "running" },
    { id: "core", desc: "ядро памяти", status: "queued" },
    { id: "morph", desc: "рефакторинг", status: "failed" },
  ];

  const assignments = {
    active: [
      {
        agent: "agb",
        task: "T-128",
        title: "UI-10 проводник",
        status: "running",
        hb: "пульс 40 с назад",
        report: "reported by agb (unverified)",
      },
    ],
    queued: [
      {
        agent: "core",
        task: "T-131",
        title: "Дозапись смыслового индекса",
        status: "queued",
        wait: "в очереди 4 мин",
        harness: "zcode",
      },
      {
        agent: "morph",
        task: "T-127",
        title: "Чистка дублей тегов",
        status: "queued",
        wait: "в очереди 12 мин",
        harness: "zcode",
        stagnant: true,
        note: "поллер молчит",
      },
    ],
  };

  const agentFeed = [
    { time: "14:02", agent: "agb", text: "отчёт (промежуточный): волна 1 закрыта", kind: "write" },
    { time: "13:47", agent: "core", text: "дозапись индекса: 214 записей переиндексировано", kind: "write" },
    { time: "13:12", agent: "morph", text: "assignment T-124 упал: конфликт записи с agb", kind: "error" },
    { time: "12:58", agent: "agb", text: "recall по M-215 при правке контракта", kind: "recall" },
    { time: "12:31", agent: "core", text: "heartbeat восстановлен после паузы", kind: "recall" },
  ];

  const docs = [
    {
      id: "mnemos-eyes",
      title: { ru: "mnemos-eyes", orig: "mnemos-eyes" },
      snippet: {
        ru: "Вьюер памяти: «живая кора», колодец, импульсы по живой ленте.",
        orig: "Memory viewer: living cortex, the well, live-feed impulses.",
      },
      count: 48,
      updated: "обновлён 2 ч назад",
      prov: "agb · 3 сервера",
      featured: true,
      exp: false,
      paused: false,
    },
    {
      id: "gcw",
      title: { ru: "gcw", orig: "gcw" },
      snippet: {
        ru: "Оркестрация команды агентов: роли, гейты, протоколы отчётов.",
        orig: "Agent team orchestration: roles, gates, reporting protocols.",
      },
      count: 112,
      updated: "обновлён 1 д назад",
      prov: "owner · 1 сервер",
      featured: false,
      exp: false,
      paused: false,
    },
    {
      id: "sealbox",
      title: { ru: "sealbox", orig: "sealbox" },
      snippet: {
        ru: "Хранилище секретов: одноразовые ключи, QR-пейринг устройств.",
        orig: "Secret vault: one-shot keys, device QR pairing.",
      },
      count: 21,
      updated: "обновлён 9 д назад",
      prov: "owner · seal-vault",
      featured: false,
      exp: false,
      paused: true,
    },
  ];

  const explorerFiles = [
    {
      name: "web/",
      type: "dir",
      children: [
        {
          name: "styles/",
          type: "dir",
          children: [
            { name: "tokens.css", type: "file", edited: true },
            { name: "base.css", type: "file" },
          ],
        },
        { name: "app.js", type: "file" },
        { name: "index.html", type: "file" },
      ],
    },
    {
      name: "docs/",
      type: "dir",
      children: [
        { name: "ui-contract.md", type: "file" },
        { name: "adr-0006-frozen-tokens.md", type: "file" },
      ],
    },
    { name: "README.md", type: "file" },
  ];

  const editorTabs = [
    { name: "tokens.css", agent: "agb", note: "agb правит сейчас", lines: "строки 40–48", conflict: false, active: true },
    { name: "base.css", agent: null },
    { name: "adr-0006-frozen-tokens.md", agent: null },
  ];

  const codeLines = [
    "/* tokens — frozen names (ADR 0006) */",
    ":root {",
    "  --color-well-canvas: #090b0f;",
    "  --color-bg-base: #0d0f14;",
    "  --color-bg-well: #12161d;",
    "",
    "  /* v2: charcoal вместо сине-фиолетового уклона */",
    "  --color-bg-elevated: #161b23;",
    "  --color-bg-overlay: #1c222c;",
  ];
  const editedFrom = 5; // 1-based line the agent is editing from

  const buddy = [
    { agent: "agb", note: "«волна 1 закрыта, перехожу к правкам токенов»", lines: "строки 40–48 · tokens.css", diff: true },
    { agent: "core", note: "ждёт разбора индекса", lines: "—", diff: false },
  ];

  const termFiles = {
    "projects/": ["mnemos-eyes/", "gcw/", "sealbox/"],
    "projects/mnemos-eyes/README.md":
      "# mnemos-eyes — вьюер памяти\nКора держит, колодец светит, импульс говорит правду.\nСтенд дизайна: design/stand/, тёмная тема по умолчанию.\n",
    "projects/gcw/README.md":
      "# gcw — GithubCopilotWorkflow\nОркестрация команды агентов: роли, гейты, протоколы отчётов.\nРелизы — только через git-workflow-specialist.\n",
    "projects/sealbox/README.md":
      "# sealbox — хранилище секретов\nОдноразовые ключи, QR-пейринг устройств (90 секунд).\nСекреты не покидают vault без явного решения владельца.\n",
    "README.md":
      "# колодец mnemos\nПамять как организм: кора, страты, синапс-импульсы.\nИмпульс бежит только на реальное событие из ленты.\n",
    "notes.md":
      "# заметки\n- heartbeat агентов: 30 с; молчание 10 мин → предупреждение\n- QR-пейринг живёт 90 с, потом перегенерация\n- свиток читается в Lora, числа — JetBrains Mono\n",
  };

  const feedSeed = [
    { ev: "recall", mem: "M-219", text: "recall: M-219 «Словарь импульсов» — попадание по запросу", time: "14:06" },
    { ev: "write", mem: "M-233", text: "запись агента agb: M-233 «Схема провенанса»", time: "14:02" },
    { ev: "recall", mem: "M-215", text: "recall: M-215 «Heartbeat-контракт» — ссылка из свитка", time: "13:58" },
    { ev: "write", mem: "M-219", text: "запись агента core: индекс обновлён для M-219", time: "13:51" },
    { ev: "error", mem: "M-201", text: "SSE-разрыв на mnemos-02 — переподключились за 8 с", time: "13:47" },
    { ev: "recall", mem: "M-177", text: "recall: M-177 «Выбор шрифтов» — открытие записи", time: "13:40" },
    { ev: "write", mem: "M-241", text: "запись agb: черновик тег-словаря дополнен", time: "13:32" },
    { ev: "recall", mem: "M-189", text: "recall: M-189 «Почему борд заморожен» — из поиска", time: "13:24" },
  ];

  const feedPool = [
    { ev: "recall", mem: "M-215", text: "recall: M-215 «Heartbeat-контракт агентов» — попадание" },
    { ev: "write", mem: "M-233", text: "запись agb: правка M-233 «Схема провенанса»" },
    { ev: "recall", mem: "M-156", text: "recall: M-156 «Лестница страт» — переход из свитка" },
    { ev: "recall", mem: "M-219", text: "recall: M-219 «Словарь импульсов» — ссылка в отчёте" },
    { ev: "write", mem: "M-241", text: "запись agb: M-241 тег-словарь, правка раздела" },
    { ev: "error", mem: "M-201", text: "ошибка: mnemos-02 не ответил на дозапрос ленты" },
    { ev: "recall", mem: "M-177", text: "recall: M-177 «Выбор шрифтов» — открытие" },
    { ev: "write", mem: "M-128", text: "запись agb: черновик к T-128 «UI-10 проводник»" },
  ];

  /* Well graph: 68 nodes in 4 project clusters (mnemos-eyes / gcw / sealbox / core).
   * First 12 = the real fixture memories (feed event ids point at them); the rest
   * are plausible demo records of the same memory organism. */
  function w(id, title, conf, age, cluster, tags, prov) {
    return { id: id, title: title, conf: conf, age: age, kind: "заметка", tags: tags, prov: prov, cluster: cluster, content: [] };
  }
  const wellNodes = [
    // ── реальные фикстуры (совпадают с feedPool/палитрой) ──
    w("T-128", "UI-10 проводник", 0.92, 2, 0, ["ui", "agents"], "agb · mnemos-01"),
    w("T-121", "Пейринг QR", 0.74, 24, 2, ["pairing"], "owner · abyss"),
    w("M-204", "Решение по пейрингу: QR вместо ручного ввода", 0.88, 3, 2, ["pairing", "security"], "owner · abyss"),
    w("M-189", "Почему борд задач заморожен", 0.81, 26, 1, ["tasks", "process"], "owner · abyss"),
    w("M-215", "Heartbeat-контракт агентов", 0.95, 5, 1, ["agents", "contract"], "core · mnemos-01"),
    w("M-177", "Выбор шрифтов: Inter, Lora, JetBrains Mono", 0.9, 144, 0, ["ui", "design"], "owner · abyss"),
    w("M-156", "Лестница страт коры: пять уровней глубины", 0.86, 168, 0, ["ui", "design"], "owner · abyss"),
    w("M-201", "SSE-лента: контракт переподключения", 0.93, 8, 0, ["sync", "contract"], "core · mnemos-01"),
    w("M-148", "Мнемос-ID в отчётах: сноски вместо тела", 0.79, 288, 1, ["process", "reporting"], "owner · abyss"),
    w("M-233", "Схема провенанса: кто · где · когда", 0.91, 1, 3, ["memory", "contract"], "agb · mnemos-01"),
    w("M-219", "Словарь импульсов: событие → цвет → место", 0.94, 1, 0, ["design", "motion"], "owner · abyss"),
    w("M-241", "Теги памяти: первая сотня", 0.68, 72, 3, ["memory", "tags"], "agb · mnemos-02"),
    // ── кластер mnemos-eyes ──
    w("M-301", "Свиток: переносы строк в Lora", 0.87, 12, 0, ["ui"], "agb · mnemos-01"),
    w("M-302", "Палитра Ctrl+K: скелетон-состояние", 0.82, 9, 0, ["ui", "motion"], "agb · mnemos-01"),
    w("M-303", "Хоткей «[»: сворачивание сайдбара", 0.9, 20, 0, ["ui"], "owner · abyss"),
    w("M-304", "Тосты: канал обратной связи", 0.85, 30, 0, ["ui"], "agb · mnemos-01"),
    w("M-305", "Скелетоны: shimmer без blur", 0.78, 40, 0, ["ui", "motion"], "agb · mnemos-02"),
    w("M-306", "Skip-link: первый таб-стоп", 0.92, 50, 0, ["ui", "a11y"], "owner · abyss"),
    w("M-307", "Крошки: обрезка по середине", 0.8, 60, 0, ["ui"], "agb · mnemos-01"),
    w("M-308", "Пилюля live: glow 16px", 0.83, 70, 0, ["ui", "motion"], "agb · mnemos-01"),
    w("M-309", "DPR cap 2 для канваса", 0.88, 80, 0, ["ui", "perf"], "core · mnemos-01"),
    w("M-310", "Idle-ребро: миелин 0.5px", 0.76, 90, 0, ["ui", "design"], "owner · abyss"),
    w("M-311", "Focus-ринг на sticky-панелях", 0.91, 100, 0, ["ui", "a11y"], "owner · abyss"),
    w("M-312", "Сегмент-контрол режимов поиска", 0.84, 110, 0, ["ui"], "agb · mnemos-01"),
    w("M-313", "Сырой вид записи: raw ▾", 0.72, 120, 0, ["ui"], "agb · mnemos-02"),
    w("M-314", "Пустой колодец: 3 узла-семени", 0.69, 130, 0, ["ui", "design"], "owner · abyss"),
    w("M-315", "Мобильный топбар: меню «⋮»", 0.75, 140, 0, ["ui"], "agb · mnemos-01"),
    w("M-316", "Плотность: компакт 32px строки", 0.86, 150, 0, ["ui"], "owner · abyss"),
    w("M-317", "Bento: против одинаковых плиток", 0.89, 160, 0, ["ui", "design"], "owner · abyss"),
    w("M-318", "Иконки: lucide-стиль, stroke 1.5", 0.93, 170, 0, ["ui", "design"], "owner · abyss"),
    w("M-319", "Галерея: витрина канона", 0.81, 180, 0, ["ui", "design"], "agb · mnemos-01"),
    // ── кластер gcw ──
    w("M-320", "Роли: границы и hard denials", 0.94, 55, 1, ["process"], "owner · abyss"),
    w("M-321", "Гейт ревью: veto-правила", 0.9, 65, 1, ["process", "review"], "owner · abyss"),
    w("M-322", "Отчёт волны: checkpoint board", 0.87, 75, 1, ["process", "reporting"], "owner · abyss"),
    w("M-323", "Мнемос-гейты G1–G4", 0.96, 85, 1, ["process", "memory"], "owner · abyss"),
    w("M-324", "Delegation: параллельные лейны", 0.83, 95, 1, ["process"], "owner · abyss"),
    w("M-325", "Блок «Ждут владельца»: формат", 0.88, 105, 1, ["process", "reporting"], "owner · abyss"),
    w("M-326", "Slice report: что/где/как проверено", 0.85, 115, 1, ["process"], "owner · abyss"),
    w("M-327", "Коммит-стиль: type(scope)", 0.92, 125, 1, ["process"], "owner · abyss"),
    w("M-328", "A2A: таблица маршрутизации", 0.8, 135, 1, ["process"], "owner · abyss"),
    w("M-329", "Канонизация: очередь для архитектора", 0.77, 145, 1, ["process"], "owner · abyss"),
    w("M-330", "Прогресс: living roadmap по волнам", 0.86, 155, 1, ["process"], "owner · abyss"),
    w("M-331", "Токен-экономика: recall перед чтением", 0.91, 165, 1, ["process", "memory"], "owner · abyss"),
    w("M-332", "Архком: реальные позиции и споры", 0.84, 175, 1, ["process"], "owner · abyss"),
    w("M-333", "Финальный отчёт: пять пунктов", 0.79, 185, 1, ["process", "reporting"], "owner · abyss"),
    w("M-334", "Чекпоинт в мнемос: каждые 5 ходов", 0.9, 195, 1, ["process", "memory"], "owner · abyss"),
    w("M-335", "Owner-mandate: приоритеты и эскалация", 0.93, 205, 1, ["process"], "owner · abyss"),
    // ── кластер sealbox ──
    w("M-340", "QR-пейринг: окно 90 секунд", 0.89, 15, 2, ["security", "pairing"], "owner · seal-vault"),
    w("M-341", "Одноразовый токен устройства", 0.92, 25, 2, ["security"], "owner · seal-vault"),
    w("M-342", "Маскирование секретов в логах", 0.95, 35, 2, ["security"], "owner · seal-vault"),
    w("M-343", "env:/file: ссылки вместо секретов", 0.9, 45, 2, ["security"], "owner · seal-vault"),
    w("M-344", "Vault: доступ по решению владельца", 0.97, 55, 2, ["security"], "owner · seal-vault"),
    w("M-345", "Ротация ключей сессии", 0.82, 65, 2, ["security"], "owner · seal-vault"),
    w("M-346", "Подпись отчёта: seal", 0.76, 75, 2, ["security"], "owner · seal-vault"),
    w("M-347", "Backup-ключи: оффлайн-хранение", 0.84, 85, 2, ["security"], "owner · seal-vault"),
    w("M-348", "Аудит доступа: журнал событий", 0.87, 95, 2, ["security"], "owner · seal-vault"),
    w("M-349", "Пин-пейринг: fallback без камеры", 0.71, 105, 2, ["security", "pairing"], "owner · seal-vault"),
    // ── кластер core (ядро памяти) ──
    w("M-350", "Индекс: инкрементальная дозапись", 0.93, 18, 3, ["memory", "sync"], "core · mnemos-02"),
    w("M-351", "Confidence: пересчёт при правке", 0.88, 28, 3, ["memory"], "core · mnemos-02"),
    w("M-352", "Сжатие старых сессий", 0.8, 38, 3, ["memory"], "core · mnemos-02"),
    w("M-353", "Синонимы тегов: алиасы", 0.74, 48, 3, ["memory", "tags"], "core · mnemos-02"),
    w("M-354", "Дедупликация записей", 0.85, 58, 3, ["memory"], "core · mnemos-02"),
    w("M-355", "SSE: переподключение 30 секунд", 0.94, 68, 3, ["sync"], "core · mnemos-02"),
    w("M-356", "Лента: окно дозагрузки пропущенного", 0.89, 78, 3, ["sync"], "core · mnemos-02"),
    w("M-357", "Снапшот графа: nightly", 0.83, 88, 3, ["memory"], "core · mnemos-02"),
    w("M-358", "Теги: счётчики использования", 0.78, 98, 3, ["memory", "tags"], "core · mnemos-02"),
    w("M-359", "Связи записей: синапсы по тегам", 0.86, 108, 3, ["memory"], "core · mnemos-02"),
  ];

  window.STAND = {
    memories,
    wellNodes,
    servers,
    counters,
    waiting,
    agents,
    assignments,
    agentFeed,
    docs,
    explorerFiles,
    editorTabs,
    codeLines,
    editedFrom,
    buddy,
    termFiles,
    feedSeed,
    feedPool,
  };
})();
