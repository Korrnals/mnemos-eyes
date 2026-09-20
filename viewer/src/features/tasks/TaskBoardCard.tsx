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
  isValidationOverdue,
  priorityBadgeVariant,
  priorityLabelKey,
  validationElapsed,
} from "./taskStatus";
import { useValidationNow } from "./useValidationClock";
import { TaskRowMenu } from "./TaskRowMenu";

/**
 * One kanban card (Ф3, ARCHCOM-3 verdict §3). The card BODY is the pointer
 * drag surface (pointer sensor + DragOverlay live in the page); the TITLE is
 * the keyboard/screen-reader path into `/tasks/:id`, and the ⋯ menu carries
 * the canonical keyboard move («Переместить…» — the verdict's keyboard path;
 * a dnd-kit keyboard sensor stays a deliberate later enhancement).
 *
 * Without a ui token the card is NOT draggable (owner decision CV-4 §3: the
 * simpler honest option — no phantom "drag then log in" queue): the drag is
 * disabled, the cursor stays default and the tooltip says why. The card
 * remains fully readable and navigable.
 *
 * `content-visibility: auto` + `contain-intrinsic-size` keep long columns
 * cheap to paint (verdict §3: the 100+-tasks posture without virtualizing).
 */

/** Shared card body — the sortable card and the DragOverlay ghost render it. */
const TaskCardBody = forwardRef<
  HTMLLIElement,
  {
    task: BoardTask;
    reportCount?: number;
    canDrag: boolean;
    showMenu: boolean;
    query?: string;
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
  return (
    <li
      ref={ref}
      style={style}
      title={canDrag ? undefined : t("tasks.board.dragDisabled")}
      className={
        "relative list-none rounded-md border border-border-subtle bg-well px-2.5 py-2 text-sm shadow-well transition-colors duration-instant [contain-intrinsic-size:auto_7rem] [content-visibility:auto] " +
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

      <h3 className="mt-1 break-words text-sm font-medium leading-snug">
        <Link
          to={`/tasks/${encodeURIComponent(task.id)}`}
          className="text-foreground underline-offset-2 hover:text-iris-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
        >
          <HighlightedTitle title={task.title} query={query} />
        </Link>
      </h3>

      {isValidatingTask(task) ? (
        <ValidatingClock since={task.validating_since} />
      ) : null}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-foreground-secondary">
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
  reducedMotion = false,
}: {
  task: BoardTask;
  reportCount?: number;
  showMenu: boolean;
  query?: string;
  reducedMotion?: boolean;
}) {
  return (
    <TaskCardBody
      task={task}
      reportCount={reportCount}
      canDrag
      showMenu={showMenu}
      query={query}
      overlay={!reducedMotion}
    />
  );
}

/**
 * The WF-1 validation clock line: «в валидации Xч Yм». Reads the SHARED 1 Hz
 * ticker (useValidationClock) — no per-card interval; renders nothing while
 * the ticker is inactive (SSR) or the stamp is absent/unparsable.
 */
function ValidatingClock({ since }: { since: string | null | undefined }) {
  const t = useT();
  const now = useValidationNow();
  if (now === 0) return null;
  const elapsed = validationElapsed(since, now);
  if (!elapsed) return null;
  const overdue = isValidationOverdue(since, now);
  return (
    <p
      className={
        "mt-0.5 font-mono text-xs " + (overdue ? "text-error" : "text-foreground-muted")
      }
      title={overdue ? t("tasks.board.validatingOverdueTitle") : undefined}
    >
      {t("tasks.board.validatingFor", {
        hours: elapsed.hours,
        minutes: elapsed.minutes,
      })}
    </p>
  );
}

/** Title with the active `q` match highlighted (`<mark>`, semantic boost). */
function HighlightedTitle({ title, query }: { title: string; query: string }) {
  const needle = query.trim();
  if (needle.length === 0) return <>{title}</>;
  const index = title.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return <>{title}</>;
  return (
    <>
      {title.slice(0, index)}
      <mark className="rounded-sm bg-iris/20 px-0.5 text-foreground">
        {title.slice(index, index + needle.length)}
      </mark>
      {title.slice(index + needle.length)}
    </>
  );
}
