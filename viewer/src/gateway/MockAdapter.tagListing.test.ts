import { describe, expect, it } from "vitest";
import { MockAdapter } from "./MockAdapter";
import { MOCK_MEMORIES } from "./fixtures";
import type { Memory } from "./types";

/**
 * BE-13 parity gate: the tag drill's memories ride the HONEST LISTING
 * (`listMemories({ tags })` — the wire `GET /memories?tags=`), never the
 * search ranker. The mock must hold both sides of the contract:
 *   1. the listing is COMPLETE coverage (every memory carrying the tag,
 *      recency-ordered — listing semantics, not a ranked/truncated subset);
 *   2. listing coverage == drill coverage for the same tag (the viewer
 *      renders the listing, so the drill can never show less than `?tag=`
 *      in «Записи»).
 * Covers EVERY fixture tag, so the parity cannot rot for one tag silently.
 */

function makeAdapter(): MockAdapter {
  return new MockAdapter({ latency: false });
}

/** The full corpus expectation: tag filter + recency desc, id asc tiebreak. */
function expectedListing(tag: string): readonly string[] {
  return MOCK_MEMORIES.filter((memory) => (memory.tags ?? []).includes(tag))
    .sort(
      (a: Memory, b: Memory) =>
        (b.created_at ?? "").localeCompare(a.created_at ?? "") ||
        (a.id ?? "").localeCompare(b.id ?? ""),
    )
    .map((memory) => memory.id!);
}

const ALL_TAGS = [
  ...new Set(MOCK_MEMORIES.flatMap((memory) => memory.tags ?? [])),
];

describe("BE-13: tag listing is a listing, not search", () => {
  it("covers every fixture tag (the corpus is not searched, it is listed)", async () => {
    const adapter = makeAdapter();
    expect(ALL_TAGS.length).toBeGreaterThan(5);
    for (const tag of ALL_TAGS) {
      const listed = await adapter.listMemories({ tags: tag, limit: 500 });
      expect(
        listed.map((memory) => memory.id),
        `honest coverage failed for tag ${tag}`,
      ).toEqual(expectedListing(tag));
    }
  });

  it("drill memories == listing memories for the same tag (mock parity)", async () => {
    const adapter = makeAdapter();
    for (const tag of ALL_TAGS) {
      const listed = await adapter.listMemories({ tags: tag, limit: 500 });
      const drilled = await adapter.drillTag(tag, { limit: 500 });
      expect(
        drilled.memories.map((memory) => memory.id),
        `drill/listing parity failed for tag ${tag}`,
      ).toEqual(listed.map((memory) => memory.id));
    }
  });

  it("intersects comma-separated tags (a filter narrows, it does not rank)", async () => {
    // The wire contract for `?tags=a,b` is an INTERSECTION — and the exact
    // place where «search the tag term» and «filter by the tag» diverge:
    // a ranker would OR the tokens, the listing must AND them.
    const adapter = makeAdapter();
    const both = await adapter.listMemories({ tags: "project:mnemos,topic:fts", limit: 500 });
    expect(both.map((memory) => memory.id)).toEqual(
      expectedListing("project:mnemos").filter((id) =>
        (MOCK_MEMORIES.find((memory) => memory.id === id)?.tags ?? []).includes("topic:fts"),
      ),
    );
    expect(both.length).toBeGreaterThan(0);
  });
});
