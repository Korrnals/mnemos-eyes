import { Link, useLocation } from "react-router";
import { XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TextEngine } from "@/components/TextEngine";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import type { AssignmentItem } from "@/gateway/boardTypes";
import { withReturn } from "@/lib/returnParams";
import { useI18n, useT } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { formatTaskDate } from "@/features/tasks/taskStatus";
import { useTaskReports } from "@/features/tasks/useTasks";
import {
  ACTIVE_ASSIGNMENT_STATES,
  routingReasonKey,
} from "./assignmentStatus";
import { AssignmentStateBadge } from "./AssignmentStateBadge";

/**
 * Assignment drawer (spec §1.1 — ПОДГЛЯДЫВАНИЕ, not a route: an assignment
 * is execution metadata of a task, never a master entity — ADR 0009 §6).
 * A right-side Radix Dialog: Esc/outside close for free. Content:
 * - the phase TIMELINE (created→claimed→started→pulse→terminal) with the
 *   server timestamps verbatim;
 * - the identity line — claimed_by is executor-CLAIMED, never verified;
 * - the dispatch envelope preview RECONSTRUCTED from API fields (the real
 *   envelope is poller-side stdin; what the wire exposes is task/specialist/
 *   harness — labelled as a reconstruction);
 * - the spec snapshot FINGERPRINT (spec_hash, mono; the snapshot itself is
 *   contractually server-side);
 * - the final report preview (the task's last final, superseded included —
 *   honest provenance) via the shared reports query;
 * - cancel/restart, the same gated mutations the task tab uses.
 *
 * EXPORT CONTRACT (AGW-3, for the future /tasks/:id integration): this
 * component is SELF-CONTAINED — props are {row, executorName, on_CANCEL,
 * on_RETRY, on_CLOSE}; it owns no routing and no stream. Mounting it under
 * the task tab is a prop change, not a refactor.
 */
export function AssignmentDrawer({
  row,
  executorName,
  onCancel,
  onRetry,
  onClose,
}: {
  row: AssignmentItem | null;
  executorName: (id: string) => string;
  onCancel: (row: AssignmentItem) => void;
  onRetry: (row: AssignmentItem) => void;
  onClose: () => void;
}) {
  const t = useT();
  const { lang } = useI18n();
  // UI-18 pair 6: the execution URL rides as `return=` on the open-task
  // link so the task's back control leads back into this drawer's page.
  const location = useLocation();
  // The reports query keys per TASK — the drawer reads the SAME cache the
  // task tab fills (one wire call per task across surfaces).
  const reports = useTaskReports(row?.task_id);
  if (!row) return null;

  const finals = (reports.data?.items ?? []).filter((report) => report.kind === "final");
  const lastFinal = finals[finals.length - 1];

  const timeline: { key: TranslationKey; stamp: string | null | undefined }[] = [
    { key: "agents.timeline.created", stamp: row.created_at },
    { key: "agents.timeline.claimed", stamp: row.claimed_at },
    { key: "agents.timeline.started", stamp: row.started_at },
    { key: "agents.timeline.heartbeat", stamp: row.heartbeat_at },
    { key: "agents.timeline.finished", stamp: row.finished_at },
  ];

  return (
    <Dialog open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="inset-y-0 right-0 left-auto top-auto h-full max-h-full w-full max-w-md translate-x-0 translate-y-0 rounded-lg border-l border-border-subtle p-0">
        <div className="flex h-full flex-col gap-3 overflow-y-auto p-6">
          <DialogTitle className="flex flex-wrap items-center gap-2 text-base">
            <AssignmentStateBadge state={row.state} />
            <span className="font-mono text-xs text-foreground-muted">
              #{row.id} · {row.task_id}
            </span>
          </DialogTitle>

          <Link
            to={withReturn(
              `/tasks/${encodeURIComponent(row.task_id)}?tab=execution`,
              location.pathname,
              location.search,
            )}
            className="text-sm font-medium text-foreground underline-offset-2 hover:text-iris-bright hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            {t("agents.drawer.openTask", { id: row.task_id })}
          </Link>

          {/* Phase timeline — server timestamps verbatim. */}
          <section aria-label={t("agents.drawer.timelineLabel")}>
            <h3 className="text-xs font-medium text-foreground-secondary">
              {t("agents.drawer.timelineLabel")}
            </h3>
            <ol className="mt-1 space-y-1">
              {timeline.map((entry) => (
                <li
                  key={entry.key}
                  className={
                    "flex items-baseline justify-between gap-3 border-l-2 pl-2 text-sm " +
                    (entry.stamp ? "border-iris-bright/50" : "border-border-subtle")
                  }
                >
                  <span className={entry.stamp ? "" : "text-foreground-muted"}>
                    {t(entry.key)}
                  </span>
                  <span className="whitespace-nowrap font-mono text-xs text-foreground-muted">
                    {entry.stamp ? formatTaskDate(entry.stamp, lang) : "—"}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          {/* Identity — declared, unverified (§2.2). */}
          <section aria-label={t("agents.drawer.identityLabel")}>
            <h3 className="text-xs font-medium text-foreground-secondary">
              {t("agents.drawer.identityLabel")}
            </h3>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              {row.claimed_by ? (
                <Badge variant="outline" title={t("agents.identity.tooltip")} className="font-normal">
                  {t("agents.identity.reportedBy", { who: row.claimed_by })}
                </Badge>
              ) : (
                <span className="text-foreground-muted">
                  {t("agents.drawer.identityNone")}
                </span>
              )}
              {row.claimed_by_executor ? (
                <span className="text-xs text-foreground-secondary">
                  {executorName(row.claimed_by_executor)}
                </span>
              ) : null}
            </p>
          </section>

          {/* Envelope preview — reconstructed from API fields. */}
          <section aria-label={t("agents.drawer.envelopeLabel")}>
            <h3 className="text-xs font-medium text-foreground-secondary">
              {t("agents.drawer.envelopeLabel")}
            </h3>
            <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-md border border-border-subtle bg-well p-2 font-mono text-xs leading-relaxed text-foreground-secondary">
              {`[GCW ASSIGNMENT task:${row.task_id} specialist:${row.specialist} harness:${row.harness}]\nMODE: ${row.harness}\nspec: ${row.spec_hash || "—"}`}
            </pre>
            {row.routing?.resolved ? (
              <p className="mt-1 text-xs text-foreground-secondary">
                {t("agents.routing.resolvedRow", {
                  name: executorName(row.routing.resolved),
                  reason: t(routingReasonKey(row.routing.reason)),
                })}
              </p>
            ) : (
              <p className="mt-1 text-xs text-foreground-muted">
                {t("agents.routing.unmatchedRow")}
              </p>
            )}
          </section>

          {/* Final report preview (last final of the task, honest supersede). */}
          <section aria-label={t("agents.drawer.reportLabel")}>
            <h3 className="text-xs font-medium text-foreground-secondary">
              {t("agents.drawer.reportLabel")}
            </h3>
            {reports.isPending ? (
              <p className="mt-1 text-xs text-foreground-muted">
                {t("agents.drawer.reportLoading")}
              </p>
            ) : lastFinal ? (
              /* UI-27 + owner clamp directive: the report preview is author
               * text — through the TextEngine primitive with the measured
               * clamp. Replaces the hard 4-line CSS cut: long finals get the
               * inline «показать полностью» expand instead of an unreadable
               * truncation. */
              <div className="mt-1 rounded-md border border-border-subtle bg-well p-2 text-xs text-foreground-secondary">
                <TextEngine text={lastFinal.body} variant="compact" clamp />
              </div>
            ) : (
              <p className="mt-1 text-xs text-foreground-muted">
                {t("agents.drawer.reportNone")}
              </p>
            )}
          </section>

          <div className="mt-auto flex justify-end gap-2">
            {row.state === "failed" || row.state === "expired" ? (
              <Button variant="outline" size="sm" onClick={() => onRetry(row)}>
                {t("agents.retry.label")}
              </Button>
            ) : null}
            {ACTIVE_ASSIGNMENT_STATES.includes(row.state) ? (
              <Button variant="outline" size="sm" onClick={() => onCancel(row)}>
                <XCircle className="size-4" aria-hidden="true" />
                {t("agents.cancel.label")}
              </Button>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
