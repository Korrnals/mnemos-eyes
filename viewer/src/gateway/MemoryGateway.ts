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
 * The single data-access seam of the viewer (architecture.md §4).
 *
 * Every component/hook reads memory through this interface; direct `fetch()`
 * or Tauri `invoke()` calls outside `gateway/` are forbidden. Implementations:
 * - `HttpAdapter` — Phase 1, fetch against the mnemos HTTP API (task T2);
 * - `TauriAdapter` — Phase 2, in-process Rust core (stub).
 *
 * Every method takes an optional `AbortSignal` so callers (TanStack Query)
 * can cancel in-flight requests on unmount / query-key change.
 */
export interface MemoryGateway {
  // Search (FTS + semantic)
  search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult[]>;

  // Memories
  listMemories(params?: ListMemoriesParams, signal?: AbortSignal): Promise<Memory[]>;
  getMemory(id: string, includeRaw?: boolean, signal?: AbortSignal): Promise<Memory>;

  // Tags
  listTags(signal?: AbortSignal): Promise<TagSummary[]>;

  // Agent recall
  agentRecall(
    agent: string,
    project?: string,
    query?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]>;

  // Status / health
  health(signal?: AbortSignal): Promise<HealthStatus>;
  metrics(signal?: AbortSignal): Promise<Metrics>;

  // Traces
  listTraces(taskLabel?: string, limit?: number, signal?: AbortSignal): Promise<Trace[]>;

  // A2A sessions (mounted under /v1 on mnemos)
  listSessions(signal?: AbortSignal): Promise<A2ASession[]>;
  getSession(id: string, signal?: AbortSignal): Promise<A2ASession>;
}
