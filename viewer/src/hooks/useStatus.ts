import { useQuery } from "@tanstack/react-query";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";

/** mnemos health — drives the status panel and shell status indicator. */
export function useStatus() {
  const gateway = useGateway();
  return useQuery({
    queryKey: keys.status.health(),
    queryFn: () => gateway.health(),
    staleTime: STALE_TIMES.status,
    gcTime: GC_TIMES.status,
  });
}

/** Aggregate mnemos metrics (counts, pipeline counters). */
export function useMetrics() {
  const gateway = useGateway();
  return useQuery({
    queryKey: keys.status.metrics(),
    queryFn: () => gateway.metrics(),
    staleTime: STALE_TIMES.status,
    gcTime: GC_TIMES.status,
  });
}
