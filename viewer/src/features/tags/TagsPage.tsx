import { useSearchParams } from "react-router";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { Button } from "@/components/ui/button";
import { TagFilterInput } from "@/components/TagInspector/TagInspector";
import { useT } from "@/i18n";
import {
  buildBands,
  buildFamilies,
  buildTaxonomy,
  filterAndRankTags,
  formatStatsTime,
  parseTagsUrlState,
  SEARCH_CAP,
  sectionVisibleCount,
  updateTagsUrl,
} from "./model";
import type { TagsUrlState } from "./model";
import { useTagsCloud } from "./useTagsCloud";
import { TagCloudView } from "./TagCloudView";
import { TagTaxonomyView } from "./TagTaxonomyView";
import { TagDrillView } from "./TagDrillView";
import { TagBreadcrumbs } from "./TagSections";
import { TagChip } from "./TagChip";

/**
 * `/memory/tags` — облако тегов по диапазонам + матрёшка-дрилл (UI-17,
 * spec 2026-09-21-tags-cloud-spec). Весь список-стейт живёт в URL
 * (`?tag= / ?family= / ?q= / ?b= / ?f=`): back-навигация восстанавливает
 * фильтр, семейство, раскрытия и дрилл (§2.2), а refetch/SSE-шум не может
 * их сбросить (freeze-рамка §4.4 — урок 1.11.4). Composition всегда идёт
 * по снапшоту фетча: реконсиляция по имени тега, счётчики обновляются тихо.
 */
export function TagsPage() {
  const t = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  const state = parseTagsUrlState(searchParams);

  // Navigation acts (tag/family) push history so browser back walks the
  // matryoshka; in-page list tweaks (filter, expansions) replace — back
  // restores the LIST state without replaying every keystroke.
  const patch = (changes: Partial<TagsUrlState>, replace = false) =>
    setSearchParams((prev) => updateTagsUrl(prev, changes), { replace });

  const cloud = useTagsCloud();

  if (state.tag) {
    return (
      // The drill's mono tag heading IS the page h1 here — one h1 per view;
      // «Теги» stays reachable through the «← Все теги» return.
      <section className="mx-auto max-w-3xl">
        <TagDrillView
          tag={state.tag}
          cloudTags={cloud.tags}
          onBack={() => patch({ tag: undefined })}
          onFamilyOpen={(family) => patch({ tag: undefined, family })}
          onTagSelect={(tag) => patch({ tag })}
        />
      </section>
    );
  }

  const q = state.q.trim();
  const filtering = q.length > 0;
  const activeFamily = state.family;
  const inFamily = activeFamily !== undefined;
  const families = buildFamilies(cloud.tags);
  const bands = buildBands(cloud.tags);
  const matches = filtering ? filterAndRankTags(cloud.tags, q) : [];
  const totalMatches = filtering
    ? cloud.tags.filter((tag) => tag.tag.toLowerCase().includes(q.toLowerCase())).length
    : 0;
  const familyVisible = sectionVisibleCount(families.length, state.familyVisible);

  const resolvedVisible = (key: string, total: number) =>
    sectionVisibleCount(total, state.bandVisible[key]);

  return (
    <section aria-labelledby="tags-title" className="mx-auto max-w-3xl space-y-4">
      <header className="space-y-1">
        <h1 id="tags-title" className="text-xl font-semibold">
          {t("tags.title")}
        </h1>
        {!cloud.isPending && !cloud.isError ? (
          <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-secondary">
            <span>
              {t("tags.statsLine", {
                count: cloud.tags.length,
                time: cloud.dataUpdatedAt ? formatStatsTime(cloud.dataUpdatedAt) : "—",
              })}
            </span>
            {cloud.stats && cloud.stats.errors.length > 0 ? (
              <span
                className="text-warning"
                title={t("tags.partialStores", {
                  servers: cloud.stats.errors
                    .map((error) => error.server ?? "?")
                    .join(", "),
                })}
              >
                ◐{" "}
                {t("tags.partialData", {
                  answered: cloud.stats.serversScanned - cloud.stats.errors.length,
                  total: cloud.stats.serversScanned,
                })}
              </span>
            ) : cloud.stats ? (
              <span
                title={t("tags.partialData", {
                  answered: cloud.stats.serversScanned,
                  total: cloud.stats.serversScanned,
                })}
              >
                ○{" "}
                {t("tags.partialData", {
                  answered: cloud.stats.serversScanned,
                  total: cloud.stats.serversScanned,
                })}
              </span>
            ) : null}
          </div>
        ) : null}
      </header>

      <TagFilterInput
        id="tag-filter"
        value={state.q}
        onChange={(value) => patch({ q: value }, true)}
      />
      {filtering ? (
        <p
          role="status"
          aria-live="polite"
          className="text-xs text-foreground-secondary"
        >
          {t("tags.searchMatches", { count: totalMatches })}
        </p>
      ) : null}

      {inFamily && !filtering ? (
        <TagBreadcrumbs
          crumbs={[
            {
              label: t("tags.family.all"),
              onClick: () => patch({ family: undefined }),
            },
            ...activeFamily.split(":").map((_, index, all) => ({
              label: all.slice(0, index + 1).join(":"),
              onClick:
                index === all.length - 1
                  ? undefined
                  : () => patch({ family: all.slice(0, index + 1).join(":") }),
            })),
          ]}
        />
      ) : null}

      {cloud.isPending ? (
        <TagsCloudSkeleton />
      ) : cloud.isError ? (
        <EmptyState
          variant="error"
          title={t("tags.loadFailed")}
          message={cloud.error?.message}
          action={
            <Button variant="outline" onClick={cloud.refetch}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : cloud.tags.length === 0 ? (
        <EmptyState
          variant="empty"
          title={t("tags.noTags")}
          message={t("tags.noTagsMessage")}
        />
      ) : filtering ? (
        matches.length === 0 ? (
          <EmptyState
            variant="empty"
            title={t("tags.noMatch")}
            message={t("tags.noMatchMessage", { filter: q })}
          />
        ) : (
          <div className="space-y-2">
            <ul className="flex flex-wrap gap-2">
              {matches.map((tag) => (
                <TagChip
                  key={tag.tag}
                  tag={tag.tag}
                  count={tag.count}
                  size="flat"
                  query={q}
                  onClick={() => patch({ tag: tag.tag })}
                />
              ))}
            </ul>
            {totalMatches > SEARCH_CAP ? (
              <p className="text-xs text-foreground-muted">
                {t("tags.searchCapped", { count: SEARCH_CAP })}
              </p>
            ) : null}
          </div>
        )
      ) : inFamily ? (
        <TagTaxonomyView
          family={activeFamily}
          taxonomy={buildTaxonomy(cloud.tags, activeFamily)}
          visible={Object.fromEntries(Object.entries(state.bandVisible))}
          onTagClick={(tag) => patch({ tag })}
          onGroupOpen={(family) => patch({ family })}
          onMore={(capKey, next) =>
            patch({ bandVisible: { ...state.bandVisible, [capKey]: next } }, true)
          }
          onShowAll={(capKey, total) =>
            patch({ bandVisible: { ...state.bandVisible, [capKey]: total } }, true)
          }
          onCollapse={(capKey) => {
            const next = { ...state.bandVisible };
            delete next[capKey];
            patch({ bandVisible: next }, true);
          }}
        />
      ) : (
        <TagCloudView
          bands={bands}
          families={families}
          selectedFamily={undefined}
          familyVisible={familyVisible}
          visible={Object.fromEntries(
            bands.map((band) => [
              band.key,
              resolvedVisible(band.key, band.tags.length),
            ]),
          )}
          onTagClick={(tag) => patch({ tag })}
          onFamilySelect={(family) => patch({ family })}
          onBandMore={(capKey, next) =>
            patch({ bandVisible: { ...state.bandVisible, [capKey]: next } }, true)
          }
          onBandShowAll={(capKey, total) =>
            patch({ bandVisible: { ...state.bandVisible, [capKey]: total } }, true)
          }
          onBandCollapse={(capKey) => {
            const next = { ...state.bandVisible };
            delete next[capKey];
            patch({ bandVisible: next }, true);
          }}
          onFamilyMore={(next) => patch({ familyVisible: next }, true)}
          onFamilyShowAll={(total) => patch({ familyVisible: total }, true)}
          onFamilyCollapse={() => patch({ familyVisible: undefined }, true)}
        />
      )}
    </section>
  );
}

/**
 * Loading state (§6): two section contours + a chip-row contour,
 * role=status, no fake numbers.
 */
function TagsCloudSkeleton() {
  return (
    <div role="status" className="space-y-6" aria-busy="true">
      <div className="flex flex-wrap gap-2" aria-hidden="true">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="h-6 w-20 animate-pulse rounded-sm bg-elevated" />
        ))}
      </div>
      {Array.from({ length: 2 }, (_, section) => (
        <div key={section} className="space-y-2" aria-hidden="true">
          <div className="h-4 w-32 animate-pulse rounded-sm bg-elevated" />
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 8 }, (_, index) => (
              <div
                key={index}
                className="h-6 animate-pulse rounded-sm bg-elevated"
                style={{ width: `${5 + ((index * 13 + section * 7) % 9)}rem` }}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
