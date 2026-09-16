/**
 * `/status` — health, counts, pipeline status (architecture.md §3).
 * TODO(T5): wire `useStatus` + `useMetrics`, StatusIndicator panel.
 */
export function StatusPage() {
  return (
    <section aria-labelledby="status-title" className="space-y-4">
      <h1 id="status-title" className="text-xl font-semibold">
        Status
      </h1>
      <p className="text-sm text-foreground-secondary">
        Health panel is implemented in task T5 (features/status).
      </p>
    </section>
  );
}
