import { useParams } from "react-router";
import { EmptyState } from "@/components/EmptyState/EmptyState";

/**
 * `/sessions/:id` — A2A session detail (architecture.md §3).
 * TODO(T5): wire `useSession`.
 */
export function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <section aria-labelledby="session-title" className="space-y-4">
      <h1 id="session-title" className="text-xl font-semibold">
        A2A session
      </h1>
      {id ? (
        <p className="text-sm text-foreground-secondary">
          Detail view for <code>{id}</code> lands in task T5.
        </p>
      ) : (
        <EmptyState variant="error" title="No session id in route" />
      )}
    </section>
  );
}
