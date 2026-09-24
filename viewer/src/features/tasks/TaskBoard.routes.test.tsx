// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
// Owner feedback 2026-09-22: the persisted task-view preference is GONE —
// the route is the contract (/tasks = kanban, /tasks/list = list). These
// tests pin that an explicit navigation can NEVER be overridden. A stale
// "vesmaro.tasksView" key left by older builds must be ignored harmlessly.
const TASK_VIEW_STORAGE_KEY = "vesmaro.tasksView";
import type * as useTasksModule from "@/features/tasks/useTasks";

// Test-env seam (documented, not a product change — see LoginDialog.flow):
// useReportCounts re-renders on every cache event and cycles forever against
// react-query's notifyManager under happy-dom's synchronous act(); mocking
// only the badge counts keeps the routes, the shell and both task views real.
vi.mock("@/features/tasks/useTasks", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof useTasksModule;
  return { ...actual, useReportCounts: () => ({}) };
});

/**
 * Route-level contract (CV-4 §1): `/tasks` is the KANBAN (view №1) and
 * honours the persisted view choice; `/tasks/list` keeps the dense list;
 * the «Канбан | Список» toggle navigates and persists. Drives the REAL
 * route table (buildRoutes — the same data App.tsx mounts) through a memory
 * router in a real DOM; lazy routes resolve through a small waitFor helper.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;

async function renderAt(path: string): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  const gateway = new MockAdapter({ latency: false });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.board(),
    queryFn: () => gateway.board(),
  });
  const router = createMemoryRouter(buildRoutes(), { initialEntries: [path] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <GatewayContext.Provider value={gateway}>
        <QueryClientProvider client={queryClient!}>
          <AuthProvider adapterMode="board" endpoint="test">
            <ThemeProvider>
              <I18nProvider initialLang="en">
                <DensityProvider initialDensity="comfortable">
                  <HotkeysProvider>
                    <ToastProvider>
                      <UiTokenProvider>
                        <RouterProvider router={router} />
                      </UiTokenProvider>
                    </ToastProvider>
                  </HotkeysProvider>
                </DensityProvider>
              </I18nProvider>
            </ThemeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </GatewayContext.Provider>,
    );
  });
}

/** Wait for lazy route chunks + suspense to settle (bounded polling). */
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  await queryClient?.cancelQueries();
  queryClient?.clear();
  root = null;
  container = null;
  queryClient = null;
});

describe("/tasks routes + view toggle (CV-4 §1)", () => {
  it("renders the KANBAN at /tasks by default (no stored preference)", async () => {
    await renderAt("/tasks");
    await waitFor(() => container!.querySelector('a[href^="/tasks/TB-1?"]') !== null);
    // The board region + its 7 lanes (aria-labels + EN column titles).
    expect(container!.querySelector('[aria-label="Task kanban board"]')).not.toBeNull();
    expect(container!.textContent).toContain("backlog");
    expect(container!.textContent).toContain("in progress");
    // The dense table is NOT the default view anymore.
    expect(container!.querySelector("table")).toBeNull();
  });

  it("IGNORES a stale stored «list» preference: /tasks still renders the kanban", async () => {
    // Older builds persisted vesmaro.tasksView=list and redirected /tasks —
    // the owner's «Канбан показывает список» regression. Route wins now.
    localStorage.setItem(TASK_VIEW_STORAGE_KEY, "list");
    await renderAt("/tasks?q=board");
    // The board region itself is the assertion — ?q=board may filter the
    // fixture cards out, the projection is the contract under test.
    await waitFor(() => container!.querySelector('[aria-label="Task kanban board"]') !== null);
    expect(container!.querySelector("table")).toBeNull();
  });

  it("serves the dense list at /tasks/list directly", async () => {
    await renderAt("/tasks/list");
    await waitFor(() => container!.querySelector("table") !== null);
    expect(container!.textContent).not.toContain("Task kanban board");
  });

  it("the toggle navigates board → list WITHOUT persisting the choice", async () => {
    await renderAt("/tasks");
    await waitFor(() => container!.querySelector('a[href^="/tasks/TB-1?"]') !== null);
    // The TOGGLE's list link (the sidebar section link shares the href but
    // does not persist the choice — scope the query to the toggle nav).
    const listLink = Array.from(
      container!.querySelectorAll('nav[aria-label="Task view"] a'),
    ).find((link) => link.getAttribute("href") === "/tasks/list");
    expect(listLink).toBeDefined();
    await act(async () => {
      listLink!.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
    await waitFor(() => container!.querySelector("table") !== null);
    // Pure navigation: no storage write — /tasks must always render the
    // kanban again (the toggle is a route switch, not a preference).
    expect(localStorage.getItem(TASK_VIEW_STORAGE_KEY)).toBeNull();
  });
});
