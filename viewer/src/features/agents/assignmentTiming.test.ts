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
 * Honest timing semantics (AGW-3 review P1-1/P2-1/P3-3): amber ONLY on a
 * real breach; the queued 30-min boundary is NOTIFICATION-ONLY (the row
 * never expires — store.py "state stays queued"); an unstamped claim gets
 * no arithmetic at all. The server-mirror constants are pinned so a drift
 * against store.py cannot slip by unnoticed.
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

describe("assignmentRowTiming — claimed (P2-1: breach-only amber)", () => {
  it("mid-life: neutral, the countdown stays as NEUTRAL text", () => {
    const fresh = assignmentRowTiming(
      assignment({ state: "claimed", claimed_at: ago(200) }),
      NOW,
    );
    expect(fresh.warning).toBe(false);
    expect(fresh.countdownS).toBe(400);
    expect(fresh.queuedHint).toBe(false);
  });

  it("the near-reaper window (5 min to go) is STILL neutral — no preventive amber", () => {
    const urgent = assignmentRowTiming(
      assignment({ state: "claimed", claimed_at: ago(CLAIM_NO_START_AFTER_S - 60) }),
      NOW,
    );
    expect(urgent.warning).toBe(false); // P2-1: only the breach ambers
    expect(urgent.countdownS).toBe(60);
  });

  it("BREACH: >10 min without a start — amber + overdue countdown", () => {
    const breached = assignmentRowTiming(
      assignment({ state: "claimed", claimed_at: ago(CLAIM_NO_START_AFTER_S + 1) }),
      NOW,
    );
    expect(breached.warning).toBe(true);
    expect(breached.countdownS).toBe(-1); // «истёк — ждёт жнеца» copy branch
  });

  it("NO claim stamp → no arithmetic at all (P3-3: the server never reaps these)", () => {
    const unstamped = assignmentRowTiming(
      assignment({ state: "claimed", claimed_at: null, created_at: ago(9999) }),
      NOW,
    );
    expect(unstamped).toEqual({
      ageS: null,
      countdownS: null,
      warning: false,
      queuedHint: false,
    });
  });
});

describe("assignmentRowTiming — running (pulse)", () => {
  it("neutral pulse under 2 min, amber beyond; countdown to the reaper", () => {
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
});

describe("assignmentRowTiming — queued (P1-1: notify-only, never expires)", () => {
  it("young queue: plain age, no countdown, no hint, no amber", () => {
    const calm = assignmentRowTiming(
      assignment({ state: "queued", created_at: ago(60) }),
      NOW,
    );
    expect(calm).toEqual({ ageS: 60, countdownS: null, warning: false, queuedHint: false });
  });

  it("nearing 30 min: the NEUTRAL notify hint appears — NO countdown, NO amber", () => {
    const near = assignmentRowTiming(
      assignment({ state: "queued", created_at: ago(QUEUED_REAP_AFTER_S - 240) }),
      NOW,
    );
    expect(near.warning).toBe(false);
    expect(near.countdownS).toBeNull(); // there is nothing to expire
    expect(near.queuedHint).toBe(true);
  });

  it("PAST the 30-min boundary: STILL no amber — the row waits, it does not die", () => {
    const past = assignmentRowTiming(
      assignment({ state: "queued", created_at: ago(QUEUED_REAP_AFTER_S + 3600) }),
      NOW,
    );
    expect(past.warning).toBe(false);
    expect(past.countdownS).toBeNull();
    expect(past.queuedHint).toBe(true); // the hint stays honest forever
  });
});

describe("assignmentRowTiming — terminal", () => {
  it("terminal rows carry no timing (the finish stamp is the fact)", () => {
    for (const state of ["done", "failed", "cancelled", "expired"] as const) {
      const timing = assignmentRowTiming(
        assignment({ state, finished_at: ago(60) }),
        NOW,
      );
      expect(timing).toEqual({
        ageS: null,
        countdownS: null,
        warning: false,
        queuedHint: false,
      });
    }
  });
});