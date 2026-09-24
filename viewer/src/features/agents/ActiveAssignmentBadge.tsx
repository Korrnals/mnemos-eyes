import { Link, useLocation } from "react-router";
import { useT } from "@/i18n";
import { withReturn } from "@/lib/returnParams";
import type { AssignmentLifecycleState } from "@/gateway/boardTypes";
import { assignmentStateStyle } from "./assignmentStatus";
import { useActiveAssignment } from "./useAgents";

/**
 * The active-assignment badge (concept §4.4 matrix Б, dense variant): a
 * small chip on the kanban card and the list row linking straight to the
 * task's «Исполнение» tab. Iris CONTOUR for claimed/running (someone is on
 * it), neutral contour for queued (waiting) — colour + text + the shape dot
 * carried over from the state badge. Renders NOTHING without an active
 * attempt (unknown is not zero, and mnemos mode has no agents data).
 */

/** Contour treatment per active state (iris ring vs neutral ring). */
const ACTIVE_CHIP: Record<string, string> = {
  claimed:
    "border border-iris-bright/60 text-iris-bright hover:border-iris-bright hover:text-iris-bright",
  running:
    "border border-iris-bright/60 text-iris-bright hover:border-iris-bright hover:text-iris-bright",
  queued: "border border-border text-foreground-secondary hover:border-foreground-muted",
};

/** Shape dot classes (mirrors AssignmentStateBadge, aria-hidden). */
const SHAPE_CLASS: Record<string, string> = {
  hollow: "size-1.5 rounded-full border border-current",
  filled: "size-1.5 rounded-full bg-current",
  pulse: "size-1.5 rounded-full bg-current motion-safe:animate-pulse",
  square: "size-1.5 rounded-[1px] bg-current",
};

export function ActiveAssignmentBadge({ taskId }: { taskId: string }) {
  const t = useT();
  // UI-18 pair 6: the badge is source-aware — from /agents/execution the
  // return leads back into the feed; from the board/list rows it carries
  // those surfaces' URLs (pair 1 semantics on the ?tab=execution target).
  const location = useLocation();
  const active = useActiveAssignment(taskId);
  const row = active.data;
  if (!row) return null;
  const style: ReturnType<typeof assignmentStateStyle> = assignmentStateStyle(
    row.state as AssignmentLifecycleState,
  );
  return (
    <Link
      to={withReturn(
        `/tasks/${encodeURIComponent(taskId)}?tab=execution`,
        location.pathname,
        location.search,
      )}
      title={t("agents.badge.title", { state: t(style.labelKey) })}
      className={
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-xs font-medium transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright " +
        (ACTIVE_CHIP[row.state] ?? ACTIVE_CHIP.queued)
      }
    >
      <span aria-hidden="true" className={`inline-block ${SHAPE_CLASS[style.shape]}`} />
      {t(style.labelKey)}
    </Link>
  );
}
