import { useT } from "@/i18n";
import { BAND_CHUNK } from "./model";
import type { TaxonomyView } from "./model";
import { ChipSection } from "./TagSections";

/**
 * Вид «таксономии» (UI-17 spec §2 Ур.3, the matryoshka's inner level): a
 * family prefix chosen via the family row. Leaf tags of the prefix render
 * as the top group; deeper chains group by the NEXT segment («Группа
 * component:»), groups sorted by mass. Group headings are themselves
 * drillable — the breadcrumbs grow (Все → gcw → gcw:component → …). Same
 * 24-chip caps as the bands (§3.3).
 */

/** Cap key for the family's own leaf chips. */
const LEAVES_KEY = "__leaves";

export interface TagTaxonomyViewProps {
  family: string;
  taxonomy: TaxonomyView;
  /** Resolved visible counts per cap key (leaves under LEAVES_KEY). */
  visible: Record<string, number>;
  onTagClick: (tag: string) => void;
  onGroupOpen: (family: string) => void;
  onMore: (capKey: string, next: number) => void;
  onShowAll: (capKey: string, total: number) => void;
  onCollapse: (capKey: string) => void;
}

export function TagTaxonomyView({
  family,
  taxonomy,
  visible,
  onTagClick,
  onGroupOpen,
  onMore,
  onShowAll,
  onCollapse,
}: TagTaxonomyViewProps) {
  const t = useT();
  const leafLabel = family === "" ? t("tags.family.bare") : family;
  return (
    <div className="space-y-6">
      {taxonomy.leaves.length > 0 ? (
        <ChipSection
          id="family-leaves"
          title={leafLabel}
          count={taxonomy.leaves.length}
          chips={taxonomy.leaves}
          visible={visible[LEAVES_KEY] ?? Math.min(BAND_CHUNK, taxonomy.leaves.length)}
          capKey={LEAVES_KEY}
          size="frequent"
          onTagClick={onTagClick}
          onMore={onMore}
          onShowAll={onShowAll}
          onCollapse={onCollapse}
        />
      ) : null}
      {taxonomy.groups.map((group, index) => (
        <ChipSection
          key={group.family}
          id={`group-${index}`}
          title={t("tags.group.heading", { group: group.label })}
          count={group.tags.length}
          chips={group.tags}
          visible={visible[group.family] ?? Math.min(BAND_CHUNK, group.tags.length)}
          capKey={group.family}
          size="middle"
          heading="h3"
          onTitleClick={() => onGroupOpen(group.family)}
          titleAria={`${t("tags.group.open", { group: group.label })}, ${t("tags.family.tags", { count: group.tags.length })}`}
          onTagClick={onTagClick}
          onMore={onMore}
          onShowAll={onShowAll}
          onCollapse={onCollapse}
        />
      ))}
    </div>
  );
}
