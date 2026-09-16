import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { MemoryCard } from "@/components/MemoryCard/MemoryCard";
import { MemoryCardSkeleton } from "@/components/skeletons/Skeletons";
import { TagFilterInput, TagInspector } from "@/components/TagInspector/TagInspector";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";
import { useTags } from "@/hooks/useTags";

/**
 * `/tags` — tag inspector + drilldown (component-inventory §6). Counts come
 * from the gateway `listTags` (server `GET /tags` via MockAdapter/HttpAdapter;
 * the ADR-0003 client-side aggregation stays available inside the gateway).
 * Clicking a tag drills down into memories carrying it (`?tag=` URL param) —
 * mnemos has no by-tag list filter, so the drilldown filters a wide fetch
 * client-side and says so.
 */
export function TagsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedTag = searchParams.get("tag");
  const [filter, setFilter] = useState("");

  const tags = useTags();
  const record: Record<string, number> = {};
  for (const { tag, count } of tags.data ?? []) {
    if (filter && !tag.toLowerCase().includes(filter.toLowerCase())) continue;
    record[tag] = count;
  }

  if (selectedTag) {
    return <TagDrilldown tag={selectedTag} />;
  }

  return (
    <section aria-labelledby="tags-title" className="mx-auto max-w-3xl space-y-4">
      <h1 id="tags-title" className="text-xl font-semibold">
        Tags
      </h1>

      <TagFilterInput id="tag-filter" value={filter} onChange={setFilter} />

      {tags.isPending ? (
        <div role="status" aria-label="Loading tags">
          <MemoryCardSkeleton count={2} />
        </div>
      ) : tags.isError ? (
        <EmptyState
          variant="error"
          title="Could not load tags"
          message={tags.error.message}
          action={
            <Button variant="outline" onClick={() => void tags.refetch()}>
              Retry
            </Button>
          }
        />
      ) : (
        <TagInspector
          tags={record}
          onTagClick={(tag) =>
            setSearchParams(
              (prev) => {
                const next = new URLSearchParams(prev);
                next.set("tag", tag);
                return next;
              },
              { replace: false },
            )
          }
        />
      )}

      {!tags.isPending && !tags.isError && Object.keys(record).length === 0 ? (
        <EmptyState
          variant="empty"
          title={filter ? "No tags match" : "No tags yet"}
          message={
            filter
              ? `Nothing matches “${filter}”.`
              : "Tags appear once memories carry them."
          }
        />
      ) : null}
    </section>
  );
}

/**
 * Drilldown: memories carrying the chosen tag, filtered client-side from a
 * wide list fetch (no by-tag endpoint on mnemos — stated on screen).
 */
function TagDrilldown({ tag }: { tag: string }) {
  const [, setSearchParams] = useSearchParams();
  const gateway = useGateway();
  const all = useQuery({
    queryKey: keys.memories.list({ limit: 500 }),
    queryFn: ({ signal }) => gateway.listMemories({ limit: 500 }, signal),
    staleTime: STALE_TIMES.memoriesList,
    gcTime: GC_TIMES.memoriesList,
  });

  const memories = (all.data ?? []).filter((memory) =>
    (memory.tags ?? []).includes(tag),
  );

  return (
    <section aria-labelledby="tag-drilldown-title" className="mx-auto max-w-3xl space-y-4">
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.delete("tag");
              return next;
            },
            { replace: true },
          )
        }
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> All tags
      </Button>
      <h1 id="tag-drilldown-title" className="text-xl font-semibold">
        Memories tagged <span className="text-iris-bright">{tag}</span>
      </h1>
      <p className="text-xs text-foreground-muted">
        Filtered client-side — mnemos has no by-tag list filter (ADR 0003 §9).
      </p>

      {all.isPending ? (
        <div role="status" aria-label="Loading memories">
          <MemoryCardSkeleton count={3} />
        </div>
      ) : all.isError ? (
        <EmptyState
          variant="error"
          title="Could not load memories"
          message={all.error.message}
          action={
            <Button variant="outline" onClick={() => void all.refetch()}>
              Retry
            </Button>
          }
        />
      ) : memories.length === 0 ? (
        <EmptyState
          variant="empty"
          title="Nothing carries this tag"
          message={`No memory is tagged ${tag} right now.`}
        />
      ) : (
        <ul className="grid gap-4">
          {memories.map((memory) => (
            <li key={memory.id}>
              <MemoryCard memory={memory} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
