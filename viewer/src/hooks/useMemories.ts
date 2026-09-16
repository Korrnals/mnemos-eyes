import { useQuery } from "@tanstack/react-query";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";
import type { ListMemoriesParams } from "@/gateway/types";

/**
 * Paginated memory list.
 * TODO(T5): wire list UI (filters via URL params, pagination state).
 */
export function useMemories(params: ListMemoriesParams = {}) {
  const gateway = useGateway();
  return useQuery({
    queryKey: keys.memories.list(params),
    queryFn: () => gateway.listMemories(params),
    staleTime: STALE_TIMES.memoriesList,
    gcTime: GC_TIMES.memoriesList,
  });
}
