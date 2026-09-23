import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { parseBoardEvent } from "@/gateway/events";
import type { BoardEvent } from "@/gateway/events";
import {
  MOCK_ASSIGNMENTS_PAGE,
  MOCK_BOARD,
  MOCK_EXECUTORS_PAGE,
} from "@/gateway/boardFixtures";
import { keys } from "@/lib/queryKeys";
import { applyAgentsEventToCache, applyAgentsReconnectToCache } from "./agentsEvents";

/**
 * SSE → cache mapping for the agents domain (AGW-1 gate): the bridge is
 * INVALIDATION-only — every assignment and executor transition marks the
 * affected agents keys stale, nothing else. Events are produced by the REAL
 * parser (parseBoardEvent over wire JSON), so the input side is the true
 * wire dictionary, not a hand-cast double.
 */

function seededClient(): QueryClient {
  const client = new QueryClient();
  client.setQueryData(keys.agents.assignments.list(), MOCK_ASSIGNMENTS_PAGE);
  client.setQueryData(keys.agents.executors.list(), MOCK_EXECUTORS_PAGE);
  // AGW-5 phase 2: the enrollment list is part of the domain cache.
  client.setQueryData(keys.agents.enrollment.list(), { ok: true, count: 0, items: [] });
  client.setQueryData(keys.tasks.board(), MOCK_BOARD);
  return client;
}

/** Parse one wire frame; fail loud when a relied-on fixture parses ignored. */
function mustEvent(payload: unknown): BoardEvent {
  const parsed = parseBoardEvent(JSON.stringify(payload));
  if (parsed.status !== "event") {
    throw new Error(`fixture frame parsed as ignored (${parsed.reason})`);
  }
  return parsed.event;
}

/** True when a query under the given key prefix is marked invalidated. */
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

describe("applyAgentsEventToCache — invalidation-only mapping", () => {
  it("every assignment.* kind invalidates the assignment queue and nothing else", () => {
    const kinds = [
      "assignment.created",
      "assignment.claimed",
      "assignment.started",
      "assignment.done",
      "assignment.failed",
      "assignment.cancelled",
      "assignment.expired",
    ] as const;
    for (const kind of kinds) {
      const client = seededClient();
      applyAgentsEventToCache(
        client,
        mustEvent({
          kind,
          assignment: { id: "101", task_id: "TB-1", state: "queued" },
          task_id: "TB-1",
        }),
      );
      expect(isKeyInvalidated(client, keys.agents.assignments.all)).toBe(true);
      expect(isKeyInvalidated(client, keys.agents.executors.all)).toBe(false);
      expect(isKeyInvalidated(client, keys.tasks.all)).toBe(false);
    }
  });

  it("every executor.* kind invalidates executors AND the queue (routing is registry-derived)", () => {
    const kinds = [
      "executor.online",
      "executor.offline",
      "executor.registered",
      "executor.updated",
      "executor.deleted",
    ] as const;
    for (const kind of kinds) {
      const client = seededClient();
      applyAgentsEventToCache(
        client,
        mustEvent({
          kind,
          executor: { id: "exec-1", presence: "online" },
          prev_state: "offline",
          state: "online",
          ...(kind === "executor.online" || kind === "executor.offline"
            ? { last_seen_at: "2026-09-19T08:59:30+00:00" }
            : {}),
        }),
      );
      expect(isKeyInvalidated(client, keys.agents.executors.all)).toBe(true);
      expect(isKeyInvalidated(client, keys.agents.assignments.all)).toBe(true);
      expect(isKeyInvalidated(client, keys.tasks.all)).toBe(false);
    }
  });

  it("task/report events leave the agents keys untouched (task bridge owns them)", () => {
    const client = seededClient();
    applyAgentsEventToCache(
      client,
      mustEvent({
        kind: "task.moved",
        task: { id: "TB-1", col: "in-progress", status: "in-progress" },
      }),
    );
    applyAgentsEventToCache(client, mustEvent({ kind: "hello", last_event_id: 7 }));
    expect(isKeyInvalidated(client, keys.agents.assignments.all)).toBe(false);
    expect(isKeyInvalidated(client, keys.agents.executors.all)).toBe(false);
  });
});

describe("applyAgentsReconnectToCache — §5.9 reconnect refetch", () => {
  it("invalidates assignments + executors together, task keys untouched", () => {
    const client = seededClient();
    applyAgentsReconnectToCache(client);
    expect(isKeyInvalidated(client, keys.agents.assignments.all)).toBe(true);
    expect(isKeyInvalidated(client, keys.agents.executors.all)).toBe(true);
    expect(isKeyInvalidated(client, keys.tasks.all)).toBe(false);
  });
});

describe("applyAgentsEventToCache — enrollment family (AGW-5 phase 2)", () => {
  it("created/revoked/expired invalidate the enrollment list only", () => {
    for (const kind of ["created", "revoked", "expired"]) {
      const client = seededClient();
      applyAgentsEventToCache(
        client,
        mustEvent({ kind: `enrollment.${kind}`, enrollment_id: "enr-1" }),
      );
      expect(isKeyInvalidated(client, keys.agents.enrollment.all)).toBe(true);
      expect(isKeyInvalidated(client, keys.agents.executors.all)).toBe(false);
      expect(isKeyInvalidated(client, keys.agents.assignments.all)).toBe(false);
    }
  });

  it("used invalidates enrollment AND executors (a pending row was minted)", () => {
    const client = seededClient();
    applyAgentsEventToCache(
      client,
      mustEvent({
        kind: "enrollment.used",
        enrollment_id: "enr-1",
        executor_id: "exec-new",
        executor_name: "vps-1",
        used_ip: "10.0.0.9",
      }),
    );
    expect(isKeyInvalidated(client, keys.agents.enrollment.all)).toBe(true);
    expect(isKeyInvalidated(client, keys.agents.executors.all)).toBe(true);
  });

  it("the reconnect refetch covers the enrollment list too", () => {
    const client = seededClient();
    applyAgentsReconnectToCache(client);
    expect(isKeyInvalidated(client, keys.agents.enrollment.all)).toBe(true);
  });
});

describe("harness.* — dictionary sync (wave 3C)", () => {
  it("added/removed invalidate the harnesses key and nothing else", () => {
    for (const [kind, payload] of [
      ["harness.added", { harness: { name: "myagent", added_via: "owner" } }],
      ["harness.removed", { name: "myagent" }],
    ] as const) {
      const client = seededClient();
      client.setQueryData(keys.agents.harnesses.list(), {
        ok: true,
        count: 10,
        items: [],
        meta: { seed_min_count: 10 },
      });
      applyAgentsEventToCache(client, mustEvent({ kind, ...payload }));
      expect(isKeyInvalidated(client, keys.agents.harnesses.all)).toBe(true);
      expect(isKeyInvalidated(client, keys.agents.executors.all)).toBe(false);
      expect(isKeyInvalidated(client, keys.agents.assignments.all)).toBe(false);
    }
  });

  it("reconnect marks the harness dictionary stale too (at-most-once stream)", () => {
    const client = seededClient();
    client.setQueryData(keys.agents.harnesses.list(), {
      ok: true,
      count: 10,
      items: [],
      meta: { seed_min_count: 10 },
    });
    applyAgentsReconnectToCache(client);
    expect(isKeyInvalidated(client, keys.agents.harnesses.all)).toBe(true);
  });
});
