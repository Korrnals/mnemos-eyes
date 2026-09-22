import type { TagSummary } from "./types";

/**
 * Deterministic tag corpus at live scale (UI-17 spec §10.5): 611 tags with
 * the magnitude distribution captured from the live board on 2026-09-22 —
 * Ядро 1000+ → 1, Частые 100–999 → 19 (incl. the §0 anchors), Средние
 * 10–99 → 78, Редкие 1–9 → 513 — so band sections, the 24-chip caps and the
 * DOM budget are tested at true scale, not on the ~30 fixture tags.
 *
 * Family quotas deliberately mirror the live shape: a few populous families
 * (stack/domain/project/agent/issue…), multi-segment chains for the
 * taxonomy drill (gcw:component:*), and a long tail of single-tag families
 * plus bare (colon-less) tags. All counts come from a seeded PRNG — the
 * corpus is byte-identical across runs.
 */

/** Live §0 anchors (2026-09-22 capture) — the Ядро chip + Частые head. */
const HEAD_ANCHORS: readonly (readonly [string, number])[] = [
  ["mnemos:checkpoint", 1152],
  ["agent:user", 977],
  ["project:gcw", 901],
  ["agent:gcw-agent-architect", 715],
  ["mnemos:learning", 507],
  ["agent:gcw-tech-lead", 477],
  ["project:mnemos", 422],
  ["gcw:component:skills", 340],
];

const TOTAL_TAGS = 611;
const FREQUENT_TOTAL = 19; // 7 anchors + 12 planned
const MIDDLE_TOTAL = 78; // 2 named specials (status:error, severity:critical) + 76 planned

type Band = "frequent" | "middle" | "rare";

interface FamilyQuota {
  /** First tag segment ("" → bare, colon-less tags). */
  prefix: string;
  /** Optional second segment for multi-colon chains ("" → plain `<n>` slugs). */
  segment: string;
  frequent: number;
  middle: number;
  rare: number;
}

const FAMILY_PLAN: readonly FamilyQuota[] = [
  { prefix: "stack", segment: "", frequent: 5, middle: 42, rare: 60 },
  { prefix: "domain", segment: "", frequent: 3, middle: 18, rare: 36 },
  { prefix: "project", segment: "", frequent: 2, middle: 6, rare: 47 },
  { prefix: "agent", segment: "", frequent: 1, middle: 4, rare: 26 },
  { prefix: "issue", segment: "", frequent: 0, middle: 0, rare: 37 },
  { prefix: "topic", segment: "", frequent: 1, middle: 0, rare: 17 },
  { prefix: "mnemos", segment: "", frequent: 0, middle: 0, rare: 8 },
  { prefix: "gcw", segment: "component", frequent: 0, middle: 2, rare: 2 },
  { prefix: "gcw", segment: "release", frequent: 0, middle: 2, rare: 0 },
  { prefix: "gcw", segment: "", frequent: 0, middle: 0, rare: 2 },
  { prefix: "source", segment: "", frequent: 0, middle: 0, rare: 28 },
  { prefix: "milestone", segment: "", frequent: 0, middle: 0, rare: 26 },
  { prefix: "specialist", segment: "", frequent: 0, middle: 0, rare: 17 },
  { prefix: "applyTo", segment: "", frequent: 0, middle: 0, rare: 20 },
  { prefix: "severity", segment: "", frequent: 0, middle: 1, rare: 8 },
  { prefix: "status", segment: "", frequent: 0, middle: 1, rare: 0 },
  { prefix: "", segment: "", frequent: 0, middle: 0, rare: 12 }, // bare tags
];

/** Seeded PRNG (mulberry32) — identical corpus across runs/stores. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTagCorpus(): TagSummary[] {
  const rand = mulberry32(20260921);
  const tags: TagSummary[] = [];
  const seen = new Set<string>();
  const perFamily = new Map<string, number>();

  const push = (name: string, count: number) => {
    if (seen.has(name)) return;
    seen.add(name);
    tags.push({ tag: name, count });
  };
  const jitter = (min: number, max: number) =>
    Math.round(min + rand() * (max - min));

  /** Next deterministic name inside a family slot (or null when spent). */
  const nextName = (quota: FamilyQuota): string | null => {
    const key = `${quota.prefix}|${quota.segment}`;
    const n = (perFamily.get(key) ?? 0) + 1;
    perFamily.set(key, n);
    if (!quota.prefix) return `bare-tag-${n}`;
    if (quota.segment) return `${quota.prefix}:${quota.segment}:chain-${n}`;
    return `${quota.prefix}:slug-${n}`;
  };

  // Head: the live anchors, verbatim.
  for (const [name, count] of HEAD_ANCHORS) push(name, count);

  // Planned slots, band by band, family order stable; every band stops at
  // its exact quota (the anchors already occupy part of frequent).
  const emit = (band: Band, budget: number) => {
    let left = budget;
    for (const quota of FAMILY_PLAN) {
      const quotaFor = (q: FamilyQuota): number =>
        band === "frequent" ? q.frequent : band === "middle" ? q.middle : q.rare;
      for (let i = 0; i < quotaFor(quota) && left > 0; i++, left--) {
        const name = nextName(quota);
        if (name) {
          push(
            name,
            band === "frequent"
              ? jitter(100, 899)
              : band === "middle"
                ? jitter(10, 99)
                : jitter(1, 9),
          );
        }
      }
      if (left === 0) return;
    }
  };
  emit("frequent", FREQUENT_TOTAL - 7);
  emit("middle", MIDDLE_TOTAL - 2);

  // Named middle-band specials tests can pin.
  push("status:error", jitter(10, 99));
  push("severity:critical", jitter(10, 99));

  // Rare band soaks up the remainder via single-tag families (the long tail).
  let tail = 0;
  emit("rare", Math.max(0, TOTAL_TAGS - tags.length - 1));
  while (tags.length < TOTAL_TAGS) {
    tail++;
    push(`orphan-fam-${tail}:single-${tail}`, jitter(1, 9));
  }
  return tags;
}

/** The shared 611-tag corpus (deterministic — see module docblock). */
export const TAG_CORPUS: TagSummary[] = buildTagCorpus();
