import { useState } from "react";
import { useParams } from "react-router";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { MemoryScroll } from "@/components/MemoryScroll/MemoryScroll";
import { MemoryScrollSkeleton } from "@/components/skeletons/Skeletons";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/errors";
import { useMemory } from "@/hooks/useMemory";
import { useT } from "@/i18n";

/**
 * `/memory/:id` — the "scroll" detail view (component-inventory §5).
 * `showRaw` toggles the `include_raw` wire flag: the raw variant refetches
 * rather than pretending the payload was already there.
 *
 * UI-18 (spec §3.1): the old in-page «← Все записи» BackLink is gone — the
 * sticky crumb row's back control owns the return now (a validated
 * `?return=` source, else the domain root). One pattern instead of three
 * behaviors.
 */
export function MemoryDetailPage() {
  const t = useT();
  const { id = "" } = useParams<{ id: string }>();
  const [showRaw, setShowRaw] = useState(false);
  const memory = useMemory(id, showRaw);

  if (!id) {
    return <EmptyState variant="error" title={t("memories.noId")} />;
  }

  if (memory.isPending) {
    return (
      <div
        role="status"
        aria-label={t("memories.loadingOne")}
        className="mx-auto max-w-3xl"
      >
        <MemoryScrollSkeleton />
      </div>
    );
  }

  if (memory.isError) {
    const notFound = isApiError(memory.error) && memory.error.status === 404;
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {notFound ? (
          <EmptyState
            variant="not-found"
            title={t("memories.notFoundTitle")}
            message={t("memories.notFoundMessage", { id })}
          />
        ) : (
          <EmptyState
            variant="error"
            title={t("memories.loadOneFailed")}
            message={memory.error.message}
            action={
              <Button variant="outline" onClick={() => void memory.refetch()}>
                {t("common.retry")}
              </Button>
            }
          />
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <MemoryScroll
        memory={memory.data}
        showRaw={showRaw}
        onToggleRaw={() => setShowRaw((value) => !value)}
      />
    </div>
  );
}
