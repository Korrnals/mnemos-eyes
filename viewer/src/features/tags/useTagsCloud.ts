import { useQuery } from "@tanstack/react-query";
import { isTagMergeSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";
import type { TagSummary } from "@/gateway/types";

/**
 * Tags cloud data hook (UI-17 spec §6): prefers the raw merged view when the
 * gateway speaks it (`mergedTags` — board/mock adapters; carries `errors[]` +
 * `servers_scanned` for the partial-data honesty line), falls back to the
 * plain `listTags` projection on single-store mnemos mode. One wire call
 * feeds chips, bands, families, siblings and the drill header count — all
 * views derive from this snapshot, so a refetch can never reshuffle live
 * view state (freeze-рамка §4.4).
 */

/** Unreachable stores as reported by the merged tags view. */
export interface TagStoreError {
  readonly server?: string;
  readonly status?: number;
}

export interface TagsCloudStats {
  readonly serversScanned: number;
  readonly errors: readonly TagStoreError[];
}

export interface UseTagsCloudResult {
  /** count DESC, name ASC — the deterministic house sort. */
  tags: TagSummary[];
  /** Per-store honesty; null when the gateway has no merged view. */
  stats: TagsCloudStats | null;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
  dataUpdatedAt: number;
}

export function useTagsCloud(): UseTagsCloudResult {
  const gateway = useGateway();
  // Capability probe (structural, not configuration): adapters with the
  // merged view light the partial-data line up; mnemos mode falls back.
  const mergedGateway = isTagMergeSource(gateway) ? gateway : null;

  const mergedQuery = useQuery({
    queryKey: keys.tags.merged(),
    queryFn: async ({ signal }) => {
      // enabled: false keeps this from firing on gateways without the
      // capability — the guard is for the type, not for the wire.
      if (!mergedGateway) {
        throw new Error("mergedTags: gateway has no merged-tags capability");
      }
      return mergedGateway.mergedTags(signal);
    },
    enabled: mergedGateway !== null,
    staleTime: STALE_TIMES.tags,
    gcTime: GC_TIMES.tags,
  });

  const listQuery = useQuery({
    queryKey: keys.tags.list(),
    queryFn: ({ signal }) => gateway.listTags(signal),
    enabled: mergedGateway === null,
    staleTime: STALE_TIMES.tags,
    gcTime: GC_TIMES.tags,
  });

  const useMerged = mergedGateway !== null;
  const active = useMerged ? mergedQuery : listQuery;
  const tags: TagSummary[] = useMerged
    ? (mergedQuery.data?.tags ?? []).map((entry) => ({
        tag: entry.name,
        count: entry.count,
      }))
    : (listQuery.data ?? []);

  return {
    tags,
    stats:
      useMerged && mergedQuery.data
        ? {
            serversScanned: mergedQuery.data.servers_scanned,
            errors: (mergedQuery.data.errors ?? []).map((entry) => ({
              server: typeof entry.server === "string" ? entry.server : undefined,
              status: typeof entry.status === "number" ? entry.status : undefined,
            })),
          }
        : null,
    isPending: active.isPending,
    isError: active.isError,
    error: active.isError && active.error ? active.error : null,
    refetch: () => void active.refetch(),
    dataUpdatedAt: active.dataUpdatedAt ?? 0,
  };
}
