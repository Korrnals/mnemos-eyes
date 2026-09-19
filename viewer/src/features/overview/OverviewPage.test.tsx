import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { OverviewPage } from "./OverviewPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { HttpAdapter } from "@/gateway/HttpAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";

/**
 * Ф1 Overview gates (QA verdict §3): with the mock gateway the store-health
 * cards and the fresh-pulse strip render from real prefetched data; with a
 * gateway that lacks the board-native capabilities (mnemos HttpAdapter) the
 * blocks do not render at all — no fake widgets, no dead sections. The quick
 * links and the L1 read-only badge are always honest.
 */
async function renderOverview(
  gateway: InstanceType<typeof MockAdapter> | InstanceType<typeof HttpAdapter>,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (gateway instanceof MockAdapter) {
    // Prefetch the exact keys the page reads so renderToString sees data
    // (no effects run server-side).
    await queryClient.prefetchQuery({
      queryKey: keys.pulse.feed({ scope: "all", limit: 5 }),
      queryFn: () => gateway.pulse({ scope: "all", limit: 5 }),
    });
    await queryClient.prefetchQuery({
      queryKey: keys.status.boardHealth(),
      queryFn: () => gateway.boardHealth(),
    });
  }
  return renderToString(
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLang="en">
          <MemoryRouter>
            <OverviewPage />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("OverviewPage (mock gateway — capable)", () => {
  it("renders store health cards with probe status and latency", async () => {
    const html = await renderOverview(new MockAdapter({ latency: false }));
    expect(html).toContain("Stores");
    expect(html).toContain("mock-store");
    expect(html).toContain("healthy");
    expect(html).toContain("ms probe");
    // The paused mock store says so in words — colour never alone (1.4.1).
    expect(html).toContain("disabled");
  });

  it("renders the fresh-pulse strip with provenance and the full-pulse link", async () => {
    const html = await renderOverview(new MockAdapter({ latency: false }));
    expect(html).toContain("Fresh pulse");
    expect(html).toContain('href="/memory/pulse"');
    expect(html).toContain('href="/memory/');
    expect(html).toContain("mock-store");
  });

  it("always offers the three quick links and the read-only badge", async () => {
    const html = await renderOverview(new MockAdapter({ latency: false }));
    expect(html).toContain('href="/memory/search"');
    expect(html).toContain('href="/memory/tags"');
    expect(html).toContain("L1 read-only");
  });
});

describe("OverviewPage (mnemos gateway — capabilities absent)", () => {
  it("hides the store and pulse blocks instead of faking them", async () => {
    const html = await renderOverview(new HttpAdapter("/api"));
    expect(html).not.toContain("Stores");
    expect(html).not.toContain("Fresh pulse");
    expect(html).toContain('href="/memory/search"'); // quick links stay
  });
});
