import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { BoardEvent } from "@/gateway/events";
import { isTaskEventSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { pushExecutionEvent, setFeedStreamState } from "./executionFeedStore";

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
 * | harness.* (2 kinds)    | agents.harnesses.*                          |
 * | provisioning.* (5)     | agents.provision.* (ok adds executors.*)    |
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
    // AGW-5 phase 2: the enrollment family syncs ITS list; `used` also
    // minted a pending executor row (belt-and-braces beside the server's
    // own executor.registered — the at-most-once stream can drop frames).
    case "enrollment.created":
    case "enrollment.revoked":
    case "enrollment.expired":
      void queryClient.invalidateQueries({ queryKey: keys.agents.enrollment.all });
      break;
    case "enrollment.used":
      void queryClient.invalidateQueries({ queryKey: keys.agents.enrollment.all });
      void queryClient.invalidateQueries({ queryKey: keys.agents.executors.all });
      break;
    // Wave 3C: dictionary mutations sync the harness select options.
    case "harness.added":
    case "harness.removed":
      void queryClient.invalidateQueries({ queryKey: keys.agents.harnesses.all });
      break;
    // AGW-11 (wave 4): provisioning frames are change HINTS for the
    // connect card's job query (invalidation-only, like the rest of this
    // bridge — the GET is the authoritative projection). `ok` also mints
    // a pending registry row (belt-and-braces beside executor.registered,
    // the at-most-once stream may drop frames); `repinned` fails live
    // jobs of the identity server-side, so the jobs family syncs too.
    case "provisioning.created":
    case "provisioning.progress":
    case "provisioning.failed":
    case "provisioning.repinned":
      void queryClient.invalidateQueries({ queryKey: keys.agents.provision.all });
      break;
    case "provisioning.ok":
      void queryClient.invalidateQueries({ queryKey: keys.agents.provision.all });
      void queryClient.invalidateQueries({ queryKey: keys.agents.executors.all });
      break;
    default:
      // task / report / notification kinds — task-domain keys are the task
      // bridge's (taskEvents.ts) responsibility; agents keys stay untouched.
      break;
  }
}

/**
 * §5.9 reconnect refetch: assignments, executors, enrollment tokens AND the
 * harness dictionary go stale together — SSE is at-most-once without
 * resumption, so the drop window may have missed any number of transitions.
 */
export function applyAgentsReconnectToCache(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: keys.agents.assignments.all });
  void queryClient.invalidateQueries({ queryKey: keys.agents.executors.all });
  void queryClient.invalidateQueries({ queryKey: keys.agents.enrollment.all });
  void queryClient.invalidateQueries({ queryKey: keys.agents.harnesses.all });
  // AGW-11: a live provision job may have moved (or finished) while the
  // stream was down — the connect card re-reads its terminal verdict.
  void queryClient.invalidateQueries({ queryKey: keys.agents.provision.all });
}

/**
 * Domain events bridge for the agents domain.
 *
 * MOUNT (AGW-3, retired the AGW-1/P3-1 cost): AgentsLayout owns this hook —
 * the stream exists only while the /agents subtree is visited, and the
 * /tasks layout keeps its own bridge; the two never overlap, so no route
 * holds two `/api/events` connections anymore.
 *
 * One stream, two sinks (both fed from the SAME onAny subscription):
 * - cache invalidation (assignment and executor kinds → TanStack keys, §5.9);
 * - the UI-10 execution feed ring buffer (executionFeedStore) — the page
 *   reads the store, never opens a second EventSource.
 * The store also mirrors the connection state for the amber «данные на
 * HH:MM» marker. Capability-gated as before: mock/mnemos modes never open
 * a stream (the mock has no SSE — its data moves through React Query).
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
      pushExecutionEvent(event);
    });
    const unsubscribeState = stream.onStateChange((state) => {
      setFeedStreamState(state);
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
      setFeedStreamState("closed");
      stream.close();
    };
  }, [gateway, queryClient]);
}
