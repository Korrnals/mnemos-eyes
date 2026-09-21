import { describe, expect, it } from "vitest";
import type { AssignmentItem } from "@/gateway/boardTypes";
import { assignmentRowTiming } from "./assignmentTiming";
import {
  CLAIM_NO_START_AFTER_S,
  HEARTBEAT_REAP_AFTER_S,
  PULSE_STALE_AFTER_S,
  QUEUED_REAP_AFTER_S,
} from "./reaperThresholds";

/**
 * Amber/countdown boundary arithmetic (spec §3.1) against the server-mirror
 * thresholds — the constants themselves are pinned here so a silent change
 * to reaperThresholds.ts cannot drift unnoticed against store.py.
 */

const NOW = Date.parse("2026-09-19T09:00:00+00:00");
const ago = (seconds: number): string => new Date(NOW - seconds * 1000).toISOString();

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
    created_at: ago(0),
    claimed_at: null,
    started_at: null,
    heartbeat_at: null,
    finished_at: null,
    topics: [],
    routing: null,
    ...overrides,
  };
}

describe("reaperThresholds — the server mirror (store.py)", () => {
  it("pins the constants: 600 / 1800 / 1800 / 120", () => {
    expect(CLAIM_NO_START_AFTER_S).toBe(600);
    expect(HEARTBEAT_REAP_AFTER_S).toBe(1800);
    expect(QUEUED_REAP_AFTER_S).toBe(1800);
    expect(PULSE_STALE_AFTER_S).toBe(120);
  });
});

describe("assignmentRowTiming — claimed (no start)", () => {
  it("neutral mid-life, amber in the near-reaper window, amber after the breach", () => {
    // 200 s in: 400 s to the reaper — comfortably neutral.
    const fresh = assignmentRowTiming(
      assignment({ state: "claimed", claimed_at: ago(200) }),
      NOW,
    );
    expect(fresh.warning).toBe(false);
    expect(fresh.countdownS).toBe(400);

    // 301 s in: 299 s left — inside the urgent window («приближение»).
    const urgent = assignmentRowTiming(
      assignment({ state: "claimed", claimed_at: ago(CLAIM_NO_START_AFTER_S - 299) }),
      NOW,
    );
    expect(urgent.warning).toBe(true);

    // Breached: >10 min without a start — amber + overdue countdown.
    const breached = assignmentRowTiming(
      assignment({ state: "claimed", claimed_at: ago(CLAIM_NO_START_AFTER_S + 1) }),
      NOW,
    );
    expect(breached.warning).toBe(true);
    expect(breached.countdownS).toBe(-1); // «истёк — ждёт жнеца» copy branch
  });
});

describe("assignmentRowTiming — running (pulse)", () => {
  it("neutral pulse under 2 min, amber beyond; countdown to the 30-min reaper", () => {
    const fresh = assignmentRowTiming(
      assignment({ state: "running", heartbeat_at: ago(PULSE_STALE_AFTER_S - 1) }),
      NOW,
    );
    expect(fresh.warning).toBe(false);
    expect(fresh.countdownS).toBe(HEARTBEAT_REAP_AFTER_S - (PULSE_STALE_AFTER_S - 1));

    const stale = assignmentRowTiming(
      assignment({ state: "running", heartbeat_at: ago(PULSE_STALE_AFTER_S + 1) }),
      NOW,
    );
    expect(stale.warning).toBe(true);
  });

  it("the near-reaper window is amber even with a fresh pulse", () => {
    // Pulse 25 min old: not stale by the 2-min rule, but only 5 min to the
    // reaper — «приближение к жнецу» turns the countdown urgent (spec §3.1).
    const near = assignmentRowTiming(
      assignment({ state: "running", heartbeat_at: ago(1500) }),
      NOW,
    );
    expect(near.warning).toBe(true);
    expect(near.countdownS).toBe(300);
  });
});

describe("assignmentRowTiming — queued and terminal", () => {
  it("queued stays neutral; the countdown appears only near the 30-min reaper", () => {
    const calm = assignmentRowTiming(assignment({ state: "queued" }), NOW + 60_000);
    expect(calm.warning).toBe(false);
    expect(calm.countdownS).toBeNull(); // hidden — nothing urgent

    const near = assignmentRowTiming(
      assignment({ state: "queued", created_at: ago(QUEUED_REAP_AFTER_S - 240) }),
      NOW,
    );
    expect(near.warning).toBe(true);
    expect(near.countdownS).toBe(240);
  });

  it("terminal rows carry no timing (the finish stamp is the fact)", () => {
    for (const state of ["done", "failed", "cancelled", "expired"] as const) {
      const timing = assignmentRowTiming(
        assignment({ state, finished_at: ago(60) }),
        NOW,
      );
      expect(timing).toEqual({ ageS: null, countdownS: null, warning: false });
    }
  });
});
