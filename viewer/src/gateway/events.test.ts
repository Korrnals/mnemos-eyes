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
