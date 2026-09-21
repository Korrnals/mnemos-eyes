import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { OverviewPage } from "@/features/overview/OverviewPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";

/**
 * Overview «Агенты» block (SCHED-1-UI, ADR 0013 §8): the auto-launches
 * line renders ONLY when the server's own counter says launches happened
 * (anti-dashification — a zero-count block does not render at all).
 */

async function renderOverview(dailyUsed: number): Promise<string> {
  const gateway = new MockAdapter({ latency: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await client.prefetchQuery({
    queryKey: keys.automation.status(),
    queryFn: () => gateway.automationStatus(),
  });
  // Override the server's own counter (the seed): the honest hook reads
  // status.daily_used, whatever the server says.
  const status = client.getQueryData(keys.automation.status()) as Record<string, unknown>;
  client.setQueryData(keys.automation.status(), { ...status, daily_used: dailyUsed });
  return renderToString(
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={client}>
        <I18nProvider initialLang="en">
          <MemoryRouter>
            <OverviewPage />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("Overview agents block — auto-launches line (N>0 only)", () => {
  it("renders the line with the count when launches happened today", async () => {
    const html = await renderOverview(3);
    expect(html).toContain("auto-launches today: 3");
    expect(html).toContain("/agents/execution"); // the section link
  });

  it("renders NOTHING when the count is zero (no counters for the sake of it)", async () => {
    const html = await renderOverview(0);
    expect(html).not.toContain("auto-launches today");
    expect(html).not.toContain('id="overview-agents"'); // the whole block is absent
  });
});
