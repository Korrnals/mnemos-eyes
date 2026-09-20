import { useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  AssignmentCancelledResult,
  AssignmentCreateInput,
  AssignmentCreatedResult,
  AssignmentListParams,
  AssignmentsPage,
  ExecutionSettings,
  ExecutionSettingsInput,
} from "@/gateway/boardTypes";
import { isAgentsMutationSource, isAgentsSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";
import { activeAssignmentOf } from "./assignmentStatus";

/**
 * AGW-1 agents-domain data hooks (spec 2026-09-19). Reads are
 * capability-gated exactly like the Ф2 task hooks (`isAgentsSource`): on
 * the mnemos adapter the queries stay idle and pages render their honest
 * unsupported states. `useExecutors` returns the WHOLE page — `meta` (the
 * presence TTL constants and sweeper cadence) is server-owned DATA the UI
 * reads and re-renders thresholds from, never hardcodes (§5.1).
 *
 * Mutations are plain TanStack mutations + targeted invalidation.
 * User-visible strings (toasts, confirmations, dialogs) arrive with the Ф3
 * UI wave — this layer stays i18n-free by contract, which is also why no
 * toast/toastContext import lives here.
 */

/** Assignment queue (`GET /api/assignments`), optionally filtered. */
export function useAssignments(params: AssignmentListParams = {}) {
  const gateway = useGateway();
  const capable = isAgentsSource(gateway);
  return useQuery({
    queryKey: keys.agents.assignments.list(params),
    queryFn: ({ signal }) => {
      if (!isAgentsSource(gateway)) {
        throw new Error("useAssignments: gateway has no agents capability.");
      }
      return gateway.listAssignments(params, signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.agentsAssignments,
    gcTime: GC_TIMES.agentsAssignments,
  });
}

/**
 * Executor registry (`GET /api/executors`). Presence is a point-in-time
 * server computation; ages render from `last_seen` + a local ticker while
 * SSE transitions (executor.*) invalidate this key.
 */
export function useExecutors() {
  const gateway = useGateway();
  const capable = isAgentsSource(gateway);
  return useQuery({
    queryKey: keys.agents.executors.list(),
    queryFn: ({ signal }) => {
      if (!isAgentsSource(gateway)) {
        throw new Error("useExecutors: gateway has no agents capability.");
      }
      return gateway.listExecutors(signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.agentsExecutors,
    gcTime: GC_TIMES.agentsExecutors,
  });
}

/** Default/fallback executor pair (`GET /api/settings/execution`). */
export function useExecutionSettings() {
  const gateway = useGateway();
  const capable = isAgentsSource(gateway);
  return useQuery({
    queryKey: keys.agents.settings.execution(),
    queryFn: ({ signal }) => {
      if (!isAgentsSource(gateway)) {
        throw new Error("useExecutionSettings: gateway has no agents capability.");
      }
      return gateway.getExecutionSettings(signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.agentsSettings,
    gcTime: GC_TIMES.agentsSettings,
  });
}

/**
 * The ACTIVE assignment of one task (≤1 invariant), read from the shared
 * unfiltered queue query through a `select` — every card, list row and the
 * detail page observe ONE wire call (the same single-projection decision as
 * tasks.board). undefined = no active attempt (or no agents capability —
 * mnemos mode renders no badge, which is the honest state).
 */
export function useActiveAssignment(taskId: string | undefined) {
  const gateway = useGateway();
  const capable = isAgentsSource(gateway) && taskId !== undefined;
  const select = useCallback(
    (page: AssignmentsPage) => activeAssignmentOf(page.items, taskId ?? ""),
    [taskId],
  );
  return useQuery({
    // MUST stay key-identical with useAssignments() — one cache entry feeds
    // the tab (filtered), the cards and the list rows (selected).
    queryKey: keys.agents.assignments.list({}),
    queryFn: ({ signal }) => {
      if (!isAgentsSource(gateway)) {
        throw new Error("useActiveAssignment: gateway has no agents capability.");
      }
      return gateway.listAssignments({}, signal);
    },
    enabled: capable,
    select,
    staleTime: STALE_TIMES.agentsAssignments,
    gcTime: GC_TIMES.agentsAssignments,
  });
}

/**
 * Queue an execution attempt (`POST /api/assignments`, ui-token). The 201
 * answer carries the created row, but routing is recomputed per GET — the
 * queue is invalidated, never patched.
 */
export function useCreateAssignment() {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  return useMutation<AssignmentCreatedResult, Error, AssignmentCreateInput>({
    mutationFn: (payload) => {
      if (!isAgentsMutationSource(gateway)) {
        throw new Error("useCreateAssignment: gateway has no agents mutation capability.");
      }
      return gateway.createAssignment(payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.agents.assignments.all });
    },
  });
}

/**
 * Cancel an assignment (`POST /api/assignments/{id}/cancel`, ui-token).
 * When the answer reports a task column return (`moved`), the board key is
 * invalidated too — the authoritative patch normally arrives via the
 * task.moved SSE event, the invalidation is the fallback for a missed
 * at-most-once frame.
 */
export function useCancelAssignment() {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  return useMutation<
    AssignmentCancelledResult,
    Error,
    { assignmentId: number; reason?: string }
  >({
    mutationFn: ({ assignmentId, reason }) => {
      if (!isAgentsMutationSource(gateway)) {
        throw new Error("useCancelAssignment: gateway has no agents mutation capability.");
      }
      return gateway.cancelAssignment(assignmentId, reason);
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: keys.agents.assignments.all });
      if (result.moved.length > 0) {
        void queryClient.invalidateQueries({ queryKey: keys.tasks.board() });
      }
    },
  });
}

/**
 * Set the default/fallback pair (`PUT /api/settings/execution`, ui-token).
 * The queue is invalidated alongside the settings key because queued rows'
 * routing annotations are derived from the default (Amd 2 §5).
 */
export function usePutExecutionSettings() {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  return useMutation<ExecutionSettings, Error, ExecutionSettingsInput>({
    mutationFn: (payload) => {
      if (!isAgentsMutationSource(gateway)) {
        throw new Error(
          "usePutExecutionSettings: gateway has no agents mutation capability.",
        );
      }
      return gateway.putExecutionSettings(payload);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.agents.settings.execution() });
      void queryClient.invalidateQueries({ queryKey: keys.agents.assignments.all });
    },
  });
}
