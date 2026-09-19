import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PulsePage } from "./PulsePage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { HttpAdapter } from "@/gateway/HttpAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";

/**
 * Ф1 Pulse page (QA verdict §3 — "pulse-страница (мок BoardAdapter)"): with
 * the mock gateway's prefetched feed the page renders the recency list, the
 * provenance badge and the URL-driven scope switcher; a gateway without the
 * pulse capability (mnemos HttpAdapter) gets the honest "unsupported" state,
 * never a spinner or a fake feed.
 */
async function renderPulse(gateway: MockAdapter | HttpAdapter, path = "/memory/pulse") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (gateway instanceof MockAdapter) {
    await queryClient.prefetchQuery({
      queryKey: keys.pulse.feed({ scope: "all", limit: 20 }),
      queryFn: () => gateway.pulse({ scope: "all", limit: 20 }),
    });
  }
  return renderToString(
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLang="en">
          <MemoryRouter initialEntries={[path]}>
            <PulsePage />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("PulsePage (mock adapter — capable)", () => {
  it("renders the feed with provenance, the scope switcher and detail links", async () => {
    const html = await renderPulse(new MockAdapter({ latency: false }));
    expect(html).toContain("Memory pulse");
    // Scope switcher: "all stores" option present (URL-driven state).
    expect(html).toContain("all stores");
    expect(html).toContain("Pulse scope");
    // Feed rows carry the mock store provenance and link to the scroll.
    expect(html).toContain("mock-store");
    expect(html).toMatch(/href="\/memory\/[^"]+"/);
  });

  it("renders the honest unavailable state on a mnemos gateway", async () => {
    const html = await renderPulse(new HttpAdapter("/api"));
    expect(html).toContain("Pulse is unavailable in mnemos mode");
    expect(html).not.toContain("Pulse scope");
  });
});
