import { useLocation, useSearchParams } from "react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { MemoryCard } from "@/components/MemoryCard/MemoryCard";
import { MemoryCardSkeleton } from "@/components/skeletons/Skeletons";
import { statusLabelKey } from "@/components/memory/memoryBadges";
import { Button } from "@/components/ui/button";
import { useMemories } from "@/hooks/useMemories";
import { useT } from "@/i18n";
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
 * `/memory` — paginated, filterable memory list (component-inventory §4).
 * Filters and pagination live in URL params: `?status=&project=&limit=&page=`.
 */
export function MemoriesPage() {
  const t = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  // UI-18 pair 8: the list URL (filters + page included) rides as `return=`
  // on every card link so the detail's back control leads back into the
  // exact list state (spec §1 pair 8).
  const location = useLocation();
  const state = parseMemoryListParams(searchParams);
  const projects = useProjectOptions();
  const list = useMemories(toListParams(state));

  const patch = (
    changes: Partial<{ status: string; project: string; tag: string; limit: number; page: number }>,
  ) => {
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
        if (merged.tag) next.set("tag", merged.tag);
        else next.delete("tag");
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
        {t("memories.title")}
      </h1>

      {/* Filters (inventory §4: status / project / limit as URL params).
       * Deliberately not role="search" — it filters the list, it does not search. */}
      <form
        className="flex flex-wrap items-end gap-3"
        aria-label={t("memories.filterLabel")}
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="flex flex-col gap-1">
          <label
            htmlFor="memories-status"
            className="text-xs text-foreground-secondary"
          >
            {t("memories.statusLabel")}
          </label>
          <select
            id="memories-status"
            value={state.status ?? ""}
            onChange={(event) => patch({ status: event.target.value || undefined })}
            className="h-9 rounded-md border border-border bg-well px-2 text-sm text-foreground focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            <option value="">{t("memories.allStatuses")}</option>
            {MEMORY_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(statusLabelKey(status))}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label
            htmlFor="memories-project"
            className="text-xs text-foreground-secondary"
          >
            {t("memories.projectLabel")}
          </label>
          <select
            id="memories-project"
            value={state.project ?? ""}
            onChange={(event) => patch({ project: event.target.value || undefined })}
            className="h-9 rounded-md border border-border bg-well px-2 text-sm text-foreground focus-visible:border-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            <option value="">{t("memories.allProjects")}</option>
            {projects.map((project) => (
              <option key={project} value={project}>
                {project}
              </option>
            ))}
          </select>
        </div>

        {state.tag ? (
          <div className="flex flex-col gap-1">
            {/* UI-17 §5.6: an «Открыть в Записях» arrival shows the tag it
             * came from, with a one-click way out (native tag filter). */}
            <span className="text-xs text-foreground-secondary">
              {t("tags.filterLabel")}
            </span>
            <button
              type="button"
              onClick={() => patch({ tag: undefined })}
              aria-label={`${t("tags.filterLabel")}: ${state.tag}`}
              className="inline-flex min-h-9 items-center gap-1 rounded-md border border-border bg-well px-2 text-sm text-foreground-secondary transition-colors duration-instant hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            >
              <span className="font-mono">{state.tag}</span>
              <span aria-hidden="true" className="text-foreground-muted">
                ×
              </span>
            </button>
          </div>
        ) : null}

        <div className="flex flex-col gap-1">
          <label htmlFor="memories-limit" className="text-xs text-foreground-secondary">
            {t("memories.limitLabel")}
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
        <div role="status" aria-label={t("memories.loading")}>
          <MemoryCardSkeleton count={4} />
        </div>
      ) : list.isError ? (
        <EmptyState
          variant="error"
          title={t("memories.loadFailed")}
          message={list.error.message}
          action={
            <Button variant="outline" onClick={() => void list.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : memories.length === 0 ? (
        filtered ? (
          <EmptyState
            variant="empty"
            title={t("memories.noMatch")}
            message={t("memories.noMatchHint")}
            action={
              <Button
                variant="outline"
                onClick={() =>
                  patch({ status: undefined, project: undefined, tag: undefined })
                }
              >
                {t("memories.clearFilters")}
              </Button>
            }
          />
        ) : (
          <EmptyState
            variant="empty"
            title={t("memories.wellEmpty")}
            message={t("memories.wellEmptyHint")}
          />
        )
      ) : (
        <>
          <ul className="grid gap-4">
            {memories.map((memory) => (
              <li key={memory.id}>
                <MemoryCard
                  memory={memory}
                  returnSource={{ pathname: location.pathname, search: location.search }}
                />
              </li>
            ))}
          </ul>
          <nav
            aria-label={t("memories.pagesAria")}
            className="flex items-center justify-between"
          >
            <Button
              variant="outline"
              size="sm"
              disabled={!canGoPrev}
              onClick={() => patch({ page: state.page - 1 })}
            >
              <ChevronLeft className="size-4" aria-hidden="true" /> {t("memories.prev")}
            </Button>
            <p aria-live="polite" className="text-xs text-foreground-secondary">
              {t("memories.showing", { from: rangeStart, to: rangeEnd })}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={!canGoNext}
              onClick={() => patch({ page: state.page + 1 })}
            >
              {t("memories.next")}{" "}
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </nav>
        </>
      )}
    </section>
  );
}
