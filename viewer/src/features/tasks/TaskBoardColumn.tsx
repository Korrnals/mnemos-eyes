import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { BoardTask } from "@/gateway/boardTypes";
import { useT } from "@/i18n";
import { columnBadgeVariant, columnLabelKey } from "./taskStatus";
import { groupTasksByProject } from "./taskGrouping";
import { columnDropId, groupDropId } from "./boardDnd";
import { TaskBoardCard } from "./TaskBoardCard";

/**
 * One kanban column (Ф3): wire column title + counter, project-group
 * accordions INSIDE the column (the persisted "vesmaro.taskGroups" set is
 * shared with the list view — one collapse state per project across both
 * projections), a SortableContext for the vertical in-column reorder and a
 * column-root droppable (append target / empty column landing zone).
 *
 * Compact density narrows the columns (verdict §3 "тонкие колонки"); the
 * board scrolls horizontally when the 7 lanes outgrow the viewport.
 */
export function TaskBoardColumn({
  column,
  tasks,
  totalCount,
  canDrag,
  showMenu,
  reportCounts,
  query,
  collapsed,
  onToggleGroup,
  compact,
}: {
  column: string;
  /** Position-ordered tasks of THIS column (already filtered). */
  tasks: readonly BoardTask[];
  /** Whole-board count for the header (wire semantics: never filtered). */
  totalCount: number;
  canDrag: boolean;
  showMenu: boolean;
  reportCounts: Readonly<Record<string, number>>;
  query?: string;
  /** Persisted collapsed-project set (shared with the list view). */
  collapsed: ReadonlySet<string>;
  onToggleGroup: (project: string) => void;
  compact: boolean;
}) {
  const t = useT();
  const groups = groupTasksByProject(tasks);
  const { setNodeRef, isOver } = useDroppable({
    id: columnDropId(column),
    disabled: !canDrag,
    data: { type: "column", col: column },
  });

  return (
    <section
      aria-label={t("tasks.board.columnLabel", { col: t(columnLabelKey(column)) })}
      className={
        "flex shrink-0 flex-col rounded-lg border border-border-subtle bg-base/40 " +
        (compact ? "w-60" : "w-72") +
        (isOver ? " border-iris-bright/60" : "")
      }
    >
      <header
        className={
          "flex items-center justify-between gap-2 border-b border-border-subtle px-3 " +
          (compact ? "py-1.5" : "py-2")
        }
      >
        <h2 className="text-sm font-semibold text-foreground-secondary">
          {t(columnLabelKey(column))}
        </h2>
        <Badge variant={columnBadgeVariant(column)} className="font-mono">
          {totalCount}
        </Badge>
      </header>

      <div
        ref={setNodeRef}
        className={
          "flex-1 space-y-2 overflow-y-auto p-2 " +
          (compact ? "max-h-[70vh]" : "max-h-[75vh]")
        }
      >
        <SortableContext
          items={tasks.map((task) => task.id)}
          strategy={verticalListSortingStrategy}
        >
          {groups.map((group) => (
            <BoardGroup
              key={group.project || "__none"}
              column={column}
              project={group.project}
              tasks={group.tasks}
              canDrag={canDrag}
              showMenu={showMenu}
              reportCounts={reportCounts}
              query={query}
              collapsed={collapsed.has(group.project)}
              onToggle={() => onToggleGroup(group.project)}
            />
          ))}
        </SortableContext>

        {tasks.length === 0 ? (
          <p className="px-1 py-2 text-xs text-foreground-muted">
            {query ? t("tasks.board.noMatchColumn") : t("tasks.board.emptyColumn")}
          </p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * One project accordion inside a column. The header doubles as a droppable
 * target: dropping onto a COLLAPSED group header appends the card to the end
 * of that group (CV-4 §3 — the folded group's only entry point); on an
 * expanded group the cards themselves are the finer-grained targets.
 */
function BoardGroup({
  column,
  project,
  tasks,
  canDrag,
  showMenu,
  reportCounts,
  query,
  collapsed,
  onToggle,
}: {
  column: string;
  project: string;
  tasks: readonly BoardTask[];
  canDrag: boolean;
  showMenu: boolean;
  reportCounts: Readonly<Record<string, number>>;
  query?: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const { setNodeRef, isOver } = useDroppable({
    id: groupDropId(column, project),
    disabled: !canDrag,
    data: { type: "group", col: column, project },
  });

  return (
    <div>
      <button
        ref={setNodeRef}
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className={
          "flex w-full items-center gap-1 rounded-sm py-0.5 text-xs font-medium text-foreground-secondary transition-colors duration-instant hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright " +
          (isOver ? "bg-iris/10 text-iris-bright" : "")
        }
      >
        {collapsed ? (
          <ChevronRight className="size-3.5" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-3.5" aria-hidden="true" />
        )}
        <span>{project || t("tasks.noProject")}</span>
        <span className="font-mono text-foreground-muted">{tasks.length}</span>
      </button>

      {collapsed ? null : (
        <ul className="mt-1 space-y-1.5 pl-1">
          {tasks.map((task) => (
            <TaskBoardCard
              key={task.id}
              task={task}
              reportCount={reportCounts[task.id]}
              canDrag={canDrag}
              showMenu={showMenu}
              query={query}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
