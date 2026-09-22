import { describe, expect, it } from "vitest";

import { TAG_CORPUS } from "@/gateway/tagFixtures";
import {
  BAND_CHUNK,
  bandOfCount,
  buildBands,
  buildFamilies,
  buildTaxonomy,
  capControls,
  familyOf,
  filterAndRankTags,
  formatStatsTime,
  parseTagsUrlState,
  SEARCH_CAP,
  sectionVisibleCount,
  siblingTags,
  sortTags,
  updateTagsUrl,
} from "./model";

/**
 * Pure-model gate for the tags cloud (UI-17 spec §3/§11.1): band mechanics,
 * drop-empty, the 24-chip caps, family taxonomy, search ranking and the URL
 * state contract — on the deterministic 611-tag corpus whose magnitude
 * distribution mirrors the live board (spec §0 verification, 2026-09-22:
 * 1 / 19 / 78 / 513).
 */

describe("TAG_CORPUS (fixture sanity)", () => {
  it("mirrors the live §0 magnitude distribution", () => {
    expect(TAG_CORPUS).toHaveLength(611);
    expect(TAG_CORPUS.filter((t) => t.count >= 1000)).toHaveLength(1);
    expect(TAG_CORPUS.filter((t) => t.count >= 100 && t.count < 1000)).toHaveLength(19);
    expect(TAG_CORPUS.filter((t) => t.count >= 10 && t.count < 100)).toHaveLength(78);
    expect(TAG_CORPUS.filter((t) => t.count < 10)).toHaveLength(513);
  });
});

describe("bandOfCount (§3.2 log₁₀ magnitudes)", () => {
  it.each([
    [1, "rare"],
    [9, "rare"],
    [10, "middle"],
    [99, "middle"],
    [100, "frequent"],
    [999, "frequent"],
    [1000, "core"],
    [1152, "core"],
  ] as const)("count %i → %s", (count, band) => {
    expect(bandOfCount(count)).toBe(band);
  });

  it("clamps non-positive counts to the rarest band (no NaN page)", () => {
    expect(bandOfCount(0)).toBe("rare");
  });
});

describe("buildBands (§3.2 drop-empty)", () => {
  it("splits the 611-tag corpus into 1/19/78/513 in display order", () => {
    const bands = buildBands(TAG_CORPUS);
    expect(bands.map((band) => band.key)).toEqual([
      "core",
      "frequent",
      "middle",
      "rare",
    ]);
    expect(bands.map((band) => band.tags.length)).toEqual([1, 19, 78, 513]);
  });

  it("sorts inside a band count DESC, name ASC (house rule)", () => {
    const core = buildBands(TAG_CORPUS)[0].tags;
    expect(core[0].tag).toBe("mnemos:checkpoint");
    const rare = buildBands(TAG_CORPUS)[3].tags;
    for (let i = 1; i < rare.length; i++) {
      const prev = rare[i - 1];
      const curr = rare[i];
      expect(prev.count).toBeGreaterThanOrEqual(curr.count);
      if (prev.count === curr.count) {
        // Same collation the model uses (localeCompare, not code units).
        expect(prev.tag.localeCompare(curr.tag)).toBeLessThanOrEqual(0);
      }
    }
  });

  it("drops empty sections entirely (fresh corpus → one honest Редкие)", () => {
    const fresh: { tag: string; count: number }[] = [
      { tag: "topic:a", count: 3 },
      { tag: "topic:b", count: 1 },
    ];
    const bands = buildBands(fresh);
    expect(bands).toHaveLength(1);
    expect(bands[0].key).toBe("rare");
  });

  it("keeps every band populated when a magnitude gap splits the corpus", () => {
    const gap: { tag: string; count: number }[] = [
      { tag: "a", count: 150 },
      { tag: "b", count: 8 },
    ];
    expect(buildBands(gap).map((band) => band.key)).toEqual(["frequent", "rare"]);
  });
});

describe("buildFamilies (§2 Ур.1, built from data)", () => {
  it("counts tags per first segment and sorts by population", () => {
    const families = buildFamilies(TAG_CORPUS);
    const stack = families.find((family) => family.prefix === "stack");
    expect(stack?.tagCount).toBe(107); // 5 frequent + 42 middle + 60 rare
    for (let i = 1; i < families.length; i++) {
      expect(families[i - 1].tagCount).toBeGreaterThanOrEqual(families[i].tagCount);
    }
  });

  it("keeps the bare («без префикса») family last on population ties", () => {
    const bare = buildFamilies([
      { tag: "lonely", count: 5 },
      { tag: "aa:x", count: 5 },
      { tag: "bb:x", count: 5 },
    ]);
    expect(bare[bare.length - 1].prefix).toBe("");
    expect(bare[0].prefix).toBe("aa");
  });
});

describe("buildTaxonomy (§2 Ур.3 matryoshka)", () => {
  const gcw = buildTaxonomy(TAG_CORPUS, "gcw");

  it("shows exact-prefix leaves and next-segment groups for the family", () => {
    // gcw:slug-1/2 (2 segments) are leaves; component:/release: chains group.
    expect(gcw.leaves.map((leaf) => leaf.tag).sort()).toEqual([
      "gcw:slug-1",
      "gcw:slug-2",
    ]);
    expect(gcw.groups.map((group) => group.label).sort()).toEqual([
      "component",
      "release",
    ]);
  });

  it("sorts groups by mass", () => {
    const masses = gcw.groups.map((group) => group.mass);
    expect(masses).toEqual([...masses].sort((a, b) => b - a));
  });

  it("drills recursively: gcw:component chains become leaves one level down", () => {
    const component = buildTaxonomy(TAG_CORPUS, "gcw:component");
    // 2 middle + 2 rare chains + the §0 head anchor gcw:component:skills.
    expect(component.leaves.length).toBe(5);
    expect(component.groups).toHaveLength(0);
    expect(
      component.leaves.every((leaf) => leaf.tag.startsWith("gcw:component:")),
    ).toBe(true);
    expect(component.leaves[0].tag).toBe("gcw:component:skills");
  });

  it("collects colon-less tags into the bare family with no groups", () => {
    const bare = buildTaxonomy(TAG_CORPUS, "");
    expect(bare.leaves.every((leaf) => !leaf.tag.includes(":"))).toBe(true);
    expect(bare.leaves).toHaveLength(12);
    expect(bare.groups).toHaveLength(0);
  });
});

describe("filterAndRankTags (§4.3)", () => {
  const pool: { tag: string; count: number }[] = [
    { tag: "project:gcw", count: 900 },
    { tag: "phase:project-cleanup", count: 2000 },
    { tag: "project:mnemos", count: 419 },
    { tag: "topic:unrelated", count: 50 },
  ];

  it("ranks prefix matches above inclusions regardless of count", () => {
    const ranked = filterAndRankTags(pool, "project:g");
    expect(ranked[0].tag).toBe("project:gcw");
  });

  it("is case-insensitive and deterministic on ties", () => {
    expect(filterAndRankTags(pool, "PROJECT:M").map((tag) => tag.tag)).toEqual([
      "project:mnemos",
    ]);
  });

  it("returns nothing for an empty query", () => {
    expect(filterAndRankTags(pool, "  ")).toEqual([]);
  });

  it("caps the flat list at SEARCH_CAP", () => {
    const wide = Array.from({ length: 150 }, (_, index) => ({
      tag: `x:tag-${index}`,
      count: index + 1,
    }));
    expect(filterAndRankTags(wide, "x:")).toHaveLength(SEARCH_CAP);
  });
});

describe("siblingTags (§5.2 «Рядом в семействе»)", () => {
  it("returns the top-12 same-family tags, excluding the tag itself", () => {
    const siblings = siblingTags(TAG_CORPUS, "gcw:component:chain-1");
    expect(siblings.length).toBeLessThanOrEqual(12);
    expect(siblings.map((tag) => tag.tag)).not.toContain("gcw:component:chain-1");
    expect(siblings.every((tag) => familyOf(tag.tag) === "gcw")).toBe(true);
  });

  it("treats bare tags as one family", () => {
    const siblings = siblingTags(
      [
        { tag: "a", count: 1 },
        { tag: "b", count: 2 },
      ],
      "a",
    );
    expect(siblings.map((tag) => tag.tag)).toEqual(["b"]);
  });
});

describe("caps (§3.3 anti-prostynia)", () => {
  it("defaults every section to ≤ 24 chips", () => {
    expect(sectionVisibleCount(513, undefined)).toBe(BAND_CHUNK);
    expect(sectionVisibleCount(19, undefined)).toBe(19);
    expect(sectionVisibleCount(513, 48)).toBe(48);
    // A user request beyond the total renders everything (show-all snapshot).
    expect(sectionVisibleCount(19, 100)).toBe(19);
  });

  it("picks the control kind per population", () => {
    expect(capControls(19, 19).kind).toBe("none");
    expect(capControls(34, 24)).toEqual({ kind: "show-all", collapsible: false });
    expect(capControls(34, 34)).toEqual({ kind: "show-all", collapsible: true });
    expect(capControls(513, 24)).toEqual({ kind: "incremental", collapsible: false });
    expect(capControls(513, 48)).toEqual({ kind: "incremental", collapsible: true });
  });
});

describe("URL state (состояние списка в URL)", () => {
  it("round-trips tag, family, bare family, filter and expansions", () => {
    const parsed = parseTagsUrlState(
      new URLSearchParams(
        "tag=project:gcw&family=gcw:component&q=chain&b=core:48,middle:96&f=72",
      ),
    );
    expect(parsed.tag).toBe("project:gcw");
    expect(parsed.family).toBe("gcw:component");
    expect(parsed.q).toBe("chain");
    expect(parsed.bandVisible).toEqual({ core: 48, middle: 96 });
    expect(parsed.familyVisible).toBe(72);

    const next = updateTagsUrl(new URLSearchParams("tag=old"), {
      tag: undefined,
      family: "",
      q: "gc",
      bandVisible: { rare: 48 },
      familyVisible: undefined,
    });
    expect(next.get("tag")).toBeNull();
    // Present-but-empty family param = the bare («без префикса») family.
    expect(next.has("family")).toBe(true);
    expect(next.get("family")).toBe("");
    expect(next.get("q")).toBe("gc");
    expect(next.get("b")).toBe("rare:48");
    expect(next.get("f")).toBeNull();
  });

  it("round-trips GROUP keys containing colons (review P1: gcw:component:48)", () => {
    // Taxonomy group ids carry colons — the cap key is the group family
    // ("gcw:component"), so `b=` pairs must split on the LAST colon.
    const parsed = parseTagsUrlState(new URLSearchParams("b=gcw:component:48,core:96"));
    expect(parsed.bandVisible).toEqual({ "gcw:component": 48, core: 96 });

    const next = updateTagsUrl(new URLSearchParams(), {
      bandVisible: { "gcw:component": 48 },
    });
    expect(next.get("b")).toBe("gcw:component:48");
  });

  it("parses the default state from an empty location", () => {
    const state = parseTagsUrlState(new URLSearchParams(""));
    expect(state).toEqual({ q: "", bandVisible: {} });
    expect(
      sortTags([
        { tag: "b", count: 1 },
        { tag: "a", count: 2 },
      ]),
    ).toEqual([
      { tag: "a", count: 2 },
      { tag: "b", count: 1 },
    ]);
  });
});

describe("formatStatsTime (§2.1 stats line)", () => {
  it("formats a local HH:MM without Intl drift", () => {
    const epoch = Date.UTC(2026, 8, 21, 11, 2, 0); // 14:02 in UTC+3
    const date = new Date(epoch);
    const expected = `${String(date.getHours()).padStart(2, "0")}:${String(
      date.getMinutes(),
    ).padStart(2, "0")}`;
    expect(formatStatsTime(epoch)).toBe(expected);
    expect(formatStatsTime(epoch)).toMatch(/^\d{2}:\d{2}$/);
  });
});
