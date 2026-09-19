import type { BoardTask } from "@/gateway/boardTypes";
import { isTaskPriority, isTaskStatus } from "./taskStatus";

/**
 * URL-param contract for `/tasks` (QA verdict §3: list state lives in the
 * URL — deep links + F5 reproduce the exact view). `?status=&priority=
 * &project=&agent=&q=`; unknown dictionary values are dropped (the same
 * honesty as listParams.ts for /memory). Pure parse/serialize/filter helpers
 * shared by the filter controls and the list page.
 */

export interface TaskListUrlState {
  status?: TaskListStatus;
  priority?: string;
  project?: string;
  agent?: string;
  q?: string;
}

type TaskListStatus = string;

export function parseTaskListParams(params: URLSearchParams): TaskListUrlState {
  const status = params.get("status") ?? undefined;
  const priority = params.get("priority") ?? undefined;
  return {
    status: status && isTaskStatus(status) ? status : undefined,
    priority: priority && isTaskPriority(priority) ? priority : undefined,
    project: nonEmpty(params.get("project") ?? undefined),
    agent: nonEmpty(params.get("agent") ?? undefined),
    q: nonEmpty(params.get("q") ?? undefined),
  };
}

/** Serialize back into params, omitting empty values (clean URLs). */
export function serializeTaskListParams(state: TaskListUrlState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.status) params.set("status", state.status);
  if (state.priority) params.set("priority", state.priority);
  if (state.project) params.set("project", state.project);
  if (state.agent) params.set("agent", state.agent);
  if (state.q) params.set("q", state.q);
  return params;
}

/** True when any filter narrows the list (drives the empty-state copy). */
export function hasActiveTaskFilters(state: TaskListUrlState): boolean {
  return Boolean(state.status || state.priority || state.project || state.agent || state.q);
}

/**
 * Client-side filter over the board projection. The board wire is small (a
 * few dozen rows), so ONE cached `tasks.board` fetch is filtered locally —
 * no per-filter refetch, no cache fragmentation (ARCHCOM-3 verdict §3).
 */
export function filterTasks(
  tasks: readonly BoardTask[],
  state: TaskListUrlState,
): BoardTask[] {
  const q = state.q?.toLowerCase();
  return tasks.filter((task) => {
    if (state.status && task.status !== state.status) return false;
    if (state.priority && task.priority !== state.priority) return false;
    if (state.project && task.project !== state.project) return false;
    if (state.agent && !(task.agents ?? []).includes(state.agent)) return false;
    if (q) {
      const haystack = `${task.id} ${task.title} ${task.summary}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

/** Distinct project names across tasks (filter dropdown options). */
export function projectOptions(tasks: readonly BoardTask[]): string[] {
  return [...new Set(tasks.map((task) => task.project).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/** Distinct agent slugs across tasks (filter dropdown options). */
export function agentOptions(tasks: readonly BoardTask[]): string[] {
  const agents = new Set<string>();
  for (const task of tasks) for (const agent of task.agents ?? []) agents.add(agent);
  return [...agents].sort((a, b) => a.localeCompare(b));
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}
