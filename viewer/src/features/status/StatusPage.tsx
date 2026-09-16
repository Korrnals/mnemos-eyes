import { EmptyState } from "@/components/EmptyState/EmptyState";
import { StatusPanel } from "@/components/StatusPanel/StatusPanel";
import { StatGridSkeleton } from "@/components/skeletons/Skeletons";
import { Button } from "@/components/ui/button";
import { useMetrics, useStatus } from "@/hooks/useStatus";

/**
 * `/status` — system health at a glance (component-inventory §7). Health and
 * metrics load through `useStatus` / `useMetrics`; each half fails and
 * retries independently.
 */
export function StatusPage() {
  const health = useStatus();
  const metrics = useMetrics();

  return (
    <section aria-labelledby="status-title" className="mx-auto max-w-4xl space-y-4">
      <h1 id="status-title" className="text-xl font-semibold">
        Status
      </h1>

      {health.isPending || metrics.isPending ? (
        <div role="status" aria-label="Loading status">
          <StatGridSkeleton />
        </div>
      ) : health.isError ? (
        <EmptyState
          variant={metrics.isError ? "error" : "offline"}
          title="mnemos is unreachable"
          message={health.error.message}
          action={
            <Button variant="outline" onClick={() => void health.refetch()}>
              Retry
            </Button>
          }
        />
      ) : metrics.isError ? (
        <EmptyState
          variant="error"
          title="Health is fine, metrics are not"
          message={metrics.error.message}
          action={
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void metrics.refetch()}>
                Retry metrics
              </Button>
              <Button variant="ghost" onClick={() => void health.refetch()}>
                Refresh health
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
