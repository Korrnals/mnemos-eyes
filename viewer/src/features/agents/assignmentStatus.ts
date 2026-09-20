import type { TranslationKey } from "@/i18n";
import type { AssignmentItem, AssignmentLifecycleState } from "@/gateway/boardTypes";

/**
 * Pure presentation rules of the assignment lifecycle (spec §3.1): every
 * state is colour + TEXT + shape (WCAG 1.4.1 — never colour alone), ages
 * render mono, terminal states keep the muted tint treatment. No React here
 * — the badge component and the execution tab consume these mappings, tests
 * drive them directly.
 */

/** ADR 0009 states that hold the ≤1-active invariant. */
export const ACTIVE_ASSIGNMENT_STATES: readonly AssignmentLifecycleState[] = [
  "queued",
  "claimed",
  "running",
];

/** The active row of a task's assignment list, if any (≤1 invariant). */
export function activeAssignmentOf(
  items: readonly AssignmentItem[],
  taskId: string,
): AssignmentItem | undefined {
  return items.find(
    (row) => row.task_id === taskId && ACTIVE_ASSIGNMENT_STATES.includes(row.state),
  );
}

/** Visual treatment per state — variant is the Badge variant name. */
export interface AssignmentStateStyle {
  /** Badge variant (tinted chips pass AA per the T7 audit). */
  readonly variant: "outline" | "iris" | "success" | "error" | "warning" | "default";
  /** Shape marker (WCAG 1.4.1): hollow / filled / pulse dot, square = terminal. */
  readonly shape: "hollow" | "filled" | "pulse" | "square";
  readonly labelKey: TranslationKey;
}

const STATE_STYLES: Record<AssignmentLifecycleState, AssignmentStateStyle> = {
  queued: { variant: "outline", shape: "hollow", labelKey: "agents.state.queued" },
  claimed: { variant: "iris", shape: "filled", labelKey: "agents.state.claimed" },
  running: { variant: "iris", shape: "pulse", labelKey: "agents.state.running" },
  done: { variant: "success", shape: "square", labelKey: "agents.state.done" },
  failed: { variant: "error", shape: "square", labelKey: "agents.state.failed" },
  cancelled: { variant: "default", shape: "square", labelKey: "agents.state.cancelled" },
  expired: { variant: "warning", shape: "square", labelKey: "agents.state.expired" },
};

export function assignmentStateStyle(state: AssignmentLifecycleState): AssignmentStateStyle {
  return STATE_STYLES[state];
}

/** Short routing-reason label for row signatures (spec §2.3 honest preview). */
export function routingReasonKey(reason: string): TranslationKey {
  switch (reason) {
    case "explicit":
      return "agents.routing.reason.explicit";
    case "specialist":
      return "agents.routing.reason.specialist";
    case "task-specialists":
      return "agents.routing.reason.taskSpecialists";
    case "project-default":
      return "agents.routing.reason.projectDefault";
    case "global-default":
      return "agents.routing.reason.globalDefault";
    case "auto":
      return "agents.routing.reason.auto";
    default:
      return "agents.routing.reason.unmatched";
  }
}

/**
 * The timestamp one state's age line counts from (spec §3.1): queued ages
 * from creation, claimed from the claim, running from the LAST PULSE
 * (heartbeat, started as the fallback); terminal rows have no age line.
 */
export function ageAnchorOf(row: AssignmentItem): string | null {
  switch (row.state) {
    case "queued":
      return row.created_at || null;
    case "claimed":
      return row.claimed_at || row.created_at || null;
    case "running":
      return row.heartbeat_at || row.started_at || row.claimed_at || null;
    default:
      return null;
  }
}

/** Age-line copy key per state (the value formats via formatAge). */
export function ageLabelKey(state: AssignmentLifecycleState): TranslationKey {
  switch (state) {
    case "queued":
      return "agents.age.queued";
    case "claimed":
      return "agents.age.claimed";
    case "running":
      return "agents.age.running";
    default:
      return "agents.age.terminal";
  }
}

/** Structured age: the mono value plus its i18n unit word key. */
export interface AssignmentAge {
  /** Mono value: `4` (minutes) / `1:05` (h:mm) / `3` (days). */
  readonly display: string;
  readonly unitKey: TranslationKey;
}

/**
 * Compact mono age. `now` is injected: components feed the shared 1 Hz
 * ticker, tests a fixed epoch. null for unparsable/stamps in the future.
 */
export function formatAge(stamp: string, now: number): AssignmentAge | null {
  const at = Date.parse(stamp);
  if (!Number.isFinite(at) || now < at) return null;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 60) return { display: String(minutes), unitKey: "agents.age.unitMinutes" };
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) {
    return {
      display:
        restMinutes > 0 ? `${hours}:${String(restMinutes).padStart(2, "0")}` : String(hours),
      unitKey: "agents.age.unitHours",
    };
  }
  return { display: String(Math.floor(hours / 24)), unitKey: "agents.age.unitDays" };
}

/** Whether a task row accepts a new assignment (matrix A idle gate). */
export function taskAcceptsAssignments(task: {
  archived: number;
  col: string;
}): boolean {
  // WF-1 terminal lanes never take new attempts; everything else does
  // (blocked/waiting included — an attempt is how the block lifts).
  return task.archived !== 1 && task.col !== "done" && task.col !== "resolved";
}
