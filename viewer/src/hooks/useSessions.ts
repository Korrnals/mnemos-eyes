import { useQuery } from "@tanstack/react-query";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";

/** A2A session list. TODO(T5): wire the session list page. */
export function useSessions() {
  const gateway = useGateway();
  return useQuery({
    queryKey: keys.sessions.list(),
    queryFn: () => gateway.listSessions(),
    staleTime: STALE_TIMES.sessions,
    gcTime: GC_TIMES.sessions,
  });
}

/** Single A2A session detail. TODO(T5): wire the session detail page. */
export function useSession(id: string) {
  const gateway = useGateway();
  return useQuery({
    queryKey: keys.sessions.detail(id),
    queryFn: () => gateway.getSession(id),
    staleTime: STALE_TIMES.sessions,
    gcTime: GC_TIMES.sessions,
    enabled: id.length > 0,
  });
}
