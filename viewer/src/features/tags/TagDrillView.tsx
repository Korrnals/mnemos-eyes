import { Link, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { MemoryCard } from "@/components/MemoryCard/MemoryCard";
import { MemoryCardSkeleton } from "@/components/skeletons/Skeletons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/gateway/GatewayContext";
import { useMemories } from "@/hooks/useMemories";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";
import { withReturn } from "@/lib/returnParams";
import { useT } from "@/i18n";
import type { TagSummary } from "@/gateway/types";
import { familyOf, siblingTags } from "./model";
import { TagBreadcrumbs } from "./TagSections";
import { TagChip } from "./TagChip";

/**
 * Дрилл по тегу — Ур.4 матрёшки (UI-17 spec §5): tasks come from the SERVER
 * drill endpoint; memories come from the HONEST TAG LISTING —
 * `listMemories({ tags })` (the wire `GET /memories?tags=`, live since
 * 1.3.2). BE-13: a listing is not a search — same rows, same order and same
 * coverage as the «Записи» list narrowed by the tag, no ranker truncation.
 * Header count still comes from the FULL /api/tags aggregate.
 */

/** Memory budget of the drill section (matches the old drill wire limit). */
const DRILL_MEMORY_LIMIT = 12;

export interface TagDrillViewProps {
  tag: string;
  /** Full tag list snapshot (header count + sibling strip). */
  cloudTags: TagSummary[];
  onBack: () => void;
  /** Open the family taxonomy view for this tag's family. */
  onFamilyOpen: (prefix: string) => void;
  /** Switch the drill to another tag (sibling strip, breadcrumbs). */
  onTagSelect: (tag: string) => void;
}

export function TagDrillView({
  tag,
  cloudTags,
  onBack,
  onFamilyOpen,
  onTagSelect,
}: TagDrillViewProps) {
  const t = useT();
  const gateway = useGateway();
  // UI-18 pairs 5+11 (cross-domain source): the WHOLE drill URL (?tag= plus
  // family/expansion state) rides as `return=` on every task and memory link
  // — the back control on the detail page leads back into this exact drill.
  const location = useLocation();
  const drill = useQuery({
    queryKey: keys.tags.drill(tag),
    queryFn: ({ signal }) => gateway.drillTag(tag, { limit: DRILL_MEMORY_LIMIT }, signal),
    staleTime: STALE_TIMES.tags,
    gcTime: GC_TIMES.tags,
  });
  // BE-13: the memories section is the honest LISTING, not the drill's
  // search-ranked subset. Same adapter method the /memory list uses — the
  // rows the drill shows are literally the rows `?tag=` lists.
  const memories = useMemories({ tags: tag, limit: DRILL_MEMORY_LIMIT });
  const listed = memories.data ?? [];

  const count = cloudTags.find((entry) => entry.tag === tag)?.count;
  const family = familyOf(tag);
  const familyLabel = family === "" ? t("tags.family.bare") : family;
  const siblings = siblingTags(cloudTags, tag);
  const segments = tag.split(":");
  const secondSegment = segments.length >= 3 ? segments[1] : null;
  const tasks = drill.data?.tasks ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden="true" /> {t("tags.all")}
        </Button>
        <TagBreadcrumbs
          crumbs={[
            ...(family !== ""
              ? [{ label: family, onClick: () => onFamilyOpen(family) }]
              : []),
            { label: tag, mono: true },
          ]}
        />
      </div>

      <header className="space-y-1">
        <h1
          id="tag-drill-title"
          className="flex flex-wrap items-baseline gap-3 font-mono text-xl font-semibold"
        >
          {tag}
          {count !== undefined ? (
            <span className="font-ui text-sm font-normal text-foreground-secondary">
              {count}
            </span>
          ) : null}
        </h1>
        <button
          type="button"
          onClick={() => onFamilyOpen(family)}
          aria-label={`${t("tags.family.all")}: ${familyLabel}`}
          className="inline-flex min-h-6 items-center rounded-sm border border-border-subtle bg-well px-2 py-0.5 text-xs text-foreground-secondary transition-colors duration-instant hover:bg-elevated focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
        >
          {familyLabel}
        </button>
      </header>

      {siblings.length > 0 ? (
        <section aria-labelledby="tag-siblings">
          <h2 id="tag-siblings" className="text-sm font-medium text-foreground">
            {t("tags.drill.siblings", { family: familyLabel })}
          </h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {siblings.map((sibling) => (
              <TagChip
                key={sibling.tag}
                tag={sibling.tag}
                count={sibling.count}
                size="flat"
                onClick={() => onTagSelect(sibling.tag)}
              />
            ))}
          </ul>
          {secondSegment ? (
            <Button
              variant="link"
              size="sm"
              className="mt-1 px-0"
              onClick={() => onFamilyOpen(`${family}:${secondSegment}`)}
            >
              {t("tags.group.heading", { group: secondSegment })}
            </Button>
          ) : null}
        </section>
      ) : null}

      {drill.data && drill.data.errors.length > 0 ? (
        <p role="alert" className="text-xs text-warning">
          {t("tags.drill.storeErrors", {
            servers: drill.data.errors.map((error) => error.server ?? "?").join(", "),
          })}
        </p>
      ) : null}

      {drill.isPending ? (
        <div role="status" aria-label={t("tags.loading")}>
          <MemoryCardSkeleton count={3} />
        </div>
      ) : drill.isError ? (
        <EmptyState
          variant="error"
          title={t("tags.loadFailed")}
          message={drill.error instanceof Error ? drill.error.message : undefined}
          action={
            <Button variant="outline" onClick={() => void drill.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : (
        <>
          <section aria-labelledby="tag-drill-tasks">
            <h2 id="tag-drill-tasks" className="text-sm font-medium text-foreground">
              {t("tags.drill.tasks")}
              {tasks.length > 0 ? ` · ${tasks.length}` : ""}
            </h2>
            {tasks.length === 0 ? (
              <p className="mt-1 text-xs text-foreground-secondary">
                {t("tags.drill.tasksEmpty")}
              </p>
            ) : (
              <ul className="mt-2 grid gap-2">
                {tasks.map((task) => (
                  <li key={task.id}>
                    <Link
                      to={withReturn(
                        `/tasks/${encodeURIComponent(task.id)}`,
                        location.pathname,
                        location.search,
                      )}
                      className="flex min-h-6 flex-wrap items-center gap-2 rounded-sm text-sm text-foreground-secondary transition-colors duration-instant hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
                    >
                      <span className="font-mono text-xs text-iris-bright">
                        {task.id}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{task.title}</span>
                      <Badge variant="outline">{task.col}</Badge>
                      {task.env ? <Badge variant="outline">{task.env}</Badge> : null}
                      {task.agents.slice(0, 3).map((agent) => (
                        <Badge key={agent} variant="default">
                          {agent}
                        </Badge>
                      ))}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="tag-drill-memories">
            <h2 id="tag-drill-memories" className="text-sm font-medium text-foreground">
              {t("tags.drill.memories")}
              {listed.length > 0 ? ` · ${listed.length}` : ""}
            </h2>
            {memories.isPending ? (
              <div role="status" aria-label={t("tags.loading")} className="mt-2">
                <MemoryCardSkeleton count={2} />
              </div>
            ) : memories.isError ? (
              <EmptyState
                variant="error"
                title={t("tags.loadFailed")}
                message={memories.error instanceof Error ? memories.error.message : undefined}
                action={
                  <Button
                    variant="outline"
                    onClick={() => void memories.refetch()}
                  >
                    {t("common.retry")}
                  </Button>
                }
              />
            ) : listed.length === 0 ? (
              <p className="mt-1 text-xs text-foreground-secondary">
                {t("tags.nothingCarries")}
              </p>
            ) : (
              <ul className="mt-2 grid gap-4">
                {listed.map((memory) => (
                  <li key={memory.id}>
                    <MemoryCard
                      memory={memory}
                      returnSource={{
                        pathname: location.pathname,
                        search: location.search,
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Link
            to={`/memory?tag=${encodeURIComponent(tag)}`}
            className="inline-flex min-h-6 items-center gap-1 rounded-sm text-sm text-iris-bright transition-colors duration-instant hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
          >
            {t("tags.drill.openInMemories")}
            <ExternalLink className="size-4" aria-hidden="true" />
          </Link>
        </>
      )}
    </div>
  );
}
