import type { TagSummary } from "@/gateway/types";

/**
 * Pure model of the tags cloud (UI-17, spec 2026-09-21-tags-cloud-spec §2–§5).
 * Everything testable lives here: log₁₀ banding, family taxonomy (the
 * matryoshka), the anti-prostynia caps, the search ranking and the URL
 * state contract. No React, no gateway — components only render these
 * results, which is what keeps refetch/SSE noise from ever touching view
 * state (freeze-рамка §4.4: состав корзин считается по снапшоту фетча).
 */

/** Chips per band section before a «Ещё N / Показать все» control (owner cap). */
export const BAND_CHUNK = 24;
/** Same cap for the family chip-row (live corpus: ~170 families). */
export const FAMILY_ROW_CHUNK = 24;
/** Active-filter flat list cap + «уточните запрос» note (§3.3). */
export const SEARCH_CAP = 100;
/** «Рядом в семействе» strip width (§5.2). */
export const SIBLINGS_LIMIT = 12;

// --- Bands (§3) --------------------------------------------------------------

export type BandKey = "core" | "frequent" | "middle" | "rare";

/** Display/i18n order, top-down. */
export const BAND_ORDER: readonly BandKey[] = ["core", "frequent", "middle", "rare"];

/**
 * Log₁₀-magnitude band: floor(log₁₀(count)) clamped to 0..3 → thresholds
 * 1 / 10 / 100 / 1000 (§3.2). count ≤ 0 cannot exist in the wire; clamp
 * defensively to the rarest band instead of NaN-ing the page.
 */
export function bandOfCount(count: number): BandKey {
  const magnitude = Math.floor(Math.log10(Math.max(1, count)));
  const clamped = Math.min(3, magnitude);
  return BAND_ORDER[3 - clamped];
}

export interface BandSection {
  key: BandKey;
  /** count DESC, name ASC — the deterministic house sort. */
  tags: TagSummary[];
}

/** Deterministic tag sort: count DESC, then name ASC. */
export function sortTags(tags: readonly TagSummary[]): TagSummary[] {
  return [...tags].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Band sections, drop-empty (§3.2): a section with zero tags is not rendered
 * at all — a fresh corpus where every tag is 1–9 honestly renders one
 * «Редкие» section. Composition follows the fetch snapshot; nothing here
 * re-shuffles in a live session unless the data itself changed.
 */
export function buildBands(tags: readonly TagSummary[]): BandSection[] {
  const grouped = new Map<BandKey, TagSummary[]>();
  for (const tag of tags) {
    const key = bandOfCount(tag.count);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(tag);
    else grouped.set(key, [tag]);
  }
  return BAND_ORDER.filter((key) => (grouped.get(key)?.length ?? 0) > 0).map((key) => ({
    key,
    tags: sortTags(grouped.get(key) ?? []),
  }));
}

// --- Families / taxonomy (§2) -------------------------------------------------

export interface FamilyEntry {
  /** First segment before ":" ("" → the «без префикса» family). */
  prefix: string;
  /** How many tags carry the prefix. */
  tagCount: number;
  /** Sum of their counts — the family's mass. */
  mass: number;
}

/** First segment of a tag ("" when the tag has no colon). */
export function familyOf(tag: string): string {
  const colon = tag.indexOf(":");
  return colon === -1 ? "" : tag.slice(0, colon);
}

/**
 * Family chip-row (§2 Ур.1), built FROM DATA, never hardcoded. Sorted by
 * tag count DESC; ties break name ASC with the bare family pinned last
 * (it is the "no prefix" leftover, not a real namespace).
 */
export function buildFamilies(tags: readonly TagSummary[]): FamilyEntry[] {
  const grouped = new Map<string, FamilyEntry>();
  for (const { tag, count } of tags) {
    const prefix = familyOf(tag);
    const entry = grouped.get(prefix);
    if (entry) {
      entry.tagCount += 1;
      entry.mass += count;
    } else {
      grouped.set(prefix, { prefix, tagCount: 1, mass: count });
    }
  }
  return [...grouped.values()].sort((a, b) => {
    if (a.tagCount !== b.tagCount) return b.tagCount - a.tagCount;
    const aBare = a.prefix === "";
    const bBare = b.prefix === "";
    if (aBare !== bBare) return aBare ? 1 : -1;
    return a.prefix.localeCompare(b.prefix);
  });
}

export interface TaxonomyGroup {
  /** The next segment's value (e.g. `component` for gcw → gcw:component). */
  label: string;
  /** The drillable sub-family prefix (`gcw:component`). */
  family: string;
  tags: TagSummary[];
  mass: number;
}

export interface TaxonomyView {
  /** Tags exactly at the prefix (no further colons below it). */
  leaves: TagSummary[];
  /** Next-level segment groups, mass DESC — the matryoshka's inner dolls. */
  groups: TaxonomyGroup[];
}

/**
 * Taxonomy view for a family prefix (§2 Ур.3): one grouping axis — leaves at
 * the prefix + groups by the next segment for deeper chains. Recursive by
 * construction: passing `gcw:component` as the prefix drills one level down
 * (the breadcrumbs grow with it).
 */
export function buildTaxonomy(
  tags: readonly TagSummary[],
  family: string,
): TaxonomyView {
  const base = family === "" ? "" : `${family}:`;
  const members = tags.filter((tag) =>
    family === ""
      ? !tag.tag.includes(":")
      : tag.tag === family || tag.tag.startsWith(base),
  );

  const groupMap = new Map<string, TaxonomyGroup>();
  const leaves: TagSummary[] = [];

  for (const tag of members) {
    const rest = family === "" ? null : tag.tag.slice(base.length);
    const isLeaf =
      family === "" || tag.tag === family || (rest !== null && !rest.includes(":"));
    if (isLeaf) {
      leaves.push(tag);
      continue;
    }
    const label = (rest ?? "").split(":")[0];
    const group = groupMap.get(label);
    if (group) {
      group.tags.push(tag);
      group.mass += tag.count;
    } else {
      groupMap.set(label, {
        label,
        family: `${family}:${label}`,
        tags: [tag],
        mass: tag.count,
      });
    }
  }

  const sortGroups = (a: TaxonomyGroup, b: TaxonomyGroup) =>
    b.mass - a.mass || a.label.localeCompare(b.label);
  return {
    leaves: sortTags(leaves),
    groups: [...groupMap.values()].sort(sortGroups).map((group) => ({
      ...group,
      tags: sortTags(group.tags),
    })),
  };
}

// --- Search (§4.3) -------------------------------------------------------------

/**
 * Case-insensitive substring filter; prefix matches rank above inclusions
 * (`project:g` → `project:gcw` before `phase:project-cleanup`), then the
 * house sort. Capped at SEARCH_CAP (§3.3).
 */
export function filterAndRankTags(
  tags: readonly TagSummary[],
  query: string,
): TagSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches = tags.filter((tag) => tag.tag.toLowerCase().includes(q));
  matches.sort((a, b) => {
    const aPrefix = a.tag.toLowerCase().startsWith(q) ? 0 : 1;
    const bPrefix = b.tag.toLowerCase().startsWith(q) ? 0 : 1;
    if (aPrefix !== bPrefix) return aPrefix - bPrefix;
    return b.count - a.count || a.tag.localeCompare(b.tag);
  });
  return matches.slice(0, SEARCH_CAP);
}

/** Top prefix-siblings of a tag from the full /api/tags list (§5.2). */
export function siblingTags(
  tags: readonly TagSummary[],
  tag: string,
  limit: number = SIBLINGS_LIMIT,
): TagSummary[] {
  const family = familyOf(tag);
  return sortTags(
    tags.filter(
      (candidate) => candidate.tag !== tag && familyOf(candidate.tag) === family,
    ),
  ).slice(0, limit);
}

// --- Caps (§3.3) ----------------------------------------------------------------

/**
 * Visible chip count for a capped section: `requested` (from the URL) wins —
 * a refetch NEVER resets it (freeze-рамка); the default cap applies only when
 * the user has not expanded. Requests beyond total render everything.
 */
export function sectionVisibleCount(total: number, requested?: number): number {
  if (requested !== undefined) return Math.min(requested, total);
  return Math.min(BAND_CHUNK, total);
}

/** Cap control plan for one section: which affordances to render. */
export interface CapControls {
  /** total ≤ BAND_CHUNK — nothing to render. */
  readonly kind: "none" | "show-all" | "incremental";
  /** true when «Свернуть» accompanies the controls (§3.3: after first expand). */
  readonly collapsible: boolean;
}

export function capControls(total: number, visible: number): CapControls {
  if (total <= BAND_CHUNK) return { kind: "none", collapsible: false };
  if (total <= BAND_CHUNK * 2) {
    return { kind: "show-all", collapsible: visible > BAND_CHUNK };
  }
  return { kind: "incremental", collapsible: visible > BAND_CHUNK };
}

// --- URL state (правило «состояние списка в URL») --------------------------------

/**
 * The page's list state, entirely in the query string:
 * `?tag=` drill target · `?family=` taxonomy prefix (empty value = the bare
 * family) · `?q=` filter · `?b=` band/family-row visible counts
 * (`core:48,middle:96`) · `?f=` family-row visible count. Back navigation
 * therefore restores filter, family, drill AND expansions (§2.2) — and no
 * refetch can clobber any of it.
 */
export interface TagsUrlState {
  tag?: string;
  /** undefined = no family chosen; "" = the bare («без префикса») family. */
  family?: string;
  q: string;
  bandVisible: Record<string, number>;
  familyVisible?: number;
}

export function parseTagsUrlState(params: URLSearchParams): TagsUrlState {
  const bandVisible: Record<string, number> = {};
  for (const pair of (params.get("b") ?? "").split(",")) {
    // Split on the LAST colon: keys are taxonomy group ids like
    // "gcw:component" (review P1 — splitting on the first colon NaN-ed
    // the value and silently dropped every group cap entry).
    const sep = pair.lastIndexOf(":");
    const key = sep === -1 ? "" : pair.slice(0, sep);
    const value = Number.parseInt(pair.slice(sep + 1), 10);
    if (key && Number.isFinite(value) && value > 0) bandVisible[key] = value;
  }
  const familyRaw = params.get("f") ?? "";
  const familyVisible = Number.parseInt(familyRaw, 10);
  return {
    tag: params.get("tag") ?? undefined,
    family: params.has("family") ? (params.get("family") ?? "") : undefined,
    q: params.get("q") ?? "",
    bandVisible,
    familyVisible:
      Number.isFinite(familyVisible) && familyVisible > 0 ? familyVisible : undefined,
  };
}

/** Immutably patch the tags-page params over the current location search. */
export function updateTagsUrl(
  prev: URLSearchParams,
  changes: Partial<TagsUrlState>,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  const setOrDelete = (key: string, value?: string) => {
    if (value === undefined) next.delete(key);
    else next.set(key, value);
  };
  if ("tag" in changes) setOrDelete("tag", changes.tag);
  if ("family" in changes) setOrDelete("family", changes.family);
  if ("q" in changes) setOrDelete("q", changes.q || undefined);
  if ("bandVisible" in changes) {
    const encoded = Object.entries(changes.bandVisible ?? {})
      .filter(([, count]) => count > 0)
      .map(([key, count]) => `${key}:${count}`)
      .join(",");
    setOrDelete("b", encoded || undefined);
  }
  if ("familyVisible" in changes) {
    setOrDelete("f", changes.familyVisible ? String(changes.familyVisible) : undefined);
  }
  return next;
}

// --- misc -----------------------------------------------------------------------

/** «данные на {{time}}» — HH:MM in the local zone, zero-padded, no Intl drift. */
export function formatStatsTime(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Splits `tag` around the first case-insensitive match of `query` for the weight-medium highlight. */
export function highlightMatch(
  tag: string,
  query: string,
): { before: string; match: string; after: string } | null {
  const index = tag.toLowerCase().indexOf(query.trim().toLowerCase());
  if (index === -1 || !query.trim()) return null;
  return {
    before: tag.slice(0, index),
    match: tag.slice(index, index + query.trim().length),
    after: tag.slice(index + query.trim().length),
  };
}
