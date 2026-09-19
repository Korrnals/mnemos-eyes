import { EmptyState } from "@/components/EmptyState/EmptyState";
import { StatusPanel } from "@/components/StatusPanel/StatusPanel";
import { StatGridSkeleton } from "@/components/skeletons/Skeletons";
import { Button } from "@/components/ui/button";
import { useMetrics, useStatus } from "@/hooks/useStatus";
import { isApiError } from "@/lib/errors";
import { useAuth } from "@/features/auth/AuthContext";
import { useT } from "@/i18n";

/**
 * `/status` — system health at a glance (component-inventory §7). Health and
 * metrics load through `useStatus` / `useMetrics`; each half fails and
 * retries independently.
 *
 * Board mode (owner feedback 1.4.0): the merge-API declares /metrics
 * unsupported (501) — that is an honest "not available in board mode" state,
 * not an error, so it renders the empty variant with a plain explanation.
 */
export function StatusPage() {
  const t = useT();
  const { adapterMode } = useAuth();
  const health = useStatus();
  const metrics = useMetrics();

  const metricsBoardUnavailable =
    adapterMode === "board" &&
    metrics.isError &&
    isApiError(metrics.error) &&
    metrics.error.status === 501;

  return (
    <section aria-labelledby="status-title" className="mx-auto max-w-4xl space-y-4">
      <h1 id="status-title" className="text-xl font-semibold">
        {t("status.title")}
      </h1>

      {health.isPending || metrics.isPending ? (
        <div role="status" aria-label={t("status.loading")}>
          <StatGridSkeleton />
        </div>
      ) : health.isError ? (
        <EmptyState
          variant={metrics.isError ? "error" : "offline"}
          title={t("status.unreachable")}
          message={health.error.message}
          action={
            <Button variant="outline" onClick={() => void health.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : metricsBoardUnavailable ? (
        <EmptyState
          variant="empty"
          title={t("status.metricsBoardUnavailable")}
          message={t("status.metricsBoardMessage")}
          detail={metrics.error.message}
        />
      ) : metrics.isError ? (
        <EmptyState
          variant="error"
          title={t("status.metricsBroken")}
          message={metrics.error.message}
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void metrics.refetch()}>
                {t("status.retryMetrics")}
              </Button>
              <Button variant="ghost" onClick={() => void health.refetch()}>
                {t("status.refreshHealth")}
              </Button>
            </div>
          }
        />
      ) : (
        <StatusPanel health={health.data} metrics={metrics.data} />
      )}
    </section>
  );
}
