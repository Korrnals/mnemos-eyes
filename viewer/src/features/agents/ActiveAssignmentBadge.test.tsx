import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ActiveAssignmentBadge } from "./ActiveAssignmentBadge";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";

/**
 * The active-assignment badge (concept §4.4 matrix Б, AGW-2): appears on
 * cards/rows ONLY while an active attempt exists, deep-links to the task's
 * «Исполнение» tab, and carries the state text (never colour alone).
 */

async function renderBadge(taskId: string): Promise<string> {
  const gateway = new MockAdapter({ latency: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await client.prefetchQuery({
    queryKey: keys.agents.assignments.list({}),
    queryFn: () => gateway.listAssignments(),
  });
  return renderToString(
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={client}>
        <I18nProvider initialLang="en">
          <MemoryRouter>
            <ActiveAssignmentBadge taskId={taskId} />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("ActiveAssignmentBadge (mock corpus)", () => {
  it("queued task: neutral chip, state text, deep link to the execution tab", async () => {
    const html = await renderBadge("TB-1"); // corpus row 101: queued
    expect(html).toContain('href="/tasks/TB-1?tab=execution"');
    expect(html).toContain(">queued<");
    expect(html).toContain('title="Execution: queued"');
  });

  it("running task: the iris contour treatment (claimed/running)", async () => {
    const html = await renderBadge("TB-11"); // corpus row 106: running
    expect(html).toContain(">running<");
    expect(html).toContain("text-iris-bright");
    expect(html).toContain('href="/tasks/TB-11?tab=execution"');
  });

  it("terminal-only task renders NOTHING (no badge noise, unknown ≠ zero)", async () => {
    const html = await renderBadge("TB-6"); // corpus row 107: done only
    expect(html).toBe("");
  });

  it("task without assignments renders nothing", async () => {
    const html = await renderBadge("TB-10");
    expect(html).toBe("");
  });
});
