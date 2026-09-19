import type { BadgeProps } from "@/components/ui/badge";
import type { TranslationKey } from "@/i18n";
import type { BoardTask } from "@/gateway/boardTypes";

/**
 * Task dictionary helpers (Ф2). The wire dictionaries live on the server
 * (server/store.py: COLUMNS / TASK_STATUSES / TASK_PRIORITIES / REPORT_KINDS);
 * these mirrors map them onto UI vocabulary — labels, badge variants, sort
 * weights. Unknown wire values never crash: they fall through to the
 * "unknown" label with the neutral badge.
 */

/** Kanban columns in display order (wire: store.COLUMNS). */
export const TASK_COLUMNS = [
  "open",
  "in-progress",
  "blocked",
  "resolved",
  "done",
] as const;

/** Workflow statuses — columns + the terminal `withdrawn` (no column). */
export const TASK_STATUSES = [...TASK_COLUMNS, "withdrawn"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Priority dictionary (wire: store.TASK_PRIORITIES). */
export const TASK_PRIORITIES = ["critical", "high", "normal", "low"] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

/** Report kinds (wire: store.REPORT_KINDS). */
export const REPORT_KINDS = ["intermediate", "final"] as const;

export type ReportKind = (typeof REPORT_KINDS)[number];

export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export function isTaskPriority(value: string): value is TaskPriority {
  return (TASK_PRIORITIES as readonly string[]).includes(value);
}

/** Status label key (ru.ts is the key source of truth). */
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
