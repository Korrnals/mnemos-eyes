import { useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { MemoryCard } from "@/components/MemoryCard/MemoryCard";
import { MemoryCardSkeleton } from "@/components/skeletons/Skeletons";
import { Button } from "@/components/ui/button";
import { useMemories } from "@/hooks/useMemories";
import {
  DEFAULT_PAGE_SIZE,
  MEMORY_STATUSES,
  PAGE_SIZES,
  hasActiveFilters,
  parseMemoryListParams,
  toListParams,
} from "./listParams";
import { useProjectOptions } from "./useProjectOptions";

/**
 * `/memories` — paginated, filterable memory list (component-inventory §4).
 * Filters and pagination live in URL params: `?status=&project=&limit=&page=`.
 */
export function MemoriesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const state = parseMemoryListParams(searchParams);
  const projects = useProjectOptions();
  const list = useMemories(toListParams(state));

  const patch = (changes: Partial<{ status: string; project: string; limit: number; page: number }>) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const merged = { ...parseMemoryListParams(prev), ...changes };
        // Any filter/page change resets to the first page, except page itself.
        if (!("page" in changes)) merged.page = 1;
        if (merged.status) next.set("status", merged.status);
        else next.delete("status");
        if (merged.project) next.set("project", merged.project);
        else next.delete("project");
        if (merged.limit !== DEFAULT_PAGE_SIZE) next.set("limit", String(merged.limit));
        else next.delete("limit");
        if (merged.page > 1) next.set("page", String(merged.page));
        else next.delete("page");
        return next;
      },
      { replace: false },
    );
  };

  const memories = list.data ?? [];
  const canGoNext = !list.isPending && memories.length === state.limit;
  const canGoPrev = state.page > 1;
  const rangeStart = memories.length === 0 ? 0 : (state.page - 1) * state.limit + 1;
  const rangeEnd = (state.page - 1) * state.limit + memories.length;
  const filtered = hasActiveFilters(state);

  return (
    <section aria-labelledby="memories-title" className="mx-auto max-w-3xl space-y-4">
      <h1 id="memories-title" className="text-xl font-semibold">
        Memories
      </h1>

      {/* Filters (inventory §4: status / project / limit as URL params).
       * Deliberately not role="search" — it filters the list, it does not search. */}
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label="Filter memories"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex flex-col gap-1">
          <label htmlFor="memories-status" className="text-xs text-foreground-secondary">
            Status
          </label>
          <select
            id="memories-status"
            value={state.status ?? ""}
            onChange={(event) => patch({ status: event.target.value || undefined })}
            className="h-9 rounded-md border border-border bg-well px-2 text-sm text-foreground focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            <option value="">All statuses</option>
            {MEMORY_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="memories-project" className="text-xs text-foreground-secondary">
            Project
          </label>
          <select
            id="memories-project"
            value={state.project ?? ""}
            onChange={(event) => patch({ project: event.target.value || undefined })}
            className="h-9 rounded-md border border-border bg-well px-2 text-sm text-foreground focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project} value={project}>
                {project}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor="memories-limit" className="text-xs text-foreground-secondary">
            Per page
          </label>
          <select
            id="memories-limit"
            value={String(state.limit)}
            onChange={(event) => patch({ limit: Number(event.target.value) })}
            className="h-9 rounded-md border border-border bg-well px-2 text-sm text-foreground focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
      </form>

      {list.isPending ? (
        <div role="status" aria-label="Loading memories">
          <MemoryCardSkeleton count={4} />
        </div>
      ) : list.isError ? (
        <EmptyState
          variant="error"
          title="Could not load memories"
          message={list.error.message}
          action={
            <Button variant="outline" onClick={() => void list.refetch()}>
              Retry
            </Button>
          }
        />
      ) : memories.length === 0 ? (
        filtered ? (
          <EmptyState
            variant="empty"
            title="No memories match these filters"
            message="Loosen the status or project filter to surface more of the well."
            action={
              <Button variant="outline" onClick={() => patch({ status: undefined, project: undefined })}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            variant="empty"
            title="The well is empty"
            message="mnemos holds no memories yet."
          />
        )
      ) : (
        <>
          <ul className="grid gap-4">
            {memories.map((memory) => (
              <li key={memory.id}>
                <MemoryCard memory={memory} />
              </li>
            ))}
          </ul>
          <nav aria-label="Memory list pages" className="flex items-center justify-between">
            <Button variant="outline" size="sm" disabled={!canGoPrev} onClick={() => patch({ page: state.page - 1 })}>
              <ChevronLeft className="size-4" aria-hidden="true" /> Prev
            </Button>
            <p aria-live="polite" className="text-xs text-foreground-secondary">
              Showing {rangeStart}–{rangeEnd}
            </p>
            <Button variant="outline" size="sm" disabled={!canGoNext} onClick={() => patch({ page: state.page + 1 })}>
              Next <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </nav>
        </>
      )}
    </section>
  );
}
