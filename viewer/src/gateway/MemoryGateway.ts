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
 */
export interface MemoryGateway {
  // Search (FTS + semantic)
  search(params: SearchParams): Promise<SearchResult[]>;

  // Memories
  listMemories(params?: ListMemoriesParams): Promise<Memory[]>;
  getMemory(id: string, includeRaw?: boolean): Promise<Memory>;

  // Tags
  listTags(): Promise<TagSummary[]>;

  // Agent recall
  agentRecall(
    agent: string,
    project?: string,
    query?: string,
    limit?: number,
  ): Promise<SearchResult[]>;

  // Status / health
  health(): Promise<HealthStatus>;
  metrics(): Promise<Metrics>;

  // Traces
  listTraces(taskLabel?: string, limit?: number): Promise<Trace[]>;

  // A2A sessions (mounted under /v1 on mnemos)
  listSessions(): Promise<A2ASession[]>;
  getSession(id: string): Promise<A2ASession>;
}
