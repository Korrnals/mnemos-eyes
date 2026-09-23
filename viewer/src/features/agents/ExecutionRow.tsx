import { useState } from "react";
import { Link, useLocation } from "react-router";
import { ExternalLink, MoreHorizontal, RotateCcw, XCircle, Copy } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AssignmentItem } from "@/gateway/boardTypes";
import { withReturn } from "@/lib/returnParams";
import { useI18n, useT } from "@/i18n";
import { formatTaskDate } from "@/features/tasks/taskStatus";
import { useValidationNow } from "@/features/tasks/useValidationClock";
import {
  ACTIVE_ASSIGNMENT_STATES,
  ageAnchorOf,
  ageLabelKey,
  formatAge,
  routingReasonKey,
} from "./assignmentStatus";
import { assignmentRowTiming, queuedHintMinutes, timingCountdownMinutes } from "./assignmentTiming";
import { AssignmentStateBadge } from "./AssignmentStateBadge";

/**
 * One dense row of the execution list (spec §1.1 layer 2): state badge ·
 * task link · specialist · executor/route with the unverified identity chip
 * · mono heartbeat/age with the AMBER treatment (assignmentTiming — the
 * reaper thresholds live ONLY in reaperThresholds.ts). Row actions: the ⋯
 * menu (open task / cancel / copy id — TaskRowMenu posture: tab-reachable
 * trigger, role=menu, Esc closes) and the failed/expired restart prefill.
 * The two-clock rule: executor presence never paints this row (§2.1).
 */
export function ExecutionRow({
  row,
  executorName,
  cursor,
  onOpenDrawer,
  onCancel,
  onRetry,
  titleOf,
}: {
  row: AssignmentItem;
  /** Registry name lookup for route/identity chips. */
  executorName: (id: string) => string;
  /** j/k cursor (keyboard highlight — see ExecutionPage). */
  cursor: boolean;
  onOpenDrawer: (row: AssignmentItem) => void;
  onCancel: (row: AssignmentItem) => void;
  onRetry: (row: AssignmentItem) => void;
  /** Task title lookup (board projection) for the link label. */
  titleOf: (taskId: string) => string;
}) {
  const t = useT();
  const { lang } = useI18n();
  const now = useValidationNow();
  // UI-18 pair 6: the execution URL rides as `return=` on the open-task
  // link so the task's back control leads back into this feed.
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const timing = assignmentRowTiming(row, now);
  const terminal =
    row.state === "done" ||
    row.state === "failed" ||
    row.state === "cancelled" ||
    row.state === "expired";

  const anchor = ageAnchorOf(row);
  const age = anchor && now > 0 ? formatAge(anchor, now) : null;
  const countdownMin = timingCountdownMinutes(timing);

  const identity = row.claimed_by
    ? row.claimed_by
    : row.claimed_by_executor
      ? executorName(row.claimed_by_executor)
      : null;

  const copyId = (): void => {
    try {
      void navigator.clipboard?.writeText(String(row.id));
    } catch {
      // Clipboard may be absent (tests/embedded) — the menu closes anyway.
    }
    setMenuOpen(false);
  };

  return (
    <li
      className={
        "relative rounded-md border bg-well px-2.5 py-1.5 text-sm shadow-well transition-colors duration-instant " +
        (cursor
          ? "border-iris-bright/60 "
          : "border-border-subtle hover:border-iris-bright/40 ")
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <AssignmentStateBadge state={row.state} />
        <button
          type="button"
          onClick={() => onOpenDrawer(row)}
          className="min-w-0 truncate text-left font-medium text-foreground underline-offset-2 hover:text-iris-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
        >
          <span className="font-mono text-xs text-foreground-muted">{row.task_id}</span>{" "}
          {titleOf(row.task_id)}
        </button>
        <span className="truncate text-xs text-foreground-secondary">{row.specialist}</span>

        {/* Identity / route: the FACT (claimed_by, unverified) or the hint
         * (routing annotation) — never mixed up (§2.3). */}
        {identity ? (
          <Badge
            variant="outline"
            title={t("agents.identity.tooltip")}
            className="font-normal"
          >
            {t("agents.identity.reportedBy", { who: identity })}
          </Badge>
        ) : row.routing?.resolved ? (
          <span className="truncate text-xs text-foreground-secondary">
            {t("agents.routing.resolvedRow", {
              name: executorName(row.routing.resolved),
              reason: t(routingReasonKey(row.routing.reason)),
            })}
          </span>
        ) : (
          <span className="text-xs text-foreground-muted">
            {t("agents.routing.unmatchedRow")}
          </span>
        )}

        <span className="ml-auto flex items-center gap-2">
          {/* Mono age/heartbeat; amber ONLY on a real breach (§2.1) — the
           * queued notify-boundary hint stays neutral (server truth: the
           * row never expires). */}
          <span
            className={
              "whitespace-nowrap font-mono text-xs " +
              (timing.warning ? "text-warning" : "text-foreground-muted")
            }
          >
            {terminal
              ? row.finished_at
                ? formatTaskDate(row.finished_at, lang)
                : ""
              : age && now > 0
                ? t(ageLabelKey(row.state), {
                    age: `${age.display} ${t(age.unitKey)}`,
                  })
                : row.state === "claimed"
                  ? t("agents.timing.noClaimStamp")
                  : ""}
            {countdownMin !== null
              ? ` · ${t("agents.timing.expiresIn", { minutes: countdownMin })}`
              : ""}
            {row.state === "claimed" && timing.warning && timing.countdownS !== null && timing.countdownS <= 0
              ? ` · ${t("agents.timing.reapOverdue")}`
              : ""}
            {timing.queuedHint
              ? ` · ${t("agents.timing.queuedNotifyHint", { minutes: queuedHintMinutes(row, now) })}`
              : ""}
          </span>

          {/* ⋯ menu (TaskRowMenu posture): open task / cancel / copy id. */}
          <div className="relative">
            <Button
              variant="ghost"
              size="icon"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t("agents.row.menuAria", { id: row.id })}
              className="size-7"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </Button>
            {menuOpen ? (
              <div
                role="menu"
                aria-label={t("agents.row.menuLabel", { id: row.id })}
                className="absolute right-0 top-full z-30 mt-1 min-w-44 rounded-md border border-border-subtle bg-well p-1 shadow-modal"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setMenuOpen(false);
                  }
                }}
              >
                <Link
                  to={withReturn(
                    `/tasks/${encodeURIComponent(row.task_id)}?tab=execution`,
                    location.pathname,
                    location.search,
                  )}
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors duration-instant hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
                >
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                  {t("agents.row.openTask")}
                </Link>
                {ACTIVE_ASSIGNMENT_STATES.includes(row.state) ? (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onCancel(row);
                    }}
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-error transition-colors duration-instant hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
                  >
                    <XCircle className="size-3.5" aria-hidden="true" />
                    {t("agents.cancel.label")}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  onClick={copyId}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-foreground transition-colors duration-instant hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
                >
                  <Copy className="size-3.5" aria-hidden="true" />
                  {t("agents.row.copyId", { id: row.id })}
                </button>
              </div>
            ) : null}
          </div>

          {/* Failed/expired restart — same prefill as the task tab. */}
          {row.state === "failed" || row.state === "expired" ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => onRetry(row)}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t("agents.retry.label")}
            </Button>
          ) : null}
        </span>
      </div>
    </li>
  );
}
