import { useQuery } from "@tanstack/react-query";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";

/**
 * Tag list with counts.
 * TODO(T2): prefer the mnemos `GET /tags` endpoint via the gateway; the
 * client-side aggregation fallback from ADR 0003 lives in the T5 page code.
 */
export function useTags() {
  const gateway = useGateway();
  return useQuery({
    queryKey: keys.tags.list(),
    queryFn: () => gateway.listTags(),
    staleTime: STALE_TIMES.tags,
    gcTime: GC_TIMES.tags,
  });
}
