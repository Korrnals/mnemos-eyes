import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";

/**
 * L2 slot (ADR 0003 / D12): the cluster graph is deferred; the nav entry is
 * hidden in L1. Kept as a typed stub so T-L2 wires the query without touching
 * the key namespace. Intentionally NOT a live useQuery — no endpoint exists.
 * TODO(L2): implement against the future `GET /clusters` via
 * `useQuery({ queryKey: keys.clusters.all, queryFn: ... })`.
 */
export function useClusters() {
  const gateway = useGateway();
  return { queryKey: keys.clusters.all, gateway } as const;
}
