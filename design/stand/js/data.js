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

  window.STAND = {
    memories,
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
