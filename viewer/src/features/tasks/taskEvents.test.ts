import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { parseBoardEvent } from "@/gateway/events";
import type { BoardEvent } from "@/gateway/events";
import { keys } from "@/lib/queryKeys";
import { applyTaskEventToCache } from "./taskEvents";
import { MOCK_ARCHIVED_TASK, MOCK_BOARD, MOCK_REPORTS } from "@/gateway/boardFixtures";
import type { BoardSummary, BoardTask, TaskReports } from "@/gateway/boardTypes";

/**
 * SSE → cache mapping (Ф2 gate): every task.* / report event patches ONLY
 * the affected keys — the board projection is surgically mutated, never
 * refetched (ARCHCOM-3 verdict §3). Events are produced by the REAL parser
 * (parseBoardEvent over wire JSON), so the input side is the true wire
 * dictionary, not a hand-cast double.
 */

function seededClient(): QueryClient {
  const client = new QueryClient();
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

function boardOf(client: QueryClient): BoardSummary {
  return (
    client.getQueryData<BoardSummary>(keys.tasks.board()) ?? {
      columns: [],
      tasks: [],
      counts: {},
    }
  );
}

const CREATED_TASK = {
  id: "T-NEW",
  col: "open",
  position: 9,
  title: "Новая",
  summary: "",
  spec: "",
  agents: [] as string[],
  specialists: [] as string[],
  env: "local",
  project: "vesmaro",
  memory_ids: [] as string[],
  mnemos_tags: [] as string[],
  created_at: "2026-09-19T10:00:00+00:00",
  updated_at: "2026-09-19T10:00:00+00:00",
  status: "open",
  priority: "high",
};

describe("task.created / updated / moved — surgical board patch", () => {
  it("task.created appends the row and bumps the column count", () => {
    const client = seededClient();
    const before = boardOf(client);

    applyTaskEventToCache(
      client,
      mustEvent({ kind: "task.created", task: CREATED_TASK }),
    );

    const after = boardOf(client);
    expect(after.tasks.map((t) => t.id)).toContain("T-NEW");
    expect(after.counts.open).toBe(before.counts.open + 1);
    // No key was refetched — the patch is pure setQueryData.
  });

  it("task.updated replaces the row in place, counts unchanged", () => {
    const client = seededClient();
    const before = boardOf(client);

    const updated = {
      ...before.tasks.find((t) => t.id === "TB-3")!,
      title: "Переименована",
    };
    applyTaskEventToCache(client, mustEvent({ kind: "task.updated", task: updated }));

    const after = boardOf(client);
    expect(after.tasks.find((t) => t.id === "TB-3")?.title).toBe("Переименована");
    expect(after.counts).toEqual(before.counts);
    expect(after.tasks.length).toBe(before.tasks.length);
  });

  it("task.updated with archived=1 removes the board row (no phantom, ME5-1)", () => {
    const client = seededClient();
    const before = boardOf(client);
    // Reachable on the wire: PATCH has no archived guard, so a server-side
    // edit of an archived row emits task.updated carrying archived=1. The
    // board cache mirrors GET /board (archived=0 only) — the row must be
    // REMOVED, not re-inserted.
    client.setQueryData(
      keys.tasks.detail("TB-3"),
      before.tasks.find((task) => task.id === "TB-3")!,
    );
    const archivedPatch = {
      ...before.tasks.find((task) => task.id === "TB-3")!,
      archived: 1,
      title: "Архивирована чужим клиентом",
    };
    applyTaskEventToCache(client, mustEvent({ kind: "task.updated", task: archivedPatch }));

    const after = boardOf(client);
    expect(after.tasks.find((task) => task.id === "TB-3")).toBeUndefined();
    expect(after.counts.open).toBe(before.counts.open - 1);
    // The detail mirror still learns the fresh row, archived state included.
    const detail = client.getQueryData<BoardTask>(keys.tasks.detail("TB-3"));
    expect(detail?.title).toBe("Архивирована чужим клиентом");
    expect(detail?.archived).toBe(1);
  });

  it("task.moved replaces the row and recounts both columns", () => {
    const client = seededClient();
    const moved = {
      ...boardOf(client).tasks.find((t) => t.id === "TB-3")!,
      col: "blocked",
    };
    applyTaskEventToCache(client, mustEvent({ kind: "task.moved", task: moved }));

    const after = boardOf(client);
    expect(after.tasks.find((t) => t.id === "TB-3")?.col).toBe("blocked");
    expect(after.counts.open).toBe(boardOf(seededClient()).counts.open - 1);
    expect(after.counts.blocked).toBe(boardOf(seededClient()).counts.blocked + 1);
  });
});

describe("task.deleted / task.archived — removal paths", () => {
  it("task.deleted removes the row and recounts", () => {
    const client = seededClient();
    applyTaskEventToCache(client, mustEvent({ kind: "task.deleted", task_id: "TB-4" }));

    const after = boardOf(client);
    expect(after.tasks.find((t) => t.id === "TB-4")).toBeUndefined();
    expect(after.counts.open).toBe(boardOf(seededClient()).counts.open - 1);
  });

  it("task.archived removes from the board AND invalidates the archive keys", () => {
    const client = seededClient();
    // Invalidation is observable on EXISTING queries — park an archive page
    // in the cache the way a visited /tasks/archive would have.
    client.setQueryData(keys.tasks.archive({ limit: 50, offset: 0 }), {
      ok: true,
      count: 0,
      total: 0,
      limit: 50,
      offset: 0,
      items: [],
      projects: {},
    });

    applyTaskEventToCache(
      client,
      mustEvent({ kind: "task.archived", task_id: "TB-4" }),
    );

    expect(boardOf(client).tasks.find((t) => t.id === "TB-4")).toBeUndefined();
    expect(isKeyInvalidated(client, ["tasks", "archive"])).toBe(true);
  });

  it("task.unarchived invalidates the board (no row in the payload) + archive", () => {
    const client = seededClient();
    client.setQueryData(keys.tasks.archive({ limit: 50, offset: 0 }), {
      ok: true,
      count: 0,
      total: 0,
      limit: 50,
      offset: 0,
      items: [],
      projects: {},
    });

    applyTaskEventToCache(
      client,
      mustEvent({ kind: "task.unarchived", task_id: "RB-1" }),
    );

    // The honest exception: the payload carries only task_id, so the row
    // cannot be patched — the keys go stale instead of rows being invented.
    expect(isKeyInvalidated(client, ["tasks", "board"])).toBe(true);
    expect(isKeyInvalidated(client, ["tasks", "archive"])).toBe(true);
    // The cached board data itself is untouched by the invalidation marker.
    expect(boardOf(client).tasks.length).toBe(MOCK_BOARD.tasks.length);
  });
});

describe("report — reports cache patch + count badge bump", () => {
  it("appends the report, flips live finals to superseded, syncs the count key", () => {
    const client = seededClient();
    client.setQueryData(keys.tasks.reports.detail("TB-1"), MOCK_REPORTS);

    applyTaskEventToCache(
      client,
      mustEvent({
        kind: "report",
        task_id: "TB-1",
        report: {
          id: 4,
          task_id: "TB-1",
          kind: "final",
          agent: "zcode",
          body: "Финальный отчёт v3 (тело события усечено до 200 символов)",
          superseded: false,
          created_at: "2026-09-19T12:00:00+00:00",
        },
      }),
    );

    const reports = client.getQueryData<TaskReports>(keys.tasks.reports.detail("TB-1"));
    expect(reports?.count).toBe(4);
    expect(reports?.items.at(-1)?.id).toBe(4);
    // The previous LIVE final is superseded; the older flagged one stays.
    expect(reports?.items.find((r) => r.id === 3)?.superseded).toBe(true);
    expect(reports?.items.find((r) => r.id === 2)?.superseded).toBe(true);
    // The badge count key mirrors the patched page (single source).
    expect(client.getQueryData(keys.tasks.reports.count("TB-1"))).toBe(4);
  });

  it("an intermediate report appends without touching existing finals", () => {
    const client = seededClient();
    client.setQueryData(keys.tasks.reports.detail("TB-1"), MOCK_REPORTS);

    applyTaskEventToCache(
      client,
      mustEvent({
        kind: "report",
        task_id: "TB-1",
        report: {
          id: 5,
          task_id: "TB-1",
          kind: "intermediate",
          agent: "zcode",
          body: "Ещё промежуточный",
          superseded: false,
          created_at: "2026-09-19T12:30:00+00:00",
        },
      }),
    );

    const reports = client.getQueryData<TaskReports>(keys.tasks.reports.detail("TB-1"));
    expect(reports?.items.find((r) => r.id === 3)?.superseded).toBe(false);
    expect(reports?.count).toBe(4);
  });

  it("leaves an unvisited task's reports cache ABSENT (no partial page)", () => {
    const client = seededClient();
    applyTaskEventToCache(
      client,
      mustEvent({
        kind: "report",
        task_id: "TB-9",
        report: { id: 9, kind: "intermediate", body: "x", superseded: false },
      }),
    );

    expect(client.getQueryData(keys.tasks.reports.detail("TB-9"))).toBeUndefined();
    // The badge count still learns about it.
    expect(client.getQueryData(keys.tasks.reports.count("TB-9"))).toBe(1);
  });
});

describe("tasks.detail mirror (BE-16 fallback cache, ME-005)", () => {
  it("task.updated patches a cached detail row in place (no wire refetch)", () => {
    const client = seededClient();
    // The archived row was opened via the single-task GET — its answer sits
    // under keys.tasks.detail exactly like useTaskDetail would leave it.
    client.setQueryData(keys.tasks.detail(MOCK_ARCHIVED_TASK.id), MOCK_ARCHIVED_TASK);

    const renamed = { ...MOCK_ARCHIVED_TASK, title: "Переименована из архива" };
    applyTaskEventToCache(client, mustEvent({ kind: "task.updated", task: renamed }));

    const detail = client.getQueryData<BoardTask>(keys.tasks.detail("RB-1"));
    expect(detail?.title).toBe("Переименована из архива");
    expect(detail?.archived).toBe(1); // same authoritative row, not a projection
  });

  it("a full-row event for an UNCACHED id never synthesises a detail entry", () => {
    const client = seededClient();
    applyTaskEventToCache(
      client,
      mustEvent({ kind: "task.updated", task: { ...CREATED_TASK, id: "T-GHOST" } }),
    );
    expect(client.getQueryData(keys.tasks.detail("T-GHOST"))).toBeUndefined();
  });

  it("task.archived / task.unarchived invalidate a cached detail (no usable payload)", () => {
    const client = seededClient();
    client.setQueryData(keys.tasks.detail("TB-4"), MOCK_ARCHIVED_TASK);
    client.setQueryData(keys.tasks.detail("RB-1"), MOCK_ARCHIVED_TASK);

    applyTaskEventToCache(client, mustEvent({ kind: "task.archived", task_id: "TB-4" }));
    applyTaskEventToCache(client, mustEvent({ kind: "task.unarchived", task_id: "RB-1" }));

    expect(isKeyInvalidated(client, keys.tasks.detail("TB-4"))).toBe(true);
    expect(isKeyInvalidated(client, keys.tasks.detail("RB-1"))).toBe(true);
  });
});

describe("dictionary discipline (additive-only, ui-contract §11)", () => {
  it("never synthesises a board when no cache exists", () => {
    const client = new QueryClient();
    applyTaskEventToCache(
      client,
      mustEvent({ kind: "task.created", task: { id: "T-1", col: "open" } }),
    );
    expect(client.getQueryData(keys.tasks.board())).toBeUndefined();
  });

  it("ignores hello / notification / server.changed for task keys", () => {
    const client = seededClient();
    const before = JSON.stringify(boardOf(client));
    for (const payload of [
      { kind: "hello", last_event_id: 42 },
      {
        kind: "notification",
        notification: {
          id: 1,
          category: "work",
          title: "x",
          message: "",
          task_id: null,
          ts: 0,
          read: false,
        },
      },
      { kind: "server.changed", server: "laptop" },
    ]) {
      applyTaskEventToCache(client, mustEvent(payload));
    }
    expect(JSON.stringify(boardOf(client))).toBe(before);
  });

  it("silently skips an unknown future kind (additive-only dictionary)", () => {
    const client = seededClient();
    const parsed = parseBoardEvent(
      JSON.stringify({ kind: "unknown-future-kind", x: 1 }),
    );
    if (parsed.status !== "ignored")
      throw new Error("expected the frame to be ignored");
    expect(parsed.reason).toBe("unknown-kind");
    expect(JSON.stringify(boardOf(client))).toBe(
      JSON.stringify(boardOf(seededClient())),
    );
  });
});
