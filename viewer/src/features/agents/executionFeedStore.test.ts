import { describe, expect, it } from "vitest";
import { parseBoardEvent } from "@/gateway/events";
import type { BoardEvent } from "@/gateway/events";
import {
  FEED_CAP,
  feedItemFromEvent,
  pushFeedItem,
  pushExecutionEvent,
  readFeed,
  resetFeedStore,
  setFeedStreamState,
  sortFeed,
} from "./executionFeedStore";

/**
 * UI-10 feed core (spec §1.1/§4.2): the ring buffer caps without merging,
 * assignment frames and reports INTERLEAVE by time, actor labels come from
 * the declared identity (claimed_by → created_by), and only assignment and
 * report events become rows — everything else stays out of UI-10.
 */

const RECEIVED = Date.parse("2026-09-19T09:00:00+00:00");

function wireEvent(payload: unknown): BoardEvent {
  const parsed = parseBoardEvent(JSON.stringify(payload));
  if (parsed.status !== "event") throw new Error(`bad fixture: ${parsed.reason}`);
  return parsed.event;
}

const CLAIMED = wireEvent({
  kind: "assignment.claimed",
  task_id: "TB-1",
  assignment: { id: "105", task_id: "TB-1", state: "claimed", claimed_by: "zcode:laptop", created_by: "owner" },
});

const REPORT = wireEvent({
  kind: "report",
  task_id: "TB-1",
  report: { body: "финальный отчёт", kind: "final", agent: "zcode", created_at: "2026-09-19T08:58:00+00:00" },
});

const TASK_MOVED = wireEvent({
  kind: "task.moved",
  task: { id: "TB-1", col: "in-progress" },
});

describe("feedItemFromEvent — narrative translation", () => {
  it("assignment events become rows with the DECLARED actor (claimed_by wins)", () => {
    const item = feedItemFromEvent(CLAIMED, RECEIVED, 1);
    expect(item).not.toBeNull();
    expect(item!.kind).toBe("assignment.claimed");
    expect(item!.actor).toBe("zcode:laptop"); // claimed_by, not created_by
    expect(item!.taskId).toBe("TB-1");
    expect(item!.ts).toBe(new Date(RECEIVED).toISOString()); // receipt-stamped
  });

  it("reports keep report.created_at and the agent as actor", () => {
    const item = feedItemFromEvent(REPORT, RECEIVED, 2);
    expect(item!.kind).toBe("report");
    expect(item!.ts).toBe("2026-09-19T08:58:00+00:00");
    expect(item!.actor).toBe("zcode");
    expect(item!.body).toBe("финальный отчёт");
  });

  it("terminal transitions are marked; non-execution events are rejected", () => {
    const done = feedItemFromEvent(
      wireEvent({
        kind: "assignment.done",
        task_id: "TB-1",
        assignment: { id: "107", state: "done", claimed_by: "x", created_by: "owner" },
      }),
      RECEIVED,
      3,
    );
    expect(done!.terminal).toBe(true);
    expect(feedItemFromEvent(TASK_MOVED, RECEIVED, 4)).toBeNull();
  });
});

describe("pushFeedItem / sortFeed — cap and interleaving", () => {
  it("caps the buffer by evicting the OLDEST rows (no aggregation, §4.2)", () => {
    let items: ReturnType<typeof pushFeedItem> = [];
    for (let index = 0; index < FEED_CAP + 25; index += 1) {
      items = pushFeedItem(items, {
        id: `row-${index}`,
        seq: index + 1,
        kind: "assignment.created",
        ts: new Date(RECEIVED + index * 1000).toISOString(),
        taskId: `T-${index}`,
        assignmentId: String(index),
        actor: null,
        state: "queued",
        terminal: false,
        body: null,
      });
    }
    expect(items).toHaveLength(FEED_CAP);
    expect(items[0].id).toBe("row-25"); // the first 25 were evicted
    expect(items.some((item) => item.id === "row-0")).toBe(false);
  });

  it("interleaves assignments and reports by time, newest first", () => {
    const assignmentRow = feedItemFromEvent(CLAIMED, RECEIVED, 1)!;
    const reportRow = feedItemFromEvent(REPORT, RECEIVED, 2)!; // older wire ts
    const ordered = sortFeed([assignmentRow, reportRow]);
    expect(ordered.map((item) => item.kind)).toEqual([
      "assignment.claimed", // receipt 09:00 beats the report's 08:58
      "report",
    ]);
  });

  it("breaks equal-ts ties by the NUMERIC seq — never string ids (P3-8)", () => {
    const at = "2026-09-19T09:00:00+00:00";
    const row = (seq: number) => ({
      id: `assignment.created-9-${seq}`,
      seq,
      kind: "assignment.created" as const,
      ts: at,
      taskId: "TB-1",
      assignmentId: "9",
      actor: null,
      state: "queued",
      terminal: false,
      body: null,
    });
    // Same ts, seq 9 vs 10: numeric order must hold ("10" < "9" as strings).
    expect(sortFeed([row(9), row(10)]).map((item) => item.seq)).toEqual([10, 9]);
  });
});

describe("the singleton store — bridge writes and stream mirror", () => {
  it("pushExecutionEvent feeds the buffer; setFeedStreamState mirrors the socket", () => {
    resetFeedStore();
    pushExecutionEvent(CLAIMED, RECEIVED);
    pushExecutionEvent(REPORT, RECEIVED + 1000);
    const snapshot = readFeed();
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.lastDataAt).toBe(RECEIVED + 1000);

    setFeedStreamState("open", RECEIVED + 2000);
    expect(readFeed().streamState).toBe("open");

    resetFeedStore();
    expect(readFeed().items).toHaveLength(0);
    expect(readFeed().streamState).toBe("none");
  });
});
