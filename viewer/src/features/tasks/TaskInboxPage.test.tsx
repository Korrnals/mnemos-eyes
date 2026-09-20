import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskInboxPage } from "./TaskInboxPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { HttpAdapter } from "@/gateway/HttpAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ApiError } from "@/lib/errors";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";

/**
 * Ф2+Ф3 inbox page: provenance cards, stale rows dimmed into their own
 * section, adopted rows behind the URL toggle; the scan mutation is now
 * LIVE (button enabled) and adoptable rows carry «Adopt to board».
 */

type Gateway = MockAdapter | HttpAdapter;

async function renderInbox(
  gateway: Gateway,
  path = "/tasks/inbox",
  includeAdopted = false,
): Promise<string> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (gateway instanceof MockAdapter) {
    await queryClient.prefetchQuery({
      queryKey: keys.tasks.inbox({ include_adopted: includeAdopted }),
      queryFn: () => gateway.inbox({ include_adopted: includeAdopted }),
    });
  }
  return renderToString(
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <UiTokenProvider>
            <I18nProvider initialLang="en">
              <MemoryRouter initialEntries={[path]}>
                <TaskInboxPage />
              </MemoryRouter>
            </I18nProvider>
          </UiTokenProvider>
        </ToastProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("TaskInboxPage (mock adapter)", () => {
  it("renders queue records with server provenance, priority and specialist", async () => {
    const html = await renderInbox(new MockAdapter({ latency: false }));
    expect(html).toContain("Inbox");
    expect(html).toContain("server: laptop");
    expect(html).toContain("critical");
    expect(html).toContain("@GCW: Senior System Engineer");
    // The mock has 3 not-adopted records (the 4th is adopted).
    expect(html).toContain("records — 3");
    expect(html).toContain("scan: 19/09/2026");
  });

  it("hides adopted rows by default; ?adopted=1 brings them back with a link", async () => {
    const htmlDefault = await renderInbox(new MockAdapter({ latency: false }));
    expect(htmlDefault).not.toContain("adopted → TB-3");
    expect(htmlDefault).not.toContain("Свести ADR 0011 в трекер фаз");

    const htmlAdopted = await renderInbox(
      new MockAdapter({ latency: false }),
      "/tasks/inbox?adopted=1",
      true,
    );
    expect(htmlAdopted).toContain("records — 4");
    expect(htmlAdopted).toContain("adopted → TB-3");
    expect(htmlAdopted).toMatch(/href="\/tasks\/TB-3"/);
    // The toggle itself is a labelled checkbox bound to the URL state.
    expect(htmlAdopted).toContain('type="checkbox"');
  });

  it("moves stale records into a dimmed, labelled section", async () => {
    const html = await renderInbox(new MockAdapter({ latency: false }));
    expect(html).toContain("Disappeared from the source");
    expect(html).toContain("Устранить дрейф FTS5");
    // Active records render above the stale section.
    const activeAt = html.indexOf("Снять corpus с живого борда");
    const staleAt = html.indexOf("Disappeared records");
    expect(activeAt).toBeGreaterThan(-1);
    expect(staleAt).toBeGreaterThan(activeAt);
  });

  it("renders the scan mutation live and adopt buttons on adoptable rows", async () => {
    const html = await renderInbox(new MockAdapter({ latency: false }));
    // Ф3: the scan button is enabled (spinner state drives disabled only).
    expect(html).toContain("Scan stores");
    expect(html).not.toContain('title="Scanning is a mutation; arrives in Phase 3"');
    expect(html).not.toContain("store scanning — Phase 3");
    // Adoptable rows (active, not adopted) carry the mutation button.
    expect(html).toContain("Adopt to board");
    // The stale record cannot be adopted — only one adopt button per card
    // and none in the stale section (count: 2 active non-adopted records).
    expect(html.match(/Adopt to board/g)?.length).toBe(2);
  });

  it("renders the loading skeleton while pending", () => {
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    const html = renderToString(
      <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <MemoryRouter initialEntries={["/tasks/inbox"]}>
                  <TaskInboxPage />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
    expect(html).toContain("Loading inbox");
  });

  it("renders the error state with retry", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const query = client.getQueryCache().build(client, {
      queryKey: keys.tasks.inbox({ include_adopted: false }),
      queryFn: () => Promise.resolve(null),
    });
    query.setState({
      status: "error",
      fetchStatus: "idle",
      error: new ApiError(500, "inbox mirror failed"),
    });
    client.setQueryDefaults(keys.tasks.inbox({ include_adopted: false }), {
      retryOnMount: false,
      retry: false,
    });
    const html = renderToString(
      <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <MemoryRouter initialEntries={["/tasks/inbox"]}>
                  <TaskInboxPage />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
    expect(html).toContain("Could not load the inbox");
    expect(html).toContain("Retry");
  });

  it("renders the honest unsupported state on a mnemos gateway", async () => {
    const html = await renderInbox(new HttpAdapter("/api"));
    expect(html).toContain("The Tasks domain is unavailable in mnemos mode");
  });
});
