import { QueryClient } from "@tanstack/react-query";
import { isApiError } from "./errors";

/**
 * Per-query freshness policy (architecture.md §6 "Stale times").
 * Hooks pass the matching entry; the QueryClient default below is the
 * fallback for anything unmapped.
 */
export const STALE_TIMES = {
  /** health / metrics */
  status: 10_000,
  /** memories list */
  memoriesList: 30_000,
  /** memory detail */
  memoryDetail: 60_000,
  /** search results — always fresh */
  search: 0,
  /** traces */
  traces: 15_000,
  /** A2A sessions */
  sessions: 15_000,
  /** tags */
  tags: 60_000,
  /** Ф1 pulse — a recency feed: cheap to revalidate, never stale for long */
  pulse: 15_000,
  /** Ф2 board projection — SSE patches keep it fresh; refetch is the fallback */
  taskBoard: 30_000,
  /** Ф2 task detail views (reports / history / memory links) */
  taskDetail: 60_000,
  /** Ф2 archive — append-mostly, slowly changing */
  taskArchive: 60_000,
  /** Ф2 inbox mirror — refreshed by the server-side scanner */
  taskInbox: 60_000,
  /** AGW-1 assignment queue — SSE transitions invalidate; refetch is the fallback */
  agentsAssignments: 15_000,
  /** AGW-1 executor registry — presence is computed per GET (TTLs in meta) */
  agentsExecutors: 15_000,
  /** AGW-1 default-executor settings — owner-rare writes */
  agentsSettings: 60_000,
} as const;

export const GC_TIMES = {
  status: 30_000,
  memoriesList: 5 * 60_000,
  memoryDetail: 10 * 60_000,
  search: 2 * 60_000,
  traces: 5 * 60_000,
  sessions: 5 * 60_000,
  tags: 5 * 60_000,
  pulse: 60_000,
  taskBoard: 5 * 60_000,
  taskDetail: 10 * 60_000,
  taskArchive: 10 * 60_000,
  taskInbox: 5 * 60_000,
  agentsAssignments: 5 * 60_000,
  agentsExecutors: 60_000,
  agentsSettings: 10 * 60_000,
} as const;

/**
 * Retry policy (architecture.md §7): one retry for 5xx / network failures,
 * never for 4xx client errors.
 */
function retryOnServerError(failureCount: number, error: unknown): boolean {
  if (isApiError(error)) {
    return error.status >= 500 && failureCount < 1;
  }
  // Unknown (non-HTTP) failures — retry once, then surface.
  return failureCount < 1;
}

/** Build the app QueryClient with the conventions from architecture.md §6–7. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: retryOnServerError,
        refetchOnWindowFocus: false,
        // Sensible fallback; specific queries override via STALE_TIMES.
        staleTime: 10_000,
        gcTime: GC_TIMES.memoriesList,
      },
      mutations: {
        // L1 is read-only; mutations arrive with L2. Keep a sane default.
        retry: false,
      },
    },
  });
}

/** Application-wide singleton, created once and provided in main.tsx. */
export const queryClient = createQueryClient();
