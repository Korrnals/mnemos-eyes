import { useMemo, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router";
// @dnd-kit (ARCHCOM-3 verdict §3, ratified): the kanban is the PRIMARY
// surface of the Задачи domain; core+sortable land ~14–18 KB gz together,
// over the 10 KB gz dependency budget — accepted in writing by the verdict
// (pointer + later-keyboard dragging with accessible semantics; no
// hand-rolled alternative covers both within budget).
import { DndContext, DragOverlay } from "@dnd-kit/core";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { TableRowSkeleton } from "@/components/skeletons/Skeletons";
import { useDensity } from "@/components/density-provider";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { isTaskMutationSource, isTaskSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { useUiToken } from "@/features/ui-token/UiTokenContext";
import { useT } from "@/i18n";
import { buildOrderedColumns } from "./boardDnd";
import { CreateTaskDialog } from "./CreateTaskDialog";
import { TaskBoardColumn } from "./TaskBoardColumn";
import { TaskBoardCardGhost } from "./TaskBoardCard";
import { TaskFilterSelect } from "./TaskFilterSelect";
import { TasksUnsupported } from "./TasksUnsupported";
import { TasksViewToggle } from "./TasksViewToggle";
import { loadCollapsedGroups, saveCollapsedGroups } from "./taskGrouping";
import {
  agentOptions,
  filterTasks,
  hasActiveTaskFilters,
  parseTaskListParams,
  projectOptions,
  serializeTaskListParams,
} from "./taskFilters";
import { useKanbanDnd } from "./useKanbanDnd";
import { useBoardTasks, useReportCounts } from "./useTasks";
import { useTaskMutations } from "./useTaskMutations";
import { loadTaskView } from "./tasksViewPrefs";

/**
 * `/tasks` — the KANBAN view of the domain, view №1 per the redesign concept
 * §2 (Ф3 / CV-4, ADR 0011): 7 WF-1 columns from the wire `board.columns`,
 * project-group accordions inside each column (persisted
 * "vesmaro.taskGroups", shared with the list), pointer DnD with an overlay
 * ghost + optimistic move. URL filters: ?project=&agent=&q= — the same
 * dialect as the list (deep links and the view switch carry them over);
 * `q` additionally highlights the match inside card titles.
 *
 * The SSE bridge lives in the domain layout (TasksLayout) and patches
 * `tasks.board` surgically — this page NEVER refetches on task events.
 */
export function TaskBoardPage() {
  const gateway = useGateway();
  const capable = isTaskSource(gateway);
  return capable ? <TaskBoardView /> : <TasksUnsupported />;
}

/** The board view — mounted only on task-capable gateways. */
function TaskBoardView() {
  const t = useT();
  const gateway = useGateway();
  const canMutate = isTaskMutationSource(gateway);
  const { tokenPresent } = useUiToken();
  const { density } = useDensity();
  const board = useBoardTasks();
  const [searchParams, setSearchParams] = useSearchParams();
  const state = parseTaskListParams(searchParams);
  const [collapsed, setCollapsed] = useState(() => loadCollapsedGroups());
  const [createOpen, setCreateOpen] = useState(false);
  const mutations = useTaskMutations();

  // Owner decision (CV-4 §3, the simpler honest variant): without a ui token
  // cards do not drag at all — cursor default, tooltip «войдите для
  // управления». The keyboard move (⋯ → «Переместить…») still leads to the
  // login window through the standard token gate (runAuthorized).
  const canDrag = canMutate && tokenPresent;

  const tasks = useMemo(() => board.data?.tasks ?? [], [board.data]);
  const taskIds = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const reportCounts = useReportCounts(taskIds);
  const reducedMotion = useReducedMotion();

  // Hook-order discipline: every hook below runs on EVERY render (the
  // pending/error early-returns come after), so the DnD wiring stays mounted
  // across fetch-state transitions — a drag started against stale-but-live
  // data never loses its sensor mid-flight.
  const filteredTasks = useMemo(() => filterTasks(tasks, state), [tasks, state]);
  const columns = useMemo(
    () => buildOrderedColumns(board.data?.columns ?? [], filteredTasks),
    [board.data, filteredTasks],
  );
  const dnd = useKanbanDnd({
    columns,
    canDrag,
    move: (task, col, position) => mutations.moveTaskOptimistic(task, col, position),
  });

  const patch = (changes: Partial<typeof state>) => {
    setSearchParams(serializeTaskListParams({ ...state, ...changes }), {
      replace: false,
    });
  };

  const toggleGroup = (project: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(project)) next.delete(project);
      else next.add(project);
      saveCollapsedGroups(next);
      return next;
    });
  };

  const header = (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 id="tasks-title" className="text-xl font-semibold">
            {t("tasks.title")}
          </h1>
          <TasksViewToggle />
        </div>
        {canMutate ? (
          <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden="true" />
            {t("tasks.create.label")}
          </Button>
        ) : null}
      </div>
      {canMutate ? (
        <CreateTaskDialog open={createOpen} onOpenChange={setCreateOpen} />
      ) : null}
    </>
  );

  if (board.isPending) {
    return (
      <section aria-labelledby="tasks-title" className="space-y-4">
        {header}
        <div role="status" aria-label={t("tasks.loading")}>
          <TableRowSkeleton rows={6} columns={6} />
        </div>
      </section>
    );
  }

  if (board.isError) {
    return (
      <section aria-labelledby="tasks-title" className="space-y-4">
        {header}
        <EmptyState
          variant="error"
          title={t("tasks.loadFailed")}
          message={board.error.message}
          action={
            <Button variant="outline" onClick={() => void board.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      </section>
    );
  }

  const wholeBoardCounts = board.data?.counts ?? {};
  const projectChoices = projectOptions(tasks);
  const agentChoices = agentOptions(tasks);
  const filtered = hasActiveTaskFilters(state);

  return (
    <section aria-labelledby="tasks-title" className="space-y-4">
      {header}

      {/* Filters — URL state (?project=&agent=&q=), shared dialect with the
       * list view; q highlights matches inside card titles. */}
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label={t("tasks.filterLabel")}
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="board-q" className="text-xs text-foreground-secondary">
            {t("tasks.searchLabel")}
          </label>
          <input
            id="board-q"
            type="search"
            value={state.q ?? ""}
            onChange={(event) => patch({ q: event.target.value || undefined })}
            placeholder={t("tasks.searchPlaceholder")}
            className="h-9 w-48 rounded-md border border-border bg-well px-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          />
        </div>
        <TaskFilterSelect
          id="board-project"
          label={t("tasks.projectLabel")}
          value={state.project ?? ""}
          onChange={(value) => patch({ project: value || undefined })}
          allLabel={t("tasks.allProjects")}
          options={projectChoices.map((project) => ({
            value: project,
            label: project,
          }))}
        />
        <TaskFilterSelect
          id="board-agent"
          label={t("tasks.agentLabel")}
          value={state.agent ?? ""}
          onChange={(value) => patch({ agent: value || undefined })}
          allLabel={t("tasks.allAgents")}
          options={agentChoices.map((agent) => ({ value: agent, label: agent }))}
        />
        {filteredTasks.length === 0 && filtered ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              patch({ project: undefined, agent: undefined, q: undefined })
            }
          >
            {t("tasks.clearFilters")}
          </Button>
        ) : null}
      </form>

      {tasks.length === 0 ? (
        <EmptyState
          variant="empty"
          title={t("tasks.boardEmpty")}
          message={t("tasks.boardEmptyHint")}
        />
      ) : filteredTasks.length === 0 ? (
        <EmptyState
          variant="empty"
          title={t("tasks.noMatch")}
          message={t("tasks.noMatchHint")}
        />
      ) : (
        <DndContext {...dnd.dndContextProps}>
          <div
            aria-label={t("tasks.board.label")}
            className="flex items-start gap-3 overflow-x-auto pb-2"
          >
            {[...(board.data?.columns ?? [])].map((column) => (
              <TaskBoardColumn
                key={column}
                column={column}
                tasks={columns.get(column) ?? []}
                totalCount={wholeBoardCounts[column] ?? 0}
                canDrag={canDrag}
                showMenu={canMutate}
                reportCounts={reportCounts}
                query={state.q}
                collapsed={collapsed}
                onToggleGroup={toggleGroup}
                compact={density === "compact"}
              />
            ))}
          </div>
          <DragOverlay dropAnimation={reducedMotion ? null : undefined}>
            {dnd.activeTask ? (
              <TaskBoardCardGhost
                task={dnd.activeTask}
                reportCount={reportCounts[dnd.activeTask.id]}
                showMenu={false}
                query={state.q}
                reducedMotion={reducedMotion}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
    </section>
  );
}

/**
 * `/tasks` index element: honour the persisted view preference (CV-4 §1).
 * A stored "list" replace-redirects to `/tasks/list` (search params carried
 * over) so the sidebar «Задачи» lands in the owner's preferred projection;
 * every other case (including the default) renders the kanban — the domain's
 * view №1.
 */
export function TasksIndex() {
  const { search } = useLocation();
  if (loadTaskView() === "list") {
    return <Navigate to={{ pathname: "/tasks/list", search }} replace />;
  }
  return <TaskBoardPage />;
}
