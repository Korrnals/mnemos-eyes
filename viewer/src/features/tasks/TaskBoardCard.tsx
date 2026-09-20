import { forwardRef } from "react";
import { Link } from "react-router";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MessageSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { BoardTask } from "@/gateway/boardTypes";
import { useT, useI18n } from "@/i18n";
import {
  formatTaskDate,
  isArchcomReviewTask,
  isValidatingTask,
  priorityBadgeVariant,
  priorityLabelKey,
} from "./taskStatus";
import { HighlightedTitle, ValidatingClock } from "./taskCardParts";
import { TaskRowMenu } from "./TaskRowMenu";

/**
 * One kanban card (Ф3, ARCHCOM-3 verdict §3), TWO skins (CV-5):
 * - "dense" — the Ф3 grouped-board card (project accordions), unchanged;
 * - "classic" — the flat classic-kanban card: the SAME content (priority,
 *   archcom badge, ⋯ menu, title link + q highlight, validation clock,
 *   project/agents/date/reports meta) with roomier padding and rhythm —
 *   the classic kanon without a second feature set.
 * The card BODY is the pointer drag surface (pointer sensor + DragOverlay
 * live in the page); the TITLE is the keyboard/screen-reader path into
 * `/tasks/:id`, and the ⋯ menu carries the canonical keyboard move
 * («Переместить…» — the verdict's keyboard path; a dnd-kit keyboard sensor
 * stays a deliberate later enhancement).
 *
 * Without a ui token the card is NOT draggable (owner decision CV-4 §3: the
 * simpler honest option — no phantom "drag then log in" queue): the drag is
 * disabled, the cursor stays default and the tooltip says why. The card
 * remains fully readable and navigable.
 *
 * `content-visibility: auto` + `contain-intrinsic-size` keep long columns
 * cheap to paint (verdict §3: the 100+-tasks posture without virtualizing).
 */

/** Per-skin spacing/intrinsic-size scale (CV-5: classic = roomier canon). */
const CARD_SKIN = {
  dense: {
    pad: "px-2.5 py-2 ",
    intrinsic: "[contain-intrinsic-size:auto_7rem] ",
    clockGap: "mt-0.5 ",
    titleGap: "mt-1 ",
    metaGap: "mt-1.5 gap-x-2 gap-y-1 ",
  },
  classic: {
    pad: "px-3 py-3 ",
    intrinsic: "[contain-intrinsic-size:auto_9rem] ",
    clockGap: "mt-1 ",
    titleGap: "mt-2 ",
    metaGap: "mt-2 gap-x-2.5 gap-y-1.5 ",
  },
} as const;

export type TaskCardSkin = keyof typeof CARD_SKIN;

/** Shared card body — the sortable card and the DragOverlay ghost render it. */
const TaskCardBody = forwardRef<
  HTMLLIElement,
  {
    task: BoardTask;
    reportCount?: number;
    canDrag: boolean;
    showMenu: boolean;
    query?: string;
    skin: TaskCardSkin;
    overlay?: boolean;
    dragging?: boolean;
    style?: React.CSSProperties;
    /** dnd-kit pointer listeners, spread onto the card root. */
    dragHandlers?: React.DOMAttributes<HTMLLIElement>;
  } & React.HTMLAttributes<HTMLLIElement>
>(function TaskCardBody(
  {
    task,
    reportCount,
    canDrag,
    showMenu,
    query = "",
    skin,
    overlay = false,
    dragging = false,
    style,
    dragHandlers,
    ...rest
  },
  ref,
) {
  const t = useT();
  const { lang } = useI18n();
  const spacing = CARD_SKIN[skin];
  return (
    <li
      ref={ref}
      style={style}
      title={canDrag ? undefined : t("tasks.board.dragDisabled")}
      className={
        "relative list-none rounded-md border border-border-subtle bg-well text-sm shadow-well transition-colors duration-instant [content-visibility:auto] " +
        spacing.pad +
        spacing.intrinsic +
        (overlay
          ? "rotate-2 border-iris-bright/60 shadow-modal "
          : "focus-within:border-iris-bright/60 ") +
        (canDrag && !overlay
          ? "cursor-grab active:cursor-grabbing "
          : "cursor-default ") +
        (dragging && !overlay ? "opacity-30 " : "")
      }
      {...dragHandlers}
      {...rest}
    >
      <div className="flex items-start justify-between gap-1">
        <Badge variant={priorityBadgeVariant(task.priority)} className="shrink-0">
          {t(priorityLabelKey(task.priority))}
        </Badge>
        <span className="flex items-center gap-1">
          {isArchcomReviewTask(task) ? (
            <Badge
              variant="confidence"
              className="font-mono uppercase"
              title={t("tasks.board.archcomTitle")}
            >
              {t("tasks.board.archcomBadge")}
            </Badge>
          ) : null}
          {showMenu ? <TaskRowMenu task={task} /> : null}
        </span>
      </div>

      <h3
        className={
          "break-words text-sm font-medium leading-snug " + spacing.titleGap
        }
      >
        <Link
          to={`/tasks/${encodeURIComponent(task.id)}`}
          className="text-foreground underline-offset-2 hover:text-iris-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
        >
          <HighlightedTitle title={task.title} query={query} />
        </Link>
      </h3>

      {isValidatingTask(task) ? (
        <ValidatingClock since={task.validating_since} className={spacing.clockGap} />
      ) : null}

      <div
        className={
          "flex flex-wrap items-center text-xs text-foreground-secondary " +
          spacing.metaGap
        }
      >
        {task.project ? (
          <span className="rounded-sm bg-elevated px-1.5 py-0.5">{task.project}</span>
        ) : null}
        {(task.agents ?? []).length > 0 ? (
          <span
            className="truncate"
            title={(task.agents ?? [])
              .map((agent) => t("tasks.agentChip", { agent }))
              .join(", ")}
          >
            {(task.agents ?? []).join(", ")}
          </span>
        ) : null}
        <span className="ml-auto whitespace-nowrap text-foreground-muted">
          {formatTaskDate(task.updated_at, lang)}
        </span>
        {reportCount ? (
          <span
            className="inline-flex items-center gap-0.5 text-foreground-muted"
            title={t("tasks.reportsCountTitle", { count: reportCount })}
          >
            <MessageSquare className="size-3" aria-hidden="true" />
            {reportCount}
          </span>
        ) : null}
      </div>

      {!canDrag ? (
        <span className="sr-only">{t("tasks.board.dragDisabled")}</span>
      ) : null}
    </li>
  );
});

/** The sortable card — dnd-kit wiring around the shared body. */
export function TaskBoardCard(props: {
  task: BoardTask;
  reportCount?: number;
  canDrag: boolean;
  showMenu: boolean;
  query?: string;
  /** Card skin (CV-5): "dense" for the grouped board, "classic" for flat. */
  skin?: TaskCardSkin;
}) {
  const { task, canDrag } = props;
  // NOTE: dnd-kit's useSortable returns plain render values (transform,
  // transition, isDragging, listeners) alongside a callback ref (setNodeRef)
  // in ONE object — destructuring (not member access) keeps the compiler-
  // based react-hooks/refs rule from misreading the values as ref access.
  const { setNodeRef, transform, transition, isDragging, listeners } = useSortable({
    id: task.id,
    disabled: !canDrag,
    data: { type: "task", task },
  });
  return (
    <TaskCardBody
      {...props}
      skin={props.skin ?? "dense"}
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      dragging={isDragging}
      dragHandlers={
        canDrag
          ? (listeners as unknown as React.DOMAttributes<HTMLLIElement>)
          : undefined
      }
    />
  );
}

/**
 * The DragOverlay ghost (verdict §3): the same body WITHOUT sortable wiring
 * (a second registered sortable id would collide with the real card), lifted
 * visual treatment. Reduced-motion users get the plain card — no rotation.
 */
export function TaskBoardCardGhost({
  task,
  reportCount,
  showMenu,
  query,
  skin = "dense",
  reducedMotion = false,
}: {
  task: BoardTask;
  reportCount?: number;
  showMenu: boolean;
  query?: string;
  /** Card skin (CV-5) — the ghost mirrors the board the drag started on. */
  skin?: TaskCardSkin;
  reducedMotion?: boolean;
}) {
  return (
    <TaskCardBody
      task={task}
      reportCount={reportCount}
      canDrag
      showMenu={showMenu}
      query={query}
      skin={skin}
      overlay={!reducedMotion}
    />
  );
}
