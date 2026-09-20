import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { BoardEvent } from "@/gateway/events";
import { isTaskEventSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";

/**
 * SSE → cache mapping for the agents domain (AGW-1, spec 2026-09-19 §5.9).
 *
 * Unlike the task bridge (surgical setQueryData patches over one shared
 * board projection) this bridge is INVALIDATION-only, by design: the
 * assignment queue is a server-computed projection — the routing annotation
 * of every row is derived per GET from the registry — so the honest
 * reaction to any transition is to mark the affected lists stale and let
 * active observers refetch. Client-side re-derivation of server-owned
 * values would be a second, drift-prone routing implementation.
 *
 * | event                  | invalidated keys                            |
 * |------------------------|---------------------------------------------|
 * | assignment.* (7 kinds) | agents.assignments.*                        |
 * | executor.* (5 kinds)   | agents.executors.* AND agents.assignments.* |
 *
 * executor.* also invalidates the assignment queue because queued rows
 * carry routing computed over the registry (Amd 2 §5): a presence
 * transition or an approve/revoke/enabled flip changes who a queued
 * assignment would resolve to. Transitions are rare (the sweeper emits on
 * change only, §11), so the extra refetch is cheap and correctness wins.
 */

/** Apply one board event to the agents-domain caches (pure, unit-tested). */
export function applyAgentsEventToCache(
  queryClient: QueryClient,
  event: BoardEvent,
): void {
  switch (event.kind) {
    case "assignment.created":
    case "assignment.claimed":
    case "assignment.started":
    case "assignment.done":
    case "assignment.failed":
    case "assignment.cancelled":
    case "assignment.expired":
      void queryClient.invalidateQueries({ queryKey: keys.agents.assignments.all });
      break;
    case "executor.online":
    case "executor.offline":
    case "executor.registered":
    case "executor.updated":
    case "executor.deleted":
      void queryClient.invalidateQueries({ queryKey: keys.agents.executors.all });
      void queryClient.invalidateQueries({ queryKey: keys.agents.assignments.all });
      break;
    default:
      // task / report / notification kinds — task-domain keys are the task
      // bridge's (taskEvents.ts) responsibility; agents keys stay untouched.
      break;
  }
}

/**
 * §5.9 reconnect refetch: assignments AND executors go stale together —
 * SSE is at-most-once without resumption, so the drop window may have
 * missed any number of transitions.
 */
export function applyAgentsReconnectToCache(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: keys.agents.assignments.all });
  void queryClient.invalidateQueries({ queryKey: keys.agents.executors.all });
}

/**
 * Domain events bridge for the agents domain.
 *
 * MOUNT DECISION (AGW-1, documented per instruction): the task bridge lives
 * in the /tasks layout so other domains never pay for a stream they do not
 * consume — but the /agents routes do not exist until the Ф3 wave (spec
 * §6), so there is no domain layout to own the mount yet. The bridge
 * therefore mounts in the app Shell (see layout/Shell.tsx): it is pure
 * cache invalidation with no render surface, capability-gated (mock/mnemos
 * modes never open a stream), and it guarantees the §5.9 invalidation
 * semantics are live the moment the first agents page lands. When
 * AgentsLayout arrives, MOVE this mount there (one line) so each domain
 * pays only while it is visited.
 */
export function useAgentsEvents(): void {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  const openedRef = useRef(false);
  useEffect(() => {
    // The SSE guard is task-named but structurally generic (capabilities.ts:
    // "the stream factory the events bridge needs") — reuse, not rename.
    if (!isTaskEventSource(gateway)) return;
    const stream = gateway.events();
    const unsubscribe = stream.onAny((event) => {
      applyAgentsEventToCache(queryClient, event);
    });
    const unsubscribeState = stream.onStateChange((state) => {
      // Initial connect must NOT refetch (queries just mounted fresh); only
      // a RECOVERY — open → drop → open — does (§5.9).
      if (state === "open") {
        if (openedRef.current) applyAgentsReconnectToCache(queryClient);
        openedRef.current = true;
      }
    });
    return () => {
      unsubscribe();
      unsubscribeState();
      stream.close();
    };
  }, [gateway, queryClient]);
}
