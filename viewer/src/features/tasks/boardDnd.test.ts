import { describe, expect, it } from "vitest";
import type { BoardTask } from "@/gateway/boardTypes";
import {
  buildOrderedColumns,
  columnDropId,
  computeKanbanMove,
  groupDropId,
} from "./boardDnd";

/**
 * Pure drag-geometry tests (CV-4 §3): every droppable flavour resolves to
 * the wire move intent the server expects — card (reorder before target),
 * collapsed group header (append to the END of the group), column root
 * (append), self-drop (no-op).
 */

function task(id: string, col: string, position: number, project = "p1"): BoardTask {
  return {
    id,
    col,
    position,
    title: id,
    summary: "",
    spec: "",
    agents: [],
    specialists: [],
    env: "local",
    project,
    memory_ids: [],
    mnemos_tags: [],
    created_at: "2026-09-19T00:00:00+00:00",
    updated_at: "2026-09-19T00:00:00+00:00",
    archived: 0,
    status: "open",
    priority: "normal",
    archived_from: "",
    validating_since: "",
  };
}

/** A 7-lane board with a mixed in-progress column (two project groups). */
function columnsFixture() {
  return buildOrderedColumns(
    ["backlog", "validating", "open", "in-progress", "blocked", "resolved", "done"],
    [
      task("B1", "backlog", 0),
      task("V1", "validating", 0),
      task("O1", "open", 0),
      task("O2", "open", 1),
      // in-progress: p1 group (I1, I2), p2 group (I3) — the reorder matrix.
      task("I1", "in-progress", 0, "p1"),
      task("I2", "in-progress", 1, "p1"),
      task("I3", "in-progress", 2, "p2"),
      task("K1", "blocked", 0),
      task("R1", "resolved", 0),
      task("D1", "done", 0),
    ],
  );
}

describe("buildOrderedColumns", () => {
  it("orders each column by position asc with an id tiebreak", () => {
    const columns = buildOrderedColumns(
      ["open"],
      [task("b", "open", 1), task("a", "open", 0), task("c", "open", 1)],
    );
    expect(columns.get("open")?.map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("ignores tasks whose col is not a wire column (archived leakage)", () => {
    const columns = buildOrderedColumns(
      ["open"],
      [task("a", "open", 0), task("x", "gone", 0)],
    );
    expect(columns.get("open")?.map((row) => row.id)).toEqual(["a"]);
    expect(columns.has("gone")).toBe(false);
  });
});

describe("computeKanbanMove", () => {
  const columns = columnsFixture();

  it("drop ON a card → position of that card in its column (reorder before)", () => {
    const intent = computeKanbanMove(
      task("I3", "in-progress", 2, "p2"),
      {
        id: "I1",
        data: { current: { type: "task", task: columns.get("in-progress")![0] } },
      },
      columns,
    );
    expect(intent).toEqual({ col: "in-progress", position: 0 });
  });

  it("cross-column drop on a card lands in THAT column at the target index", () => {
    const intent = computeKanbanMove(
      task("O1", "open", 0),
      {
        id: "I2",
        data: { current: { type: "task", task: columns.get("in-progress")![1] } },
      },
      columns,
    );
    // in-progress without O1: [I1, I2, I3]; before I2 → index 1.
    expect(intent).toEqual({ col: "in-progress", position: 1 });
  });

  it("drop on a COLLAPSED group header appends to the end of that group", () => {
    const intent = computeKanbanMove(
      task("O1", "open", 0),
      {
        id: groupDropId("in-progress", "p1"),
        data: { current: { type: "group", col: "in-progress", project: "p1" } },
      },
      columns,
    );
    // in-progress without O1: [I1(p1), I2(p1), I3(p2)] → after I2 = index 2.
    expect(intent).toEqual({ col: "in-progress", position: 2 });
  });

  it("group header of the LAST group appends after its last member, not the column", () => {
    const intent = computeKanbanMove(
      task("O1", "open", 0),
      {
        id: groupDropId("in-progress", "p2"),
        data: { current: { type: "group", col: "in-progress", project: "p2" } },
      },
      columns,
    );
    expect(intent).toEqual({ col: "in-progress", position: 3 });
  });

  it("column-root drop appends to the end of the column", () => {
    const intent = computeKanbanMove(
      task("K1", "blocked", 0),
      {
        id: columnDropId("resolved"),
        data: { current: { type: "column", col: "resolved" } },
      },
      columns,
    );
    expect(intent).toEqual({ col: "resolved", position: 1 });
  });

  it("self-drop and missing over are no-ops", () => {
    const active = columns.get("in-progress")![0];
    expect(
      computeKanbanMove(
        active,
        { id: active.id, data: { current: { type: "task", task: active } } },
        columns,
      ),
    ).toBeNull();
    expect(computeKanbanMove(active, null, columns)).toBeNull();
  });

  it("unknown droppable payload is a no-op (never a guessed move)", () => {
    const active = columns.get("open")![0];
    expect(
      computeKanbanMove(
        active,
        { id: "whatever", data: { current: { type: "mystery" } } },
        columns,
      ),
    ).toBeNull();
    expect(computeKanbanMove(active, { id: "whatever" }, columns)).toBeNull();
  });
});
