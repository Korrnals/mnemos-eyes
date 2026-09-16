/**
 * `/tags` — tag inspector + contract viewer (architecture.md §3).
 * TODO(T5): wire `useTags` (server `GET /tags` via gateway; client-side
 * aggregation fallback per ADR 0003).
 */
export function TagsPage() {
  return (
    <section aria-labelledby="tags-title" className="space-y-4">
      <h1 id="tags-title" className="text-xl font-semibold">
        Tags
      </h1>
      <p className="text-sm text-foreground-secondary">
        Tag inspector is implemented in task T5 (features/tags).
      </p>
    </section>
  );
}
