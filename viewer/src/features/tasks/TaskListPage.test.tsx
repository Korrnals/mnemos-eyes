import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskListPage } from "./TaskListPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { HttpAdapter } from "@/gateway/HttpAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ApiError } from "@/lib/errors";

/**
 * Ф2 list page (QA verdict §3 — "страницы на мок-BoardAdapter"): the mock
 * board (12 corpus-shaped tasks) drives the grouped dense table, the URL
 * filter narrows it, the report-count badge appears from the count key, and
 * the honest state matrix (loading / error / empty / unsupported) renders
 * without effects — DOM-free renderToString per the project pattern.
 */

type Gateway = MockAdapter | HttpAdapter;

async function renderTasks(
  gateway: Gateway,
  path = "/tasks",
  seed: (client: QueryClient, gateway: Gateway) => Promise<void> = async () => {},
): Promise<string> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await seed(queryClient, gateway);
  return renderToString(
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={queryClient}>
        <I18nProvider initialLang="en">
          <MemoryRouter initialEntries={[path]}>
            <TaskListPage />
          </MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

/** Seed the shared board projection exactly like the running app would. */
async function seedBoard(client: QueryClient, gateway: Gateway): Promise<void> {
  if (gateway instanceof MockAdapter) {
    await client.prefetchQuery({
      queryKey: keys.tasks.board(),
      queryFn: () => gateway.board(),
    });
  }
}

describe("TaskListPage (mock adapter)", () => {
  it("renders the grouped table: mini-stats, project groups, links to detail", async () => {
    const html = await renderTasks(new MockAdapter({ latency: false }), "/tasks", seedBoard);
    // Title + per-column mini-stats (whole-board counts from the wire).
    expect(html).toContain("Tasks");
    expect(html).toContain("Status counts across the whole board");
    expect(html).toMatch(/open.*7/s);
    // Project group headers with counts.
    expect(html).toContain("mnemos-eyes");
    // Dense table semantics + the row link (keyboard/SR path).
    expect(html).toContain("<table");
    expect(html).toMatch(/href="\/tasks\/TB-1"/);
    // Group toggles are disclosed via aria-expanded.
    expect(html).toContain('aria-expanded="true"');
    // Read-only honesty note.
    expect(html).toContain("Read-only list");
  });

  it("keeps the list state in the URL: ?status=blocked narrows to blocked rows", async () => {
    const html = await renderTasks(
      new MockAdapter({ latency: false }),
      "/tasks?status=blocked",
      seedBoard,
    );
    expect(html).toContain("RB-2");
    expect(html).toContain("TB-5");
    expect(html).not.toContain('href="/tasks/TB-1"');
    // The pressed mini-stat reflects the URL filter.
    expect(html).toContain('aria-pressed="true"');
  });

  it("combines URL filters (project + priority) with AND semantics", async () => {
    const html = await renderTasks(
      new MockAdapter({ latency: false }),
      "/tasks?project=mnemos-eyes&priority=critical",
      seedBoard,
    );
    expect(html).toContain('href="/tasks/TB-1"');
    expect(html).toContain('href="/tasks/TB-5"');
    expect(html).not.toContain('href="/tasks/TB-3"');
  });

  it("renders the filtered empty state when nothing matches the URL q", async () => {
    const html = await renderTasks(
      new MockAdapter({ latency: false }),
      "/tasks?q=definitely-no-such-task",
      seedBoard,
    );
    expect(html).toContain("Nothing matches these filters");
  });

  it("shows the report-count badge only for tasks the client knows about", async () => {
    const html = await renderTasks(
      new MockAdapter({ latency: false }),
      "/tasks",
      async (client, gateway) => {
        await seedBoard(client, gateway);
        // SSE / visited-detail fed count for TB-1 only.
        client.setQueryData(keys.tasks.reports.count("TB-1"), 3);
      },
    );
    expect(html).toContain("reports — 3");
  });

  it("renders the loading skeleton while the board is pending", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    const html = renderToString(
      <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
        <QueryClientProvider client={client}>
          <I18nProvider initialLang="en">
            <MemoryRouter initialEntries={["/tasks"]}>
              <TaskListPage />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading tasks");
  });

  it("renders the error state with retry from a failed board fetch", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const query = client
      .getQueryCache()
      .build(client, { queryKey: keys.tasks.board(), queryFn: () => Promise.resolve(null) });
    query.setState({
      status: "error",
      fetchStatus: "idle",
      error: new ApiError(503, "board is down"),
    });
    client.setQueryDefaults(keys.tasks.board(), { retryOnMount: false, retry: false });
    const html = renderToString(
      <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
        <QueryClientProvider client={client}>
          <I18nProvider initialLang="en">
            <MemoryRouter initialEntries={["/tasks"]}>
              <TaskListPage />
            </MemoryRouter>
          </I18nProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
    expect(html).toContain("Could not load tasks");
    expect(html).toContain("Retry");
  });

  it("renders the honest unsupported state on a mnemos gateway", async () => {
    const html = await renderTasks(new HttpAdapter("/api"));
    expect(html).toContain("The Tasks domain is unavailable in mnemos mode");
    expect(html).not.toContain("<table");
  });
});
