import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  HarnessCreateInput,
  HarnessesPage,
  HarnessStateResult,
} from "@/gateway/boardTypes";
import { isAgentsMutationSource, isAgentsSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";

/**
 * Harness-dictionary hooks (wave 3C, design 2026-09-22 §C). The dictionary
 * is an OPEN read — `GET /api/harnesses` with the guaranteed-seed meta —
 * and the ONLY source of select options for every harness picker (assign
 * sheet, enrollment dialog, automation schedule form): the former
 * former closed-set mirror (gateway/harnesses.ts) is deleted, the drift
 * class with it. SSE `harness.*` frames invalidate the family key (agentsEvents).
 *
 * The add mutation is ui-token class; errors (422 bad name / 409 duplicate
 * / 422 cap) REJECT to the caller so the inline combobox form can render
 * the server's text next to the input — a toast would be invisible next to
 * a field the owner is typing in.
 */

/** Harness dictionary (`GET /api/harnesses`, open read; wave 3C). */
export function useHarnesses() {
  const gateway = useGateway();
  const capable = isAgentsSource(gateway);
  return useQuery({
    queryKey: keys.agents.harnesses.list(),
    queryFn: ({ signal }) => {
      if (!isAgentsSource(gateway)) {
        throw new Error("useHarnesses: gateway has no agents capability.");
      }
      return gateway.listHarnesses(signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.agentsExecutors,
    gcTime: GC_TIMES.agentsExecutors,
  });
}

/**
 * Add a harness (`POST /api/harnesses`, ui-token). Invalidates the
 * dictionary on success; on failure the error propagates (inline render).
 */
export function useAddHarness() {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  return useMutation<HarnessStateResult, Error, HarnessCreateInput>({
    mutationFn: async (payload) => {
      if (!isAgentsMutationSource(gateway)) {
        throw new Error("useAddHarness: gateway has no agents mutation capability.");
      }
      return gateway.createHarness(payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.agents.harnesses.all });
    },
  });
}

/** Sorted dictionary names from the page query (undefined while loading). */
export function useHarnessNames(): string[] | undefined {
  const harnesses = useHarnesses();
  if (harnesses.data === undefined) return undefined;
  return harnesses.data.items
    .map((item: HarnessesPage["items"][number]) => item.name)
    .sort((a, b) => a.localeCompare(b));
}
