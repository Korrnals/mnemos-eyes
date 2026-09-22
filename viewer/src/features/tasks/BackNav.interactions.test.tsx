// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { buildRoutes } from "@/app/routes";
import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { I18nProvider } from "@/i18n";
import { ToastProvider } from "@/components/Toast/ToastProvider";
import { UiTokenProvider } from "@/features/ui-token/UiTokenProvider";
import { DensityProvider } from "@/components/density-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { HotkeysProvider } from "@/layout/Hotkeys";
import { AuthProvider } from "@/features/auth/AuthProvider";

/**
 * UI-18 interaction gates (spec §4 criteria 2/3/6/10, W1 pairs) over the REAL
 * route table in a real DOM:
 *   1. the owner scenario — tag drill → task → «‹ Tags» lands back on
 *      /memory/tags?tag=… with the drill restored from the URL;
 *   2. a task TAB click preserves ?return= (spec §2.2 rule 4);
 *   3. the archive pair — an archive row leads to /tasks/:id (the archived
 *      row renders through the archive-probe fallback) and «‹ Archive»
 *      restores the filter URL.
 * Browser back is NOT exercised here — it is the router's own contract
 * (POP + ScrollRestoration), untouched by this wave.
 */

const DRILL_TAG = "project:mnemos-eyes";
const DRILL_RETURN = `%2Fmemory%2Ftags%3Ftag%3D${encodeURIComponent(DRILL_TAG)}`;
const ARCHIVE_Q = "регистрац";
const ARCHIVE_RETURN = `/tasks/RB-1?return=%2Ftasks%2Farchive%3Fq%3D${encodeURIComponent(ARCHIVE_Q)}`;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let router: ReturnType<typeof createMemoryRouter> | null = null;

async function mount(
  path: string,
  seed: (client: QueryClient, gateway: MockAdapter) => Promise<void> = async () => {},
): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const gateway = new MockAdapter({ latency: false });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await seed(queryClient, gateway);
  router = createMemoryRouter(buildRoutes(), { initialEntries: [path] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <AuthProvider adapterMode="mock" endpoint="/api">
              <I18nProvider initialLang="en">
                <DensityProvider initialDensity="comfortable">
                  <HotkeysProvider>
                    <ToastProvider>
                      <UiTokenProvider>
                        <RouterProvider router={router!} />
                      </UiTokenProvider>
                    </ToastProvider>
                  </HotkeysProvider>
                </DensityProvider>
              </I18nProvider>
            </AuthProvider>
          </ThemeProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
}

/** Poll inside act() until the predicate holds (lazy route + query settle). */
async function waitFor(
  what: string,
  probe: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) {
      throw new Error(`waitFor(${what}) timed out; page text: ${container!.textContent?.slice(0, 300)}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

async function click(target: Element | null | undefined): Promise<void> {
  expect(target, "interaction target must exist").toBeDefined();
  await act(async () => {
    (target as HTMLAnchorElement).click();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function anchorByHref(fragment: string): HTMLAnchorElement | undefined {
  return [...container!.querySelectorAll<HTMLAnchorElement>("a")].find((a) =>
    (a.getAttribute("href") ?? "").includes(fragment),
  );
}

function backControl(): HTMLAnchorElement | null {
  return container!.querySelector<HTMLAnchorElement>("a[aria-label^='Back:']");
}

function location(): string {
  return router!.state.location.pathname + router!.state.location.search;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  container = null;
  root = null;
  router = null;
});

describe("UI-18 back-nav interactions", () => {
  it("owner scenario: tag drill → task → «‹ Tags» restores the drill URL", async () => {
    // Raw colon in the query — browsers keep `:` unencoded in search strings.
    await mount(`/memory/tags?tag=${DRILL_TAG}`, async (client, gateway) => {
      await client.prefetchQuery({ queryKey: keys.tags.merged(), queryFn: () => gateway.mergedTags() });
    });
    await waitFor("drill task link", () => Boolean(anchorByHref("/tasks/TB-1?return=")));

    // The drill's task links carry the drill URL as their return context.
    const taskLink = anchorByHref("/tasks/TB-1?return=");
    expect(taskLink!.getAttribute("href")).toBe(`/tasks/TB-1?return=${DRILL_RETURN}`);

    // Fall into the task; the back control points back at the drill.
    await click(taskLink);
    await waitFor("task page", () => backControl() !== null);
    expect(location()).toBe(`/tasks/TB-1?return=${DRILL_RETURN}`);
    const control = backControl()!;
    expect(control.getAttribute("href")).toBe(`/memory/tags?tag=${DRILL_TAG}`);
    expect(control.getAttribute("aria-label")).toBe("Back: Tags");

    // The context link lands EXACTLY on the source URL (spec criterion 3):
    // the drill restores itself from ?tag= (UI-17 URL-first contract).
    await click(control);
    await waitFor("drill restored", () => container!.querySelector("#tag-drill-title") !== null);
    expect(location()).toBe(`/memory/tags?tag=${DRILL_TAG}`);
  });

  it("a tab click preserves ?return= (spec §2.2 rule 4)", async () => {
    const boardReturn = "%2Ftasks%3Fstatus%3Dopen";
    await mount(`/tasks/TB-1?return=${boardReturn}`, async (client, gateway) => {
      await client.prefetchQuery({ queryKey: keys.tasks.board(), queryFn: () => gateway.board() });
    });
    await waitFor("tab links", () => Boolean(anchorByHref("tab=history")));

    const historyTab = anchorByHref("tab=history")!;
    expect(historyTab.getAttribute("href")).toBe(
      `/tasks/TB-1?return=${boardReturn}&tab=history`,
    );

    await click(historyTab);
    await waitFor("history tab active", () => location().includes("tab=history"));
    expect(location()).toBe(`/tasks/TB-1?return=${boardReturn}&tab=history`);
    // The context survived the tab switch.
    expect(backControl()!.getAttribute("href")).toBe("/tasks?status=open");
  });

  it("archive pair: row → /tasks/:id (archived fallback) → «‹ Archive» restores filters", async () => {
    await mount("/tasks/archive?q=регистрац", async (client, gateway) => {
      const params = { q: ARCHIVE_Q, limit: 50, offset: 0 };
      await client.prefetchQuery({
        queryKey: keys.tasks.archive(params),
        queryFn: () => gateway.archive(params),
      });
    });
    await waitFor("archive row link", () => Boolean(anchorByHref("/tasks/RB-1?return=")));

    // Pair 4 source: the row title leads to the detail WITH the archive URL.
    const rowLink = anchorByHref("/tasks/RB-1?return=")!;
    expect(rowLink.getAttribute("href")).toBe(ARCHIVE_RETURN);

    // The archived row renders on the detail page (board misses it; the
    // archive probe supplies the row).
    await click(rowLink);
    await waitFor("archived task rendered", () => {
      const text = container!.textContent ?? "";
      return text.includes("RB-1") && !text.includes("No such task");
    });
    expect(location()).toBe(ARCHIVE_RETURN);

    // «‹ Archive» restores the filtered archive URL.
    const control = backControl();
    expect(control!.getAttribute("aria-label")).toBe("Back: Archive");
    await click(control);
    await waitFor("archive restored", () => location().startsWith("/tasks/archive"));
    expect(location()).toBe("/tasks/archive?q=регистрац");
  });
});
