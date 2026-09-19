import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { TableRowSkeleton } from "@/components/skeletons/Skeletons";
import { isTaskSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import type { BoardTask } from "@/gateway/boardTypes";
import { useI18n, useT } from "@/i18n";
import {
  TASK_COLUMNS,
  TASK_PRIORITIES,
  formatTaskDate,
  priorityBadgeVariant,
  priorityLabelKey,
  statusBadgeVariant,
  statusLabelKey,
} from "./taskStatus";
import {
  agentOptions,
  filterTasks,
  hasActiveTaskFilters,
  parseTaskListParams,
  projectOptions,
  serializeTaskListParams,
} from "./taskFilters";
import type { TaskListUrlState } from "./taskFilters";
import {
  groupTasksByProject,
  loadCollapsedGroups,
  saveCollapsedGroups,
  sortGroupTasks,
} from "./taskGrouping";
import { useBoardTasks, useReportCounts } from "./useTasks";

/** Honest mnemos-mode state: the task domain is a board-native view (Ф2). */
function TasksUnsupported() {
  const t = useT();
  return (
    <section aria-labelledby="tasks-title" className="mx-auto max-w-5xl space-y-4">
      <h1 id="tasks-title" className="text-xl font-semibold">
        {t("tasks.title")}
      </h1>
      <EmptyState
        variant="empty"
        title={t("tasks.unavailableTitle")}
        message={t("tasks.unavailableMessage")}
      />
    </section>
  );
}

/**
 * `/tasks` — the task LIST view of the domain (ARCHCOM-3 verdict §3: dense
 * table on `--row-h` tokens; the kanban view is a Ф3 deliverable). Filters
 * live in the URL (`?status=&priority=&project=&agent=&q=` — QA verdict §3),
 * rows group by project (collapsible, persisted under "vesmaro.taskGroups")
 * and sort priority → position inside a group. Desktop renders a semantic
 * table; under md the same rows render as card-rows (no second data path).
 */
export function TaskListPage() {
  const t = useT();
  const { lang } = useI18n();
  const gateway = useGateway();
  const capable = isTaskSource(gateway);
  const board = useBoardTasks();
  const [searchParams, setSearchParams] = useSearchParams();
  const state = parseTaskListParams(searchParams);
  const [collapsed, setCollapsed] = useState(() => loadCollapsedGroups());

  const tasks = board.data?.tasks ?? [];
  // Stable id list so the report-count memo does not re-derive per render.
  const taskIds = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const reportCounts = useReportCounts(taskIds);

  const patch = (changes: Partial<TaskListUrlState>) => {
    setSearchParams(
      serializeTaskListParams({ ...state, ...changes }),
      { replace: false },
    );
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

  if (!capable) {
    return <TasksUnsupported />;
  }

  if (board.isPending) {
    return (
      <section aria-labelledby="tasks-title" className="mx-auto max-w-5xl space-y-4">
        <h1 id="tasks-title" className="text-xl font-semibold">
          {t("tasks.title")}
        </h1>
        <div role="status" aria-label={t("tasks.loading")}>
          <TableRowSkeleton rows={6} columns={6} />
        </div>
      </section>
    );
  }

  if (board.isError) {
    return (
      <section aria-labelledby="tasks-title" className="mx-auto max-w-5xl space-y-4">
        <h1 id="tasks-title" className="text-xl font-semibold">
          {t("tasks.title")}
        </h1>
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

  const filteredTasks = filterTasks(tasks, state);
  const groups = groupTasksByProject(filteredTasks).map((group) => ({
    ...group,
    tasks: sortGroupTasks(group.tasks),
  }));
  const filtered = hasActiveTaskFilters(state);
  const counts = board.data?.counts ?? {};
  const projectChoices = projectOptions(tasks);
  const agentChoices = agentOptions(tasks);

  return (
    <section aria-labelledby="tasks-title" className="mx-auto max-w-5xl space-y-4">
      <h1 id="tasks-title" className="text-xl font-semibold">
        {t("tasks.title")}
      </h1>

      {/* Mini-stats: per-column counts of the WHOLE board (wire semantics:
       * counts never describe the filtered view — ui-contract /api/board). */}
      <ul
        aria-label={t("tasks.statsLabel")}
        className="flex flex-wrap gap-2"
      >
        {TASK_COLUMNS.map((column) => (
          <li key={column}>
            <button
              type="button"
              onClick={() => patch({ status: state.status === column ? undefined : column })}
              aria-pressed={state.status === column}
              className="rounded-sm transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            >
              <Badge
                variant={state.status === column ? "iris" : "outline"}
                className="cursor-pointer gap-1 px-2 py-1"
              >
                {t(statusLabelKey(column))}
                <span className="font-mono text-foreground-muted">
                  {counts[column] ?? 0}
                </span>
              </Badge>
            </button>
          </li>
        ))}
      </ul>

      {/* Filters — URL state (deep-linkable; unknown dictionary values dropped). */}
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label={t("tasks.filterLabel")}
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="tasks-q" className="text-xs text-foreground-secondary">
            {t("tasks.searchLabel")}
          </label>
          <input
            id="tasks-q"
            type="search"
            value={state.q ?? ""}
            onChange={(event) => patch({ q: event.target.value || undefined })}
            placeholder={t("tasks.searchPlaceholder")}
            className="h-9 w-48 rounded-md border border-border bg-well px-2 text-sm text-foreground placeholder:text-foreground-muted focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          />
        </div>
        <FilterSelect
          id="tasks-status"
          label={t("tasks.statusLabel")}
          value={state.status ?? ""}
          onChange={(value) => patch({ status: value || undefined })}
          allLabel={t("tasks.allStatuses")}
          options={TASK_COLUMNS.map((status) => ({
            value: status,
            label: t(statusLabelKey(status)),
          }))}
        />
        <FilterSelect
          id="tasks-priority"
          label={t("tasks.priorityLabel")}
          value={state.priority ?? ""}
          onChange={(value) => patch({ priority: value || undefined })}
          allLabel={t("tasks.allPriorities")}
          options={TASK_PRIORITIES.map((priority) => ({
            value: priority,
            label: t(priorityLabelKey(priority)),
          }))}
        />
        <FilterSelect
          id="tasks-project"
          label={t("tasks.projectLabel")}
          value={state.project ?? ""}
          onChange={(value) => patch({ project: value || undefined })}
          allLabel={t("tasks.allProjects")}
          options={projectChoices.map((project) => ({ value: project, label: project }))}
        />
        <FilterSelect
          id="tasks-agent"
          label={t("tasks.agentLabel")}
          value={state.agent ?? ""}
          onChange={(value) => patch({ agent: value || undefined })}
          allLabel={t("tasks.allAgents")}
          options={agentChoices.map((agent) => ({ value: agent, label: agent }))}
        />
      </form>

      {groups.length === 0 ? (
        <EmptyState
          variant="empty"
          title={filtered ? t("tasks.noMatch") : t("tasks.boardEmpty")}
          message={filtered ? t("tasks.noMatchHint") : t("tasks.boardEmptyHint")}
          action={
            filtered ? (
              <Button
                variant="outline"
                onClick={() =>
                  patch({
                    status: undefined,
                    priority: undefined,
                    project: undefined,
                    agent: undefined,
                    q: undefined,
                  })
                }
              >
                {t("tasks.clearFilters")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          {/* Desktop: dense semantic table (verdict §3), one tbody per group. */}
          <table className="hidden w-full border-collapse text-sm md:table">
            <caption className="sr-only">{t("tasks.tableCaption")}</caption>
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs text-foreground-muted">
                <th scope="col" className="px-2 py-1 font-medium">
                  {t("tasks.colPriority")}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t("tasks.colStatus")}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t("tasks.colTitle")}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t("tasks.colProject")}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t("tasks.colAgent")}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t("tasks.colDate")}
                </th>
              </tr>
            </thead>
            {groups.map((group) => (
              <tbody key={group.project || "__none"} className="group-tbody">
                <tr>
                  <td colSpan={6} className="border-b border-border-subtle px-2 py-1">
                    <GroupToggle
                      project={group.project}
                      count={group.tasks.length}
                      collapsed={collapsed.has(group.project)}
                      onToggle={() => toggleGroup(group.project)}
                    />
                  </td>
                </tr>
                {group.tasks.map((task) => (
                  <TaskTableRow
                    key={task.id}
                    task={task}
                    lang={lang}
                    hidden={collapsed.has(group.project)}
                    reportCount={reportCounts[task.id]}
                  />
                ))}
              </tbody>
            ))}
          </table>

          {/* Mobile: the same rows as card-rows (no second data path). */}
          <div className="space-y-4 md:hidden">
            {groups.map((group) => (
              <section key={group.project || "__none"} aria-label={group.project}>
                <GroupToggle
                  project={group.project}
                  count={group.tasks.length}
                  collapsed={collapsed.has(group.project)}
                  onToggle={() => toggleGroup(group.project)}
                />
                {collapsed.has(group.project) ? null : (
                  <ul className="mt-1 space-y-1">
                    {group.tasks.map((task) => (
                      <li key={task.id}>
                        <TaskCardRow
                          task={task}
                          lang={lang}
                          reportCount={reportCounts[task.id]}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>

          <p className="text-xs text-foreground-muted">{t("tasks.readOnlyNote")}</p>
        </>
      )}
    </section>
  );
}

/** Labeled native select (keyboard + SR paths for free). */
function FilterSelect({
  id,
  label,
  value,
  onChange,
  allLabel,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  allLabel: string;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs text-foreground-secondary">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-md border border-border bg-well px-2 text-sm text-foreground focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
      >
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Collapsible group header (project accordion, persisted collapse). */
function GroupToggle({
  project,
  count,
  collapsed,
  onToggle,
}: {
  project: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="flex items-center gap-1 rounded-sm py-0.5 text-xs font-medium text-foreground-secondary transition-colors duration-instant hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
    >
      {collapsed ? (
        <ChevronRight className="size-3.5" aria-hidden="true" />
      ) : (
        <ChevronDown className="size-3.5" aria-hidden="true" />
      )}
      <span>{project || t("tasks.noProject")}</span>
      <span className="font-mono text-foreground-muted">{count}</span>
    </button>
  );
}

/** One dense table row on --row-h; whole row navigates, title link is the
 * keyboard/SR path (WCAG 2.1.1 — never a click-only row). */
function TaskTableRow({
  task,
  lang,
  hidden,
  reportCount,
}: {
  task: BoardTask;
  lang: "ru" | "en";
  hidden: boolean;
  reportCount?: number;
}) {
  const t = useT();
  const navigate = useNavigate();
  if (hidden) return null;
  return (
    <tr
      className="h-row cursor-pointer border-b border-border-subtle transition-colors duration-instant hover:bg-elevated focus-within:bg-elevated"
      onClick={() => navigate(`/tasks/${encodeURIComponent(task.id)}`)}
    >
      <td className="px-2">
        <Badge variant={priorityBadgeVariant(task.priority)}>
          {t(priorityLabelKey(task.priority))}
        </Badge>
      </td>
      <td className="px-2">
        <Badge variant={statusBadgeVariant(task.status)}>
          {t(statusLabelKey(task.status))}
        </Badge>
      </td>
      <td className="max-w-[28rem] truncate px-2">
        <Link
          to={`/tasks/${encodeURIComponent(task.id)}`}
          className="font-medium text-foreground underline-offset-2 hover:text-iris-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
        >
          {task.title}
        </Link>
        {reportCount ? (
          <span
            className="ml-2 inline-flex items-center gap-0.5 align-middle text-xs text-foreground-muted"
            title={t("tasks.reportsCountTitle", { count: reportCount })}
          >
            <MessageSquare className="size-3" aria-hidden="true" />
            {reportCount}
          </span>
        ) : null}
      </td>
      <td className="px-2 text-xs text-foreground-secondary">{task.project || "—"}</td>
      <td className="px-2 text-xs text-foreground-secondary">
        {(task.agents ?? []).join(", ") || "—"}
      </td>
      <td className="whitespace-nowrap px-2 text-xs text-foreground-muted">
        {formatTaskDate(task.updated_at, lang)}
      </td>
    </tr>
  );
}

/** Mobile card-row: badges + title + meta (same fields as the table). */
function TaskCardRow({
  task,
  lang,
  reportCount,
}: {
  task: BoardTask;
  lang: "ru" | "en";
  reportCount?: number;
}) {
  const t = useT();
  return (
    <Link
      to={`/tasks/${encodeURIComponent(task.id)}`}
      className="flex min-h-row flex-col gap-1 rounded-md border border-border-subtle bg-well px-3 py-2 text-sm shadow-well transition-colors duration-instant hover:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
    >
      <span className="flex flex-wrap items-center gap-1.5">
        <Badge variant={priorityBadgeVariant(task.priority)}>
          {t(priorityLabelKey(task.priority))}
        </Badge>
        <Badge variant={statusBadgeVariant(task.status)}>
          {t(statusLabelKey(task.status))}
        </Badge>
        {reportCount ? (
          <span className="inline-flex items-center gap-0.5 text-xs text-foreground-muted">
            <MessageSquare className="size-3" aria-hidden="true" />
            {reportCount}
          </span>
        ) : null}
      </span>
      <span className="font-medium">{task.title}</span>
      <span className="flex flex-wrap gap-x-3 text-xs text-foreground-secondary">
        <span>{task.project || t("tasks.noProject")}</span>
        <span>{(task.agents ?? []).join(", ") || "—"}</span>
        <span>{formatTaskDate(task.updated_at, lang)}</span>
      </span>
    </Link>
  );
}
