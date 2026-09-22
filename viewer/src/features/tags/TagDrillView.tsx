import { Link, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { MemoryCard } from "@/components/MemoryCard/MemoryCard";
import { MemoryCardSkeleton } from "@/components/skeletons/Skeletons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";
import { withReturn } from "@/lib/returnParams";
import { useT } from "@/i18n";
import type { TagSummary } from "@/gateway/types";
import type { TagDrillMemory } from "@/gateway/boardTypes";
import { familyOf, siblingTags } from "./model";
import { TagBreadcrumbs } from "./TagSections";
import { TagChip } from "./TagChip";

/**
 * Дрилл по тегу — Ур.4 матрёшки (UI-17 spec §5): the SERVER drill endpoint
 * (tasks + memories; replaces the old client-side 500-row filter that lost
 * everything beyond the fresh window and never saw the board). BE-13
 * honesty: memories ride the search ranker → the subset note stays until
 * the server closes BE-13. Header count comes from the FULL /api/tags
 * aggregate, so the subset gap is visible, not hidden.
 */

function drillMemoryToCard(memory: TagDrillMemory): {
  memory: Parameters<typeof MemoryCard>[0]["memory"];
  server: string | null;
} {
  return {
    memory: {
      id: memory.id,
      title: memory.title,
      content: memory.excerpt,
      tags: [...memory.tags],
      // Pass the server status through verbatim — a silent "raw" default
      // would fabricate a lifecycle state the server never sent (review
      // P3). Unknown values land in statusLabelKey's default branch.
      status: memory.status as Parameters<typeof MemoryCard>[0]["memory"]["status"],
      project: "",
      agent: "",
      memory_type: "note",
      source: "manual",
      created_at: memory.created_at ?? "",
      updated_at: "",
      marker_version: 1,
    },
    server: memory.server ?? null,
  };
}

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
    queryFn: ({ signal }) => gateway.drillTag(tag, { limit: 12 }, signal),
    staleTime: STALE_TIMES.tags,
    gcTime: GC_TIMES.tags,
  });

  const count = cloudTags.find((entry) => entry.tag === tag)?.count;
  const family = familyOf(tag);
  const familyLabel = family === "" ? t("tags.family.bare") : family;
  const siblings = siblingTags(cloudTags, tag);
  const segments = tag.split(":");
  const secondSegment = segments.length >= 3 ? segments[1] : null;
  const memories = drill.data?.memories ?? [];
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
              {memories.length > 0 ? ` · ${memories.length}` : ""}
            </h2>
            {memories.length === 0 ? (
              <p className="mt-1 text-xs text-foreground-secondary">
                {t("tags.nothingCarries")}
              </p>
            ) : (
              <ul className="mt-2 grid gap-4">
                {memories.map((memory) => {
                  const card = drillMemoryToCard(memory);
                  return (
                    <li key={memory.id} className="grid gap-1">
                      <MemoryCard
                        memory={card.memory}
                        returnSource={{
                          pathname: location.pathname,
                          search: location.search,
                        }}
                      />
                      {card.server ? (
                        <Badge
                          variant="outline"
                          className="w-fit"
                          aria-label={`${t("memory.sourceLabel")} ${card.server}`}
                        >
                          {card.server}
                        </Badge>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {/* Spec §6: the BE-13 subset note rides BOTH branches — an empty
             * drill is still a subset, the honest caveat never disappears. */}
            <p className="mt-2 text-xs text-foreground-muted">
              {t("tags.drill.subsetNote")}
            </p>
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
