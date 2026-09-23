import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { TaskDetailPage } from "./TaskDetailPage";
import { MockAdapter } from "@/gateway/MockAdapter";
import { HttpAdapter } from "@/gateway/HttpAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ApiError } from "@/lib/errors";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";

/**
 * Ф2 task page (concept §4.1 — a ROUTE, not a modal): tabs are URL state
 * (?tab=…), the row comes from the shared tasks.board projection, reports
 * render chronologically with superseded dimming, history merges events +
 * memory checkpoints, memory links carry provenance. Ф3 adds the mutation
 * header: «Edit» always, «Resume» on a live final report (UI-8).
 */

type Gateway = MockAdapter | HttpAdapter;

async function renderTask(
  gateway: Gateway,
  path: string,
  seed: (client: QueryClient, gateway: Gateway) => Promise<void> = async () => {},
): Promise<string> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await seed(queryClient, gateway);
  return renderToString(
    <GatewayContext.Provider value={gateway}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <UiTokenProvider>
            <I18nProvider initialLang="en">
              <MemoryRouter initialEntries={[path]}>
                <Routes>
                  <Route path="/tasks/:id" element={<TaskDetailPage />} />
                </Routes>
              </MemoryRouter>
            </I18nProvider>
          </UiTokenProvider>
        </ToastProvider>
      </QueryClientProvider>
    </GatewayContext.Provider>,
  );
}

/** Seed every view the tabs read (board + reports + history + memories). */
async function seedAll(client: QueryClient, gateway: Gateway): Promise<void> {
  if (gateway instanceof MockAdapter) {
    await client.prefetchQuery({
      queryKey: keys.tasks.board(),
      queryFn: () => gateway.board(),
    });
    await client.prefetchQuery({
      queryKey: keys.tasks.reports.detail("TB-1"),
      queryFn: () => gateway.reports("TB-1"),
    });
    await client.prefetchQuery({
      queryKey: keys.tasks.history("TB-1"),
      queryFn: () => gateway.history("TB-1"),
    });
    await client.prefetchQuery({
      queryKey: keys.tasks.memories("TB-1"),
      queryFn: () => gateway.taskMemories("TB-1"),
    });
  }
}

describe("TaskDetailPage (mock adapter)", () => {
  it("header: id, status/priority badges, env, people chips, dates", async () => {
    const html = await renderTask(
      new MockAdapter({ latency: false }),
      "/tasks/TB-1",
      seedAll,
    );
    expect(html).toContain("TB-1");
    expect(html).toContain("in progress");
    expect(html).toContain("critical");
    expect(html).toContain("cluster");
    expect(html).toContain("agent: zcode");
    expect(html).toContain("@GCW: Tech Lead");
    // Ф3 mutation header: «Edit» always; TB-1 has a live final report,
    // so UI-8 «Resume» renders too. No read-only footer anymore.
    expect(html).toContain(">Edit<");
    expect(html).toContain(">Resume<");
    expect(html).not.toContain("read-only");
  });

  it("default tab = reports: chronological cards, kind badges, superseded dimming", async () => {
    const html = await renderTask(
      new MockAdapter({ latency: false }),
      "/tasks/TB-1",
      seedAll,
    );
    expect(html).toContain("Task reports, chronological");
    expect(html).toContain("intermediate");
    expect(html).toContain("final");
    expect(html).toContain("superseded");
    // All three mock reports render (compact card = <summary>).
    expect(html).toContain("Финальный отчёт v2");
    // Native expandable — keyboard/SR paths for free.
    expect(html).toContain("<details");
    expect(html).toContain("<summary");
  });

  it("?tab=history: merged timeline of events + memory checkpoints, newest first", async () => {
    const html = await renderTask(
      new MockAdapter({ latency: false }),
      "/tasks/TB-1?tab=history",
      seedAll,
    );
    expect(html).toContain("Task timeline");
    expect(html).toContain("agent report");
    expect(html).toContain("status changed");
    expect(html).toContain("Session checkpoint");
    // The newest event (report v2, 14:30) sits before the oldest (created).
    const reportAt = html.indexOf("agent report");
    const createdAt = html.indexOf("task created");
    expect(reportAt).toBeGreaterThan(-1);
    expect(createdAt).toBeGreaterThan(reportAt);
  });

  it("?tab=memory: linked cards with server provenance + unresolved links", async () => {
    const html = await renderTask(
      new MockAdapter({ latency: false }),
      "/tasks/TB-1?tab=memory",
      seedAll,
    );
    expect(html).toContain("Linked memories");
    expect(html).toContain("source: laptop");
    // Resolved card links into the memory domain scroll.
    expect(html).toMatch(/href="\/memory\/25cdc0e9/);
    // Unresolved links are honest, never dropped.
    expect(html).toContain("Unresolved links");
    expect(html).toContain("86ce17e7");
  });

  it("?tab=details: readable summary, spec in pre-wrap, metadata table", async () => {
    const html = await renderTask(
      new MockAdapter({ latency: false }),
      "/tasks/TB-1?tab=details",
      seedAll,
    );
    expect(html).toContain("Specification");
    // UI-27: the spec renders through TextEngine — this mock spec is plain
    // prose (em-dash dashes, no markdown syntax), so the plain path keeps
    // the verbatim pre-wrap output inside the well box (no <pre> anymore).
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("Metadata");
    expect(html).toContain("Acceptance criteria");
    expect(html).toContain("mnemos:decision");
  });

  it("tab links carry ?tab= so every pane deep-links", async () => {
    const html = await renderTask(
      new MockAdapter({ latency: false }),
      "/tasks/TB-1",
      seedAll,
    );
    expect(html).toContain('href="/tasks/TB-1?tab=reports"');
    expect(html).toContain('href="/tasks/TB-1?tab=history"');
    expect(html).toContain('href="/tasks/TB-1?tab=memory"');
    expect(html).toContain('href="/tasks/TB-1?tab=details"');
  });

  it("unknown tab value falls back to reports", async () => {
    const html = await renderTask(
      new MockAdapter({ latency: false }),
      "/tasks/TB-1?tab=nonsense",
      seedAll,
    );
    expect(html).toContain("Task reports, chronological");
  });

  it("empty tab states render honestly (a task without reports)", async () => {
    const gateway = new MockAdapter({ latency: false });
    const html = await renderTask(gateway, "/tasks/TB-3", async (client) => {
      await client.prefetchQuery({
        queryKey: keys.tasks.board(),
        queryFn: () => gateway.board(),
      });
      await client.prefetchQuery({
        queryKey: keys.tasks.reports.detail("TB-3"),
        queryFn: () => gateway.reports("TB-3"),
      });
    });
    expect(html).toContain("No reports yet");
  });

  it("not on the board (unknown id) → not-found with the archive escape", async () => {
    // UI-18: the seed settles the archived-row probe too (in a live DOM it
    // fetches — the page shows its skeleton while probing, then lands here).
    const probe = { limit: 200, offset: 0 };
    const html = await renderTask(
      new MockAdapter({ latency: false }),
      "/tasks/NOPE-404",
      async (client, gw) => {
        await seedAll(client, gw);
        if (gw instanceof MockAdapter) {
          await client.prefetchQuery({
            queryKey: keys.tasks.archive(probe),
            queryFn: () => gw.archive(probe),
          });
        }
      },
    );
    expect(html).toContain("No such task");
    expect(html).toContain("NOPE-404");
    expect(html).toContain("Open the archive");
  });

  it("error state with retry from a failed board fetch", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const query = client
      .getQueryCache()
      .build(client, { queryKey: keys.tasks.board(), queryFn: () => Promise.resolve(null) });
    query.setState({
      status: "error",
      fetchStatus: "idle",
      error: new ApiError(500, "board blew up"),
    });
    client.setQueryDefaults(keys.tasks.board(), { retryOnMount: false, retry: false });
    const html = renderToString(
      <GatewayContext.Provider value={new MockAdapter({ latency: false })}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            <UiTokenProvider>
              <I18nProvider initialLang="en">
                <MemoryRouter initialEntries={["/tasks/TB-1"]}>
                  <Routes>
                    <Route path="/tasks/:id" element={<TaskDetailPage />} />
                  </Routes>
                </MemoryRouter>
              </I18nProvider>
            </UiTokenProvider>
          </ToastProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
    expect(html).toContain("Could not load the task");
    expect(html).toContain("Retry");
  });

  it("renders the honest unsupported state on a mnemos gateway", async () => {
    const html = await renderTask(new HttpAdapter("/api"), "/tasks/TB-1");
    expect(html).toContain("The Tasks domain is unavailable in mnemos mode");
  });

  it("UI-18: tab links preserve ?return= (spec §2.2 rule 4)", async () => {
    const html = await renderTask(
      new MockAdapter({ latency: false }),
      "/tasks/TB-1?return=%2Ftasks%3Fstatus%3Dopen",
      seedAll,
    );
    expect(html).toContain(
      'href="/tasks/TB-1?return=%2Ftasks%3Fstatus%3Dopen&amp;tab=history"',
    );
    expect(html).toContain(
      'href="/tasks/TB-1?return=%2Ftasks%3Fstatus%3Dopen&amp;tab=memory"',
    );
  });

  it("UI-18 pair 4: an archived id renders from the archive probe fallback", async () => {
    const gateway = new MockAdapter({ latency: false });
    const probe = { limit: 200, offset: 0 };
    const html = await renderTask(gateway, "/tasks/RB-1", async (client, gw) => {
      if (gw instanceof MockAdapter) {
        await client.prefetchQuery({
          queryKey: keys.tasks.board(),
          queryFn: () => gw.board(),
        });
        await client.prefetchQuery({
          queryKey: keys.tasks.archive(probe),
          queryFn: () => gw.archive(probe),
        });
      }
    });
    // The board projection misses RB-1 (archived) — the archive probe row
    // renders the honest detail instead of the not-found escape.
    expect(html).toContain("RB-1");
    expect(html).toContain("регистрац");
    expect(html).not.toContain("No such task");
  });
});
