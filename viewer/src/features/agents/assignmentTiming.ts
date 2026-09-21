import type { AssignmentItem } from "@/gateway/boardTypes";
import {
  CLAIM_NO_START_AFTER_S,
  HEARTBEAT_REAP_AFTER_S,
  PULSE_STALE_AFTER_S,
  QUEUED_REAP_AFTER_S,
  REAP_URGENT_WITHIN_S,
} from "./reaperThresholds";

/**
 * Amber/countdown timing of one assignment row (spec §3.1 + §2.1, AGW-3):
 * the thresholds come from reaperThresholds.ts (the server mirror) — this
 * module only ARITHMETIZES them, so threshold boundary tests drive it pure.
 *
 * Honesty rules (§2.1): neutral until a real miss; amber only on an actual
 * threshold breach or a soon reaper; the countdown is a PREVENTIVE fact
 * («истечёт через ~M мин»), never an alarm without a basis. Terminal rows
 * carry no timing — their timestamp is the finish stamp.
 */
export interface RowTiming {
  /** Seconds since the state's anchor (claimed_at / heartbeat / created_at). */
  readonly ageS: number | null;
  /** Seconds until the reaper boundary (null when not applicable/shown). */
  readonly countdownS: number | null;
  /** Amber: threshold breached (no-start / stale pulse) — spec §3.1. */
  readonly warning: boolean;
}

function ageSeconds(stamp: string | null | undefined, now: number): number | null {
  if (!stamp) return null;
  const at = Date.parse(stamp);
  if (!Number.isFinite(at) || now < at) return null;
  return Math.floor((now - at) / 1000);
}

/** Timing view of one row; terminal states answer all-null. */
export function assignmentRowTiming(row: AssignmentItem, now: number): RowTiming {
  if (row.state === "claimed") {
    const ageS = ageSeconds(row.claimed_at ?? row.created_at, now);
    if (ageS === null) return { ageS: null, countdownS: null, warning: false };
    const countdownS = CLAIM_NO_START_AFTER_S - ageS;
    return {
      ageS,
      countdownS,
      // >10 мин без старта — amber (spec §3.1); a soon reaper counts too.
      warning: ageS > CLAIM_NO_START_AFTER_S || countdownS <= REAP_URGENT_WITHIN_S,
    };
  }
  if (row.state === "running") {
    const ageS = ageSeconds(row.heartbeat_at ?? row.started_at ?? row.claimed_at, now);
    if (ageS === null) return { ageS: null, countdownS: null, warning: false };
    const countdownS = HEARTBEAT_REAP_AFTER_S - ageS;
    return {
      ageS,
      countdownS,
      // Pulse older than 2 min — amber; the two-clock rule keeps executor
      // presence OUT of this signal (a running row may outlive its executor
      // chip's online state — both facts show independently).
      warning: ageS > PULSE_STALE_AFTER_S || countdownS <= REAP_URGENT_WITHIN_S,
    };
  }
  if (row.state === "queued") {
    const ageS = ageSeconds(row.created_at, now);
    if (ageS === null) return { ageS: null, countdownS: null, warning: false };
    const countdownS = QUEUED_REAP_AFTER_S - ageS;
    // Queued stays neutral (spec §3.1) — the countdown appears only when
    // the reaper is genuinely near («приближение к жнецу»).
    const near = countdownS <= REAP_URGENT_WITHIN_S;
    return { ageS, countdownS: near ? countdownS : null, warning: near };
  }
  return { ageS: null, countdownS: null, warning: false };
}

/** Mono line parts for the row's right side (age + optional countdown). */
export function timingCountdownMinutes(timing: RowTiming): number | null {
  if (timing.countdownS === null) return null;
  return Math.max(0, Math.ceil(timing.countdownS / 60));
}
