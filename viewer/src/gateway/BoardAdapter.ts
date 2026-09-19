import type { MemoryGateway } from "./MemoryGateway";
import { DEFAULT_TIMEOUT_MS, SEARCH_TIMEOUT_MS, requestJson } from "./http";
import type { RequestConfig } from "./http";
import { EventStream } from "./events";
import type { BoardEvent } from "./events";
import { ApiError } from "@/lib/errors";
import type {
  ArchivePage,
  ArchiveParams,
  BoardHealth,
  BoardHealthDetail,
  BoardHealthServer,
  BoardMemoryEnvelope,
  BoardSearchResponse,
  BoardSummary,
  BoardTask,
  MemoryPulse,
  MemoryPulseItem,
  MemoryPulseServerNote,
  MergedMemoriesPage,
  MergedMemoryListItem,
  MergedTags,
  PulseParams,
  TaskHistory,
  TaskInbox,
  TaskMemories,
  TaskReports,
} from "./boardTypes";
import type {
  A2ASession,
  HealthStatus,
  ListMemoriesParams,
  Memory,
  Metrics,
  SearchParams,
  SearchResult,
  TagSummary,
  Trace,
} from "./types";

/**
 * Phase-0 convergence adapter (ADR 0011 §6): speaks the BOARD server's
 * merge-API, not the mnemos wire contract. Lives alongside HttpAdapter /
 * MockAdapter — the mnemos path stays untouched until the Ф1 auth rewrite.
 *
 * Base URL is same-origin "/api" (`VITE_BOARD_API_URL` overrides); auth is
 * deliberately absent: reads are open through Ф0–Ф2 (ADR 0011 §7), so no
 * bearer token is attached, no `Authorization` header is ever sent, and the
 * 401/unauthorized flag is never raised from this adapter.
 *
 * Wire contract (board-openapi-snapshot.json):
 * - search         GET /api/mnemos/search        ?q&limit&project&scope (proxied)
 * - listMemories   GET /api/memories             ?limit&cursor&scope&status&project&…
 * - getMemory      GET /api/memories/item/{id}   (first resolving server)
 * - listTags       GET /api/tags                 (aggregated, count DESC/name ASC)
 * - health         GET /api/health
 * - board          GET /api/board                ?status
 * - inbox          GET /api/tasks/inbox          ?scope&project&include_adopted
 * - reports        GET /api/tasks/{id}/reports   (chronological, Ф2)
 * - history        GET /api/tasks/{id}/history   (audit + memory timeline, Ф2)
 * - taskMemories   GET /api/tasks/{id}/memories  (resolved links, Ф2)
 * - archive        GET /api/archive              ?q&status&col&agent&project&limit&offset (Ф2)
 * - taskById       GET /api/board                (pick by id — no single GET exists)
 * - pulse          GET /api/memories/pulse       ?scope&project&limit (Ф1)
 * - boardHealth    GET /api/health               (per-store detail view, Ф1)
 * - events         GET /api/events               (SSE, see gateway/events.ts)
 *
 * v0 honestly declares metrics / traces / sessions / agentRecall
 * unsupported (501) — they are mnemos-side views the merge API does not
 * expose yet; Ф1+ pages will consume board-native replacements.
 */

/** Merged-list parameters (ADR 0011 §11 cursor contract + native filters). */
export interface BoardListParams {
  limit?: number;
  /** Opaque cursor from a previous page's `next_cursor`. */
  cursor?: string;
  /** `'all'` (default) or one ACTIVE server name; unknown names → 404. */
  scope?: string;
  /** Native mnemos listing filters — pass through verbatim. */
  status?: string;
  project?: string;
  agent?: string;
  tags?: string;
  since?: string;
  until?: string;
}

/** Inbox read parameters (AGG-1, mirrors the server query contract). */
export interface InboxParams {
  /** `'all'` or one source server name. */
  scope?: string;
  /** Exact project match. */
  project?: string;
  /** Re-include rows that already produced a native task. */
  include_adopted?: boolean;
}

/**
 * The board-facing gateway surface: the viewer's `MemoryGateway` plus the
 * board-native reads (board, inbox) and the SSE capability (ADR 0011 §6 —
 * "BoardAdapter implements MemoryGateway (+ расширения: SSE, tasks)").
 */
export interface BoardGateway extends MemoryGateway {
  /** Board projection (`GET /api/board`). */
  board(status?: string, signal?: AbortSignal): Promise<BoardSummary>;
  /** AGG-1 inbox read (`GET /api/tasks/inbox`). */
  inbox(params?: InboxParams, signal?: AbortSignal): Promise<TaskInbox>;
  /** Cursor-paginated merged memory list (`GET /api/memories`). */
  listMemoriesPage(
    params?: BoardListParams,
    signal?: AbortSignal,
  ): Promise<MergedMemoriesPage>;
  /** SSE stream on `/api/events` (see gateway/events.ts). */
  events(): EventStream;
  /** Merged recency feed (`GET /api/memories/pulse`, Ф1). */
  pulse(params?: PulseParams, signal?: AbortSignal): Promise<MemoryPulse>;
  /** Per-store health detail (`GET /api/health`, Ф1 Overview). */
  boardHealth(signal?: AbortSignal): Promise<BoardHealthDetail>;
  /**
   * Chronological report history for one task, oldest first
   * (`GET /api/tasks/{id}/reports`, Ф2).
   */
  reports(taskId: string, signal?: AbortSignal): Promise<TaskReports>;
  /** Merged audit + memory timeline (`GET /api/tasks/{id}/history`, Ф2). */
  history(taskId: string, signal?: AbortSignal): Promise<TaskHistory>;
  /** Resolved memory links of a task (`GET /api/tasks/{id}/memories`, Ф2). */
  taskMemories(taskId: string, signal?: AbortSignal): Promise<TaskMemories>;
  /** Filtered + paginated archive page (`GET /api/archive`, Ф2). */
  archive(params?: ArchiveParams, signal?: AbortSignal): Promise<ArchivePage>;
  /**
   * Single task lookup. The board API has NO per-id GET, so this is a
   * board-projection pick (`GET /api/board` + find); callers that live in
   * React should cache it through the shared `tasks.board` query key (one
   * wire call feeds the list and every detail page — see hooks/useTasks.ts).
   * Throws 404 when the id is neither on the board.
   */
  taskById(taskId: string, signal?: AbortSignal): Promise<BoardTask>;
}

export interface BoardAdapterOptions {
  /** Board API base URL. Default "/api" (same-origin, `VITE_BOARD_API_URL`). */
  baseUrl?: string;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Default per-request timeout; search gets a dedicated generous budget. */
  timeoutMs?: number;
}

export class BoardAdapter implements BoardGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BoardAdapterOptions | string = {}) {
    // Backwards-compatible string form: new BoardAdapter("/api").
    const opts = typeof options === "string" ? { baseUrl: options } : options;
    this.baseUrl = opts.baseUrl ?? "/api";
    this.fetchImpl = opts.fetchImpl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult[]> {
    const response = await this.request<BoardSearchResponse>("/mnemos/search", {
      // The board proxy names the query `q`; tags/include_raw have no
      // wire counterpart on the merged search (documented, ignored).
      query: { q: params.query, limit: params.limit, project: params.project },
      signal,
      timeoutMs: SEARCH_TIMEOUT_MS,
    });
    const hits = Array.isArray(response?.results) ? response.results : [];
    return hits.map(normalizeSearchHit);
  }

  /**
   * Merged list, first page flattened for the `MemoryGateway` contract.
   * `status`/`project` filters pass through to the merged endpoint; the
   * mnemos `offset` has no wire counterpart (the cursor contract replaces
   * it, ADR 0011 §11) and is ignored — continuation goes through
   * `listMemoriesPage`. List rows carry an excerpt only (SEC-4), which
   * lands in `Memory.content`; the full card comes from `getMemory`.
   */
  async listMemories(
    params: ListMemoriesParams = {},
    signal?: AbortSignal,
  ): Promise<Memory[]> {
    const page = await this.listMemoriesPage(
      { limit: params.limit, status: params.status, project: params.project },
      signal,
    );
    return page.items.map(listItemToMemory);
  }

  async listMemoriesPage(
    params: BoardListParams = {},
    signal?: AbortSignal,
  ): Promise<MergedMemoriesPage> {
    return this.request<MergedMemoriesPage>("/memories", {
      query: {
        limit: params.limit,
        cursor: params.cursor,
        scope: params.scope,
        status: params.status,
        project: params.project,
        agent: params.agent,
        tags: params.tags,
        since: params.since,
        until: params.until,
      },
      signal,
    });
  }

  /**
   * Memory card from the first resolving server. The board endpoint always
   * reshapes the full card (raw_content included), so `includeRaw` is
   * accepted for interface parity and has no wire effect.
   */
  async getMemory(
    id: string,
    _includeRaw = false,
    signal?: AbortSignal,
  ): Promise<Memory> {
    const envelope = await this.request<BoardMemoryEnvelope>(
      `/memories/item/${encodeURIComponent(id)}`,
      { signal },
    );
    if (!envelope || envelope.ok !== true) {
      throw new ApiError(
        404,
        envelope && envelope.error ? envelope.error : `memory '${id}' not found`,
        { url: `${this.baseUrl}/memories/item/${id}` },
      );
    }
    return envelopeMemory(envelope);
  }

  async listTags(signal?: AbortSignal): Promise<TagSummary[]> {
    const response = await this.request<MergedTags>("/tags", { signal });
    return (response?.tags ?? []).map((tag) => ({
      tag: tag.name,
      count: tag.count,
    }));
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    const payload = await this.request<BoardHealth>("/health", { signal });
    // Project the board payload onto the viewer's string-map health shape:
    // `status` drives deriveHealthStatus; nested arrays (servers/groups)
    // have no place in it and are dropped (Ф1 status page goes board-native).
    return {
      status: payload?.ok === true ? "ok" : "degraded",
      service: String(payload?.service ?? "vesmaro-eyes"),
      board_tasks: String(payload?.board_tasks ?? 0),
    };
  }

  async board(status?: string, signal?: AbortSignal): Promise<BoardSummary> {
    return this.request<BoardSummary>("/board", { query: { status }, signal });
  }

  async inbox(params: InboxParams = {}, signal?: AbortSignal): Promise<TaskInbox> {
    return this.request<TaskInbox>("/tasks/inbox", {
      query: {
        scope: params.scope,
        project: params.project,
        include_adopted: params.include_adopted,
      },
      signal,
    });
  }

  events(): EventStream {
    return new EventStream({ baseUrl: this.baseUrl });
  }

  /**
   * Merged recency feed across scope. The wire shape is captured in
   * boardTypes (live corpus, board `memory_pulse_all`); this normalises the
   * anonymous dict defensively — per-row unknowns get honest defaults instead
   * of pretending the field was there.
   */
  async pulse(params: PulseParams = {}, signal?: AbortSignal): Promise<MemoryPulse> {
    const payload = await this.request<Record<string, unknown>>("/memories/pulse", {
      query: { scope: params.scope, project: params.project, limit: params.limit },
      signal,
    });
    return normalizePulse(payload);
  }

  /**
   * Per-store health detail for the Overview cards. `health()` keeps serving
   * the projected string map for the legacy Status page; this is the Ф1
   * board-native view (`servers[].ok/latency_ms/memories_total`).
   */
  async boardHealth(signal?: AbortSignal): Promise<BoardHealthDetail> {
    const payload = await this.request<Record<string, unknown>>("/health", { signal });
    return normalizeBoardHealth(payload);
  }

  // --- Ф2 task-domain reads ------------------------------------------------------

  async reports(taskId: string, signal?: AbortSignal): Promise<TaskReports> {
    return this.request<TaskReports>(`/tasks/${encodeURIComponent(taskId)}/reports`, {
      signal,
    });
  }

  async history(taskId: string, signal?: AbortSignal): Promise<TaskHistory> {
    return this.request<TaskHistory>(`/tasks/${encodeURIComponent(taskId)}/history`, {
      signal,
    });
  }

  async taskMemories(taskId: string, signal?: AbortSignal): Promise<TaskMemories> {
    return this.request<TaskMemories>(`/tasks/${encodeURIComponent(taskId)}/memories`, {
      signal,
    });
  }

  async archive(
    params: ArchiveParams = {},
    signal?: AbortSignal,
  ): Promise<ArchivePage> {
    return this.request<ArchivePage>("/archive", {
      query: {
        q: params.q,
        status: params.status,
        col: params.col,
        agent: params.agent,
        project: params.project,
        limit: params.limit,
        offset: params.offset,
      },
      signal,
    });
  }

  async taskById(taskId: string, signal?: AbortSignal): Promise<BoardTask> {
    const board = await this.board(undefined, signal);
    const task = board.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw new ApiError(404, `task '${taskId}' not found on the board`, {
        url: `${this.baseUrl}/board`,
      });
    }
    return task;
  }

  // --- v0-unsupported mnemos-side views (fail loud, never pretend) ----------

  async agentRecall(
    _agent: string,
    _project?: string,
    _query?: string,
    _limit?: number,
    _signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    throw unsupported("agentRecall", "/recall/agent/{name}");
  }

  async metrics(_signal?: AbortSignal): Promise<Metrics> {
    throw unsupported("metrics", "/metrics");
  }

  async listTraces(
    _taskLabel?: string,
    _limit?: number,
    _signal?: AbortSignal,
  ): Promise<Trace[]> {
    throw unsupported("listTraces", "/traces");
  }

  async listSessions(_signal?: AbortSignal): Promise<A2ASession[]> {
    throw unsupported("listSessions", "/v1/sessions");
  }

  async getSession(_id: string, _signal?: AbortSignal): Promise<A2ASession> {
    throw unsupported("getSession", "/v1/sessions/{id}");
  }

  /**
   * Board requests are unauthenticated by design (ADR 0011 §7: reads open
   * through Ф0–Ф2) — no token provider, no unauthorized flag wiring. The
   * shared requestJson plumbing still maps every non-2xx to `ApiError`,
   * composes timeouts with external aborts, and lets caller aborts pass.
   */
  private request<T>(path: string, config: RequestConfig): Promise<T> {
    return requestJson<T>(
      {
        baseUrl: this.baseUrl,
        fetchImpl: this.fetchImpl,
        defaultTimeoutMs: this.timeoutMs,
      },
      path,
      config,
    );
  }
}

function unsupported(method: string, mnemosPath: string): ApiError {
  return new ApiError(
    501,
    `BoardAdapter.${method}: the board merge-API does not expose the mnemos ` +
      `${mnemosPath} view (ADR 0011 §6 — v0 declares it unsupported until the ` +
      `convergence phases replace the page with a board-native read).`,
  );
}

/**
 * Normalise an anonymous proxied mnemos search hit into the pinned UI shape
 * (same honest-defaults policy as the HttpAdapter mapping; the board-added
 * `server` provenance field is not part of the viewer SearchResult yet).
 */
function normalizeSearchHit(hit: unknown, index: number): SearchResult {
  const source = (hit ?? {}) as Record<string, unknown>;
  const searchType = source.search_type;
  return {
    id: typeof source.id === "string" ? source.id : `hit-${index}`,
    title: typeof source.title === "string" ? source.title : "",
    content: typeof source.content === "string" ? source.content : "",
    tags: Array.isArray(source.tags) ? source.tags.map(String) : [],
    score: typeof source.score === "number" ? source.score : 0,
    search_type:
      searchType === "fts" || searchType === "semantic" || searchType === "hybrid"
        ? searchType
        : "fts",
  };
}

/**
 * Map a merged-list row onto the viewer's `Memory` view. The wire row is
 * excerpt-only (SEC-4) and carries no agent/memory_type/source — those get
 * honest defaults; the detail card (getMemory) fills the real values.
 */
function listItemToMemory(item: MergedMemoryListItem): Memory {
  return {
    id: item.id,
    title: item.title,
    content: item.excerpt,
    tags: [...item.tags],
    status: oneOf(item.status, MEMORY_STATUSES),
    project: item.project,
    agent: agentFromTags(item.tags),
    memory_type: "note",
    source: "manual",
    created_at: item.created_at,
    updated_at: item.updated_at,
    marker_version: DEFAULT_MARKER_VERSION,
  };
}

/** Map the `GET /api/memories/item/{id}` envelope onto the viewer `Memory`. */
function envelopeMemory(envelope: Extract<BoardMemoryEnvelope, { ok: true }>): Memory {
  const card = envelope.memory;
  return {
    id: card.id ?? "",
    title: card.title ?? "",
    content: card.content ?? "",
    raw_content: card.raw_content ?? null,
    tags: Array.isArray(card.tags) ? [...card.tags] : [],
    status: oneOf(card.status, MEMORY_STATUSES),
    memory_type: oneOf(card.memory_type, MEMORY_TYPES),
    source: oneOf(card.source, MEMORY_SOURCES),
    source_url: card.source_url ?? null,
    project: card.project ?? "",
    agent: card.agent ?? "",
    created_at: card.created_at ?? "",
    updated_at: card.updated_at ?? "",
    marker_version: DEFAULT_MARKER_VERSION,
  };
}

/** Recover the agent slug from an `agent:` tag when the row omits the field. */
function agentFromTags(tags: readonly string[]): string {
  const tagged = tags.find((tag) => tag.startsWith("agent:"));
  return tagged ? tagged.slice("agent:".length) : "";
}

/** Narrow a wire string onto a literal union with an honest fallback. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : allowed[0];
}

/** mnemos `Memory` enum mirrors (gateway/types.ts is the single source). */
const MEMORY_STATUSES = [
  "raw",
  "processing",
  "processed",
  "published",
  "archived",
] as const;
const MEMORY_TYPES = [
  "note",
  "fact",
  "snippet",
  "bookmark",
  "conversation",
  "session_context",
] as const;
const MEMORY_SOURCES = [
  "manual",
  "web",
  "file",
  "mcp",
  "obsidian",
  "cli",
  "rule",
  "synthesized",
] as const;

/** mnemos `Memory.marker_version` schema default (not carried by the board wire). */
const DEFAULT_MARKER_VERSION = 1;

// --- Ф1 normalizers (anonymous dicts → honest view models) ---------------------

/** String-tunnel with an honest fallback (never pretend a field existed). */
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * `GET /api/memories/pulse` anonymous dict → `MemoryPulse`. Rows missing the
 * server stamp (should not happen — the server assigns it) fall back to "?"
 * so provenance never silently disappears from the feed.
 */
export function normalizePulse(payload: unknown): MemoryPulse {
  const source = (payload ?? {}) as Record<string, unknown>;
  const items = Array.isArray(source.items) ? source.items : [];
  const perServer = Array.isArray(source.per_server) ? source.per_server : [];
  return {
    ok: source.ok === true,
    scope: str(source.scope, "all"),
    kind: str(source.kind, "all"),
    items: items.map((row): MemoryPulseItem => {
      const item = (row ?? {}) as Record<string, unknown>;
      return {
        id: str(item.id),
        title: str(item.title),
        tags: strArray(item.tags),
        status: str(item.status),
        created_at: str(item.created_at),
        server: str(item.server, "?"),
      };
    }),
    per_server: perServer.map((row): MemoryPulseServerNote => {
      const note = (row ?? {}) as Record<string, unknown>;
      return {
        server: str(note.server, "?"),
        ok: note.ok === true,
        items: num(note.items),
        detail: note.detail ?? null,
      };
    }),
    store_stats: Array.isArray(source.store_stats) ? source.store_stats : undefined,
  };
}

/** `GET /api/health` anonymous dict → `BoardHealthDetail` (per-store rows). */
export function normalizeBoardHealth(payload: unknown): BoardHealthDetail {
  const source = (payload ?? {}) as Record<string, unknown>;
  const servers = Array.isArray(source.servers) ? source.servers : [];
  return {
    ok: source.ok === true,
    service: str(source.service, "vesmaro-eyes"),
    board_tasks: num(source.board_tasks),
    servers: servers.map((row): BoardHealthServer => {
      const server = (row ?? {}) as Record<string, unknown>;
      return {
        name: str(server.name, "?"),
        group_name: str(server.group_name, "default"),
        enabled: server.enabled !== false,
        state: str(server.state, "idle"),
        description: typeof server.description === "string" ? server.description : null,
        ok: server.ok === true,
        latency_ms: typeof server.latency_ms === "number" ? server.latency_ms : null,
        error: typeof server.error === "string" ? server.error : null,
        memories_total:
          typeof server.memories_total === "number" ? server.memories_total : null,
      };
    }),
  };
}

// Re-export for consumers that subscribe through the adapter (typed handler
// wiring lives in gateway/events.ts).
export type { BoardEvent };
