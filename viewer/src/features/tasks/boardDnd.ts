import type { BoardTask } from "@/gateway/boardTypes";

/**
 * Pure kanban DnD geometry (Ф3, ARCHCOM-3 verdict §3): resolves a dnd-kit
 * drag end into a wire move intent (`POST /api/tasks/{id}/move` col+position)
 * from the board's ordered columns — no React, no dnd-kit imports, directly
 * unit-testable.
 *
 * Droppable id plan (cards keep their raw task id as the sortable id):
 * - card (sortable)        → drop BEFORE that card in its column
 * - `drop:group:col:proj`  → group header (collapsed groups live here):
 *                            drop at the END of that project group
 * - `drop:col:col`         → column root: append to the end of the column
 *
 * `position` semantics mirror the server: the index the task occupies in
 * the column's position-ordered task list AFTER the move.
 */

/** Droppable id for a project-group header inside a column. */
export function groupDropId(column: string, project: string): string {
  return `drop:group:${column}:${project}`;
}

/** Droppable id for a column root (append target / empty column). */
export function columnDropId(column: string): string {
  return `drop:col:${column}`;
}

/** One resolved move intent; null = no-op (drop on itself / unknown target). */
export interface KanbanMoveIntent {
  readonly col: string;
  readonly position: number;
}

/** The dnd-kit `over` subset the resolver needs (data.current carries ours). */
export interface DragOver {
  readonly id: string | number;
  readonly data?: { current?: unknown };
}

/** Structural read of one droppable's data payload. */
function overData(over: DragOver): Record<string, unknown> {
  const data = over.data?.current;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

/** Ordered task ids of a column after removing the active task. */
function columnWithout(ordered: readonly BoardTask[], activeId: string): BoardTask[] {
  return ordered.filter((task) => task.id !== activeId);
}

/**
 * Resolve the move for one drag end. `columns` maps EVERY wire column to its
 * position-ordered task list (the exact arrays the board renders); `active`
 * is the dragged task row.
 */
export function computeKanbanMove(
  active: BoardTask,
  over: DragOver | null,
  columns: ReadonlyMap<string, readonly BoardTask[]>,
): KanbanMoveIntent | null {
  if (!over) return null;
  const data = overData(over);
  const type = data.type;

  if (type === "task") {
    const target = data.task as BoardTask | undefined;
    // Self-drop (or a payload without the row) is a no-op.
    if (!target || target.id === active.id) return null;
    const ordered = columnWithout(columns.get(target.col) ?? [], active.id);
    const index = ordered.findIndex((task) => task.id === target.id);
    if (index < 0) return null;
    return { col: target.col, position: index };
  }

  if (type === "group") {
    const col = data.col;
    const project = data.project;
    if (typeof col !== "string" || typeof project !== "string") return null;
    const ordered = columnWithout(columns.get(col) ?? [], active.id);
    // Insert after the LAST member of the group (collapsed headers are the
    // only entry point into a folded group — instruction CV-4 §3).
    let insertAt = ordered.length;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      if ((ordered[index].project ?? "") === project) {
        insertAt = index + 1;
        break;
      }
    }
    return { col, position: insertAt };
  }

  if (type === "column") {
    const col = data.col;
    if (typeof col !== "string") return null;
    return { col, position: columnWithout(columns.get(col) ?? [], active.id).length };
  }

  // Unknown payload — a no-op, never a guessed move.
  return null;
}

/**
 * Board columns projection for DnD + render: every wire column mapped to its
 * tasks ordered by position asc (kanban order is the owner's explicit order —
 * the priority sort belongs to the LIST view, not the board).
 */
export function buildOrderedColumns(
  wireColumns: readonly string[],
  tasks: readonly BoardTask[],
): Map<string, BoardTask[]> {
  const byColumn = new Map<string, BoardTask[]>(
    wireColumns.map((column) => [column, []]),
  );
  for (const task of tasks) {
    const bucket = byColumn.get(task.col);
    if (bucket) bucket.push(task);
  }
  for (const bucket of byColumn.values()) {
    bucket.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  }
  return byColumn;
}
