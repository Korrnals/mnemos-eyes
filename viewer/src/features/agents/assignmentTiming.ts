import type { AssignmentItem } from "@/gateway/boardTypes";
import {
  CLAIM_NO_START_AFTER_S,
  HEARTBEAT_REAP_AFTER_S,
  PULSE_STALE_AFTER_S,
  QUEUED_REAP_AFTER_S,
  REAP_URGENT_WITHIN_S,
} from "./reaperThresholds";

/**
 * Amber/countdown timing of one assignment row (spec §3.1 + §2.1, AGW-3
 * review P1-1/P2-1 semantics):
 * - AMBER ONLY ON A REAL BREACH (§2.1: «зелёный только по свежему факту,
 *   amber только при реальном пропуске») — preventive countdowns stay
 *   NEUTRAL text until the threshold is actually crossed;
 * - claimed: the claim STAMP is the anchor — no stamp, no arithmetic
 *   (the server never reaps an unstamped claim; honest «без метки»);
 * - queued NEVER expires (store.py — notification-only at 30 min): no
 *   countdown, no amber; nearing the boundary shows a NEUTRAL hint in the
 *   server's terms («без исполнителя — poller не забирает, уведомление»);
 * - terminal rows carry no timing — the finish stamp is the fact.
 */
export interface RowTiming {
  /** Seconds since the state's anchor (claimed_at / heartbeat / created_at). */
  readonly ageS: number | null;
  /** Seconds until the reaper boundary (null when not applicable/shown). */
  readonly countdownS: number | null;
  /** Amber: threshold breached (no-start / stale pulse) — spec §3.1. */
  readonly warning: boolean;
  /** Queued nearing the notify-only boundary (neutral hint, NOT amber). */
  readonly queuedHint: boolean;
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
    // P3-3: no claim stamp — no arithmetic (the server never reaps these).
    const ageS = ageSeconds(row.claimed_at, now);
    if (ageS === null) {
      return { ageS: null, countdownS: null, warning: false, queuedHint: false };
    }
    return {
      ageS,
      countdownS: CLAIM_NO_START_AFTER_S - ageS,
      // P2-1: breach-only amber — >10 min WITHOUT a start; the preventive
      // countdown stays neutral until the boundary is crossed.
      warning: ageS > CLAIM_NO_START_AFTER_S,
      queuedHint: false,
    };
  }
  if (row.state === "running") {
    const ageS = ageSeconds(row.heartbeat_at ?? row.started_at ?? row.claimed_at, now);
    if (ageS === null) {
      return { ageS: null, countdownS: null, warning: false, queuedHint: false };
    }
    const countdownS = HEARTBEAT_REAP_AFTER_S - ageS;
    return {
      ageS,
      countdownS,
      // A stale pulse (>2 мин) is a real miss — amber; the near-reaper
      // window alone is NOT (the pulse is still fresh; §2.1 honesty).
      warning: ageS > PULSE_STALE_AFTER_S,
      queuedHint: false,
    };
  }
  if (row.state === "queued") {
    const ageS = ageSeconds(row.created_at, now);
    if (ageS === null) {
      return { ageS: null, countdownS: null, warning: false, queuedHint: false };
    }
    // P1-1: the 30-min boundary is NOTIFICATION-ONLY — the row never
    // expires, so there is no countdown to show and no amber to raise.
    // Nearing it, a NEUTRAL hint spells the server's truth out.
    const secondsToNotify = QUEUED_REAP_AFTER_S - ageS;
    return {
      ageS,
      countdownS: null,
      warning: false,
      queuedHint: secondsToNotify <= REAP_URGENT_WITHIN_S,
    };
  }
  return { ageS: null, countdownS: null, warning: false, queuedHint: false };
}

/** Mono line parts for the row's right side (age + optional countdown). */
export function timingCountdownMinutes(timing: RowTiming): number | null {
  if (timing.countdownS === null) return null;
  return Math.max(0, Math.ceil(timing.countdownS / 60));
}

/** Minutes left to the queued NOTIFY boundary (the hint's ~N), 0 past it. */
export function queuedHintMinutes(row: AssignmentItem, now: number): number {
  const ageS = ageSeconds(row.created_at, now) ?? QUEUED_REAP_AFTER_S;
  return Math.max(0, Math.ceil((QUEUED_REAP_AFTER_S - ageS) / 60));
}
