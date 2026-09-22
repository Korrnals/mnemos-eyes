import type { MemoryGateway } from "./MemoryGateway";
import { DEFAULT_TIMEOUT_MS, SEARCH_TIMEOUT_MS, requestJson } from "./http";
import type { RequestConfig } from "./http";
import { getToken, notifyUnauthorized } from "./auth";
import { ApiError } from "@/lib/errors";
import type { TagDrill, TagDrillParams } from "./boardTypes";
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
 * Phase-1 adapter: fetch against the mnemos HTTP API (architecture.md §4).
 *
 * Base URL is same-origin "/api" so the Vite dev-proxy forwards to the live
 * mnemos (127.0.0.1:8787) without CORS involvement; in production a reverse
 * proxy performs the same routing (mnemos serves its routes from root, the
 * proxies strip the "/api" prefix).
 *
 * Wire contract (openapi-snapshot.json):
 * - search         POST /search                     body SearchQuery
 * - listMemories   GET  /memories                   ?status&project&limit&offset
 * - getMemory      GET  /memories/{memory_id}       ?include_raw
 * - listTags       GET  /tags
 * - agentRecall    GET  /recall/agent/{name}        ?project&q&limit
 * - health         GET  /health
 * - metrics        GET  /metrics                    (stats JSON, not Prometheus)
 * - listTraces     GET  /traces                     ?task_label&limit
 * - getSession     GET  /v1/sessions/{session_id}
 * - listSessions   — no list endpoint exists on the mnemos snapshot (only
 *                    POST /v1/sessions create + GET by id), so it fails loud
 *                    with 501; use `getSession(id)` or the MockAdapter.
 */

export interface HttpAdapterOptions {
  /** Base URL of the mnemos gateway. Default "/api". */
  baseUrl?: string;
  /** Test seam — defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Default per-request timeout; search gets a dedicated generous budget. */
  timeoutMs?: number;
}

export class HttpAdapter implements MemoryGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpAdapterOptions | string = {}) {
    // Backwards-compatible string form: new HttpAdapter("/api").
    const opts = typeof options === "string" ? { baseUrl: options } : options;
    this.baseUrl = opts.baseUrl ?? "/api";
    this.fetchImpl = opts.fetchImpl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult[]> {
    const hits = await this.request<unknown[]>(
      "/search",
      {
        method: "POST",
        body: {
          query: params.query,
          tags: params.tags,
          project: params.project,
          limit: params.limit,
          include_raw: params.include_raw,
        },
        signal,
        timeoutMs: SEARCH_TIMEOUT_MS,
      },
    );
    return hits.map(normalizeSearchHit);
  }

  async listMemories(
    params: ListMemoriesParams = {},
    signal?: AbortSignal,
  ): Promise<Memory[]> {
    return this.request<Memory[]>(
      "/memories",
      {
        query: {
          status: params.status,
          project: params.project,
          // Native mnemos listing filter (UI-17 §5.6 «Открыть в Записях»).
          tags: params.tags,
          limit: params.limit,
          offset: params.offset,
        },
        signal,
      },
    );
  }

  async getMemory(id: string, includeRaw = false, signal?: AbortSignal): Promise<Memory> {
    return this.request<Memory>(
      `/memories/${encodeURIComponent(id)}`,
      {
        query: includeRaw ? { include_raw: true } : undefined,
        signal,
      },
    );
  }

  async listTags(signal?: AbortSignal): Promise<TagSummary[]> {
    return this.request<TagSummary[]>("/tags", { signal });
  }

  /**
   * Tag drill on mnemos mode (UI-17 §5/§10.2). mnemos has no drill endpoint
   * and no board: the memories slice is composed from a wildcard search with
   * the tag filter (the same ranker BE-13 documents) and `tasks` stays empty —
   * honest absence, never a fake board.
   */
  async drillTag(
    tag: string,
    params: TagDrillParams = {},
    signal?: AbortSignal,
  ): Promise<TagDrill> {
    const hits = await this.search(
      { query: "*", tags: [tag], limit: params.limit ?? 12 },
      signal,
    );
    return {
      ok: true,
      tag,
      tasks: [],
      memories: hits.map((hit) => ({
        id: hit.id,
        title: hit.title,
        tags: hit.tags,
        server: null,
        created_at: null,
        status: null,
        excerpt: hit.content.slice(0, 180),
      })),
      errors: [],
    };
  }

  async agentRecall(
    agent: string,
    project?: string,
    query?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const hits = await this.request<unknown[]>(
      `/recall/agent/${encodeURIComponent(agent)}`,
      {
        query: { project, q: query, limit },
        signal,
        timeoutMs: SEARCH_TIMEOUT_MS,
      },
    );
    return hits.map(normalizeSearchHit);
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    return this.request<HealthStatus>("/health", { signal });
  }

  async metrics(signal?: AbortSignal): Promise<Metrics> {
    return this.request<Metrics>("/metrics", { signal });
  }

  async listTraces(
    taskLabel?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Trace[]> {
    const entries = await this.request<Record<string, unknown>[]>(
      "/traces",
      {
        query: { task_label: taskLabel, limit },
        signal,
      },
    );
    // Wire entries are anonymous objects; pin an id so the UI has a stable key.
    return entries.map((entry, index) => ({
      ...entry,
      id: typeof entry.id === "string" ? entry.id : `trace-${index}`,
      task_label:
        entry.task_label === undefined ? null : (entry.task_label as Trace["task_label"]),
    }));
  }

  /**
   * The mnemos snapshot has no session-list endpoint — fail loud instead of
   * pretending. The MockAdapter serves a fixture list for UI development.
   */
  async listSessions(_signal?: AbortSignal): Promise<A2ASession[]> {
    throw new ApiError(
      501,
      "HttpAdapter.listSessions: mnemos exposes no GET /v1/sessions list endpoint " +
        "(only POST /v1/sessions and GET /v1/sessions/{id}); use getSession(id).",
      { url: `${this.baseUrl}/v1/sessions` },
    );
  }

  async getSession(id: string, signal?: AbortSignal): Promise<A2ASession> {
    return this.request<A2ASession>(
      `/v1/sessions/${encodeURIComponent(id)}`,
      { signal },
    );
  }

  private request<T>(path: string, config: RequestConfig): Promise<T> {
    return requestJson<T>(
      {
        baseUrl: this.baseUrl,
        fetchImpl: this.fetchImpl,
        getToken,
        onUnauthorized: notifyUnauthorized,
        defaultTimeoutMs: this.timeoutMs,
      },
      path,
      config,
    );
  }
}

/**
 * Normalise an anonymous mnemos search hit into the pinned UI shape.
 * Missing fields get honest defaults rather than undefined leaks.
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
