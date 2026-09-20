import type { BadgeProps } from "@/components/ui/badge";
import type { TranslationKey } from "@/i18n";
import type { BoardTask } from "@/gateway/boardTypes";

/**
 * Task dictionary helpers (Ф2). The wire dictionaries live on the server
 * (server/store.py: COLUMNS / TASK_STATUSES / TASK_PRIORITIES / REPORT_KINDS);
 * these mirrors map them onto UI vocabulary — labels, badge variants, sort
 * weights. Unknown wire values never crash: they fall through to the
 * "unknown" label with the neutral badge.
 *
 * WF-1 (server 1.9.0) splits the two dictionaries apart: the KANBAN has 7
 * columns (backlog/validating join left of `open`), while the WORKFLOW keeps
 * 5 statuses + the terminal `withdrawn` — pre-validation lanes read as
 * workflow `open` (store.COLUMN_STATUS_MAP). The viewer mirrors the split:
 * TASK_COLUMNS drives the board/move surfaces, TASK_STATUSES the status
 * filters and workflow badges.
 */

/** Kanban columns in display order (wire: store.COLUMNS, WF-1 §2). */
export const TASK_COLUMNS = [
  "backlog",
  "validating",
  "open",
  "in-progress",
  "blocked",
  "resolved",
  "done",
] as const;

export type TaskColumn = (typeof TASK_COLUMNS)[number];

/** Column → workflow status (wire mirror of store.COLUMN_STATUS_MAP). */
export const COLUMN_STATUS_MAP: Readonly<Record<TaskColumn, string>> = {
  backlog: "open",
  validating: "open",
  open: "open",
  "in-progress": "in-progress",
  blocked: "blocked",
  resolved: "resolved",
  done: "done",
};

/** Workflow statuses — the 5 column-aligned ones + terminal `withdrawn`. */
export const TASK_STATUSES = [
  "open",
  "in-progress",
  "blocked",
  "resolved",
  "done",
  "withdrawn",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Workflow statuses that have a kanban column (mini-stats order, Ф2 list). */
export const WORKFLOW_COLUMNS = [
  "open",
  "in-progress",
  "blocked",
  "resolved",
  "done",
] as const;

/** Priority dictionary (wire: store.TASK_PRIORITIES). */
export const TASK_PRIORITIES = ["critical", "high", "normal", "low"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Report kinds (wire: store.REPORT_KINDS). */
export const REPORT_KINDS = ["intermediate", "final"] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

export function isTaskColumn(value: string): value is TaskColumn {
  return (TASK_COLUMNS as readonly string[]).includes(value);
}

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskPriority(value: string): value is TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(value);
}

/** Column label key — the 7 kanban titles (ru.ts is the key source of truth). */
export function columnLabelKey(column: string): TranslationKey {
  return isTaskColumn(column)
    ? (`tasks.column.${column}` as const)
    : "tasks.status.unknown";
}

/** Status label key (workflow vocabulary — filters, list rows). */
export function statusLabelKey(status: string): TranslationKey {
  return isTaskStatus(status)
    ? (`tasks.status.${status}` as const)
    : "tasks.status.unknown";
}

/** Priority label key. */
export function priorityLabelKey(priority: string): TranslationKey {
  return isTaskPriority(priority)
    ? (`tasks.priority.${priority}` as const)
    : "tasks.priority.normal";
}

/** Badge variant per status (colour language: iris=flow, error=attention). */
export function statusBadgeVariant(status: string): BadgeProps["variant"] {
  switch (status) {
    case "in-progress":
      return "iris";
    case "blocked":
      return "error";
    case "resolved":
      return "success";
    case "done":
    case "withdrawn":
      return "outline";
    default:
      return "default";
  }
}

/** Badge variant per kanban column (WF-1: lanes left of `open` are quiet). */
export function columnBadgeVariant(column: string): BadgeProps["variant"] {
  switch (column) {
    case "validating":
      return "iris";
    case "in-progress":
      return "iris";
    case "blocked":
      return "error";
    case "resolved":
      return "success";
    case "backlog":
    case "done":
      return "outline";
    default:
      return "default";
  }
}

/** Badge variant per priority (critical is the loudest, low the quietest). */
export function priorityBadgeVariant(priority: string): BadgeProps["variant"] {
  switch (priority) {
    case "critical":
      return "error";
    case "high":
      return "confidence";
    case "low":
      return "outline";
    default:
      return "default";
  }
}

/** Sort weight: higher wins (critical first, low last; unknown = normal). */
export function priorityWeight(priority: string): number {
  switch (priority) {
    case "critical":
      return 3;
    case "high":
      return 2;
    case "low":
      return 0;
    default:
      return 1;
  }
}

/** Human event-kind title for history rows (`task.moved` → label key). */
export function historyEventLabelKey(title: string): TranslationKey {
  switch (title) {
    case "task.created":
      return "tasks.history.created";
    case "task.updated":
      return "tasks.history.updated";
    case "task.moved":
      return "tasks.history.moved";
    case "task.deleted":
      return "tasks.history.deleted";
    case "task.archived":
      return "tasks.history.archived";
    case "task.unarchived":
      return "tasks.history.unarchived";
    case "task.report":
      return "tasks.history.report";
    default:
      return "tasks.history.event";
  }
}

/**
 * Deterministic UTC date label (no timezone drift between environments).
 * Empty wire values render as an em dash.
 */
export function formatTaskDate(
  iso: string | null | undefined,
  lang: "ru" | "en",
): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(lang === "ru" ? "ru-RU" : "en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** Row-level view helper: agents label for chips ("—" when none). */
export function taskAgents(task: BoardTask): readonly string[] {
  return task.agents ?? [];
}

// --- WF-1 validation clock helpers (Ф3 kanban) -----------------------------------

/** The validation lane column id (WF-1 §2). */
export const VALIDATING_COLUMN = "validating" as const;

/** WF-1 sweep window: validating tasks older than this get archcom-flagged. */
export const VALIDATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The 24h-sweep flag tag the server stamps on stale validating tasks. */
export const ARCHCOM_REVIEW_TAG = "task:stage:archcom-review";

/** True when the task sits in the validation lane (the clock applies). */
export function isValidatingTask(task: BoardTask): boolean {
  return task.col === VALIDATING_COLUMN;
}

/** True when the task carries the WF-1 archcom-branch marker tag. */
export function isArchcomReviewTask(task: BoardTask): boolean {
  return (task.mnemos_tags ?? []).includes(ARCHCOM_REVIEW_TAG);
}

/**
 * Elapsed validation time in whole hours/minutes (WF-1 clock). Null when the
 * stamp is absent or unparsable — unknown is not zero, so no label renders.
 */
export function validationElapsed(
  since: string | null | undefined,
  now: number,
): { hours: number; minutes: number } | null {
  if (!since) return null;
  const start = Date.parse(since);
  if (Number.isNaN(start) || now < start) return null;
  const elapsed = now - start;
  return {
    hours: Math.floor(elapsed / 3_600_000),
    minutes: Math.floor((elapsed % 3_600_000) / 60_000),
  };
}

/** True when the task has been validating past the 24h WF-1 window. */
export function isValidationOverdue(
  since: string | null | undefined,
  now: number,
): boolean {
  if (!since) return false;
  const start = Date.parse(since);
  if (Number.isNaN(start)) return false;
  return now - start >= VALIDATION_WINDOW_MS;
}
