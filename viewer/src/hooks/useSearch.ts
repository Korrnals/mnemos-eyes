import { useQuery } from "@tanstack/react-query";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";
import type { SearchParams } from "@/gateway/types";

/**
 * Unified search (FTS + semantic) — always-fresh (staleTime 0).
 * TODO(T5): enable only for non-empty queries via the page's URL state.
 */
export function useSearch(params: SearchParams) {
  const gateway = useGateway();
  return useQuery({
    queryKey: keys.search.results(params),
    queryFn: ({ signal }) => gateway.search(params, signal),
    staleTime: STALE_TIMES.search,
    gcTime: GC_TIMES.search,
  });
}
