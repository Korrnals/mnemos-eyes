import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TagsPage } from "./TagsPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { HttpAdapter } from "@/gateway/HttpAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { TAG_CORPUS } from "@/gateway/tagFixtures";
import { I18nProvider } from "@/i18n";

/**
 * SSR gate for the tags cloud (UI-17 spec §11): band sections on the
 * 611-tag corpus, the ~110-node DOM budget (§11.1), drop-empty, the partial
 * honesty line (§6), the flat filter list (§4.3), deep-linked taxonomy and
 * drill views (§5), and the honest fallback on a mnemos gateway. English
 * copy pinned via initialLang (project test pattern).
 */

interface RenderOptions {
  path?: string;
  /** Prefetch the merged-tags view (mock capability default). */
  prefetchMerged?: boolean;
  /** Seed extra cache entries (drill) into the SAME client the page reads. */
  prepare?: (client: QueryClient, gateway: MockAdapter) => Promise<void>;
}

async function renderTags(
  gateway: MockAdapter | HttpAdapter,
  options: RenderOptions = {},
): Promise<string> {
  const { path = "/memory/tags", prefetchMerged = true, prepare } = options;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const isMock = gateway instanceof MockAdapter;
  if (isMock && prefetchMerged) {
    await queryClient.prefetchQuery({
      queryKey: keys.tags.merged(),
      queryFn: () => (gateway as MockAdapter).mergedTags(),
    });
  }
  if (!isMock) {
    await queryClient.prefetchQuery({
      queryKey: keys.tags.list(),
      queryFn: () => (gateway as HttpAdapter).listTags(),
    });
  }
  if (prepare) await prepare(queryClient, gateway as MockAdapter);
  return renderToString(
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLang="en">
          <MemoryRouter initialEntries={[path]}>
            <TagsPage />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

/** Interactive-node count — the §3.3 DOM budget unit. */
function interactiveNodes(html: string): number {
  return (
    (html.match(/<button/g)?.length ?? 0) +
    (html.match(/<a /g)?.length ?? 0) +
    (html.match(/<input/g)?.length ?? 0)
  );
}

/** First <ul> content of a band section (the rendered chip <li>s). */
function bandChips(html: string, band: string): number {
  const list = html.match(
    new RegExp(`id="band-${band}-list"[^>]*>([\\s\\S]*?)</ul>`),
  )?.[1];
  return list?.match(/<li/g)?.length ?? 0;
}

const corpusGateway = () => new MockAdapter({ latency: false, tagCorpus: TAG_CORPUS });

describe("TagsPage — вид «частоты» on the 611-tag corpus", () => {
  it("renders the four magnitude sections with live counters and the §0 head", async () => {
    const html = await renderTags(corpusGateway());
    expect(html).toContain("Core · 1000+");
    expect(html).toContain("Frequent · 100–999");
    expect(html).toContain("Middle · 10–99");
    expect(html).toContain("Rare · 1–9");
    expect(html).toContain("611 tags");
    expect(html).toContain("mnemos:checkpoint");
    // Section counters are the real populations (§3.2: живые из данных).
    expect(html).toContain("19 tags");
    expect(html).toContain("513 tags");
  });

  it("keeps the initial render inside the ~110 interactive-node budget (§11.1)", async () => {
    const html = await renderTags(corpusGateway());
    const nodes = interactiveNodes(html);
    expect(nodes).toBeGreaterThan(60); // sanity: the cloud actually rendered
    expect(nodes).toBeLessThanOrEqual(110);
  });

  it("caps every band at 24 chips; controls appear only where the tail is", async () => {
    const html = await renderTags(corpusGateway());
    expect(bandChips(html, "core")).toBe(1);
    expect(bandChips(html, "frequent")).toBe(19); // ≤24 → full render, no control
    expect(bandChips(html, "middle")).toBe(24);
    expect(bandChips(html, "rare")).toBe(24);
    expect(html).not.toContain("Show all 19");
    // 78/513 middle+rare tails + the 182-family chip-row → three «Ещё 24».
    expect(html.match(/Show 24 more/g)?.length ?? 0).toBe(3);
  });

  it("renders the family chip-row from data with the bare family label", async () => {
    const html = await renderTags(corpusGateway());
    expect(html).toContain("All families");
    expect(html).toContain("stack");
    expect(html).toContain("no prefix");
  });
});

describe("TagsPage — state matrix (§6)", () => {
  it("renders one honest Редкие section on a fresh corpus (drop-empty)", async () => {
    const gateway = new MockAdapter({
      latency: false,
      tagCorpus: [
        { tag: "topic:a", count: 3 },
        { tag: "topic:b", count: 1 },
      ],
    });
    const html = await renderTags(gateway);
    expect(html).toContain("Rare · 1–9");
    expect(html).not.toContain("Core · 1000+");
    expect(html).not.toContain("Middle · 10–99");
  });

  it("shows the partial-data honesty line when stores failed", async () => {
    const gateway = new MockAdapter({
      latency: false,
      tagCorpus: TAG_CORPUS,
      tagStoreErrors: [{ server: "mnemos-2", status: 503 }],
    });
    const html = await renderTags(gateway);
    expect(html).toContain("◐");
    expect(html).toContain("Data from 1 of 2 stores");
    expect(html).toContain("Stores unreachable: mnemos-2");
  });

  it("shows the stores line without the warning marker when all answered", async () => {
    const html = await renderTags(corpusGateway());
    expect(html).toContain("Data from 1 of 1 stores");
    expect(html).not.toContain("◐");
  });

  it("renders the empty corpus state", async () => {
    const gateway = new MockAdapter({ latency: false, tagCorpus: [] });
    const html = await renderTags(gateway);
    expect(html).toContain("No tags yet");
  });

  it("renders the loading skeleton before data arrives", async () => {
    const html = await renderTags(new MockAdapter({ latency: false }), {
      prefetchMerged: false,
    });
    expect(html).toContain('role="status"');
    expect(html).not.toContain("611 tags");
  });
});

describe("TagsPage — фильтр (§4.3 flat ranked list)", () => {
  it("replaces the sections with a ranked list and announces matches", async () => {
    const html = await renderTags(corpusGateway(), {
      path: "/memory/tags?q=project%3Ag",
    });
    expect(html).toContain("1 matches");
    expect(html).toContain("project:gcw");
    // Matched substring carries weight-medium (the highlight span, §4.3).
    expect(html).toContain('class="font-medium text-foreground"');
    // The flat list replaces band sections entirely.
    expect(html).not.toContain('id="band-core"');
  });

  it("renders filter-empty honestly", async () => {
    const html = await renderTags(corpusGateway(), {
      path: "/memory/tags?q=%3Anope%3A",
    });
    expect(html).toContain("No tags match");
  });
});

describe("TagsPage — матрёшка-дрилл deep-links (§5)", () => {
  it("opens the taxonomy view for ?family=gcw with drillable groups", async () => {
    const html = await renderTags(corpusGateway(), { path: "/memory/tags?family=gcw" });
    expect(html).toContain("Group component");
    expect(html).toContain("gcw:component:chain-1");
    expect(html).toContain("All families");
  });

  it("opens the taxonomy view for the bare family (?family=)", async () => {
    const html = await renderTags(corpusGateway(), { path: "/memory/tags?family=" });
    expect(html).toContain("no prefix");
    expect(html).toContain("bare-tag-1");
  });

  it("opens the server drill for ?tag= with siblings, groups and the BE-13 note", async () => {
    const gateway = new MockAdapter({ latency: false });
    const html = await renderTags(gateway, {
      path: "/memory/tags?tag=project:gcw",
      prepare: (client, gw) =>
        client.prefetchQuery({
          queryKey: keys.tags.drill("project:gcw"),
          queryFn: () => gw.drillTag("project:gcw", { limit: 12 }),
        }),
    });
    expect(html).toContain("project:gcw");
    // Sibling strip from /api/tags (§5.2): same-family chips, itself excluded.
    expect(html).toContain("Nearby in project");
    expect(html).toContain("project:mnemos");
    // Board tasks section + honest empty copy (no project:gcw task in fixtures).
    expect(html).toContain("Tasks carrying this tag");
    expect(html).toContain("No tasks carry this tag");
    // Memories from the server drill + the subset honesty note (BE-13).
    expect(html).toContain("Memories");
    expect(html).toContain("Showing a subset");
    expect(html).toContain("Open in Memories");
  });

  it("restores expanded bands from the URL (back-navigation contract, §2.2)", async () => {
    const html = await renderTags(corpusGateway(), {
      path: "/memory/tags?b=middle:48,rare:48",
    });
    expect(bandChips(html, "middle")).toBe(48);
    expect(html).toContain("Collapse");
  });

  it("falls back to listTags on a mnemos gateway (no merged view)", async () => {
    const gateway = new HttpAdapter({
      baseUrl: "/api",
      fetchImpl: (() =>
        Promise.resolve(
          new Response(
            JSON.stringify([
              { tag: "topic:fts", count: 88 },
              { tag: "type:note", count: 64 },
              { tag: "status:error", count: 71 },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        )) as typeof fetch,
    });
    const html = await renderTags(gateway, { prefetchMerged: false });
    expect(html).toContain("Middle · 10–99");
    // No store-failure concept on mnemos mode → no partial line at all.
    expect(html).not.toContain("Data from");
    expect(html).not.toContain("◐");
  });
});
