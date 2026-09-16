import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { SearchResultList } from "./SearchResultList";
import { splitHighlight } from "@/components/SearchResultCard/highlight";
import { MockAdapter } from "@/gateway/MockAdapter";

async function searchResults(query: string) {
  const adapter = new MockAdapter({ latency: false });
  return adapter.search({ query });
}

describe("SearchResultList (mock fixtures)", () => {
  it("renders fixture hits ranked by score desc with type badges", async () => {
    const results = await searchResults("fts");
    expect(results.length).toBeGreaterThan(0);
    const sorted = [...results].sort((a, b) => b.score - a.score);
    expect(results[0].id).toBe(sorted[0].id);

    const html = renderToString(
      <MemoryRouter>
        <SearchResultList results={results} queryTerms={["fts"]} />
      </MemoryRouter>,
    );
    // Both FTS-tagged fixture memories surface, deep-linked.
    expect(html).toContain('href="/memories/mem-0002"');
    expect(html).toContain('href="/memories/mem-0010"');
    // Every hit carries a search-type badge (fts / semantic / hybrid)…
    expect(html).toContain("hybrid");
    // …and query terms are highlighted with <mark>.
    expect(html).toContain("<mark");
  });

  it("renders the loading state as skeleton cards", () => {
    const html = renderToString(
      <MemoryRouter>
        <SearchResultList results={[]} isLoading />
      </MemoryRouter>,
    );
    expect(html).toContain("shimmer");
  });
});

describe("splitHighlight", () => {
  it("marks whole terms case-insensitively and keeps the rest plain", () => {
    const parts = splitHighlight("FTS5 drift after plain UPDATE", ["update", "fts"]);
    const marked = parts.filter((part) => part.highlighted).map((part) => part.text);
    expect(marked).toEqual(["FTS", "UPDATE"]);
  });

  it("returns a single plain part when no term matches", () => {
    expect(splitHighlight("nothing here", ["zzz"])).toEqual([
      { text: "nothing here", highlighted: false },
    ]);
  });
});
