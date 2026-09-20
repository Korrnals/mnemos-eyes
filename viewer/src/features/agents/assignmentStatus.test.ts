import { describe, expect, it } from "vitest";
import type { AssignmentItem } from "@/gateway/boardTypes";
import {
  ACTIVE_ASSIGNMENT_STATES,
  activeAssignmentOf,
  ageAnchorOf,
  ageLabelKey,
  assignmentStateStyle,
  formatAge,
  routingReasonKey,
  taskAcceptsAssignments,
} from "./assignmentStatus";

/**
 * Pure presentation rules of the assignment lifecycle (spec §3.1): the
 * 7-state matrix (each state = colour variant + TEXT + shape, WCAG 1.4.1),
 * age anchors, the compact mono age, and the active/accepts gates.
 */

function assignment(overrides: Partial<AssignmentItem>): AssignmentItem {
  return {
    id: 1,
    task_id: "TB-1",
    specialist: "x",
    harness: "zcode",
    state: "queued",
    created_by: "owner",
    claimed_by: null,
    note: "",
    spec_hash: "",
    executor_id: "",
    claimed_by_executor: "",
    created_at: "2026-09-19T08:00:00+00:00",
    claimed_at: null,
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    topics: [],
    routing: null,
    ...overrides,
  };
}

const NOW = Date.parse("2026-09-19T09:00:00+00:00");

describe("7-state matrix (spec §3.1)", () => {
  const CASES = [
    { state: "queued", variant: "outline", shape: "hollow" },
    { state: "claimed", variant: "iris", shape: "filled" },
    { state: "running", variant: "iris", shape: "pulse" },
    { state: "done", variant: "success", shape: "square" },
    { state: "failed", variant: "error", shape: "square" },
    { state: "cancelled", variant: "default", shape: "square" },
    { state: "expired", variant: "warning", shape: "square" },
  ] as const;

  it("every state maps to a DISTINCT label key (text never colour-alone)", () => {
    const labels = new Set(CASES.map((c) => assignmentStateStyle(c.state).labelKey));
    expect(labels.size).toBe(7);
  });

  it.each(CASES)("state $state → variant $variant, shape $shape", ({ state, variant, shape }) => {
    const style = assignmentStateStyle(state);
    expect(style.variant).toBe(variant);
    expect(style.shape).toBe(shape);
  });
});

describe("active/accepts gates", () => {
  it("the ≤1 invariant picks the single active row of a task", () => {
    const items = [
      assignment({ id: 1, state: "done" }),
      assignment({ id: 2, state: "queued" }),
      assignment({ id: 3, state: "cancelled", task_id: "OTHER" }),
    ];
    expect(activeAssignmentOf(items, "TB-1")?.id).toBe(2);
    expect(activeAssignmentOf(items, "NOPE")).toBeUndefined();
    expect(ACTIVE_ASSIGNMENT_STATES).toEqual(["queued", "claimed", "running"]);
  });

  it("terminal lanes take no new assignments, everything else does", () => {
    expect(taskAcceptsAssignments({ archived: 0, col: "done" })).toBe(false);
    expect(taskAcceptsAssignments({ archived: 0, col: "resolved" })).toBe(false);
    expect(taskAcceptsAssignments({ archived: 1, col: "open" })).toBe(false);
    expect(taskAcceptsAssignments({ archived: 0, col: "open" })).toBe(true);
    expect(taskAcceptsAssignments({ archived: 0, col: "blocked" })).toBe(true);
    expect(taskAcceptsAssignments({ archived: 0, col: "validating" })).toBe(true);
  });
});

describe("ages", () => {
  it("age anchor per state: created → claimed → last pulse", () => {
    const stamps = {
      created_at: "2026-09-19T06:00:00+00:00",
      claimed_at: "2026-09-19T07:00:00+00:00",
      started_at: "2026-09-19T08:00:00+00:00",
      heartbeat_at: "2026-09-19T08:59:00+00:00",
      finished_at: "2026-09-19T08:55:00+00:00",
    };
    expect(ageAnchorOf(assignment({ state: "queued", ...stamps }))).toBe(stamps.created_at);
    expect(ageAnchorOf(assignment({ state: "claimed", ...stamps }))).toBe(stamps.claimed_at);
    // The pulse wins over the start stamp; claimed_at is the last fallback.
    expect(ageAnchorOf(assignment({ state: "running", ...stamps }))).toBe(stamps.heartbeat_at);
    expect(
      ageAnchorOf(assignment({ state: "running", ...stamps, heartbeat_at: null })),
    ).toBe(stamps.started_at);
    expect(ageAnchorOf(assignment({ state: "done", ...stamps }))).toBeNull();
    expect(ageLabelKey("queued")).toBe("agents.age.queued");
    expect(ageLabelKey("claimed")).toBe("agents.age.claimed");
    expect(ageLabelKey("running")).toBe("agents.age.running");
    expect(ageLabelKey("expired")).toBe("agents.age.terminal");
  });

  it("compact mono age: minutes, h:mm, days; honest null on garbage", () => {
    expect(formatAge("2026-09-19T08:55:00+00:00", NOW)).toEqual({
      display: "5",
      unitKey: "agents.age.unitMinutes",
    });
    expect(formatAge("2026-09-19T07:15:00+00:00", NOW)).toEqual({
      display: "1:45",
      unitKey: "agents.age.unitHours",
    });
    expect(formatAge("2026-09-19T07:00:00+00:00", NOW)).toEqual({
      display: "2",
      unitKey: "agents.age.unitHours",
    });
    expect(formatAge("2026-09-17T09:00:00+00:00", NOW)).toEqual({
      display: "2",
      unitKey: "agents.age.unitDays",
    });
    expect(formatAge("not-a-date", NOW)).toBeNull();
    expect(formatAge("2026-09-19T10:00:00+00:00", NOW)).toBeNull(); // future
  });
});

describe("routing reason keys", () => {
  it("every server reason maps to its label key; garbage falls to unmatched", () => {
    expect(routingReasonKey("explicit")).toBe("agents.routing.reason.explicit");
    expect(routingReasonKey("task-specialists")).toBe("agents.routing.reason.taskSpecialists");
    expect(routingReasonKey("global-default")).toBe("agents.routing.reason.globalDefault");
    expect(routingReasonKey("nonsense")).toBe("agents.routing.reason.unmatched");
  });
});
