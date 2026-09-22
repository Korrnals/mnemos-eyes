import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { BAND_CHUNK, capControls } from "./model";
import { TagChip, type TagChipSize } from "./TagChip";
import "./tags-cloud.css";

/**
 * Shared section primitives of the tags cloud (UI-17 spec §3.3/§4): a
 * capped chip section (typography, not cards — ▌ marker + label + live
 * counter), the cap controls («Показать все / Ещё 24 / Свернуть» with
 * aria-expanded), the family chip-row (the single allowed horizontal
 * scroller, §4.2 reflow) and the in-page breadcrumb trail. layout/ is
 * frozen this wave, so the trail renders in-page with the same semantics
 * (nav > ol > li, aria-current) as the shell Breadcrumbs.
 */

export interface ChipSectionProps {
  /** Stable ids: heading id, list id (aria-labelledby / aria-controls). */
  id: string;
  /** Section title (already translated). */
  title: string;
  /** Counter value — «{{count}} тегов». */
  count: number;
  /** The section's tags, already sorted; only `visible` render. */
  chips: readonly { tag: string; count: number }[];
  visible: number;
  /** Cap-expansion key in the URL state (band key or group prefix). */
  capKey: string;
  size?: TagChipSize;
  query?: string;
  heading?: "h2" | "h3";
  /** Makes the heading itself a drill control (taxonomy group → sub-family). */
  onTitleClick?: () => void;
  titleAria?: string;
  /** First-load entrance stagger (§4.4) — index ≤ 3 animates. */
  staggerIndex?: number;
  onTagClick?: (tag: string) => void;
  onMore?: (capKey: string, next: number) => void;
  onShowAll?: (capKey: string, total: number) => void;
  onCollapse?: (capKey: string) => void;
}

export function ChipSection({
  id,
  title,
  count,
  chips,
  visible,
  capKey,
  size = "middle",
  query,
  heading: Heading = "h2",
  onTitleClick,
  titleAria,
  staggerIndex,
  onTagClick,
  onMore,
  onShowAll,
  onCollapse,
}: ChipSectionProps) {
  const t = useT();
  const listId = `${id}-list`;
  const shown = chips.slice(0, visible);
  const controls = capControls(count, visible);
  return (
    <section
      aria-labelledby={id}
      className={cn(
        "space-y-2",
        staggerIndex !== undefined && staggerIndex < 4 && "tags-section-enter",
      )}
      style={
        staggerIndex !== undefined && staggerIndex < 4
          ? { animationDelay: `calc(var(--duration-stagger) * ${staggerIndex})` }
          : undefined
      }
    >
      <div className="flex items-baseline justify-between gap-2">
        <Heading
          id={id}
          className="flex min-w-0 items-baseline gap-2 text-sm font-medium text-foreground"
        >
          <span
            aria-hidden="true"
            className="inline-block h-4 w-0.5 shrink-0 translate-y-0.5 bg-iris-dim"
          />
          {onTitleClick ? (
            <button
              type="button"
              onClick={onTitleClick}
              aria-label={titleAria}
              className="min-h-6 truncate rounded-sm transition-colors duration-instant hover:text-iris-bright focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            >
              {title}
            </button>
          ) : (
            <span className="truncate">{title}</span>
          )}
        </Heading>
        <span className="shrink-0 text-xs text-foreground-secondary">
          {t("tags.family.tags", { count })}
        </span>
      </div>
      <ul id={listId} className="flex flex-wrap gap-2">
        {shown.map((chip) => (
          <TagChip
            key={chip.tag}
            tag={chip.tag}
            count={chip.count}
            size={size}
            query={query}
            onClick={onTagClick ? () => onTagClick(chip.tag) : undefined}
          />
        ))}
      </ul>
      {controls.kind !== "none" ? (
        <div className="flex items-center gap-2">
          {controls.kind === "show-all" && visible < count ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={visible > BAND_CHUNK}
              aria-controls={listId}
              onClick={() => onShowAll?.(capKey, count)}
            >
              {t("tags.band.showAll", { count })}
            </Button>
          ) : null}
          {controls.kind === "incremental" && visible < count ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={visible > BAND_CHUNK}
              aria-controls={listId}
              onClick={() => onMore?.(capKey, visible + BAND_CHUNK)}
            >
              {t("tags.band.showMore", {
                count: Math.min(BAND_CHUNK, count - visible),
              })}
            </Button>
          ) : null}
          {controls.collapsible ? (
            // The list IS expanded while this control is visible — the
            // disclosure state every cap control reports about `listId`.
            <Button
              variant="ghost"
              size="sm"
              aria-expanded
              aria-controls={listId}
              onClick={() => onCollapse?.(capKey)}
            >
              {t("tags.band.collapse")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export interface FamilyRowProps {
  /** (prefix | "") families, sorted by tag count DESC. */
  families: readonly { prefix: string; tagCount: number }[];
  /** Currently selected family prefix (undefined = «Все семейства»). */
  selected?: string;
  visible: number;
  onMore: (next: number) => void;
  onShowAll: (total: number) => void;
  onCollapse: () => void;
  onSelect: (prefix: string | undefined) => void;
}

/**
 * Family chip-row (§2 Ур.1, built from data). The ONLY horizontally
 * scrollable element on the page (reflow exception §4.2) — with a fade
 * affordance hint via overflow-x-auto + token padding.
 */
export function FamilyRow({
  families,
  selected,
  visible,
  onMore,
  onShowAll,
  onCollapse,
  onSelect,
}: FamilyRowProps) {
  const t = useT();
  const shown = families.slice(0, visible);
  const controls = capControls(families.length, visible);
  return (
    <nav aria-label={t("tags.familyRowLabel")} className="min-w-0">
      <ul className="flex flex-wrap items-center gap-2">
        <li>
          <button
            type="button"
            aria-pressed={selected === undefined}
            onClick={() => onSelect(undefined)}
            className={cn(
              "inline-flex min-h-6 items-center rounded-sm border px-2 py-0.5 text-sm transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
              selected === undefined
                ? "border-transparent bg-iris/15 text-iris-bright"
                : "border-border-subtle bg-well text-foreground-secondary hover:bg-elevated",
            )}
          >
            {t("tags.family.all")}
          </button>
        </li>
        {shown.map((family) => {
          const label = family.prefix === "" ? t("tags.family.bare") : family.prefix;
          const active = selected === family.prefix;
          return (
            <li key={family.prefix || ":"} className="min-w-0">
              <button
                type="button"
                aria-pressed={active}
                aria-label={`${label}, ${t("tags.family.tags", { count: family.tagCount })}`}
                onClick={() => onSelect(family.prefix)}
                className={cn(
                  "inline-flex min-h-6 max-w-[16rem] items-center truncate rounded-sm border px-2 py-0.5 text-sm transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
                  active
                    ? "border-transparent bg-iris/15 text-iris-bright"
                    : "border-border-subtle bg-well text-foreground-secondary hover:bg-elevated",
                )}
              >
                <span className="truncate">{label}</span>
                <span
                  aria-hidden="true"
                  className="ml-1 shrink-0 font-ui text-xs text-foreground-secondary"
                >
                  {family.tagCount}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {controls.kind !== "none" ? (
        <div className="mt-1 flex items-center gap-2">
          {controls.kind === "show-all" && visible < families.length ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={visible > BAND_CHUNK}
              onClick={() => onShowAll(families.length)}
            >
              {t("tags.band.showAll", { count: families.length })}
            </Button>
          ) : null}
          {controls.kind === "incremental" && visible < families.length ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={visible > BAND_CHUNK}
              onClick={() => onMore(visible + BAND_CHUNK)}
            >
              {t("tags.band.showMore", {
                count: Math.min(BAND_CHUNK, families.length - visible),
              })}
            </Button>
          ) : null}
          {controls.collapsible ? (
            <Button variant="ghost" size="sm" onClick={onCollapse}>
              {t("tags.band.collapse")}
            </Button>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}

export interface Crumb {
  label: string;
  /** Click target; the last crumb renders plain with aria-current. */
  onClick?: () => void;
  mono?: boolean;
}

/** In-page breadcrumb trail (§2.2) — shell layout is frozen this wave. */
export function TagBreadcrumbs({ crumbs }: { crumbs: Crumb[] }) {
  const t = useT();
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label={t("tags.familyRowLabel")} className="min-w-0">
      <ol className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li
              key={`${crumb.label}-${index}`}
              className="flex min-w-0 items-center gap-1"
            >
              {index > 0 ? (
                <ChevronRight
                  className="size-3.5 shrink-0 text-foreground-muted"
                  aria-hidden="true"
                />
              ) : null}
              {crumb.onClick && !last ? (
                <button
                  type="button"
                  onClick={crumb.onClick}
                  className={cn(
                    "inline-flex min-h-6 items-center truncate rounded-sm text-foreground-secondary transition-colors duration-instant hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright",
                    crumb.mono && "font-mono",
                  )}
                >
                  {crumb.label}
                </button>
              ) : (
                <span
                  aria-current="page"
                  className={cn(
                    "inline-flex min-h-6 items-center truncate font-medium text-foreground",
                    crumb.mono && "font-mono",
                  )}
                >
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
