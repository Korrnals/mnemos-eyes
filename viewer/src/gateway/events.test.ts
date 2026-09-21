import { describe, expect, it, vi } from "vitest";
import { EventStream, parseBoardEvent } from "./events";
import type { ParsedBoardEvent } from "./events";

/** Convenience: parse and assert the event branch. */
function parseEvent(raw: string) {
  const result = parseBoardEvent(raw);
  expect(result.status).toBe("event");
  return (result as Extract<ParsedBoardEvent, { status: "event" }>).event;
}

/** Convenience: parse and assert the ignored branch. */
function parseIgnored(raw: string) {
  const result = parseBoardEvent(raw);
  expect(result.status).toBe("ignored");
  return result as Extract<ParsedBoardEvent, { status: "ignored" }>;
}

const TASK = {
  id: "task-1",
  col: "open",
  position: 0,
  title: "Do the thing",
  summary: "",
  spec: "",
  agents: [],
  specialists: [],
  env: "local",
  project: "x",
  memory_ids: [],
  mnemos_tags: [],
  created_at: "2026-09-19T10:00:00Z",
  updated_at: "2026-09-19T10:00:00Z",
  archived: 0,
  status: "open",
  priority: "P2",
  archived_from: "",
  validating_since: "",
};

const NOTIFICATION = {
  id: 7,
  category: "work",
  title: "Task moved",
  message: "task-1 → in-progress",
  task_id: "task-1",
  ts: 1760000000,
  read: false,
};

/** Public executor shape as the registry emits it (_executor_public). */
const EXECUTOR = {
  id: "exec-1",
  name: "zcode@laptop",
  harness: "zcode",
  host: "laptop",
  transport: "local-poll",
  capabilities: ["@GCW: Senior Frontend Developer"],
  version: "1.11.3",
  enabled: true,
  state: "approved",
  last_seen: "2026-09-19T08:59:30+00:00",
  presence: "online",
  registered_at: "2026-09-18T09:00:00+00:00",
  updated_at: "2026-09-19T08:00:00+00:00",
};

describe("parseBoardEvent — ui-contract §11 dictionary", () => {
  it("parses the connect-time hello service frame", () => {
    const event = parseEvent('{"kind":"hello","last_event_id":42}');
    expect(event).toEqual({ kind: "hello", last_event_id: 42 });
  });

  it("parses task.created with its embedded task and notification", () => {
    const event = parseEvent(
      JSON.stringify({ kind: "task.created", task: TASK, notification: NOTIFICATION }),
    );
    expect(event.kind).toBe("task.created");
    if (event.kind !== "task.created") return;
    expect(event.task.id).toBe("task-1");
    expect(event.notification?.title).toBe("Task moved");
  });

  it("parses task.updated without inventing a notification", () => {
    const event = parseEvent(JSON.stringify({ kind: "task.updated", task: TASK }));
    expect(event.kind).toBe("task.updated");
    if (event.kind !== "task.updated") return;
    expect("notification" in event).toBe(false);
  });

  it("parses task.moved (task + notification)", () => {
    const event = parseEvent(
      JSON.stringify({ kind: "task.moved", task: TASK, notification: NOTIFICATION }),
    );
    expect(event.kind).toBe("task.moved");
  });

  it("parses the task_id-only kinds (deleted/archived/unarchived)", () => {
    for (const kind of ["task.deleted", "task.archived", "task.unarchived"] as const) {
      const event = parseEvent(JSON.stringify({ kind, task_id: "task-1" }));
      expect(event.kind).toBe(kind);
    }
    const archived = parseEvent(
      JSON.stringify({
        kind: "task.archived",
        task_id: "task-1",
        notification: NOTIFICATION,
      }),
    );
    if (archived.kind !== "task.archived") return;
    expect(archived.notification?.category).toBe("work");
  });

  it("parses server.changed with, without, and with a group: marker", () => {
    expect(parseEvent('{"kind":"server.changed"}')).toEqual({ kind: "server.changed" });
    expect(parseEvent('{"kind":"server.changed","server":"mnemos-main"}')).toEqual({
      kind: "server.changed",
      server: "mnemos-main",
    });
    expect(parseEvent('{"kind":"server.changed","server":"group:edge"}')).toEqual({
      kind: "server.changed",
      server: "group:edge",
    });
  });

  it("parses the bare notification fallback kind", () => {
    const event = parseEvent(
      JSON.stringify({ kind: "notification", notification: NOTIFICATION }),
    );
    if (event.kind !== "notification") return;
    expect(event.notification.id).toBe(7);
  });

  it("parses report with its truncated body", () => {
    const event = parseEvent(
      JSON.stringify({
        kind: "report",
        task_id: "task-1",
        report: { body: "a".repeat(200) },
      }),
    );
    if (event.kind !== "report") return;
    expect(event.report.body).toHaveLength(200);
  });

  it("parses the reserved assignment.* kinds (ADR 0009)", () => {
    const assignment = {
      id: "as-1",
      task_id: "task-1",
      state: "queued",
      specialist: "zed",
    };
    const event = parseEvent(
      JSON.stringify({ kind: "assignment.claimed", assignment, task_id: "task-1" }),
    );
    if (event.kind !== "assignment.claimed") return;
    expect(event.assignment.state).toBe("queued");
    expect(event.task_id).toBe("task-1");
  });

  it("parses the executor.* registry kinds (ARCH-9)", () => {
    const event = parseEvent(
      JSON.stringify({
        kind: "executor.updated",
        executor: EXECUTOR,
        prev_state: "pending",
        state: "approved",
      }),
    );
    if (event.kind !== "executor.updated") return;
    expect(event.executor.id).toBe("exec-1");
    expect(event.prev_state).toBe("pending");
    expect(event.state).toBe("approved");
    expect("last_seen_at" in event).toBe(false); // registry kinds carry no timestamp
  });
});

describe("parseBoardEvent — executor.* presence family (AGW-1)", () => {
  it("parses online/offline transitions with their last_seen_at", () => {
    const online = parseEvent(
      JSON.stringify({
        kind: "executor.online",
        executor: EXECUTOR,
        prev_state: "offline",
        state: "online",
        last_seen_at: "2026-09-19T08:59:30+00:00",
      }),
    );
    if (online.kind !== "executor.online") return;
    expect(online.prev_state).toBe("offline");
    expect(online.state).toBe("online");
    expect(online.last_seen_at).toBe("2026-09-19T08:59:30+00:00");

    const offline = parseEvent(
      JSON.stringify({
        kind: "executor.offline",
        executor: EXECUTOR,
        prev_state: "online",
        state: "offline",
        last_seen_at: "2026-09-19T08:59:30+00:00",
      }),
    );
    if (offline.kind !== "executor.offline") return;
    expect(offline.state).toBe("offline");
  });

  it("parses executor.registered with prev_state null (no prior state)", () => {
    const event = parseEvent(
      JSON.stringify({
        kind: "executor.registered",
        executor: { ...EXECUTOR, state: "pending", presence: "offline" },
        prev_state: null,
        state: "pending",
      }),
    );
    if (event.kind !== "executor.registered") return;
    expect(event.prev_state).toBeNull();
    expect(event.state).toBe("pending");
  });

  it("parses executor.deleted with prev_state === state (terminal snapshot)", () => {
    const event = parseEvent(
      JSON.stringify({
        kind: "executor.deleted",
        executor: EXECUTOR,
        prev_state: "approved",
        state: "approved",
      }),
    );
    if (event.kind !== "executor.deleted") return;
    expect(event.prev_state).toBe(event.state);
    // The deleted frame never grew a notification in this payload — absent
    // must stay absent (no invented field).
    expect("notification" in event).toBe(false);
  });

  it("keeps the embedded owner notification on registered/deleted (P2-1)", () => {
    // registered: `_notify_and_broadcast` attaches the notification for the
    // FIRST open pending registration per host — the frame carries it inline.
    const registered = parseEvent(
      JSON.stringify({
        kind: "executor.registered",
        executor: { ...EXECUTOR, state: "pending", presence: "offline" },
        prev_state: null,
        state: "pending",
        notification: NOTIFICATION,
      }),
    );
    if (registered.kind !== "executor.registered") return;
    expect(registered.notification?.id).toBe(7);
    expect(registered.notification?.category).toBe("work");

    const deleted = parseEvent(
      JSON.stringify({
        kind: "executor.deleted",
        executor: EXECUTOR,
        prev_state: "approved",
        state: "approved",
        notification: NOTIFICATION,
      }),
    );
    if (deleted.kind !== "executor.deleted") return;
    expect(deleted.notification?.title).toBe("Task moved");

    // ...and the same kinds parse CLEANLY without one (the duplicate-name
    // register arm and every later host go out bare via `_broadcast`).
    for (const kind of ["executor.registered", "executor.deleted"] as const) {
      const bare = parseEvent(
        JSON.stringify({
          kind,
          executor: EXECUTOR,
          prev_state: "approved",
          state: "approved",
        }),
      );
      if (bare.kind !== "executor.registered" && bare.kind !== "executor.deleted") return;
      expect("notification" in bare).toBe(false);
    }
  });

  it("classifies truncated/broken executor frames as malformed", () => {
    // No executor row.
    expect(
      parseIgnored('{"kind":"executor.online","state":"online","last_seen_at":"x"}').reason,
    ).toBe("malformed-payload");
    // No transition state.
    expect(
      parseIgnored(
        JSON.stringify({ kind: "executor.updated", executor: EXECUTOR }),
      ).reason,
    ).toBe("malformed-payload");
    // Presence kinds refuse to parse without their timestamp (§5.2).
    expect(
      parseIgnored(
        JSON.stringify({ kind: "executor.online", executor: EXECUTOR, state: "online" }),
      ).reason,
    ).toBe("malformed-payload");
    expect(
      parseIgnored(
        JSON.stringify({ kind: "executor.offline", executor: EXECUTOR, state: "offline" }),
      ).reason,
    ).toBe("malformed-payload");
  });

  it("keeps executor.stale unknown — stale is a silent corridor, no kind", () => {
    const result = parseIgnored(
      JSON.stringify({ kind: "executor.stale", executor: EXECUTOR, state: "stale" }),
    );
    expect(result.reason).toBe("unknown-kind");
    expect(result.kind).toBe("executor.stale");
  });

  it("classifies garbage frames: primitives invalid-json, arrays missing-kind", () => {
    // An array IS valid JSON and passes isRecord (typeof "object") — the
    // discriminator gate then rejects it, exactly like the frozen task kinds.
    expect(parseIgnored('[{"kind":"executor.online"}]').reason).toBe("missing-kind");
    expect(parseIgnored("42").reason).toBe("invalid-json");
    expect(parseIgnored("null").reason).toBe("invalid-json");
    expect(parseIgnored("not json{").reason).toBe("invalid-json");
  });
});

describe("parseBoardEvent — additive-only evolution rules", () => {
  it("silently classifies unknown kinds (client MUST ignore them)", () => {
    const result = parseIgnored('{"kind":"future.kind","payload":{}}');
    expect(result.reason).toBe("unknown-kind");
    expect(result.kind).toBe("future.kind");
  });

  it("classifies non-JSON frames as invalid-json", () => {
    expect(parseIgnored("not json{").reason).toBe("invalid-json");
    expect(parseIgnored('"a bare string"').reason).toBe("invalid-json");
  });

  it("classifies frames without the mandatory kind discriminator", () => {
    expect(parseIgnored('{"task_id":"task-1"}').reason).toBe("missing-kind");
    expect(parseIgnored('{"kind":""}').reason).toBe("missing-kind");
    expect(parseIgnored('{"kind":42}').reason).toBe("missing-kind");
  });

  it("classifies known kinds with broken payloads as malformed", () => {
    expect(parseIgnored('{"kind":"hello"}').reason).toBe("malformed-payload");
    expect(parseIgnored('{"kind":"task.created"}').reason).toBe("malformed-payload");
    expect(parseIgnored('{"kind":"task.deleted"}').reason).toBe("malformed-payload");
    expect(parseIgnored('{"kind":"notification"}').reason).toBe("malformed-payload");
    expect(parseIgnored('{"kind":"report","task_id":"t"}').reason).toBe(
      "malformed-payload",
    );
    expect(parseIgnored('{"kind":"assignment.done","task_id":"t"}').reason).toBe(
      "malformed-payload",
    );
  });
});

describe("EventStream wiring", () => {
  /** Minimal EventSource stand-in driven by the test through the factory seam. */
  function stubSource() {
    const listeners: { message: ((event: { data: string }) => void)[] } = {
      message: [],
    };
    return {
      url: "",
      set onmessage(handler: (event: { data: string }) => void) {
        listeners.message.push(handler);
      },
      emit(data: string) {
        for (const handler of listeners.message) handler({ data });
      },
      close: () => undefined,
    };
  }

  it("dispatches parsed frames to kind and any-subscribers, ignores the rest", () => {
    const source = stubSource();
    const stream = new EventStream({
      baseUrl: "/api/",
      eventSourceFactory: (url) => {
        source.url = url;
        return source as unknown as EventSource;
      },
    });
    const moved = vi.fn();
    const everything = vi.fn();
    stream.on("task.moved", moved);
    stream.onAny(everything);

    source.emit(JSON.stringify({ kind: "task.moved", task: TASK }));
    source.emit('{"kind":"future.kind"}');
    source.emit("broken{");

    expect(moved).toHaveBeenCalledTimes(1);
    expect(moved.mock.calls[0][0].kind).toBe("task.moved");
    expect(everything).toHaveBeenCalledTimes(1);
    expect(source.url).toBe("/api/events");
    stream.close();
  });
});
