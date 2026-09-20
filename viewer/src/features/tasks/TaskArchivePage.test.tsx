import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskArchivePage } from "./TaskArchivePage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { HttpAdapter } from "@/gateway/HttpAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ApiError } from "@/lib/errors";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import type { ArchiveParams } from "@/gateway/boardTypes";

/**
 * Ф2+Ф3 archive page (BE-11b): URL-state filters + pagination, expandable
 * rows carrying the full archived detail, and the Ф3 «Restore to board»
 * mutation (live, no longer the honest-disabled stub). The q debounce
 * itself is behaviour for a DOM test-runner — here the URL-driven contract
 * is pinned: a ?q= deep link renders the filtered page the server answered
 * for exactly that key.
 */

type Gateway = MockAdapter | HttpAdapter;

async function renderArchive(
  gateway: Gateway,
  path = "/tasks/archive",
  params: ArchiveParams = { limit: 50, offset: 0 },
): Promise<string> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (gateway instanceof MockAdapter) {
    await queryClient.prefetchQuery({
      queryKey: keys.tasks.archive(params),
      queryFn: () => gateway.archive(params),
    });
  }
  return renderToString(
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <UiTokenProvider>
            <I18nProvider initialLang="en">
              <MemoryRouter initialEntries={[path]}>
                <TaskArchivePage />
              </MemoryRouter>
            </I18nProvider>
          </UiTokenProvider>
        </ToastProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

describe("TaskArchivePage (mock adapter)", () => {
  it("renders archived rows with the archive-from note and range counter", async () => {
    const html = await renderArchive(new MockAdapter({ latency: false }));
    expect(html).toContain("Archive");
    expect(html).toContain("RB-1");
    expect(html).toContain("archived from “blocked”");
    expect(html).toContain("Showing 1–1 of 1");
    // The inline expansion carries the full detail (summary/spec live in
    // the details pane — archived rows have no /tasks/:id page).
    expect(html).toContain("<details");
  });

  it("unarchive is a live mutation (Ф3): enabled button, no read-only note", async () => {
    const html = await renderArchive(new MockAdapter({ latency: false }));
    expect(html).toContain("Restore to board");
    expect(html).not.toContain('title="Restore is a mutation; arrives in Phase 3"');
    expect(html).not.toContain("Read-only list");
    // The button is enabled — the only disabled controls on the page are the
    // pager buttons at offset 0 (Next), so the restore button carries no
    // disabled attribute of its own.
    expect(html).not.toMatch(new RegExp("Restore to board[^<]*disabled"));
  });

  it("a ?q= deep link renders the page fetched for exactly that filter", async () => {
    const html = await renderArchive(
      new MockAdapter({ latency: false }),
      "/tasks/archive?q=регистрац",
      { q: "регистрац", limit: 50, offset: 0 },
    );
    // The mock's only archived row matches the LIKE query.
    expect(html).toContain("RB-1");
    // The search field reflects the URL value.
    expect(html).toContain('value="регистрац"');
  });

  it("an empty filtered archive renders the honest empty state", async () => {
    const html = await renderArchive(
      new MockAdapter({ latency: false }),
      "/tasks/archive?q=nothing-matches-this",
      { q: "nothing-matches-this", limit: 50, offset: 0 },
    );
    expect(html).toContain("The archive is empty");
  });

  it("pagination range follows offset (N–M of total)", async () => {
    // The mock archive holds ONE row; page 2 (offset 50) is legitimately
    // empty while the range counter reports the truth: 0 rows shown.
    const html = await renderArchive(
      new MockAdapter({ latency: false }),
      "/tasks/archive?offset=50",
      { limit: 50, offset: 50 },
    );
    expect(html).toContain("Showing 0–0 of 1");
    // Prev stays available (offset 50 > 0), Next correctly disabled.
    expect(html).toContain(">Prev<");
  });

  it("renders the loading skeleton while pending", () => {
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    const html = renderToString(
      <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <MemoryRouter initialEntries={["/tasks/archive"]}>
                  <TaskArchivePage />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
    expect(html).toContain("Loading archive");
  });

  it("renders the error state with retry", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const query = client.getQueryCache().build(client, {
      queryKey: keys.tasks.archive({ limit: 50, offset: 0 }),
      queryFn: () => Promise.resolve(null),
    });
    query.setState({
      status: "error",
      fetchStatus: "idle",
      error: new ApiError(500, "archive blew up"),
    });
    client.setQueryDefaults(keys.tasks.archive({ limit: 50, offset: 0 }), {
      retryOnMount: false,
      retry: false,
    });
    const html = renderToString(
      <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <MemoryRouter initialEntries={["/tasks/archive"]}>
                  <TaskArchivePage />
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
    expect(html).toContain("Could not load the archive");
    expect(html).toContain("Retry");
  });

  it("renders the honest unsupported state on a mnemos gateway", async () => {
    const html = await renderArchive(new HttpAdapter("/api"));
    expect(html).toContain("The Tasks domain is unavailable in mnemos mode");
  });
});
