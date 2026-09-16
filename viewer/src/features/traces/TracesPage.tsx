/**
 * `/traces` — pipeline trace list (architecture.md §3).
 * TODO(T5): wire `useTraces` (filter by task label).
 */
export function TracesPage() {
  return (
    <section aria-labelledby="traces-title" className="space-y-4">
      <h1 id="traces-title" className="text-xl font-semibold">
        Traces
      </h1>
      <p className="text-sm text-foreground-secondary">
        Traces view is implemented in task T5 (features/traces).
      </p>
    </section>
  );
}
