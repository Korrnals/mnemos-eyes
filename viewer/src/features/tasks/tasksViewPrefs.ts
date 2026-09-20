/**
 * Task-domain view preference (Ф3 kanban, CV-4): which of the two `/tasks`
 * projections the owner treats as their landing view — the kanban board
 * (`/tasks`, view №1 per the design concept §2) or the dense list
 * (`/tasks/list`). The choice persists under "vesmaro.tasksView" (same
 * `vesmaro.*` namespace as lang/density/taskGroups) and the `/tasks` index
 * route honours it on entry: a stored "list" replace-redirects to
 * `/tasks/list` so the sidebar «Задачи» always lands in the preferred
 * projection. Pure + guarded-storage helpers, exactly like
 * taskGrouping.ts — the node test environment (no DOM) works.
 */

export type TaskView = "kanban" | "list";

/** localStorage key for the preferred task view (concept §2.3 persistence). */
export const TASK_VIEW_STORAGE_KEY = "vesmaro.tasksView";

/** The view №1 of the domain (design concept §2) — also the stored default. */
export const DEFAULT_TASK_VIEW: TaskView = "kanban";

export function isTaskView(value: unknown): value is TaskView {
  return value === "kanban" || value === "list";
}

/** Guarded localStorage handle — undefined outside a browser/test stub. */
function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined; // private mode / disabled storage
  }
}

/** Read the persisted view; corrupt data falls back to the kanban default. */
export function loadTaskView(storage: Storage | undefined = safeStorage()): TaskView {
  if (!storage) return DEFAULT_TASK_VIEW;
  try {
    const stored = storage.getItem(TASK_VIEW_STORAGE_KEY);
    return isTaskView(stored) ? stored : DEFAULT_TASK_VIEW;
  } catch {
    return DEFAULT_TASK_VIEW;
  }
}

/** Persist the view choice; storage failures are non-fatal. */
export function saveTaskView(
  view: TaskView,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(TASK_VIEW_STORAGE_KEY, view);
  } catch {
    // Swallow: the navigation still happens, only the default is lost.
  }
}
