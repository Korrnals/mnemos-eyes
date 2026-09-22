import type { MemoryGateway } from "./MemoryGateway";
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
 * Phase-2 adapter (stub): Tauri `invoke()` → in-process Rust core reading
 * SQLite directly, no HTTP server needed (architecture.md §9).
 *
 * // import { invoke } from "@tauri-apps/api/core";
 * // Each method: invoke("plugin:mnemos|search", { ... })
 * // AbortSignal plumbing: forward to the Rust side or poll signal.aborted.
 */
export class TauriAdapter implements MemoryGateway {
  search(_params: SearchParams, _signal?: AbortSignal): Promise<SearchResult[]> {
    return this.unimplemented("search");
  }

  listMemories(
    _params?: ListMemoriesParams,
    _signal?: AbortSignal,
  ): Promise<Memory[]> {
    return this.unimplemented("listMemories");
  }

  getMemory(
    _id: string,
    _includeRaw?: boolean,
    _signal?: AbortSignal,
  ): Promise<Memory> {
    return this.unimplemented("getMemory");
  }

  listTags(_signal?: AbortSignal): Promise<TagSummary[]> {
    return this.unimplemented("listTags");
  }

  drillTag(
    _tag: string,
    _params?: TagDrillParams,
    _signal?: AbortSignal,
  ): Promise<TagDrill> {
    return this.unimplemented("drillTag");
  }

  agentRecall(
    _agent: string,
    _project?: string,
    _query?: string,
    _limit?: number,
    _signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    return this.unimplemented("agentRecall");
  }

  health(_signal?: AbortSignal): Promise<HealthStatus> {
    return this.unimplemented("health");
  }

  metrics(_signal?: AbortSignal): Promise<Metrics> {
    return this.unimplemented("metrics");
  }

  listTraces(
    _taskLabel?: string,
    _limit?: number,
    _signal?: AbortSignal,
  ): Promise<Trace[]> {
    return this.unimplemented("listTraces");
  }

  listSessions(_signal?: AbortSignal): Promise<A2ASession[]> {
    return this.unimplemented("listSessions");
  }

  getSession(_id: string, _signal?: AbortSignal): Promise<A2ASession> {
    return this.unimplemented("getSession");
  }

  private async unimplemented(method: string): Promise<never> {
    throw new Error(`TauriAdapter.${method}: not yet implemented (Phase 2)`);
  }
}
