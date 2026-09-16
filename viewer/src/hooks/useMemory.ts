import { useQuery } from "@tanstack/react-query";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";

/**
 * Single memory ("scroll") detail.
 * TODO(T5): wire the scroll view; raw-content toggle reads `includeRaw`.
 */
export function useMemory(id: string, includeRaw = false) {
  const gateway = useGateway();
  return useQuery({
    queryKey: keys.memories.detail(id, includeRaw),
    queryFn: ({ signal }) => gateway.getMemory(id, includeRaw, signal),
    staleTime: STALE_TIMES.memoryDetail,
    gcTime: GC_TIMES.memoryDetail,
    enabled: id.length > 0,
  });
}
