import { useParams } from "react-router";
import { EmptyState } from "@/components/EmptyState/EmptyState";

/**
 * `/memories/:id` — single memory scroll view (architecture.md §3).
 * TODO(T5): wire `useMemory` + the scroll treatment (design-system.md §8.3).
 */
export function MemoryDetailPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <section aria-labelledby="memory-title" className="space-y-4">
      <h1 id="memory-title" className="text-xl font-semibold">
        Memory
      </h1>
      {id ? (
        <p className="text-sm text-foreground-secondary">
          Scroll view for <code>{id}</code> lands in task T5 (features/memory-detail).
        </p>
      ) : (
        <EmptyState variant="error" title="No memory id in route" />
      )}
    </section>
  );
}
