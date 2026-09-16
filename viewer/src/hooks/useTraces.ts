import { useQuery } from "@tanstack/react-query";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";

/** Pipeline trace list. TODO(T5): wire the traces page (filter by label). */
export function useTraces(params: { task_label?: string; limit?: number } = {}) {
  const gateway = useGateway();
  return useQuery({
    queryKey: keys.traces.list(params),
    queryFn: () => gateway.listTraces(params.task_label, params.limit),
    staleTime: STALE_TIMES.traces,
    gcTime: GC_TIMES.traces,
  });
}
