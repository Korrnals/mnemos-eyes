import { useState } from "react";
import { Play, RotateCcw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { TableRowSkeleton } from "@/components/skeletons/Skeletons";
import type { AssignmentItem, BoardTask } from "@/gateway/boardTypes";
import { useI18n, useT } from "@/i18n";
import { formatTaskDate } from "@/features/tasks/taskStatus";
import { useValidationNow } from "@/features/tasks/useValidationClock";
import {
  ACTIVE_ASSIGNMENT_STATES,
  ageAnchorOf,
  ageLabelKey,
  formatAge,
  routingReasonKey,
  taskAcceptsAssignments,
} from "./assignmentStatus";
import { AssignmentStateBadge } from "./AssignmentStateBadge";
import { AssignExecutorSheet } from "./AssignExecutorSheet";
import type { AssignPrefill } from "./AssignExecutorSheet";
import { useAssignments, useExecutors } from "./useAgents";
import { useAssignmentMutations } from "./useAssignmentMutations";

/**
 * «Исполнение» tab of `/tasks/:id` (AGW-2, spec §2.4): the task's assignment
 * depth — the dense queue of execution attempts. Creation lives HERE and
 * only here (the section is observability); the «Взять в работу» button and
 * the failed/expired «Перезапустить» prefill both open the sheet.
 *
 * Row anatomy (spec §1.1/§3.1): state badge (7 states, colour+text+shape) ·
 * mono age (queued age / claim age / pulse age; terminal rows show the
 * finish stamp instead) · the declared-identity chip (UNVERIFIED, spec
 * §2.2) · the routing signature («резолвится к …» / «ждёт исполнителя») ·
 * actions (cancel for active, retry for failed/expired).
 *
 * Amber staleness thresholds (§3.1 >10 min no start, >2 min pulse) are
 * deliberately NOT coloured here: the TTL constants are server-owned data
 * (executors meta) and this wave's tab has no meta feed — deferred to the
 * /agents/execution wave where the presence strip owns the thresholds.
 */

/** Dense order: active first (claimed/running → queued), then the rest. */
function assignmentOrder(a: AssignmentItem, b: AssignmentItem): number {
  const active = (row: AssignmentItem): number =>
    ACTIVE_ASSIGNMENT_STATES.includes(row.state) ? 0 : 1;
  if (active(a) !== active(b)) return active(a) - active(b);
  return b.created_at.localeCompare(a.created_at);
}

export function TaskExecutionTab({ task }: { task: BoardTask }) {
  const t = useT();
  const { lang } = useI18n();
  // Shared 1 Hz ticker — 0 before the first subscribe (SSR-honest: no age
  // line), a live timestamp afterwards.
  const now = useValidationNow();
  const assignments = useAssignments({ task_id: task.id });
  const executors = useExecutors();
  const mutations = useAssignmentMutations();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [prefill, setPrefill] = useState<AssignPrefill | null>(null);

  const items = [...(assignments.data?.items ?? [])].sort(assignmentOrder);
  const active = items.find((row) => ACTIVE_ASSIGNMENT_STATES.includes(row.state));
  const accepts = taskAcceptsAssignments(task);
  const executorName = (id: string): string =>
    (executors.data?.items ?? []).find((row) => row.id === id)?.name ?? id;

  const openFreshSheet = (): void => {
    setPrefill(null);
    setSheetOpen(true);
  };

  const retry = (row: AssignmentItem): void => {
    // Prefill with the failed attempt's parameters verbatim (spec §3.1).
    setPrefill({ specialist: row.specialist, harness: row.harness });
    setSheetOpen(true);
  };

  return (
    <div className="space-y-3">
      {/* Header action: hidden while an attempt is active (≤1 invariant),
       * disabled with a reason on terminal tasks (matrix A idle). */}
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground-secondary">
          {t("agents.list.label")}
        </h2>
        {!active && accepts ? (
          <Button variant="outline" size="sm" onClick={openFreshSheet}>
            <Play className="size-4" aria-hidden="true" />
            {t("agents.assign.open")}
          </Button>
        ) : null}
        {!active && !accepts ? (
          <Button variant="outline" size="sm" disabled title={t("agents.assign.terminalTask")}>
            <Play className="size-4" aria-hidden="true" />
            {t("agents.assign.open")}
          </Button>
        ) : null}
      </div>

      {assignments.isPending ? (
        <div role="status" aria-label={t("agents.list.loading")}>
          <TableRowSkeleton rows={3} columns={3} />
        </div>
      ) : assignments.isError ? (
        <EmptyState
          variant="error"
          title={t("agents.list.failed")}
          message={assignments.error.message}
          action={
            <Button variant="outline" onClick={() => void assignments.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          variant="empty"
          title={t("agents.empty.title")}
          message={t("agents.empty.message")}
          action={
            accepts ? (
              <Button onClick={openFreshSheet}>
                <Play className="size-4" aria-hidden="true" />
                {t("agents.assign.open")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <ul className="space-y-1.5" aria-label={t("agents.list.label")}>
          {items.map((row) => (
            <li
              key={row.id}
              className="rounded-md border border-border-subtle bg-well px-3 py-2 text-sm shadow-well"
            >
              <div className="flex flex-wrap items-center gap-2">
                <AssignmentStateBadge state={row.state} />
                <span className="font-mono text-xs text-foreground-muted">
                  #{row.id} · {row.specialist} · {row.harness}
                </span>
                <span className="ml-auto whitespace-nowrap font-mono text-xs text-foreground-muted">
                  {ageLine(row, now, t, lang)}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {identityChip(row, executorName, t)}
                {routingSignature(row, executorName, t)}
                <span className="ml-auto flex items-center gap-1">
                  {ACTIVE_ASSIGNMENT_STATES.includes(row.state) ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => mutations.cancelAssignment(row)}
                    >
                      <XCircle className="size-3.5" aria-hidden="true" />
                      {t("agents.cancel.label")}
                    </Button>
                  ) : null}
                  {row.state === "failed" || row.state === "expired" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      onClick={() => retry(row)}
                    >
                      <RotateCcw className="size-3.5" aria-hidden="true" />
                      {t("agents.retry.label")}
                    </Button>
                  ) : null}
                </span>
              </div>
              {row.note ? (
                <p className="mt-1 text-xs text-foreground-secondary">{row.note}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <AssignExecutorSheet
        task={task}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        prefill={prefill}
      />
    </div>
  );
}

/** The row's age/stamp line — mono per state (spec §3.1). */
function ageLine(
  row: AssignmentItem,
  now: number,
  t: ReturnType<typeof useT>,
  lang: "ru" | "en",
): string {
  if (row.state === "done" || row.state === "failed" || row.state === "cancelled" || row.state === "expired") {
    return row.finished_at ? formatTaskDate(row.finished_at, lang) : "";
  }
  const anchor = ageAnchorOf(row);
  if (!anchor) return "";
  const age = formatAge(anchor, now);
  return age ? t(ageLabelKey(row.state), { age: `${age.display} ${t(age.unitKey)}` }) : "";
}

/**
 * The declared-identity chip: claimed_by is executor-CLAIMED, server never
 * verified it (spec §2.2) — contour chip + tooltip, neutral tone.
 */
function identityChip(
  row: AssignmentItem,
  executorName: (id: string) => string,
  t: ReturnType<typeof useT>,
) {
  if (row.claimed_by) {
    return (
      <Badge
        variant="outline"
        title={t("agents.identity.tooltip")}
        className="font-normal"
      >
        {t("agents.identity.reportedBy", { who: row.claimed_by })}
      </Badge>
    );
  }
  if (row.claimed_by_executor) {
    return (
      <Badge
        variant="outline"
        title={t("agents.identity.tooltip")}
        className="font-normal"
      >
        {t("agents.identity.reportedBy", {
          who: executorName(row.claimed_by_executor),
        })}
      </Badge>
    );
  }
  return null;
}

/** «резолвится к X (правило)» / «ждёт исполнителя» — server annotation. */
function routingSignature(
  row: AssignmentItem,
  executorName: (id: string) => string,
  t: ReturnType<typeof useT>,
) {
  const routing = row.routing;
  if (!routing || routing.resolved === null) {
    return <span className="text-foreground-muted">{t("agents.routing.unmatchedRow")}</span>;
  }
  return (
    <span className="text-foreground-secondary">
      {t("agents.routing.resolvedRow", {
        name: executorName(routing.resolved),
        reason: t(routingReasonKey(routing.reason)),
      })}
    </span>
  );
}
