import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type { BoardEvent } from "@/gateway/events";
import { isTaskEventSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";

/**
 * SSE → cache mapping for the automation domain (SCHED-1-UI, ADR 0013 §4):
 * the rule family is ONE list-sync signal (АРХКОМ-5 FE verdict) — any
 * `automation.rule.*` mutation (created/updated/toggled/deleted, either
 * rule kind) marks BOTH rule lists and the journal stale; the status key
 * follows because its rule counters derive from the same rows. No
 * per-field patching: the events carry the row, but the lists are cheap
 * and the family signal is the contract.
 *
 * MOUNT (documented decision): /system/automation is a single System page,
 * not a domain with a layout — the PAGE mounts this hook, so the stream
 * exists exactly while the section is visited (the TasksLayout/
 * AgentsLayout ownership pattern, page-flavoured: one route, one owner).
 */

/** Apply one automation rule event to the caches (pure, unit-tested). */
export function applyAutomationEventToCache(
  queryClient: QueryClient,
  event: BoardEvent,
): void {
  switch (event.kind) {
    case "automation.rule.created":
    case "automation.rule.updated":
    case "automation.rule.toggled":
    case "automation.rule.deleted":
      void queryClient.invalidateQueries({ queryKey: keys.automation.schedules() });
      void queryClient.invalidateQueries({ queryKey: keys.automation.hooks() });
      void queryClient.invalidateQueries({ queryKey: keys.automation.launches({}).slice(0, 2) });
      void queryClient.invalidateQueries({ queryKey: keys.automation.status() });
      break;
    default:
      break;
  }
}

/** Page-level SSE bridge for the automation section. */
export function useAutomationEvents(): void {
  const gateway = useGateway();
  const queryClient = useQueryClient();
  useEffect(() => {
    // The generic stream-capability guard (capabilities.ts: "the stream
    // factory the events bridge needs") — task-named, structurally generic.
    if (!isTaskEventSource(gateway)) return;
    const stream = gateway.events();
    const unsubscribe = stream.onAny((event) => {
      applyAutomationEventToCache(queryClient, event);
    });
    return () => {
      unsubscribe();
      stream.close();
    };
  }, [gateway, queryClient]);
}
