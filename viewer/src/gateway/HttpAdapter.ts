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
import { ApiError } from "@/lib/errors";

/**
 * Phase-1 adapter: fetch against the mnemos HTTP API (architecture.md §4).
 *
 * Base URL is same-origin "/api" so the Vite dev-proxy forwards to the live
 * mnemos (127.0.0.1:8787) without CORS involvement; in production a reverse
 * proxy performs the same routing.
 *
 * TODO(T2): implement all methods (`fetch` → JSON, non-2xx → ApiError).
 * The bodies below keep the scaffold honest — they fail loudly instead of
 * returning fake data.
 */
export class HttpAdapter implements MemoryGateway {
  constructor(private readonly baseUrl: string = "/api") {
    this.baseUrl = baseUrl;
  }

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
    throw new ApiError(501, `HttpAdapter.${method}: not implemented (task T2)`, {
      url: this.baseUrl,
    });
  }
}
