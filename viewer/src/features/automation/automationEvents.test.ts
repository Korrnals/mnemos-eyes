import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { parseBoardEvent } from "@/gateway/events";
import type { BoardEvent } from "@/gateway/events";
import { keys } from "@/lib/queryKeys";
import { applyAutomationEventToCache } from "./automationEvents";

/**
 * SSE → cache mapping for the automation domain (SCHED-1-UI): the rule
 * family is ONE list-sync signal — any automation.rule.* mutation marks
 * BOTH rule lists, the journal and the status stale; nothing else moves.
 * Events come from the REAL parser (wire JSON), like agentsEvents tests.
 */

function mustEvent(payload: unknown): BoardEvent {
  const parsed = parseBoardEvent(JSON.stringify(payload));
  if (parsed.status !== "event") {
    throw new Error(`fixture frame parsed as ignored (${parsed.reason})`);
  }
  return parsed.event;
}

function isKeyInvalidated(client: QueryClient, prefix: readonly unknown[]): boolean {
  return client
    .getQueryCache()
    .getAll()
    .some((query) => {
      const key = query.queryKey as readonly unknown[];
      return (
        key.length >= prefix.length &&
        JSON.stringify(key.slice(0, prefix.length)) === JSON.stringify(prefix) &&
        query.state.isInvalidated
      );
    });
}

function seededClient(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(keys.automation.schedules(), { ok: true, count: 0, items: [] });
  client.setQueryData(keys.automation.hooks(), { ok: true, count: 0, items: [] });
  client.setQueryData(keys.automation.status(), {
    ok: true,
    engine: false,
    global_kill_switch: false,
    daily_cap: 50,
    daily_used: 0,
    condition_meta: {},
    rules: {},
  });
  client.setQueryData(keys.automation.launches({ limit: 50 }), {
    ok: true,
    count: 0,
    total: 0,
    items: [],
    next_cursor: null,
    truncated: false,
  });
  client.setQueryData(keys.agents.assignments.list({}), { ok: true, count: 0, items: [] });
  return client;
}

describe("applyAutomationEventToCache — the family list-sync signal", () => {
  it("every automation.rule.* kind invalidates schedules, hooks, journal AND status", () => {
    for (const kind of [
      "automation.rule.created",
      "automation.rule.updated",
      "automation.rule.toggled",
      "automation.rule.deleted",
    ] as const) {
      const client = seededClient();
      applyAutomationEventToCache(
        client,
        mustEvent({
          kind,
          rule_kind: kind === "automation.rule.toggled" ? "hook" : "schedule",
          rule: { id: 1, name: "x", enabled: false },
          ...(kind !== "automation.rule.created"
            ? { changes: { enabled: [true, false] } }
            : {}),
        }),
      );
      expect(isKeyInvalidated(client, ["automation", "schedules"]), kind).toBe(true);
      expect(isKeyInvalidated(client, ["automation", "hooks"]), kind).toBe(true);
      expect(isKeyInvalidated(client, ["automation", "launches"]), kind).toBe(true);
      expect(isKeyInvalidated(client, keys.automation.status()), kind).toBe(true);
      // The assignment queue is NOT part of the rule-sync signal (the
      // assignment.created event of a run-now handles that side).
      expect(isKeyInvalidated(client, ["agents", "assignments"]), kind).toBe(false);
    }
  });

  it("non-automation events leave every automation key untouched", () => {
    const client = seededClient();
    applyAutomationEventToCache(
      client,
      mustEvent({ kind: "task.updated", task: { id: "TB-1", col: "open" } }),
    );
    applyAutomationEventToCache(
      client,
      mustEvent({
        kind: "executor.online",
        executor: { id: "e", presence: "online" },
        prev_state: "offline",
        state: "online",
        last_seen_at: "2026-09-19T09:00:00+00:00",
      }),
    );
    expect(client.getQueryCache().getAll().some((query) => query.state.isInvalidated)).toBe(
      false,
    );
  });
});
