import type { BoardTask } from "@/gateway/boardTypes";
import { priorityWeight } from "./taskStatus";

/**
 * Project grouping for the task list (ARCHCOM-3 verdict §3 + concept §2.3:
 * groups-accordion by project, collapse state persistent). Pure helpers +
 * a guarded localStorage pair so the node test environment (no DOM) works.
 */

/** localStorage key for the collapsed-project set (concept §2.3 persistence). */
export const TASK_GROUPS_STORAGE_KEY = "vesmaro.taskGroups";

export interface TaskGroup {
  /** Project slug; "" rows land under the "no project" bucket. */
  project: string;
  tasks: BoardTask[];
}

/** Group tasks by project; groups sorted by name, "" last. */
export function groupTasksByProject(tasks: readonly BoardTask[]): TaskGroup[] {
  const buckets = new Map<string, BoardTask[]>();
  for (const task of tasks) {
    const key = task.project ?? "";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(task);
    else buckets.set(key, [task]);
  }
  return [...buckets.entries()]
    .map(([project, groupTasks]) => ({ project, tasks: groupTasks }))
    .sort((a, b) => {
      // The "no project" bucket always sorts last.
      if (a.project === "") return 1;
      if (b.project === "") return -1;
      return a.project.localeCompare(b.project);
    });
}

/**
 * In-group order: priority weight desc, then board position asc, then id —
 * the instruction's "priority → position" with a deterministic tiebreak.
 */
export function sortGroupTasks(tasks: readonly BoardTask[]): BoardTask[] {
  return [...tasks].sort(
    (a, b) =>
      priorityWeight(b.priority) - priorityWeight(a.priority) ||
      a.position - b.position ||
      a.id.localeCompare(b.id),
  );
}

// --- collapsed-set persistence (guarded storage, i18n-free) --------------------

/** Guarded localStorage handle — undefined outside a browser/test stub. */
function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined; // private mode / disabled storage
  }
}

/** Read the persisted collapsed-project set; corrupt data resets silently. */
export function loadCollapsedGroups(storage: Storage | undefined = safeStorage()): Set<string> {
  if (!storage) return new Set();
  try {
    const raw = storage.getItem(TASK_GROUPS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((name): name is string => typeof name === "string"));
  } catch {
    return new Set();
  }
}

/** Persist the collapsed-project set; storage failures are non-fatal. */
export function saveCollapsedGroups(
  collapsed: ReadonlySet<string>,
  storage: Storage | undefined = safeStorage(),
): void {
  try {
    storage?.setItem(TASK_GROUPS_STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Swallow: the in-memory collapse state still works this session.
  }
}
