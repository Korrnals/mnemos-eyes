import { useCallback, useMemo, useState } from "react";
import { PointerSensor, closestCenter, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import type { BoardTask } from "@/gateway/boardTypes";
import { computeKanbanMove } from "./boardDnd";

/**
 * Kanban DnD wiring (Ф3, ARCHCOM-3 verdict §3): ONE pointer sensor with a
 * small activation distance (clicks — the title link, the ⋯ menu — must not
 * mutate into drags), closestCenter collision detection, and a drag-end
 * resolver that turns the drop into a wire move intent.
 *
 * The KEYBOARD move path is the row ⋯ menu («Переместить…») — canonical per
 * the verdict; a dnd-kit KeyboardSensor is a deliberate later enhancement
 * and is intentionally NOT registered here.
 *
 * @dnd-kit dependency note (verdict §3 "обосновать письменно"): @dnd-kit
 * core+sortable exceed the 10 KB gz budget (~14–18 KB gz combined) — accepted
 * by АРХКОМ-3 because the kanban is the PRIMARY surface of the Задачи
 * domain and needs pointer + (later) keyboard dragging with accessible
 * semantics; no hand-rolled alternative covers both within budget.
 */

/** Pointer travel before a press becomes a drag (title-link clicks survive). */
const DRAG_ACTIVATION_DISTANCE_PX = 5;

export interface KanbanDndOptions {
  /** Ordered per-column task lists (the exact arrays the board renders). */
  columns: ReadonlyMap<string, readonly BoardTask[]>;
  /** Whether dragging is allowed at all (ui token present + adapter can). */
  canDrag: boolean;
  /** Executes the resolved move (optimistic mutation from useTaskMutations). */
  move: (task: BoardTask, col: string, position: number) => void;
}

export function useKanbanDnd(options: KanbanDndOptions) {
  const { columns, canDrag, move } = options;
  const [activeId, setActiveId] = useState<string | null>(null);

  const pointerSensor = useSensor(PointerSensor, {
    activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE_PX },
  });
  // Without drag permission NO sensor mounts — the disabled-per-card state
  // and the sensorless context agree on "not draggable at all".
  const sensors = useSensors(canDrag ? pointerSensor : null);

  const onDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const onDragCancel = useCallback(() => setActiveId(null), []);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const activeTask = findTaskById(columns, String(event.active.id));
      if (!activeTask) return;
      const intent = computeKanbanMove(activeTask, event.over, columns);
      if (!intent) return;
      // Same slot (column + position) — a no-op drop, no wire call.
      if (intent.col === activeTask.col && intent.position === activeTask.position)
        return;
      move(activeTask, intent.col, intent.position);
    },
    [columns, move],
  );

  const activeTask = useMemo(
    () => (activeId ? (findTaskById(columns, activeId) ?? null) : null),
    [activeId, columns],
  );

  return useMemo(
    () => ({
      /** Spread onto <DndContext>. */
      dndContextProps: {
        sensors,
        collisionDetection: closestCenter,
        onDragStart,
        onDragEnd,
        onDragCancel,
      },
      /** The dragged task for the DragOverlay ghost (null while idle). */
      activeTask,
    }),
    [sensors, onDragStart, onDragEnd, onDragCancel, activeTask],
  );
}

function findTaskById(
  columns: ReadonlyMap<string, readonly BoardTask[]>,
  id: string,
): BoardTask | undefined {
  for (const tasks of columns.values()) {
    const found = tasks.find((task) => task.id === id);
    if (found) return found;
  }
  return undefined;
}
