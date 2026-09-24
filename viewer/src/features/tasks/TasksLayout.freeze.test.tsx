// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Profiler, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { buildRoutes } from "@/app/routes";
import { EventStream } from "@/gateway/events";
import { MockAdapter } from "@/gateway/MockAdapter";
import type { TaskEventSource } from "@/gateway/capabilities";
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
 * FREEZE GATE (prod feedback: after ~6 navigations /tasks ↔ / the DOM froze
 * while pushState kept working; /api/health stayed 200 — the network was
 * alive, React was not). Root cause class: `useReportCounts` re-rendered on
 * EVERY query-cache event, while every re-render of a sibling `useQuery`
 * (inline `queryFn` → unstable options) emits `observerOptionsUpdated` back
 * into the cache — event → render → event → …, an unbounded feedback loop
 * that starves router transitions: URLs change, content never commits.
 *
 * This gate drives the REAL route table through a memory router with a
 * seeded cache (board + visited detail keys) and LIVE SSE frames, runs the
 * exact reported cycle (6× /tasks ↔ /, then /memory) and asserts the three
 * invariants the frozen build violated:
 *   (a) query-cache subscriptions return to baseline (no listener leak),
 *   (b) the render count stays inside a hard budget (no render storm),
 *   (c) navigation still swaps page content after the cycle (no DOM freeze).
 *
 * On the frozen build this gate does not "fail" — it never settles (the
 * render loop keeps act() busy forever); the timeout IS the reproduction.
 * The SSE seam also proves the domain bridge hygiene: exactly ONE stream
 * open while inside /tasks, every stream closed after leaving it.
 */

/** Minimal EventSource stand-in driven by the test through the factory seam. */
interface FakeSseSource {
  onmessage: ((event: { data: string }) => void) | null;
  closed: boolean;
  emit(data: string): void;
  close(): void;
}

function makeFakeSource(): FakeSseSource {
  return {
    onmessage: null,
    closed: false,
    emit(data: string) {
      this.onmessage?.({ data });
    },
    close() {
      this.closed = true;
    },
  };
}

/** MockAdapter + `gateway.events()` whose sources the test controls. */
class SseMockAdapter extends MockAdapter implements TaskEventSource {
  readonly sseSources: FakeSseSource[] = [];

  events(): EventStream {
    return new EventStream({
      eventSourceFactory: () => {
        const source = makeFakeSource();
        this.sseSources.push(source);
        return source as unknown as EventSource;
      },
    });
  }
}

/** One SSE `report` frame for TB-1 (ui-contract §11 wire shape). */
const reportFrame = () =>
  JSON.stringify({
    kind: "report",
    task_id: "TB-1",
    report: { kind: "intermediate", body: "freeze-gate probe" },
  });

/** QueryCache internals the Subscribable base exposes (listener bookkeeping). */
type CacheWithListeners = { listeners: Set<unknown> };

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;
let gateway: SseMockAdapter | null = null;
let router: ReturnType<typeof createMemoryRouter> | null = null;
/** Commits of the profiled subtree (every page + shell render pass). */
let renderCount = 0;

async function mountApp(initialPath: string): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  gateway = new SseMockAdapter({ latency: false });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the cache the way a live session looks after visiting a detail
  // page: the shared board projection + reports.detail + the count key.
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.board(),
    queryFn: () => gateway!.board(),
  });
  await queryClient.prefetchQuery({
    queryKey: keys.tasks.reports.detail("TB-1"),
    queryFn: () => gateway!.reports("TB-1"),
  });
  queryClient.setQueryData(keys.tasks.reports.count("TB-1"), 3);

  router = createMemoryRouter(buildRoutes(), { initialEntries: [initialPath] });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <Profiler id="freeze-gate" onRender={() => (renderCount += 1)}>
        <GatewayContext.Provider value={gateway}>
          <QueryClientProvider client={queryClient!}>
            <AuthProvider adapterMode="board" endpoint="test">
              <ThemeProvider>
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
              </ThemeProvider>
            </AuthProvider>
          </QueryClientProvider>
        </GatewayContext.Provider>
      </Profiler>,
    );
  });
}

/** Wait for lazy route chunks + suspense to settle (bounded polling). */
// ME-006: 2s per condition left no headroom for a scheduler spike while
// 16 vitest workers hammer the CPU (the ~1-in-2 full-run flake: one wait
// over budget aborted the whole cycle). 5s is still far below the test
// timeout — the budget is wall-clock, every assertion is unchanged.
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor: condition not met");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

const listenersCount = (): number =>
  (queryClient!.getQueryCache() as unknown as CacheWithListeners).listeners.size;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  renderCount = 0;
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
  gateway = null;
  router = null;
});

describe("freeze gate: /tasks navigation cycle with live SSE", () => {
  it(
    "keeps the app interactive across 6× /tasks ↔ / with SSE report frames",
    { timeout: 30_000 },
    async () => {
      await mountApp("/");
      const baselineListeners = listenersCount();
      // The lazy Overview chunk must be on screen before the cycle starts.
      await waitFor(() => container!.textContent!.length > 0);

      for (let i = 0; i < 6; i += 1) {
        await act(async () => {
          await router!.navigate("/tasks");
        });
        await waitFor(() => container!.querySelector('a[href^="/tasks/TB-1?"]') !== null);

        // Exactly ONE live stream while inside the domain (per-mount stream,
        // no stacking); every frame goes through the real SSE → cache path.
        const open = gateway!.sseSources.filter((source) => !source.closed);
        expect(open).toHaveLength(1);
        await act(async () => {
          open[0].emit(reportFrame());
        });

        await act(async () => {
          await router!.navigate("/");
        });
      }

      // Leaving the domain closed every stream the layout opened (no leak,
      // no orphan EventSource patching the cache from the outside).
      expect(gateway!.sseSources.length).toBeGreaterThanOrEqual(6);
      for (const source of gateway!.sseSources) {
        expect(source.closed).toBe(true);
      }

      // (c) The exact frozen-build symptom: after the cycle, navigation must
      // still SWAP page content. /memory renders the memories heading; the
      // frozen build kept showing the tasks board here.
      await act(async () => {
        await router!.navigate("/memory");
      });
      await waitFor(() => container!.querySelector("#memories-title") !== null);
      expect(container!.querySelector('a[href^="/tasks/TB-1?"]')).toBeNull();

      // And back into the task domain — content swaps both ways, and the
      // badge still mirrors the SSE-fed count (6 frames over the seeded 3).
      await act(async () => {
        await router!.navigate("/tasks/list");
      });
      await waitFor(() => container!.querySelector("table") !== null);
      const badgeCount = queryClient!.getQueryData<number>(
        keys.tasks.reports.count("TB-1"),
      );
      expect(badgeCount).toBe(9);
      // The badge lives in the title attribute + the visible count digit.
      expect(
        container!.querySelector(`[title="reports — ${badgeCount}"]`),
      ).not.toBeNull();

      // (b) Render budget: 14 navigations + 6 SSE frames + lazy chunks must
      // stay far below storm territory. Healthy build: ~46 commits; storms
      // are unbounded (the frozen build never settles at all).
      expect(renderCount).toBeLessThan(150);

      // (a) Cache subscriptions return to baseline after unmount — the
      // badge subscription and the SSE-driven patches leave no listeners.
      await act(async () => {
        root!.unmount();
      });
      expect(listenersCount()).toBe(baselineListeners);
    },
  );
});
