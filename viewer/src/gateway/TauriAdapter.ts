import type { MemoryGateway } from "./MemoryGateway";
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
 * Phase-2 adapter (stub): Tauri `invoke()` → in-process Rust core reading
 * SQLite directly, no HTTP server needed (architecture.md §9).
 *
 * // import { invoke } from "@tauri-apps/api/core";
 * // Each method: invoke("plugin:mnemos|search", { ... })
 */
export class TauriAdapter implements MemoryGateway {
  search(_params: SearchParams): Promise<SearchResult[]> {
    return this.unimplemented("search");
  }

  listMemories(_params?: ListMemoriesParams): Promise<Memory[]> {
    return this.unimplemented("listMemories");
  }

  getMemory(_id: string, _includeRaw?: boolean): Promise<Memory> {
    return this.unimplemented("getMemory");
  }

  listTags(): Promise<TagSummary[]> {
    return this.unimplemented("listTags");
  }

  agentRecall(
    _agent: string,
    _project?: string,
    _query?: string,
    _limit?: number,
  ): Promise<SearchResult[]> {
    return this.unimplemented("agentRecall");
  }

  health(): Promise<HealthStatus> {
    return this.unimplemented("health");
  }

  metrics(): Promise<Metrics> {
    return this.unimplemented("metrics");
  }

  listTraces(_taskLabel?: string, _limit?: number): Promise<Trace[]> {
    return this.unimplemented("listTraces");
  }

  listSessions(): Promise<A2ASession[]> {
    return this.unimplemented("listSessions");
  }

  getSession(_id: string): Promise<A2ASession> {
    return this.unimplemented("getSession");
  }

  private async unimplemented(method: string): Promise<never> {
    throw new Error(`TauriAdapter.${method}: not yet implemented (Phase 2)`);
  }
}
