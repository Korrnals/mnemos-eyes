import type { MemoryGateway } from "./MemoryGateway";
import { ApiError } from "@/lib/errors";
import { MOCK_MEMORIES, MOCK_SESSIONS, MOCK_TRACES } from "./fixtures";
import type {
  BoardHealthDetail,
  MemoryPulse,
  MemoryPulseItem,
  PulseParams,
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

/** Default wire limit for search (mirrors mnemos `SearchQuery.limit`). */
const DEFAULT_SEARCH_LIMIT = 20;
/** Default wire limit for the traces list. */
const DEFAULT_TRACE_LIMIT = 50;
/** Default wire limit for agent recall. */
const DEFAULT_RECALL_LIMIT = 5;

export interface MockAdapterOptions {
  /**
   * Simulated network latency. Default 80–200 ms (drawn from a seeded PRNG,
   * so the sequence is deterministic). `false` disables delays entirely —
   * use in tests.
   */
  latency?: false | { minMs: number; maxMs: number };
}

/**
 * In-memory adapter for UI development without a live mnemos (task T2).
 * Full `MemoryGateway` implementation over the deterministic fixtures
 * (fixtures.ts): substring search with a surface-weighted rank that imitates
 * FTS+semantic behaviour, wire-compatible pagination and filters, and honest
 * 404s. Toggle via `VITE_MNEMOS_ADAPTER=mock`.
 */
export class MockAdapter implements MemoryGateway {
  private readonly latency: false | { minMs: number; maxMs: number };
  private readonly rand: () => number;

  constructor(options: MockAdapterOptions = {}) {
    this.latency = options.latency ?? { minMs: 80, maxMs: 200 };
    // Fixed seed → identical latency sequences across runs.
    this.rand = mulberry32(20260916);
  }

  async search(params: SearchParams, signal?: AbortSignal): Promise<SearchResult[]> {
    await this.delay(signal);
    const terms = tokenize(params.query);
    if (terms.length === 0) return [];

    const hits: SearchResult[] = [];
    for (const memory of MOCK_MEMORIES) {
      const match = scoreMemory(memory, terms, params.tags, params.project);
      if (!match) continue;
      hits.push({
        id: memory.id ?? `mem-${hits.length}`,
        title: memory.title ?? "",
        content: memory.content,
        tags: [...(memory.tags ?? [])],
        score: match.score,
        search_type: match.searchType,
      });
    }

    hits.sort(byScoreDesc);
    return hits.slice(0, params.limit ?? DEFAULT_SEARCH_LIMIT);
  }

  async listMemories(
    params: ListMemoriesParams = {},
    signal?: AbortSignal,
  ): Promise<Memory[]> {
    await this.delay(signal);
    const filtered = MOCK_MEMORIES.filter(
      (memory) =>
        (params.status === undefined || memory.status === params.status) &&
        (params.project === undefined || memory.project === params.project),
    ).sort(byCreatedDesc);
    const offset = params.offset ?? 0;
    return filtered
      .slice(offset, params.limit === undefined ? undefined : offset + params.limit)
      .map((memory) => ({ ...memory }));
  }

  async getMemory(
    id: string,
    includeRaw = false,
    signal?: AbortSignal,
  ): Promise<Memory> {
    await this.delay(signal);
    const memory = MOCK_MEMORIES.find((candidate) => candidate.id === id);
    if (!memory) {
      throw new ApiError(404, `Memory "${id}" not found`, {
        url: `mock:/memories/${id}`,
      });
    }
    // Imitate the wire: raw_content is withheld unless explicitly requested.
    return includeRaw ? { ...memory } : { ...memory, raw_content: null };
  }

  async listTags(signal?: AbortSignal): Promise<TagSummary[]> {
    await this.delay(signal);
    const counts = new Map<string, number>();
    for (const memory of MOCK_MEMORIES) {
      for (const tag of memory.tags ?? []) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  async agentRecall(
    agent: string,
    project?: string,
    query?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    await this.delay(signal);
    const agentTag = `agent:${agent}`;
    const terms = tokenize(query ?? "");

    const candidates = MOCK_MEMORIES.filter(
      (memory) =>
        (memory.agent === agent || (memory.tags ?? []).includes(agentTag)) &&
        (project === undefined || memory.project === project) &&
        terms.every(
          (term) =>
            (memory.title ?? "").toLowerCase().includes(term) ||
            memory.content.toLowerCase().includes(term) ||
            (memory.tags ?? []).some((tag) => tag.toLowerCase().includes(term)),
        ),
    ).sort(byCreatedDesc);

    const total = Math.max(candidates.length, 1);
    return candidates.slice(0, limit ?? DEFAULT_RECALL_LIMIT).map((memory, index) => ({
      id: memory.id ?? `recall-${index}`,
      title: memory.title ?? "",
      content: memory.content,
      tags: [...(memory.tags ?? [])],
      // Recency-flavoured score: newest candidate scores 1.0.
      score: round((total - index) / total, 4),
      search_type: "hybrid",
    }));
  }

  async health(signal?: AbortSignal): Promise<HealthStatus> {
    await this.delay(signal);
    // HealthStatus is a string-valued map on the wire.
    return {
      status: "ok",
      version: "4.1.0-mock",
      project: "mnemos-eyes",
    };
  }

  /**
   * Board-native per-store health (Ф1 Overview). Mirrors the BoardAdapter
   * wire with the mock's honest truth: one live store holding the fixtures,
   * one paused store (the neutral "not probed" card branch — disabled stores
   * are skipped by the merge, so its ok flag is false without an error).
   */
  async boardHealth(signal?: AbortSignal): Promise<BoardHealthDetail> {
    await this.delay(signal);
    return {
      ok: true,
      service: "vesmaro-eyes",
      board_tasks: MOCK_TRACES.length,
      servers: [
        {
          name: "mock-store",
          group_name: "default",
          enabled: true,
          state: "idle",
          description: "in-memory fixtures",
          ok: true,
          latency_ms: 24,
          error: null,
          memories_total: MOCK_MEMORIES.length,
        },
        {
          name: "mock-store-paused",
          group_name: "default",
          enabled: false,
          state: "paused",
          description: "paused store (mock)",
          ok: false,
          latency_ms: null,
          error: null,
          memories_total: null,
        },
      ],
    };
  }

  /**
   * Board-native merged recency feed (Ф1 Pulse). The mock has a single
   * store, so every row carries the same provenance stamp; scope filtering
   * honours the board contract: unknown names fail honestly (404).
   */
  async pulse(params: PulseParams = {}, signal?: AbortSignal): Promise<MemoryPulse> {
    await this.delay(signal);
    const scope = params.scope && params.scope !== "all" ? params.scope : "";
    if (scope && scope !== "mock-store" && scope !== "mock-store-paused") {
      throw new ApiError(404, `no memory server or group named '${scope}'`, {
        url: "mock:/api/memories/pulse",
      });
    }
    const pool =
      scope === "mock-store-paused"
        ? []
        : MOCK_MEMORIES.filter(
            (memory) =>
              params.project === undefined || memory.project === params.project,
          ).sort(byCreatedDesc);
    const items: MemoryPulseItem[] = pool
      .slice(0, params.limit ?? 12)
      .map((memory) => ({
        id: memory.id ?? "mem-mock",
        title: memory.title ?? "",
        tags: [...(memory.tags ?? [])],
        status: memory.status,
        created_at: memory.created_at ?? "",
        server: scope || "mock-store",
      }));
    return {
      ok: scope !== "mock-store-paused",
      scope: scope || "all",
      kind: scope ? "server" : "all",
      items,
      per_server: [
        {
          server: scope || "mock-store",
          ok: scope !== "mock-store-paused",
          items: items.length,
          detail: null,
        },
      ],
    };
  }

  async metrics(signal?: AbortSignal): Promise<Metrics> {
    await this.delay(signal);
    const byStatus: Record<string, number> = {};
    for (const memory of MOCK_MEMORIES) {
      byStatus[memory.status] = (byStatus[memory.status] ?? 0) + 1;
    }
    const tags = new Set(MOCK_MEMORIES.flatMap((memory) => memory.tags ?? []));
    const scored = MOCK_MEMORIES.filter((m) => typeof m.quality_score === "number");
    const avgQuality =
      scored.reduce((sum, m) => sum + (m.quality_score ?? 0), 0) /
      Math.max(scored.length, 1);
    return {
      memories_total: MOCK_MEMORIES.length,
      memories_by_status: byStatus,
      tags_total: tags.size,
      sessions_total: MOCK_SESSIONS.length,
      traces_total: MOCK_TRACES.length,
      avg_quality_score: round(avgQuality, 4),
      adapter: "mock",
      generated_at: "2026-09-16T00:00:00Z",
    };
  }

  async listTraces(
    taskLabel?: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<Trace[]> {
    await this.delay(signal);
    const entries = [...MOCK_TRACES]
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .filter((trace) => taskLabel === undefined || trace.task_label === taskLabel)
      .slice(0, limit ?? DEFAULT_TRACE_LIMIT);
    return entries.map((trace) => ({ ...trace }));
  }

  async listSessions(signal?: AbortSignal): Promise<A2ASession[]> {
    await this.delay(signal);
    return [...MOCK_SESSIONS]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((session) => ({ ...session }));
  }

  async getSession(id: string, signal?: AbortSignal): Promise<A2ASession> {
    await this.delay(signal);
    const session = MOCK_SESSIONS.find((candidate) => candidate.session_id === id);
    if (!session) {
      throw new ApiError(404, `Session "${id}" not found`, {
        url: `mock:/v1/sessions/${id}`,
      });
    }
    return { ...session };
  }

  /** Simulated latency; honours external cancellation mid-delay. */
  private async delay(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (this.latency === false) return;
    const { minMs, maxMs } = this.latency;
    const ms = Math.round(minMs + this.rand() * (maxMs - minMs));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(abortError());
        },
        { once: true },
      );
    });
    throwIfAborted(signal);
  }
}

// --- Search heuristics (FTS/semantic imitation) ------------------------------

interface MemoryMatch {
  score: number;
  searchType: SearchResult["search_type"];
}

/**
 * Score one memory against the tokenised query. All terms must match
 * somewhere (AND). Weights: title/tag hit 3, content hit 1, normalised to
 * 0..1 (per-term max 3+1=4). `search_type` imitates the pipeline:
 * title/tag-only → "fts", content-only → "semantic", both → "hybrid".
 */
function scoreMemory(
  memory: Memory,
  terms: string[],
  tagsFilter?: string[],
  project?: string,
): MemoryMatch | null {
  if (project !== undefined && memory.project !== project) return null;
  if (tagsFilter && tagsFilter.length > 0) {
    const memoryTags = memory.tags ?? [];
    if (!tagsFilter.every((tag) => memoryTags.includes(tag))) return null;
  }

  const title = (memory.title ?? "").toLowerCase();
  const content = memory.content.toLowerCase();
  const tags = (memory.tags ?? []).map((tag) => tag.toLowerCase());

  let sum = 0;
  let sawTitleOrTag = false;
  let sawContent = false;
  for (const term of terms) {
    const inTitle = title.includes(term);
    const inTag = tags.some((tag) => tag.includes(term));
    const inContent = content.includes(term);
    if (!inTitle && !inTag && !inContent) return null; // AND semantics
    if (inTitle || inTag) {
      sum += 3;
      sawTitleOrTag = true;
    }
    if (inContent) {
      sum += 1;
      sawContent = true;
    }
  }

  const score = round(sum / (terms.length * 4), 4);
  const searchType: SearchResult["search_type"] =
    sawTitleOrTag && sawContent ? "hybrid" : sawTitleOrTag ? "fts" : "semantic";
  return { score, searchType };
}

/** Lowercase, split on whitespace, drop empties. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

// --- Deterministic helpers ----------------------------------------------------

/** Sort by score desc; created_at desc then id as deterministic tiebreaks. */
function byScoreDesc(a: SearchResult, b: SearchResult): number {
  const memoryA = MOCK_MEMORIES.find((m) => m.id === a.id);
  const memoryB = MOCK_MEMORIES.find((m) => m.id === b.id);
  if (b.score !== a.score) return b.score - a.score;
  const byDate = compareCreated(memoryA, memoryB);
  if (byDate !== 0) return byDate;
  return a.id.localeCompare(b.id);
}

/** Sort by created_at desc with an id tiebreak (fixture dates are unique). */
function byCreatedDesc(a: Memory, b: Memory): number {
  return compareCreated(a, b) || (a.id ?? "").localeCompare(b.id ?? "");
}

function compareCreated(a?: Memory, b?: Memory): number {
  return (b?.created_at ?? "").localeCompare(a?.created_at ?? "");
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Deterministic PRNG (mulberry32) — no Math.random anywhere in the mock. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}
