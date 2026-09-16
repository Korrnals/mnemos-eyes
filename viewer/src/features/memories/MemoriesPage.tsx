/**
 * `/memories` — paginated memory list (architecture.md §3).
 * TODO(T5): wire `useMemories` + MemoryCard grid + URL-param filters.
 */
export function MemoriesPage() {
  return (
    <section aria-labelledby="memories-title" className="space-y-4">
      <h1 id="memories-title" className="text-xl font-semibold">
        Memories
      </h1>
      <p className="text-sm text-foreground-secondary">
        Memory list is implemented in task T5 (features/memories).
      </p>
    </section>
  );
}
