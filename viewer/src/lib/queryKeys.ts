import type { ListMemoriesParams, SearchParams } from "@/gateway/types";

/**
 * Typed TanStack Query key factories (architecture.md §6).
 * Always build keys through these factories — never hand-roll arrays in hooks —
 * so query invalidation stays consistent across the app.
 */
export const keys = {
  memories: {
    all: ["memories"] as const,
    list: (params: ListMemoriesParams = {}) => ["memories", "list", params] as const,
    detail: (id: string, includeRaw = false) =>
      ["memories", "detail", id, { includeRaw }] as const,
  },
  search: {
    results: (params: SearchParams) => ["search", params] as const,
  },
  tags: {
    all: ["tags"] as const,
    list: () => ["tags", "list"] as const,
  },
  status: {
    health: () => ["status", "health"] as const,
    metrics: () => ["status", "metrics"] as const,
  },
  traces: {
    all: ["traces"] as const,
    list: (params: { task_label?: string; limit?: number } = {}) =>
      ["traces", "list", params] as const,
  },
  sessions: {
    all: ["sessions"] as const,
    list: () => ["sessions", "list"] as const,
    detail: (id: string) => ["sessions", "detail", id] as const,
  },
  // L2 (D12): cluster graph is out of L1 scope; the key namespace stays
  // reserved so the hidden nav slot can be wired without a key migration.
  clusters: {
    all: ["clusters"] as const,
  },
} as const;

/** Convenience key types for hook signatures. */
export type MemoriesListKey = ReturnType<typeof keys.memories.list>;
export type MemoryDetailKey = ReturnType<typeof keys.memories.detail>;
export type SearchResultsKey = ReturnType<typeof keys.search.results>;
export type TagsListKey = ReturnType<typeof keys.tags.list>;
export type HealthKey = ReturnType<typeof keys.status.health>;
export type MetricsKey = ReturnType<typeof keys.status.metrics>;
export type TracesListKey = ReturnType<typeof keys.traces.list>;
export type SessionsListKey = ReturnType<typeof keys.sessions.list>;
export type SessionDetailKey = ReturnType<typeof keys.sessions.detail>;
