// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { MockAdapter } from "@/gateway/MockAdapter";
import { GatewayContext } from "@/gateway/GatewayContext";
import {
  useBoardTasks,
  useInboxMemory,
  useTask,
  useTaskArchive,
  useTaskDetail,
  useTaskHistory,
  useTaskInbox,
  useTaskMemories,
  useTaskReports,
} from "./useTasks";

/**
 * BE-15 regression gate (the measured shape of the 1.11.4 freeze lesson):
 * TanStack v5's `useQuery` re-runs `observer.setOptions` after every render
 * and notifies the cache (`observerOptionsUpdated`) whenever the new options
 * are not shallow-equal to the previous ones — and BOTH the `queryFn` and
 * the `queryKey` ARRAY are compared by reference. Inline closures plus bare
 * `keys.*()` calls made every useTasks re-render emit the event; every cache
 * subscriber then re-renders into the storm (the freeze loop's fuel).
 *
 * This gate mounts ONE consumer of every useTasks hook, settles the initial
 * fetches, then forces 25 parent-driven re-renders and asserts the two
 * invariants the unstable build violated:
 *   (a) ZERO `observerOptionsUpdated` events during the re-render burst
 *       (stable queryFn identity + stable queryKey reference),
 *   (b) ZERO extra wire calls (stability must not cost refetches).
 * On the pre-fix build (a) fails immediately: 25 re-renders → ≥25 events.
 */

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;
let gateway: MockAdapter | null = null;

/** One component consuming every useTasks hook (the real surface mix). */
function Probe(): null {
  useBoardTasks();
  useTask("TB-1");
  // The detail-GET fallback (BE-16 fold-in) rides the same conventions —
  // "NOPE" 404s once at mount and then sits in its error state, which the
  // burst must not disturb (no retry, no option churn).
  useTaskDetail("NOPE", true);
  useTaskReports("TB-1");
  useTaskHistory("TB-1");
  useTaskMemories("TB-1");
  useTaskArchive({ limit: 50, offset: 0 });
  useTaskInbox({});
  useInboxMemory("mem-0001", true);
  return null;
}

function ConsumerRig(): React.ReactElement {
  const [tick, setTick] = useState(0);
  return (
    <GatewayContext.Provider value={gateway!}>
      <QueryClientProvider client={queryClient!}>
        {/* Same mounted observer set across the whole burst. */}
        <button type="button" onClick={() => setTick((value) => value + 1)}>
          bump {tick}
        </button>
        <Probe />
      </QueryClientProvider>
    </GatewayContext.Provider>
  );
}

async function settleQueries(): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    if (queryClient!.isFetching() === 0) return;
    if (Date.now() > deadline) throw new Error("settleQueries: queries never settled");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  gateway = new MockAdapter({ latency: false });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
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
});

describe("BE-15: useTasks queryFn/queryKey identity is render-stable", () => {
  it(
    "25 re-renders of every hook emit no observerOptionsUpdated and no refetches",
    { timeout: 15_000 },
    async () => {
      root = createRoot(container!);
      await act(async () => {
        root!.render(<ConsumerRig />);
      });
      await settleQueries();

      // Baseline wire-call counters AFTER the initial mount.
      const boardCalls = vi.spyOn(gateway!, "board");
      const archiveCalls = vi.spyOn(gateway!, "archive");

      // (a) Subscribe AFTER settle; count ONLY the burst's events.
      const events: string[] = [];
      const unsubscribe = queryClient!.getQueryCache().subscribe((event) => {
        events.push(event.type);
      });

      for (let i = 0; i < 25; i += 1) {
        await act(async () => {
          container!.querySelector("button")!.click();
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
      }

      unsubscribe();
      expect(
        events.filter((type) => type === "observerOptionsUpdated"),
        "unstable options re-notify the cache on EVERY render — the freeze fuel",
      ).toEqual([]);

      // (b) Stability must not cost wire calls: no refetch during the burst.
      expect(boardCalls.mock.calls).toHaveLength(0);
      expect(archiveCalls.mock.calls).toHaveLength(0);
      boardCalls.mockRestore();
      archiveCalls.mockRestore();
    },
  );

  it("normalized params land on one cache entry per content, not per render", async () => {
    root = createRoot(container!);
    await act(async () => {
      root!.render(<ConsumerRig />);
    });
    await settleQueries();

    // The hooks normalize params objects — a caller passing a fresh literal
    // every render must land on ONE cache entry per content. The pre-fix
    // hooks hashed the same, but could not keep the OPTIONS reference stable;
    // this pins the wire-consumption side of the contract.
    const inboxState = queryClient!.getQueryState([
      "tasks",
      "inbox",
      { include_adopted: undefined },
    ]);
    expect(inboxState?.dataUpdateCount ?? 0).toBeGreaterThan(0);
    const archiveState = queryClient!.getQueryState([
      "tasks",
      "archive",
      { limit: 50, offset: 0 },
    ]);
    expect(archiveState?.dataUpdateCount ?? 0).toBeGreaterThan(0);
  });
});
