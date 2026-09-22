import { useT, type TranslationKey } from "@/i18n";
import { BAND_CHUNK } from "./model";
import type { BandKey, BandSection } from "./model";
import { ChipSection, FamilyRow } from "./TagSections";

/**
 * Вид «частоты» (UI-17 spec §2.1): the start view. Vertical log₁₀ band
 * sections (drop-empty), each capped at 24 chips with the «Ещё N / Показать
 * все» controls; the family chip-row rides on top as the taxonomy entry
 * point. DOM budget: ≤ 4 sections × 24 chips + row ≈ ~110 interactive nodes
 * at ANY corpus size (§3.3) — gated by a test on the 611-tag fixture.
 */

const BAND_TITLE: Record<BandKey, TranslationKey> = {
  core: "tags.band.core",
  frequent: "tags.band.frequent",
  middle: "tags.band.middle",
  rare: "tags.band.rare",
};

const BAND_SIZE: Record<BandKey, "core" | "frequent" | "middle" | "rare"> = {
  core: "core",
  frequent: "frequent",
  middle: "middle",
  rare: "rare",
};

export interface TagCloudViewProps {
  bands: BandSection[];
  families: { prefix: string; tagCount: number }[];
  selectedFamily?: string;
  familyVisible: number;
  /** Resolved visible counts per band key (page owns the URL state). */
  visible: Record<string, number>;
  onTagClick: (tag: string) => void;
  onFamilySelect: (prefix: string | undefined) => void;
  onBandMore: (capKey: string, next: number) => void;
  onBandShowAll: (capKey: string, total: number) => void;
  onBandCollapse: (capKey: string) => void;
  onFamilyMore: (next: number) => void;
  onFamilyShowAll: (total: number) => void;
  onFamilyCollapse: () => void;
}

export function TagCloudView({
  bands,
  families,
  selectedFamily,
  familyVisible,
  visible,
  onTagClick,
  onFamilySelect,
  onBandMore,
  onBandShowAll,
  onBandCollapse,
  onFamilyMore,
  onFamilyShowAll,
  onFamilyCollapse,
}: TagCloudViewProps) {
  const t = useT();
  return (
    <div className="space-y-6">
      <FamilyRow
        families={families}
        selected={selectedFamily}
        visible={familyVisible}
        onMore={onFamilyMore}
        onShowAll={onFamilyShowAll}
        onCollapse={onFamilyCollapse}
        onSelect={onFamilySelect}
      />
      {bands.map((band, index) => (
        <ChipSection
          key={band.key}
          id={`band-${band.key}`}
          title={t(BAND_TITLE[band.key])}
          count={band.tags.length}
          chips={band.tags}
          visible={visible[band.key] ?? Math.min(BAND_CHUNK, band.tags.length)}
          capKey={band.key}
          size={BAND_SIZE[band.key]}
          onTagClick={onTagClick}
          onMore={onBandMore}
          onShowAll={onBandShowAll}
          onCollapse={onBandCollapse}
          staggerIndex={index}
        />
      ))}
    </div>
  );
}
