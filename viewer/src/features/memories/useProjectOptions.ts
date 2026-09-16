import { useQuery } from "@tanstack/react-query";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";

/**
 * Distinct project names for the list filter dropdown. There is no dedicated
 * `/projects` endpoint on mnemos, so this aggregates a wide list client-side
 * (honest fallback, same pattern as the tag inspector per ADR 0003).
 */
export function useProjectOptions(): string[] {
  const gateway = useGateway();
  const query = useQuery({
    queryKey: keys.memories.list({ limit: 500 }),
    queryFn: ({ signal }) => gateway.listMemories({ limit: 500 }, signal),
    staleTime: STALE_TIMES.memoriesList,
    gcTime: GC_TIMES.memoriesList,
  });

  if (!query.data) return [];
  return [...new Set(query.data.map((memory) => memory.project))].sort((a, b) =>
    a.localeCompare(b),
  );
}
