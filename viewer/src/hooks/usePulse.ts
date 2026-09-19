import { useQuery } from "@tanstack/react-query";
import { useGateway } from "@/gateway/GatewayContext";
import { isBoardHealthSource, isPulseSource } from "@/gateway/capabilities";
import type { PulseParams } from "@/gateway/boardTypes";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";

/**
 * Merged recency feed (Ф1 Pulse page). The query is ENABLED only when the
 * injected gateway actually speaks the pulse wire (board / mock adapters);
 * in mnemos mode the hook stays idle and the page renders its honest
 * "unsupported" state — a capability, not a configuration flag.
 */
export function usePulse(params: PulseParams = {}) {
  const gateway = useGateway();
  const capable = isPulseSource(gateway);
  return useQuery({
    queryKey: keys.pulse.feed(params),
    // The enabled flag above keeps this unreachable for incapable gateways;
    // the guard keeps queryFn honest for the type system too.
    queryFn: ({ signal }) => {
      if (!isPulseSource(gateway)) {
        throw new Error("usePulse: the injected gateway has no pulse capability.");
      }
      return gateway.pulse(params, signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.pulse,
    gcTime: GC_TIMES.pulse,
  });
}

/** Per-store health detail for the Overview cards (same capability rule). */
export function useBoardHealth() {
  const gateway = useGateway();
  const capable = isBoardHealthSource(gateway);
  return useQuery({
    queryKey: keys.status.boardHealth(),
    queryFn: ({ signal }) => {
      if (!isBoardHealthSource(gateway)) {
        throw new Error("useBoardHealth: gateway has no board-health capability.");
      }
      return gateway.boardHealth(signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.status,
    gcTime: GC_TIMES.status,
  });
}
