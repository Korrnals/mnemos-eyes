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
import type { TagDrill, TagDrillParams } from "./boardTypes";

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
  /**
   * Cross-cutting drill for one tag: board tasks + merged memories
   * (`GET /api/tags/{tag}/drill` on the board; the mnemos HttpAdapter
   * composes the memories slice from search and reports no tasks — UI-17
   * spec §5/§10.2). Memories are a ranked SUBSET (BE-13) — the UI says so.
   */
  drillTag(tag: string, params?: TagDrillParams, signal?: AbortSignal): Promise<TagDrill>;

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
