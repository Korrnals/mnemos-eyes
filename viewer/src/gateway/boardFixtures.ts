import type {
  ArchivePage,
  AssignmentItem,
  AssignmentsPage,
  AutomationSettings,
  AutomationStatus,
  BoardSummary,
  ExecutionSettings,
  ExecutorItem,
  ExecutorsPage,
  HarnessItem,
  HookRule,
  LaunchRow,
  ScheduleRule,
  TaskHistory,
  TaskInbox,
  TaskMemories,
  TaskReports,
} from "./boardTypes";
import type { BoardTask } from "./boardTypes";

/**
 * Deterministic task-domain dataset for the MockAdapter (Ф2, ADR 0011 §6).
 *
 * Shaped from the RECORDED CORPUS (2026-09-19, live board 1.5.0-dev on
 * :8141 — seeded store, real mnemos on :8787 as the "laptop" server): every
 * row mirrors the exact `TaskOut`/`ReportOut`/`EventItem`/`MemoryItem`/
 * `TaskInboxItem` keys the wire serves, so mock mode renders what production
 * renders. Like fixtures.ts: no `Date.now()`, no `Math.random()` — two
 * MockAdapter instances answer byte-identically.
 *
 * Coverage matrix (15 tasks, WF-1 7-lane board): all seven columns × all
 * four priorities × three projects × four envs; three WF-1 lane rows (one
 * backlog, two validating — one past the 24h window and archcom-flagged,
 * the sweep's output), one task with 3 reports (superseded final), one with
 * memory links, plus one archived row for the archive page.
 *
 * AGW-1 agents corpus (same reference point): executors cover presence
 * online/stale/offline × transports local-poll/mesh-r4 × ladder states;
 * assignments cover all 7 lifecycle states and every routing outcome;
 * SCHED-1 automation carries rules + a manual-only launch journal (S1: no
 * engine exists, non-manual launches are provably zero).
 */

const TASK_COLUMNS = [
  "backlog",
  "validating",
  "open",
  "in-progress",
  "blocked",
  "resolved",
  "done",
] as const;

export const MOCK_TASKS: BoardTask[] = [
  {
    id: "TB-1",
    col: "in-progress",
    position: 0,
    title: "Достроить борд v0.3: центральные модалки, управление хранилищами, кластеры",
    summary:
      "Операционный кокпит vesmaro-программы: задачи × статусы × агенты × среды × живая память. " +
      "v0.3 = замечания владельца от 2026-09-15: модалка задачи по центру, полный CRUD хранилищ.",
    spec:
      "Контекст: владелец подтвердил подключение к vesmaro.abyss.lab.\n\n" +
      "Acceptance criteria:\n— [x] задача открывается центральным модальным окном\n" +
      "— [ ] CRUD хранилищ без перезагрузки\n— [ ] кластеры памяти как интерфейсная сущность",
    agents: ["zcode"],
    specialists: ["@GCW: Tech Lead"],
    env: "cluster",
    project: "mnemos-eyes",
    memory_ids: ["25cdc0e9-1912-4217-aaf0-0e7c48912df1"],
    mnemos_tags: ["project:mnemos-eyes", "agent:zcode", "mnemos:decision"],
    created_at: "2026-09-12T09:00:00+00:00",
    updated_at: "2026-09-18T14:30:00+00:00",
    archived: 0,
    status: "in-progress",
    priority: "critical",
    archived_from: "",
    validating_since: "",
  },
  {
    id: "T6",
    col: "in-progress",
    position: 1,
    title: "Подключить L1 viewer к живому mnemos: HttpAdapter + auth flow",
    summary:
      "Backend-гейт (CORS + auth/2FA) снят 2026-06-17. Осталось подключить HttpAdapter к живому API.",
    spec:
      "Контекст: бэкенд-сессия mnemos завершена (HEAD 4331a22).\n\n" +
      "Acceptance criteria:\n— [ ] Authorization: Bearer mnk_… работает в HttpAdapter\n" +
      "— [ ] TOTP-флоу для remote-сессий",
    agents: ["zcode", "claude"],
    specialists: ["@GCW: Senior Frontend Developer", "@GCW: Tech Lead"],
    env: "cluster",
    project: "mnemos-eyes",
    memory_ids: ["25cdc0e9-1912-4217-aaf0-0e7c48912df1"],
    mnemos_tags: ["project:mnemos-eyes", "agent:zcode"],
    created_at: "2026-09-10T11:20:00+00:00",
    updated_at: "2026-09-17T08:15:00+00:00",
    archived: 0,
    status: "in-progress",
    priority: "high",
    archived_from: "",
    validating_since: "",
  },
  {
    id: "TB-3",
    col: "open",
    position: 0,
    title: "Свести документацию конвергенции в единый трекер фаз",
    summary: "Фазы Ф0–Ф4 размазаны по ADR и вердиктам; нужен один трекер с гейтами.",
    spec: "Acceptance criteria:\n— [ ] таблица фаз с гейтами\n— [ ] ссылки на ADR 0011",
    agents: ["zcode"],
    specialists: ["@GCW: Tech Lead"],
    env: "laptop",
    project: "mnemos-eyes",
    memory_ids: [],
    mnemos_tags: ["project:mnemos-eyes"],
    created_at: "2026-09-14T16:45:00+00:00",
    updated_at: "2026-09-14T16:45:00+00:00",
    archived: 0,
    status: "open",
    priority: "normal",
    archived_from: "",
    validating_since: "",
  },
  {
    id: "TB-4",
    col: "open",
    position: 1,
    title: "Прогнать UX-пейринг QR-устройств по §6 концепта",
    summary: "Проверить терминологию и флоу пейринга до реализации.",
    spec: "Acceptance criteria:\n— [ ] матрица состояний согласована",
    agents: [],
    specialists: ["owner"],
    env: "laptop",
    project: "mnemos",
    memory_ids: [],
    mnemos_tags: ["project:mnemos"],
    created_at: "2026-09-15T10:05:00+00:00",
    updated_at: "2026-09-15T10:05:00+00:00",
    archived: 0,
    status: "open",
    priority: "low",
    archived_from: "",
    validating_since: "",
  },
  {
    id: "RB-2",
    col: "blocked",
    position: 0,
    title: "Защитить publish-токены: fine-grained + атмосферу секретов",
    summary:
      "Push-токен Korrnals не имеет org в Repository access (403) — ждать владельца.",
    spec: "Acceptance criteria:\n— [ ] плейсхолдеры выданы\n— [ ] 403 снят",
    agents: ["zcode"],
    specialists: ["@GCW: Tech Lead", "@GCW: Senior Security Engineer"],
    env: "laptop",
    project: "mnemos",
    memory_ids: ["754f83a7-466e-4a42-a884-76382c7ea6d4"],
    mnemos_tags: ["project:mnemos", "topic:security"],
    created_at: "2026-09-11T13:00:00+00:00",
    updated_at: "2026-09-16T17:40:00+00:00",
    archived: 0,
    status: "blocked",
    priority: "high",
    archived_from: "",
    validating_since: "",
  },
  {
    id: "TB-5",
    col: "blocked",
    position: 1,
    title: "Спроектировать SSE-слой viewer: подписки и точечный патч кеша",
    summary: "Живые события без рефетча всего борда — маппинг события → ключи.",
    spec: "Acceptance criteria:\n— [ ] EventStream обёртка\n— [ ] патч tasks.board",
    agents: ["zcode"],
    specialists: ["@GCW: Senior Frontend Developer"],
    env: "local",
    project: "mnemos-eyes",
    memory_ids: [],
    mnemos_tags: ["project:mnemos-eyes", "topic:sse"],
    created_at: "2026-09-16T09:30:00+00:00",
    updated_at: "2026-09-16T09:30:00+00:00",
    archived: 0,
    status: "blocked",
    priority: "critical",
    archived_from: "",
    validating_since: "",
  },
  {
    id: "TB-6",
    col: "resolved",
    position: 0,
    title: "Снять recorded-corpus с merge-API для BoardAdapter-контрактов",
    summary:
      "Корпус снят с живого сервера: board/reports/history/memories/inbox/archive.",
    spec: "Acceptance criteria:\n— [x] корпус зашит в тесты",
    agents: ["zcode"],
    specialists: ["@GCW: Senior QA Engineer"],
    env: "local",
    project: "mnemos-eyes",
    memory_ids: [],
    mnemos_tags: ["project:mnemos-eyes", "topic:qa"],
    created_at: "2026-09-13T08:00:00+00:00",
    updated_at: "2026-09-18T19:10:00+00:00",
    archived: 0,
    status: "resolved",
    priority: "normal",
    archived_from: "",
    validating_since: "",
  },
  {
    id: "TB-7",
    col: "resolved",
    position: 1,
    title: "Согласовать IA домена «Задачи» с архкомом",
    summary:
      "Список-вид против канбана: вердикт §3 — таблица на dense-токенах, канбан Ф3.",
    spec: "Acceptance criteria:\n— [x] вердикт ратифицирован",
    agents: [],
    specialists: ["@GCW: Architectural Committee"],
    env: "cloud",
    project: "mnemos",
    memory_ids: [],
    mnemos_tags: ["project:mnemos", "mnemos:decision"],
    created_at: "2026-09-09T12:00:00+00:00",
    updated_at: "2026-09-15T18:00:00+00:00",
    archived: 0,
    status: "resolved",
    priority: "low",
    archived_from: "",
    validating_since: "",
  },
  {
    id: "TB-8",
    col: "done",
    position: 0,
    title: "Задеплоить /app с history-fallback и заголовками безопасности",
    summary: "Ф0a: multi-stage Containerfile, VESMARO_APP_DIR, CSP — в проде.",
    spec: "Acceptance criteria:\n— [x] деплой 1.4.0",
    agents: ["zcode"],
    specialists: ["@GCW: SRE/DevOps"],
    env: "cloud",
    project: "vesmaro",
    memory_ids: [],
    mnemos_tags: ["project:vesmaro"],
    created_at: "2026-09-05T07:45:00+00:00",
    updated_at: "2026-09-06T10:20:00+00:00",
    archived: 0,
    status: "done",
    priority: "high",
    archived_from: "",
    validating_since: "",
  },
  {
    id: "TB-9",
    col: "done",
    position: 1,
    title: "Написать RU/EN слой i18n для оболочки viewer",
    summary: "Хэнд-ролл ~100 строк, типизированные ключи, без i18next.",
    spec: "Acceptance criteria:\n— [x] ru.ts/en.ts parity",
    agents: ["zcode"],
    specialists: ["@GCW: Senior Frontend Developer"],
    env: "laptop",
    project: "vesmaro",
    memory_ids: [],
    mnemos_tags: ["project:vesmaro", "topic:i18n"],
    created_at: "2026-09-07T15:30:00+00:00",
    updated_at: "2026-09-08T09:00:00+00:00",
    archived: 0,
    status: "done",
    priority: "normal",
    archived_from: "",
    validating_since: "",
  },
  {
    id: "TB-10",
    col: "open",
    position: 2,
    title: "Перенести тег-инспектор в домен «Память» нового app",
    summary: "Ре-парентинг /tags → /memory/tags с редиректами.",
    spec: "Acceptance criteria:\n— [ ] редиректы живут",
    agents: ["zcode"],
    specialists: ["@GCW: Senior Frontend Developer"],
    env: "cluster",
    project: "vesmaro",
    memory_ids: [],
    mnemos_tags: ["project:vesmaro"],
    created_at: "2026-09-17T11:10:00+00:00",
    updated_at: "2026-09-17T11:10:00+00:00",
    archived: 0,
    status: "open",
    priority: "normal",
    archived_from: "",
    validating_since: "",
  },
  {
    id: "TB-11",
    col: "in-progress",
    position: 2,
    title: "Собрать densité-токены и проверить контраст AA",
    summary: "--row-h режимы + проверка 4.5:1 в обеих темах.",
    spec: "Acceptance criteria:\n— [x] токены заморожены",
    agents: [],
    specialists: ["@GCW: Senior Frontend Developer"],
    env: "local",
    project: "mnemos",
    memory_ids: [],
    mnemos_tags: ["project:mnemos", "topic:design"],
    created_at: "2026-09-18T06:25:00+00:00",
    updated_at: "2026-09-18T13:55:00+00:00",
    archived: 0,
    status: "in-progress",
    priority: "low",
    archived_from: "",
    validating_since: "",
  },
  {
    id: "TB-12",
    col: "backlog",
    position: 0,
    title: "WF-1: разобрать бэклог валидации — очередь на проверку владельцем",
    summary: "Пред-валидационная полоса: задачи ждут первого прохода до `open`.",
    spec: "Acceptance criteria:\n— [ ] очередь разобрана",
    agents: [],
    specialists: ["owner"],
    env: "cloud",
    project: "vesmaro",
    memory_ids: [],
    mnemos_tags: ["project:vesmaro", "topic:workflow"],
    created_at: "2026-09-19T07:15:00+00:00",
    updated_at: "2026-09-19T07:15:00+00:00",
    archived: 0,
    status: "open",
    priority: "normal",
    archived_from: "",
    validating_since: "",
  },
  {
    id: "TB-13",
    col: "validating",
    position: 0,
    title: "Валидация фазы Ф2: чтение домена «Задачи» без рефетчей",
    summary: "Задача в полосе валидации; часы тикают с validating_since.",
    spec: "Acceptance criteria:\n— [ ] владелец подтвердил приёмку",
    agents: ["zcode"],
    specialists: ["@GCW: Senior QA Engineer"],
    env: "cluster",
    project: "mnemos-eyes",
    memory_ids: [],
    mnemos_tags: ["project:mnemos-eyes"],
    created_at: "2026-09-19T05:40:00+00:00",
    updated_at: "2026-09-19T05:40:00+00:00",
    archived: 0,
    status: "open",
    priority: "high",
    archived_from: "",
    // Fresh clock: ~6h before the 2026-09-19 corpus reference point.
    validating_since: "2026-09-19T04:00:00+00:00",
  },
  {
    id: "TB-14",
    col: "validating",
    position: 1,
    title: "Валидация ADR 0013: контракты автоматизации против archcom-ревью",
    summary: "Сидит в валидации дольше 24 часов — свип пометил archcom-review.",
    spec: "Acceptance criteria:\n— [ ] решение владельца зафиксировано",
    agents: ["zcode"],
    specialists: ["@GCW: Architectural Committee"],
    env: "cloud",
    project: "mnemos",
    memory_ids: [],
    mnemos_tags: ["project:mnemos", "task:stage:archcom-review"],
    created_at: "2026-09-17T09:00:00+00:00",
    updated_at: "2026-09-18T09:00:00+00:00",
    archived: 0,
    status: "open",
    priority: "critical",
    archived_from: "",
    // Overdue clock: >24h before the corpus reference point (sweep output).
    validating_since: "2026-09-17T09:30:00+00:00",
  },
];

/** Archived row (the board projection never carries archived=1 rows). */
export const MOCK_ARCHIVED_TASK: BoardTask = {
  id: "RB-1",
  col: "blocked",
  position: 2,
  title: "Провести день регистраций vesmaro: org+плейсхолдеры → PyPI/npm → домены",
  summary: "Имя vesmaro подтверждено владельцем. Ждём «да» на runbook.",
  spec: "Acceptance criteria:\n— [ ] фаза A: GitHub org\n— [ ] фаза B: PyPI+npm",
  agents: ["zcode"],
  specialists: ["@GCW: Tech Lead", "owner"],
  env: "laptop",
  project: "mnemos",
  memory_ids: [],
  mnemos_tags: ["project:mnemos", "naming"],
  created_at: "2026-09-10T09:00:00+00:00",
  updated_at: "2026-09-18T20:00:00+00:00",
  archived: 1,
  status: "blocked",
  priority: "normal",
  archived_from: "blocked",
  validating_since: "",
};

function countByColumn(tasks: readonly BoardTask[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const column of TASK_COLUMNS) counts[column] = 0;
  for (const task of tasks) {
    counts[task.col] = (counts[task.col] ?? 0) + 1;
  }
  return counts;
}

export const MOCK_BOARD: BoardSummary = {
  columns: [...TASK_COLUMNS],
  tasks: MOCK_TASKS.map((task) => ({ ...task })),
  counts: countByColumn(MOCK_TASKS),
};

/** Reports for TB-1 — corpus shape: oldest first, one superseded live final. */
export const MOCK_REPORTS: TaskReports = {
  ok: true,
  task_id: "TB-1",
  count: 3,
  items: [
    {
      id: 1,
      task_id: "TB-1",
      kind: "intermediate",
      agent: "zcode",
      body: "Промежуточный отчёт: разведка завершена, роуты Tasks подтверждены.",
      superseded: false,
      created_at: "2026-09-18T14:20:00+00:00",
    },
    {
      id: 2,
      task_id: "TB-1",
      kind: "final",
      agent: "zcode",
      body: "Финальный отчёт v1: список страниц свёрстан.",
      superseded: true,
      created_at: "2026-09-18T14:25:00+00:00",
    },
    {
      id: 3,
      task_id: "TB-1",
      kind: "final",
      agent: "zcode",
      body: "Финальный отчёт v2: список + страница задачи готовы, правки внесены.",
      superseded: false,
      created_at: "2026-09-18T14:30:00+00:00",
    },
  ],
};

/** History for TB-1 — corpus shape: events desc, memory checkpoints desc. */
export const MOCK_HISTORY: TaskHistory = {
  events: [
    {
      ts: "2026-09-18T14:30:00+00:00",
      title: "task.report",
      detail: "final, агент: zcode",
    },
    {
      ts: "2026-09-18T14:25:00+00:00",
      title: "task.report",
      detail: "final, агент: zcode",
    },
    {
      ts: "2026-09-18T14:20:00+00:00",
      title: "task.report",
      detail: "intermediate, агент: zcode",
    },
    {
      ts: "2026-09-18T14:10:00+00:00",
      title: "task.moved",
      detail: "open → in-progress",
    },
    { ts: "2026-09-18T14:00:00+00:00", title: "task.updated", detail: "поля: summary" },
    { ts: "2026-09-12T09:00:00+00:00", title: "task.created", detail: "колонка open" },
  ],
  memories: [
    {
      ts: "2026-07-27T09:26:20.643428Z",
      title: "Session checkpoint — 2026-07-27",
      source: "laptop",
      detail:
        "# Session checkpoint\n\n## Goals\nUpdate mnemos to latest version, run full code+QA review…",
    },
  ],
};

/** Resolved memory links for TB-1 — corpus shape: excerpt-only cards. */
export const MOCK_TASK_MEMORIES: TaskMemories = {
  items: {
    "25cdc0e9-1912-4217-aaf0-0e7c48912df1": {
      id: "25cdc0e9-1912-4217-aaf0-0e7c48912df1",
      title: "Session checkpoint — 2026-07-27",
      excerpt: "# Session checkpoint\n\n## Goals\nUpdate mnemos to latest version…",
      status: "published",
      tags: ["project:mnemos-eyes", "mnemos:checkpoint"],
    },
  },
  unresolved: [
    {
      id: "86ce17e7-1099-4e94-aa1b-eba431522560",
      status: "not_found",
      server: "laptop",
    },
  ],
  sources: { "25cdc0e9-1912-4217-aaf0-0e7c48912df1": "laptop" },
};

/** Inbox mirror — corpus shape (38 live rows distilled to 4 representative). */
export const MOCK_INBOX: TaskInbox = {
  items: [
    {
      memory_id: "bd945a48-0888-4b1f-9ebb-841519e5f8b9",
      server: "laptop",
      project: "mnemos",
      title: "Снять corpus с живого борда для Ф2",
      excerpt: "Правило QA: recorded corpus вместо выдуманного дубля…",
      tags: ["project:mnemos", "task:queue"],
      priority: "high",
      specialist: "@GCW: Senior System Engineer",
      created_at: "2026-09-18T07:00:00+00:00",
      last_seen: "2026-09-19T09:00:00+00:00",
      stale: false,
      adopted: false,
      adopted_task_id: null,
    },
    {
      memory_id: "c2a111f3-5a44-4bb7-9d0e-6f7a2b3c4d5e",
      server: "laptop",
      project: "vesmaro",
      title: "Спроектировать PWA-минимум для /app",
      excerpt: "manifest + theme-color + иконки 192/512 + passthrough SW…",
      tags: ["project:vesmaro", "task:queue"],
      priority: "normal",
      specialist: "",
      created_at: "2026-09-17T16:30:00+00:00",
      last_seen: "2026-09-19T09:00:00+00:00",
      stale: false,
      adopted: false,
      adopted_task_id: null,
    },
    {
      memory_id: "d41b22c4-6b55-4cc8-8e1f-7a8b3c4d5e6f",
      server: "ai-agent",
      project: "mnemos",
      title: "Устранить дрейф FTS5 после переименования тегов",
      excerpt: "Симптом: поиск отдаёт устаревшие сниппеты…",
      tags: ["project:mnemos", "task:queue"],
      priority: "critical",
      specialist: "@GCW: Senior DBA",
      created_at: "2026-09-15T22:10:00+00:00",
      last_seen: "2026-09-18T06:00:00+00:00",
      stale: true,
      adopted: false,
      adopted_task_id: null,
    },
    {
      memory_id: "e52c33d5-7c66-4dd9-9f2a-8b9c4d5e6f70",
      server: "laptop",
      project: "mnemos-eyes",
      title: "Свести ADR 0011 в трекер фаз",
      excerpt: "Уже принято как задача TB-3.",
      tags: ["project:mnemos-eyes", "task:queue"],
      priority: "low",
      specialist: "",
      created_at: "2026-09-14T11:00:00+00:00",
      last_seen: "2026-09-19T09:00:00+00:00",
      stale: false,
      adopted: true,
      adopted_task_id: "TB-3",
    },
  ],
  count: 4,
  refreshed_at: "2026-09-19T09:00:00+00:00",
};

/** Archive page for the default query — corpus shape with project grouping. */
export const MOCK_ARCHIVE: ArchivePage = {
  ok: true,
  count: 1,
  total: 1,
  limit: 50,
  offset: 0,
  items: [{ ...MOCK_ARCHIVED_TASK }],
  projects: {
    mnemos: [
      {
        id: "RB-1",
        title: MOCK_ARCHIVED_TASK.title,
        col: "blocked",
        agents: ["zcode"],
        env: "laptop",
        updated_at: "2026-09-18T20:00:00+00:00",
      },
    ],
  },
};

// --- AGW-1 agents domain (ARCH-9, ADR 0009 Amd 2; spec 2026-09-19) -------------
// Same corpus discipline as the task fixtures: reference point
// 2026-09-19T09:00:00+00:00, no Date.now/Math.random. Presence is a STATIC
// snapshot (the real server computes it from last_seen per GET — the mock
// never recomputes, it serves what the corpus recorded). The projection
// carries NO claim_token and NO spec_snapshot — only the spec_hash
// fingerprint (contract, not fixture choice).

/**
 * Executor registry corpus. Coverage: presence online/stale/offline ×
 * transports local-poll/mesh-r4 × ladder states pending/approved/revoked;
 * capabilities are owner-declared allowlist mappings (spec §0), the L0
 * bootstrap executor (exec-old-poller) deliberately carries none.
 */
export const MOCK_EXECUTORS: ExecutorItem[] = [
  {
    id: "exec-laptop-zcode",
    name: "zcode@laptop",
    harness: "zcode",
    host: "laptop",
    transport: "local-poll",
    capabilities: ["@GCW: Senior Frontend Developer", "@GCW: Tech Lead"],
    version: "1.11.3",
    enabled: true,
    state: "approved",
    last_seen: "2026-09-19T08:59:30+00:00",
    presence: "online",
    registered_via: "",
    registered_at: "2026-09-18T09:00:00+00:00",
    updated_at: "2026-09-19T08:00:00+00:00",
  },
  {
    id: "exec-laptop-hermes",
    name: "hermes@laptop",
    harness: "hermes",
    host: "laptop",
    transport: "local-poll",
    capabilities: ["@GCW: Senior System Engineer"],
    version: "0.4.1",
    enabled: true,
    state: "approved",
    // 5 min before the corpus point — inside the stale corridor (2–10 min).
    last_seen: "2026-09-19T08:55:00+00:00",
    presence: "stale",
    registered_via: "",
    registered_at: "2026-09-17T14:20:00+00:00",
    updated_at: "2026-09-18T10:00:00+00:00",
  },
  {
    id: "exec-mesh-qa",
    name: "zcode@mesh-2",
    harness: "zcode",
    host: "mesh-2",
    transport: "mesh-r4",
    capabilities: ["@GCW: Senior QA Engineer"],
    version: "1.11.3",
    enabled: true,
    state: "approved",
    last_seen: "2026-09-19T08:58:00+00:00",
    presence: "online",
    registered_via: "",
    registered_at: "2026-09-16T11:30:00+00:00",
    updated_at: "2026-09-19T07:45:00+00:00",
  },
  {
    id: "exec-old-poller",
    name: "zcode@old-laptop",
    harness: "zcode",
    host: "old-laptop",
    transport: "local-poll",
    // L0 bootstrap shape: no owner-declared capabilities (auto-tier worker).
    capabilities: [],
    version: "1.10.0",
    enabled: true,
    state: "approved",
    // 3 h silent — beyond the 10 min offline bound.
    last_seen: "2026-09-19T06:00:00+00:00",
    presence: "offline",
    registered_via: "",
    registered_at: "2026-09-15T08:00:00+00:00",
    updated_at: "2026-09-15T08:00:00+00:00",
  },
  {
    id: "exec-copilot-pending",
    name: "copilot@new-host",
    harness: "copilot",
    host: "new-host",
    transport: "mesh-r4",
    capabilities: [],
    version: "0.9.0",
    enabled: false,
    state: "pending",
    // Pending executors MAY tick — the owner sees liveness before approving.
    last_seen: "2026-09-19T08:59:00+00:00",
    presence: "online",
    // Minted through an enrollment token (AGW-5) — the owner cross-checks
    // the origin in the approve decision (design §Threat model).
    registered_via: "enrollment:enr-4f8e2d1c9b0a",
    registered_at: "2026-09-19T08:40:00+00:00",
    updated_at: "2026-09-19T08:40:00+00:00",
  },
  {
    id: "exec-copilot-revoked",
    name: "copilot@old-host",
    harness: "copilot",
    host: "old-host",
    transport: "local-poll",
    capabilities: ["@GCW: Senior Security Engineer"],
    version: "0.8.2",
    enabled: false,
    state: "revoked",
    last_seen: "2026-09-18T18:00:00+00:00",
    presence: "offline",
    registered_via: "",
    registered_at: "2026-09-14T12:00:00+00:00",
    updated_at: "2026-09-18T18:05:00+00:00",
  },
];

/**
 * Registry page meta — the server-owned presence contract travelling WITH
 * the data (spec §5.1): online ≤ 120 s, stale ≤ 600 s, sweeper every 60 s.
 * Prod constants recorded in the corpus; the UI reads, never hardcodes.
 */
export const MOCK_EXECUTORS_META: ExecutorsPage["meta"] = {
  presence: { online_max_age_s: 120, stale_max_age_s: 600 },
  sweeper_interval_s: 60,
};

export const MOCK_EXECUTORS_PAGE: ExecutorsPage = {
  ok: true,
  count: MOCK_EXECUTORS.length,
  items: MOCK_EXECUTORS.map((executor) => ({ ...executor })),
  meta: MOCK_EXECUTORS_META,
};

/**
 * Harness dictionary corpus (wave 3C, design 2026-09-22 §C) — the
 * playground's START state: exactly the server's boot seed (10 rows,
 * added_via 'seed'). This is FIXTURE data for the mock adapter, not a
 * mirror of a UI constant: the live dictionary is `MockAdapter` state
 * mutated through createHarness/deleteHarness, and the real UI reads
 * GET /api/harnesses. The former closed-set mirror module is DELETED
 * (the drift class died with the dictionary).
 */
export const MOCK_HARNESSES: HarnessItem[] = [
  "aider",
  "claude-code",
  "cline",
  "continue",
  "copilot",
  "cursor",
  "hermes",
  "pi",
  "windsurf",
  "zcode",
].map((name) => ({
  name,
  added_at: "2026-09-22T00:00:00+00:00",
  added_via: "seed",
  note: "",
}));

/**
 * Assignment queue corpus — all 7 lifecycle states, plus queued rows
 * covering the distinct routing outcomes (specialist / explicit pin /
 * unmatched wait / global default; claimed/running add the auto tier).
 * claimed_by strings are DECLARED identities (unverified, spec §2.2).
 */
export const MOCK_ASSIGNMENTS: AssignmentItem[] = [
  {
    id: 101,
    task_id: "TB-1",
    specialist: "@GCW: Senior Frontend Developer",
    harness: "zcode",
    state: "queued",
    created_by: "owner",
    claimed_by: null,
    note: "",
    spec_hash: "b6f4a1c2d3e4",
    executor_id: "",
    claimed_by_executor: "",
    created_at: "2026-09-19T08:30:00+00:00",
    claimed_at: null,
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    topics: ["project:mnemos-eyes", "topic:ui"],
    routing: { resolved: "exec-laptop-zcode", reason: "specialist" },
  },
  {
    id: 102,
    task_id: "TB-3",
    specialist: "@GCW: Senior QA Engineer",
    harness: "zcode",
    state: "queued",
    created_by: "owner",
    claimed_by: null,
    note: "",
    spec_hash: "9d2e7b8a1f0c",
    // Explicit pin — the only tier enforced at claim (Amd 2 §5).
    executor_id: "exec-mesh-qa",
    claimed_by_executor: "",
    created_at: "2026-09-19T08:41:00+00:00",
    claimed_at: null,
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    topics: ["project:mnemos-eyes"],
    routing: { resolved: "exec-mesh-qa", reason: "explicit" },
  },
  {
    id: 103,
    task_id: "TB-5",
    specialist: "@GCW: Senior Frontend Developer",
    harness: "hermes",
    state: "queued",
    created_by: "automation",
    claimed_by: null,
    note: "создано правилом «ночной чек»",
    spec_hash: "0a5c9e3b7d21",
    executor_id: "",
    claimed_by_executor: "",
    created_at: "2026-09-19T07:05:00+00:00",
    claimed_at: null,
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    topics: ["project:mnemos-eyes", "topic:sse"],
    // No eligible route — the honest «ждёт исполнителя» chip (spec §2.3).
    routing: { resolved: null, reason: "unmatched" },
  },
  {
    id: 104,
    task_id: "TB-12",
    specialist: "@GCW: SRE/DevOps",
    harness: "zcode",
    state: "queued",
    created_by: "owner",
    claimed_by: null,
    note: "",
    spec_hash: "c81b6f2a4e90",
    executor_id: "",
    claimed_by_executor: "",
    created_at: "2026-09-19T08:50:00+00:00",
    claimed_at: null,
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    topics: ["project:vesmaro", "topic:workflow"],
    routing: { resolved: "exec-laptop-zcode", reason: "global-default" },
  },
  {
    id: 105,
    task_id: "T6",
    specialist: "@GCW: Senior Frontend Developer",
    harness: "zcode",
    state: "claimed",
    created_by: "owner",
    // Declared identity — executor-claimed, server-unverified.
    claimed_by: "zcode:laptop",
    note: "",
    spec_hash: "e7d3a8f1b6c4",
    executor_id: "",
    claimed_by_executor: "exec-laptop-zcode",
    created_at: "2026-09-19T08:20:00+00:00",
    // 16 min before the corpus point — feeds the >10 min no-start amber.
    claimed_at: "2026-09-19T08:44:00+00:00",
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    topics: ["project:mnemos-eyes"],
    routing: { resolved: "exec-laptop-zcode", reason: "specialist" },
  },
  {
    id: 106,
    task_id: "TB-11",
    specialist: "@GCW: Senior Frontend Developer",
    harness: "zcode",
    state: "running",
    created_by: "owner",
    claimed_by: "zcode:laptop",
    note: "",
    spec_hash: "1f0b9c5e2a8d",
    executor_id: "",
    claimed_by_executor: "exec-laptop-zcode",
    created_at: "2026-09-19T08:10:00+00:00",
    claimed_at: "2026-09-19T08:35:00+00:00",
    started_at: "2026-09-19T08:40:00+00:00",
    // Fresh pulse — 90 s before the corpus point (inside the 2 min bound).
    heartbeat_at: "2026-09-19T08:58:30+00:00",
    finished_at: null,
    topics: ["project:mnemos", "topic:design"],
    routing: { resolved: "exec-laptop-zcode", reason: "auto" },
  },
  {
    id: 107,
    task_id: "TB-6",
    specialist: "@GCW: Senior QA Engineer",
    harness: "zcode",
    state: "done",
    created_by: "owner",
    claimed_by: "zcode:mesh-2",
    note: "финальный отчёт записан (final, id 3)",
    spec_hash: "4c2d7e9a1b5f",
    executor_id: "",
    claimed_by_executor: "exec-mesh-qa",
    created_at: "2026-09-19T06:00:00+00:00",
    claimed_at: "2026-09-19T06:05:00+00:00",
    started_at: "2026-09-19T06:07:00+00:00",
    heartbeat_at: "2026-09-19T07:50:00+00:00",
    finished_at: "2026-09-19T08:05:00+00:00",
    topics: ["project:mnemos-eyes", "topic:qa"],
    routing: { resolved: "exec-mesh-qa", reason: "specialist" },
  },
  {
    id: 108,
    task_id: "RB-2",
    specialist: "@GCW: Senior Security Engineer",
    harness: "copilot",
    state: "failed",
    created_by: "owner",
    claimed_by: "copilot:old-host",
    note: "причина из fail-отчёта: publish-токен без org → 403",
    spec_hash: "6a8e1d3f0c7b",
    executor_id: "",
    claimed_by_executor: "exec-copilot-revoked",
    created_at: "2026-09-18T15:00:00+00:00",
    claimed_at: "2026-09-18T15:02:00+00:00",
    started_at: "2026-09-18T15:05:00+00:00",
    heartbeat_at: "2026-09-18T17:40:00+00:00",
    finished_at: "2026-09-18T17:55:00+00:00",
    topics: ["project:mnemos", "topic:security"],
    routing: { resolved: null, reason: "unmatched" },
  },
  {
    id: 109,
    task_id: "TB-7",
    specialist: "@GCW: Architectural Committee",
    harness: "zcode",
    state: "cancelled",
    created_by: "owner",
    claimed_by: null,
    note: "владелец отменил: дубликат запуска",
    spec_hash: "2b7f4c9a1e6d",
    executor_id: "",
    claimed_by_executor: "",
    created_at: "2026-09-19T05:00:00+00:00",
    claimed_at: null,
    started_at: null,
    heartbeat_at: null,
    finished_at: "2026-09-19T05:10:00+00:00",
    topics: ["project:mnemos"],
    routing: { resolved: null, reason: "unmatched" },
  },
  {
    id: 110,
    task_id: "TB-13",
    specialist: "@GCW: Senior QA Engineer",
    harness: "zcode",
    state: "expired",
    created_by: "automation",
    claimed_by: "zcode:old-laptop",
    note: "reaper: 30 мин без пульса",
    spec_hash: "8e0c3b7d5f2a",
    executor_id: "",
    claimed_by_executor: "exec-old-poller",
    created_at: "2026-09-19T03:00:00+00:00",
    claimed_at: "2026-09-19T03:10:00+00:00",
    started_at: "2026-09-19T03:15:00+00:00",
    heartbeat_at: "2026-09-19T04:00:00+00:00",
    finished_at: "2026-09-19T04:30:00+00:00",
    topics: ["project:mnemos-eyes"],
    routing: { resolved: null, reason: "unmatched" },
  },
];

export const MOCK_ASSIGNMENTS_PAGE: AssignmentsPage = {
  ok: true,
  count: MOCK_ASSIGNMENTS.length,
  items: MOCK_ASSIGNMENTS.map((assignment) => ({ ...assignment })),
};

/** Default-executor pair (Amd 2 §5): the laptop poller routes, mesh backs. */
export const MOCK_EXECUTION_SETTINGS: ExecutionSettings = {
  ok: true,
  default_executor: "exec-laptop-zcode",
  fallback_executor: "exec-mesh-qa",
  scope: "",
};

// --- SCHED-1 automation fixtures (ADR 0013; S1 = contracts, no engine) --------

export const MOCK_SCHEDULES: ScheduleRule[] = [
  {
    id: 1,
    name: "утренний съём статуса TB-1",
    enabled: true,
    target_kind: "task",
    task_id: "TB-1",
    specialist: "@GCW: Senior Frontend Developer",
    harness: "zcode",
    executor_id: "",
    trigger_kind: "time-of-day",
    trigger_value: "09:00",
    window_from: null,
    window_to: null,
    max_runs_per_day: 1,
    cooldown_s: 3600,
    next_run_at: "2026-09-20T09:00:00+00:00",
    last_run_at: "2026-09-19T09:00:00+00:00",
    created_by: "owner",
    created_at: "2026-09-18T12:00:00+00:00",
    updated_at: "2026-09-18T12:00:00+00:00",
  },
  {
    id: 2,
    name: "ночной чек спек-драйф TB-5",
    // Soft-deleted retention row (ADR 0013 §2): listed, disabled, name held.
    enabled: false,
    target_kind: "task",
    task_id: "TB-5",
    specialist: "@GCW: Senior Frontend Developer",
    harness: "hermes",
    executor_id: "",
    trigger_kind: "interval",
    trigger_value: "PT12H",
    window_from: "23:00",
    window_to: "07:00",
    max_runs_per_day: 2,
    cooldown_s: 3600,
    next_run_at: null,
    last_run_at: "2026-09-19T03:00:00+00:00",
    created_by: "owner",
    created_at: "2026-09-17T10:00:00+00:00",
    updated_at: "2026-09-19T04:00:00+00:00",
  },
];

export const MOCK_HOOKS: HookRule[] = [
  {
    id: 1,
    name: "уведомить о провале исполнения",
    enabled: true,
    on: "assignment.failed",
    condition: [],
    source_allowlist: ["ui", "server", "machine"],
    action: "notify",
    action_payload: {},
    cooldown_s: 300,
    budget: 4,
    created_by: "owner",
    created_at: "2026-09-18T09:00:00+00:00",
    updated_at: "2026-09-18T09:00:00+00:00",
  },
  {
    id: 2,
    name: "черновик поручения при блокировке",
    enabled: false,
    on: "task.updated",
    condition: [{ field: "task_col", op: "eq", value: "blocked" }],
    source_allowlist: ["ui", "server"],
    action: "create_assignment",
    action_payload: { specialist: "@GCW: Tech Lead", harness: "zcode" },
    cooldown_s: 1800,
    budget: 2,
    created_by: "owner",
    created_at: "2026-09-18T15:30:00+00:00",
    updated_at: "2026-09-19T06:00:00+00:00",
  },
];

/**
 * Launch journal corpus. S1 honesty (ADR 0013 §2): no engine exists, so
 * every row is a MANUAL trigger (origin ui) — non-manual launches are
 * provably zero, and the skipped row records a refused 409 attempt.
 */
export const MOCK_LAUNCHES: LaunchRow[] = [
  {
    id: 2,
    rule_id: 1,
    rule_kind: "schedule",
    rule_name: "утренний съём статуса TB-1",
    run_at: "2026-09-19T09:05:00+00:00",
    event_id: null,
    trigger: "manual",
    origin: "ui",
    decision: "skipped",
    reason: "409: активное поручение уже держит задачу TB-1",
    assignment_id: null,
    attempted_at: "2026-09-19T09:05:01+00:00",
  },
  {
    id: 1,
    rule_id: 1,
    rule_kind: "schedule",
    rule_name: "утренний съём статуса TB-1",
    run_at: "2026-09-19T09:00:00+00:00",
    event_id: null,
    trigger: "manual",
    origin: "ui",
    decision: "launched",
    reason: "",
    assignment_id: 101,
    attempted_at: "2026-09-19T09:00:01+00:00",
  },
];

/**
 * Kill-switch + daily cap starting values — the store defaults VERBATIM
 * (store.py ADR 0013 §6: enabled=false disable-by-default C-1,
 * cap=AUTOMATION_DEFAULT_GLOBAL_CAP=10, clamp 1..1000).
 */
export const MOCK_AUTOMATION_SETTINGS: AutomationSettings = {
  ok: true,
  enabled: false,
  cap_global_per_day: 10,
};

/**
 * Status projection — engine false is the honest S1 constant (no loop).
 * `global_kill_switch`/`daily_cap` are overridden by MockAdapter from the
 * LIVE settings pair (server parity); the values here are the same store
 * defaults, kept only as the static fallback shape.
 */
export const MOCK_AUTOMATION_STATUS: AutomationStatus = {
  ok: true,
  engine: false,
  global_kill_switch: false,
  daily_cap: 10,
  daily_used: 0,
  // condition_meta mirrors the SERVER dictionaries VERBATIM
  // (store.RULE_CONDITION_FIELD_ENUMS / HOOK_EVENT_WHITELIST): fields with
  // closed enums get values_hint; project/specialist/executor_id are
  // free-form (null); harness joins through the harness DICTIONARY corpus
  // (wave 3C — MockAdapter.automationStatus re-derives the live list from
  // its dictionary state). The form is BUILT from it, never from UI
  // constants (review SCHED-1-UI P2-1).
  condition_meta: {
    fields: [
      "col",
      "env",
      "executor_id",
      "harness",
      "priority",
      "project",
      "specialist",
      "state",
      "status",
      "transport",
    ],
    ops: ["eq", "ne"],
    values_hint: {
      col: [
        "backlog",
        "validating",
        "open",
        "in-progress",
        "blocked",
        "resolved",
        "done",
      ],
      env: ["cluster", "laptop", "local", "cloud", "unknown"],
      executor_id: null,
      harness: MOCK_HARNESSES.map((harness) => harness.name),
      priority: ["critical", "high", "normal", "low"],
      project: null,
      specialist: null,
      state: ["queued", "claimed", "running", "done", "failed", "cancelled", "expired"],
      status: ["blocked", "done", "in-progress", "open", "resolved", "withdrawn"],
      transport: ["local-poll", "mesh-r4"],
    },
    events: [
      "task.moved",
      "assignment.failed",
      "assignment.expired",
      "task.validation-timeout",
      "executor.offline",
    ],
    actions: ["create_assignment", "notify"],
    source_origins: ["machine", "server", "ui"],
  },
  rules: {
    schedules: { total: 2, enabled: 1 },
    hooks: { total: 2, enabled: 1 },
  },
};
