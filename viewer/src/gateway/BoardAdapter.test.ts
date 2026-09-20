import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardAdapter } from "./BoardAdapter";
import { EventStream } from "./events";
import { clearToken, getToken, onUnauthorized, setToken } from "./auth";
import { ApiError } from "@/lib/errors";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** fetch double that records calls and answers with the given body/status. */
function respondingFetch(data: unknown, status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    jsonResponse(data, status),
  );
}

beforeEach(() => {
  clearToken();
});

afterEach(() => {
  clearToken();
});

describe("BoardAdapter wire contract", () => {
  it("search: GET /mnemos/search with q/limit/project, hits normalised", async () => {
    const fetchMock = respondingFetch({
      ok: true,
      results: [
        {
          id: "hit-1",
          title: "Scroll",
          content: "Body",
          tags: ["project:x"],
          score: 0.87,
          search_type: "semantic",
          server: "mnemos-main",
        },
      ],
      errors: [],
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const hits = await adapter.search({ query: "gateway", project: "x", limit: 5 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/mnemos/search?q=gateway&limit=5&project=x");
    expect(init.method).toBe("GET");
    // Provenance `server` is board-only and not part of SearchResult yet.
    expect(hits).toEqual([
      {
        id: "hit-1",
        title: "Scroll",
        content: "Body",
        tags: ["project:x"],
        score: 0.87,
        search_type: "semantic",
      },
    ]);
  });

  it("search: anonymous hits get honest defaults", async () => {
    const fetchMock = respondingFetch({ ok: true, results: [{}] });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const [hit] = await adapter.search({ query: "x" });

    expect(hit).toEqual({
      id: "hit-0",
      title: "",
      content: "",
      tags: [],
      score: 0,
      search_type: "fts",
    });
  });

  it("listMemoriesPage: GET /memories with limit, opaque cursor and native filters", async () => {
    const fetchMock = respondingFetch({
      items: [
        {
          id: "mem-1",
          server: "cluster",
          title: "First",
          tags: ["project:x"],
          status: "published",
          project: "x",
          created_at: "2026-09-19T10:00:00Z",
          updated_at: "2026-09-19T11:00:00Z",
          excerpt: "Excerpt only (SEC-4)",
        },
      ],
      next_cursor: "cur-2",
      truncated: true,
      errors: [],
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const page = await adapter.listMemoriesPage({
      limit: 20,
      cursor: "cur-1",
      scope: "cluster",
      status: "published",
      project: "x",
    });

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "/api/memories?limit=20&cursor=cur-1&scope=cluster&status=published&project=x",
    );
    // The generated MemoryListOut page passes through unmapped.
    expect(page.next_cursor).toBe("cur-2");
    expect(page.truncated).toBe(true);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      id: "mem-1",
      server: "cluster",
      excerpt: "Excerpt only (SEC-4)",
    });
  });

  it("listMemoriesPage: cursor continuation walks to a terminal page", async () => {
    let call = 0;
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        call += 1;
        return jsonResponse({
          items: [{ id: `mem-${call}`, server: "cluster", title: "", tags: [] }],
          next_cursor: call === 1 ? "page-2" : null,
          truncated: false,
          errors: [],
        });
      },
    );
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const first = await adapter.listMemoriesPage({ limit: 1 });
    const second = await adapter.listMemoriesPage({
      limit: 1,
      cursor: first.next_cursor!,
    });

    expect((fetchMock.mock.calls[1] as [string])[0]).toBe(
      "/api/memories?limit=1&cursor=page-2",
    );
    expect(second.next_cursor).toBeNull();
    expect(second.truncated).toBe(false);
  });

  it("listMemories: flattens the page, excerpt lands in content, agent from tags", async () => {
    const fetchMock = respondingFetch({
      items: [
        {
          id: "mem-1",
          server: "cluster",
          title: "First",
          tags: ["project:x", "agent:z"],
          status: "published",
          project: "x",
          created_at: "2026-09-19T10:00:00Z",
          updated_at: "2026-09-19T10:00:00Z",
          excerpt: "excerpt body",
        },
      ],
      next_cursor: null,
      truncated: false,
      errors: [],
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const memories = await adapter.listMemories({
      limit: 2,
      status: "published",
      project: "x",
    });

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "/api/memories?limit=2&status=published&project=x",
    );
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      id: "mem-1",
      title: "First",
      content: "excerpt body", // SEC-4: list rows are excerpt-only
      tags: ["project:x", "agent:z"],
      status: "published",
      project: "x",
      agent: "z", // recovered from the agent: tag (absent on the wire row)
    });
  });

  it("getMemory: maps the ok-envelope from the first resolving server", async () => {
    const fetchMock = respondingFetch({
      ok: true,
      server: "mnemos-main",
      memory: {
        id: "mem-9",
        title: "Card",
        content: "Body",
        raw_content: "raw",
        tags: ["project:x", "agent:z"],
        status: "published",
        memory_type: "fact",
        source: "cli",
        project: "x",
        agent: "z",
        created_at: "2026-09-19T10:00:00Z",
        updated_at: "2026-09-19T11:00:00Z",
      },
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const memory = await adapter.getMemory("mem-9");

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/memories/item/mem-9");
    expect(memory).toMatchObject({
      id: "mem-9",
      title: "Card",
      content: "Body",
      raw_content: "raw",
      tags: ["project:x", "agent:z"],
      status: "published",
      memory_type: "fact",
      source: "cli",
      project: "x",
      agent: "z",
    });
  });

  it("getMemory: not-found envelope becomes ApiError 404", async () => {
    const fetchMock = respondingFetch({
      ok: false,
      error: "memory not found on any active server",
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const error = await adapter.getMemory("mem-x").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect((error as ApiError).message).toContain("memory not found");
  });

  it("listTags: GET /tags maps {name,count} onto the TagSummary shape", async () => {
    const fetchMock = respondingFetch({
      tags: [
        { name: "project:x", count: 12 },
        { name: "agent:z", count: 3 },
      ],
      servers_scanned: 2,
      errors: [],
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const tags = await adapter.listTags();

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/tags");
    expect(tags).toEqual([
      { tag: "project:x", count: 12 },
      { tag: "agent:z", count: 3 },
    ]);
  });

  it("health: projects the board payload onto the string-map HealthStatus", async () => {
    const fetchMock = respondingFetch({
      ok: true,
      service: "vesmaro-eyes",
      board_tasks: 7,
      servers: [{ name: "mnemos-main" }],
      groups: [],
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const health = await adapter.health();

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/health");
    expect(health.status).toBe("ok");
    expect(health.service).toBe("vesmaro-eyes");
    expect(health.board_tasks).toBe("7");
    // Nested arrays have no place in the string-map shape.
    expect(JSON.stringify(health)).not.toContain("mnemos-main");
  });

  it("health: a not-ok board degrades honestly", async () => {
    const fetchMock = respondingFetch({ ok: false });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const health = await adapter.health();
    expect(health.status).toBe("degraded");
  });

  it("board: GET /board with optional status filter", async () => {
    const fetchMock = respondingFetch({
      columns: ["open"],
      tasks: [],
      counts: { open: 0 },
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await adapter.board("open");
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/board?status=open");

    await adapter.board();
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe("/api/board");
  });

  it("inbox: GET /tasks/inbox with scope/project/include_adopted", async () => {
    const fetchMock = respondingFetch({
      items: [],
      count: 0,
      refreshed_at: "2026-09-19T00:00:00Z",
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await adapter.inbox({ scope: "mnemos-main", project: "x", include_adopted: true });

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "/api/tasks/inbox?scope=mnemos-main&project=x&include_adopted=true",
    );
  });

  it("events(): returns the SSE EventStream wired to the adapter base", () => {
    const adapter = new BoardAdapter({ baseUrl: "/api" });
    const stream = adapter.events();
    expect(stream).toBeInstanceOf(EventStream);
    stream.close();
  });

  // Recorded corpus (2026-09-19, live board 1.4.1 + stub mnemos store): the
  // exact anonymous dict `GET /api/memories/pulse` answers with — QA rule
  // "recorded corpus instead of an invented double".
  const PULSE_WIRE_FIXTURE = {
    ok: true,
    scope: "all",
    kind: "all",
    items: [
      {
        id: "mem-stub-001",
        title: "CV-1 shell plan",
        tags: ["topic:convergence", "agent:gcw-frontend"],
        status: "published",
        created_at: "2026-09-19T10:00:00Z",
        server: "stub-store",
      },
      {
        id: "mem-stub-002",
        title: "Pulse wire notes",
        tags: ["topic:pulse"],
        status: "processed",
        created_at: "2026-09-19T09:30:00Z",
        server: "stub-store",
      },
    ],
    per_server: [{ server: "stub-store", ok: true, items: 2, detail: null }],
  };

  it("pulse: GET /memories/pulse with scope/project/limit, corpus normalised", async () => {
    const fetchMock = respondingFetch(PULSE_WIRE_FIXTURE);
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const pulse = await adapter.pulse({ scope: "all", limit: 20 });

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "/api/memories/pulse?scope=all&limit=20",
    );
    expect(pulse).toEqual(PULSE_WIRE_FIXTURE);
    expect(pulse.store_stats).toBeUndefined(); // absent on the fed path
  });

  it("pulse: degraded rows keep honest defaults, empty-feed stats pass through", async () => {
    const fetchMock = respondingFetch({
      ok: false,
      scope: "all",
      kind: "all",
      items: [],
      per_server: [
        { server: "down-store", ok: false, items: 0, detail: { detail: "503" } },
      ],
      store_stats: [{ server: "down-store", stats: null }],
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const pulse = await adapter.pulse();

    expect(pulse.ok).toBe(false);
    expect(pulse.items).toEqual([]);
    expect(pulse.per_server[0].detail).toEqual({ detail: "503" });
    expect(pulse.store_stats).toEqual([{ server: "down-store", stats: null }]);
  });

  it("boardHealth: GET /health per-store rows normalised onto the detail view", async () => {
    // Recorded corpus (same session): servers[] carries the §7 dot contract.
    const fetchMock = respondingFetch({
      ok: true,
      service: "vesmaro-eyes",
      board_tasks: 11,
      servers: [
        {
          name: "stub-store",
          group_name: "lab",
          enabled: true,
          state: "idle",
          description: "stub for wire capture",
          ok: true,
          latency_ms: 18.3,
          error: null,
          memories_total: 2,
        },
      ],
      groups: [],
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const health = await adapter.boardHealth();

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/health");
    expect(health).toEqual({
      ok: true,
      service: "vesmaro-eyes",
      board_tasks: 11,
      servers: [
        {
          name: "stub-store",
          group_name: "lab",
          enabled: true,
          state: "idle",
          description: "stub for wire capture",
          ok: true,
          latency_ms: 18.3,
          error: null,
          memories_total: 2,
        },
      ],
    });
  });
});

// --- Ф2 task-domain reads ------------------------------------------------------
// Recorded corpus (2026-09-19, live board on :8141 — seeded store + the real
// mnemos on :8787 registered as "laptop"): the exact wire bodies the new
// endpoints answered with, trimmed to representative rows (QA rule: recorded
// corpus instead of an invented double).

const CORPUS_REPORTS = {
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
      created_at: "2026-09-19T21:12:12+00:00",
    },
    {
      id: 2,
      task_id: "TB-1",
      kind: "final",
      agent: "zcode",
      body: "Финальный отчёт v1: список страниц свёрстан.",
      superseded: true,
      created_at: "2026-09-19T21:12:16+00:00",
    },
    {
      id: 3,
      task_id: "TB-1",
      kind: "final",
      agent: "zcode",
      body: "Финальный отчёт v2: список + страница задачи готовы, правки внесены.",
      superseded: false,
      created_at: "2026-09-19T21:12:19+00:00",
    },
  ],
};

const CORPUS_HISTORY = {
  events: [
    {
      ts: "2026-09-19T21:12:19+00:00",
      title: "task.report",
      detail: "final, агент: zcode",
    },
    {
      ts: "2026-09-19T21:12:12+00:00",
      title: "task.report",
      detail: "intermediate, агент: zcode",
    },
    {
      ts: "2026-09-19T21:11:58+00:00",
      title: "task.moved",
      detail: "in-progress → in-progress",
    },
    { ts: "2026-09-19T21:11:52+00:00", title: "task.updated", detail: "поля: summary" },
  ],
  memories: [
    {
      ts: "2026-07-27T09:26:20.643428Z",
      title: "Session checkpoint — 2026-07-27T09:26:20.643279+00:00",
      source: "laptop",
      detail: "# Session checkpoint — 2026-07-27T09:26:20.643279+00:00\n\n## Goals\n…",
    },
  ],
};

const CORPUS_TASK_MEMORIES = {
  items: {
    "25cdc0e9-1912-4217-aaf0-0e7c48912df1": {
      id: "25cdc0e9-1912-4217-aaf0-0e7c48912df1",
      title: "Session checkpoint — 2026-07-27T09:26:20.643279+00:00",
      excerpt: "# Session checkpoint — 2026-07-27T09:26:20.643279+00:00\n\n## Goals\n…",
      status: "published",
      tags: ["project:mnemos-eyes", "mnemos:checkpoint"],
    },
  },
  unresolved: [],
  sources: { "25cdc0e9-1912-4217-aaf0-0e7c48912df1": "laptop" },
};

const CORPUS_ARCHIVED_ROW = {
  id: "RB-1",
  col: "blocked",
  position: 2,
  title: "Провести день регистраций vesmaro",
  summary: "Имя vesmaro подтверждено владельцем.",
  spec: "Acceptance criteria:\n— [ ] фаза A: GitHub org",
  agents: ["zcode"],
  specialists: ["@GCW: Tech Lead", "owner"],
  env: "laptop",
  project: "mnemos",
  memory_ids: [],
  mnemos_tags: ["project:mnemos", "naming"],
  created_at: "2026-09-19T21:11:24+00:00",
  updated_at: "2026-09-19T21:12:19+00:00",
  archived: 1,
  status: "blocked",
  priority: "normal",
  archived_from: "blocked",
};

const CORPUS_ARCHIVE = {
  ok: true,
  count: 1,
  total: 1,
  limit: 5,
  offset: 0,
  items: [CORPUS_ARCHIVED_ROW],
  projects: {
    mnemos: [
      {
        id: "RB-1",
        title: "Провести день регистраций vesmaro",
        col: "blocked",
        agents: ["zcode"],
        env: "laptop",
        updated_at: "2026-09-19T21:12:19+00:00",
      },
    ],
  },
};

const CORPUS_BOARD_TASK = {
  id: "T6",
  col: "in-progress",
  position: 1,
  title: "Подключить L1 viewer к живому mnemos: HttpAdapter + auth flow",
  summary: "Backend-гейт (CORS + auth/2FA) снят 2026-06-17.",
  spec: "Acceptance criteria:\n— [ ] Authorization: Bearer mnk_…",
  agents: ["zcode"],
  specialists: ["@GCW: Senior Frontend Developer", "@GCW: Tech Lead"],
  env: "cluster",
  project: "mnemos-eyes",
  memory_ids: ["25cdc0e9-1912-4217-aaf0-0e7c48912df1"],
  mnemos_tags: ["project:mnemos-eyes", "agent:zcode", "mnemos:decision"],
  created_at: "2026-09-19T21:11:24+00:00",
  updated_at: "2026-09-19T21:11:24+00:00",
  archived: 0,
  status: "in-progress",
  priority: "normal",
  archived_from: "",
  validating_since: "",
};

describe("BoardAdapter Ф2 task reads (recorded corpus)", () => {
  it("reports: GET /tasks/{id}/reports passes the corpus through", async () => {
    const fetchMock = respondingFetch(CORPUS_REPORTS);
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const reports = await adapter.reports("TB-1");

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/tasks/TB-1/reports");
    expect(reports.count).toBe(3);
    expect(reports.items[1].superseded).toBe(true);
    expect(reports.items[2].superseded).toBe(false);
  });

  it("history: GET /tasks/{id}/history — events desc + memory checkpoints", async () => {
    const fetchMock = respondingFetch(CORPUS_HISTORY);
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const history = await adapter.history("TB-1");

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/tasks/TB-1/history");
    expect(history.events[0].title).toBe("task.report");
    expect(history.memories[0].source).toBe("laptop");
  });

  it("taskMemories: GET /tasks/{id}/memories — cards + sources + unresolved", async () => {
    const fetchMock = respondingFetch(CORPUS_TASK_MEMORIES);
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const links = await adapter.taskMemories("T6");

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/tasks/T6/memories");
    expect(links.sources["25cdc0e9-1912-4217-aaf0-0e7c48912df1"]).toBe("laptop");
    expect(Object.keys(links.items)).toHaveLength(1);
  });

  it("archive: GET /archive with the full filter set + pagination", async () => {
    const fetchMock = respondingFetch(CORPUS_ARCHIVE);
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const page = await adapter.archive({
      q: "регистрац",
      status: "blocked",
      col: "blocked",
      agent: "zcode",
      project: "mnemos",
      limit: 5,
      offset: 0,
    });

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "/api/archive?q=%D1%80%D0%B5%D0%B3%D0%B8%D1%81%D1%82%D1%80%D0%B0%D1%86" +
        "&status=blocked&col=blocked&agent=zcode&project=mnemos&limit=5&offset=0",
    );
    expect(page.total).toBe(1);
    expect(page.items[0].archived).toBe(1);
    expect(page.items[0].archived_from).toBe("blocked");
    expect(page.projects.mnemos).toHaveLength(1);
  });

  it("taskById: picks the row from the board projection, 404 when absent", async () => {
    const fetchMock = respondingFetch({
      columns: ["open", "in-progress"],
      tasks: [CORPUS_BOARD_TASK],
      counts: { open: 0, "in-progress": 1 },
    });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const task = await adapter.taskById("T6");
    expect(task.id).toBe("T6");
    expect(task.priority).toBe("normal");

    const error = (await adapter.taskById("NOPE").catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
  });
});

describe("BoardAdapter error and auth behaviour", () => {
  it("maps non-2xx responses onto ApiError with the server detail", async () => {
    const fetchMock = respondingFetch({ detail: "boom" }, 500);
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const error = (await adapter.board().catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(500);
    expect(error.message).toBe("boom");
  });

  it("flattens FastAPI validation errors into the message", async () => {
    const fetchMock = respondingFetch(
      { detail: [{ loc: ["query", "q"], msg: "Field required", type: "missing" }] },
      422,
    );
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const error = (await adapter
      .search({ query: "" })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(422);
    expect(error.message).toBe("Field required");
  });

  it("never attaches an Authorization header, even with a token in memory", async () => {
    setToken("mnk_should_never_leave");
    const fetchMock = respondingFetch({ ok: true });
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await adapter.health();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(getToken()).toBe("mnk_should_never_leave"); // untouched, just unused
  });

  it("a 401 never raises the mnemos unauthorized flag (reads are open)", async () => {
    const fetchMock = respondingFetch({ detail: "nope" }, 401);
    const adapter = new BoardAdapter({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const unauthorized = vi.fn();
    const unsubscribe = onUnauthorized(unauthorized);

    await adapter.board().catch(() => undefined);

    expect(unauthorized).not.toHaveBeenCalled();
    unsubscribe();
  });

  it.each([
    ["agentRecall", (adapter: BoardAdapter) => adapter.agentRecall("zed")],
    ["metrics", (adapter: BoardAdapter) => adapter.metrics()],
    ["listTraces", (adapter: BoardAdapter) => adapter.listTraces()],
    ["listSessions", (adapter: BoardAdapter) => adapter.listSessions()],
    ["getSession", (adapter: BoardAdapter) => adapter.getSession("s-1")],
  ] as const)("v0 declares %s unsupported with a loud 501", async (_name, call) => {
    const adapter = new BoardAdapter();
    const error = (await call(adapter).catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(501);
    expect(error.message).toContain("merge-API");
  });
});
