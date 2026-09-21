// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { Profiler, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

import { keys } from "@/lib/queryKeys";
import { useReportCounts } from "./useTasks";

/**
 * Feedback-loop contract for `useReportCounts` (freeze gate, unit level).
 *
 * The prod freeze (prod feedback: DOM dead after /tasks ↔ / cycles while
 * pushState kept working) was an event→render→event cycle: the hook ticked
 * on EVERY query-cache event, and every re-render of a sibling `useQuery`
 * with an inline `queryFn` emits `observerOptionsUpdated` back into the
 * cache. These tests pin the two halves of the contract:
 *   — cache writes OUTSIDE the reports namespace never re-render the badge
 *     consumer (the loop fuel is gone);
 *   — report count/detail writes DO re-render it (SSE badges stay live).
 */

/** The exact component shape that froze prod: badge hook + sibling useQuery
 * with an inline queryFn in ONE component (options identity unstable). */
function LoopProbe({ taskIds }: { taskIds: readonly string[] }) {
  useQuery({ queryKey: ["unrelated", "probe"], queryFn: async () => 1 });
  const counts = useReportCounts(taskIds);
  return (
    <ul>
      {Object.entries(counts).map(([id, count]) => (
        <li key={id} data-testid={`count-${id}`}>
          {count}
        </li>
      ))}
    </ul>
  );
}

/** Commit counter (Profiler runs in the commit phase — render stays pure). */
const stats = { renders: 0 };

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let queryClient: QueryClient | null = null;

async function mountProbe(taskIds: readonly string[]): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient!}>
        <Profiler id="probe" onRender={() => (stats.renders += 1)}>
          <LoopProbe taskIds={taskIds} />
        </Profiler>
      </QueryClientProvider>,
    );
  });
}

const countsText = (): string => container!.textContent ?? "";

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
  stats.renders = 0;
});

describe("useReportCounts feedback-loop contract", () => {
  it("ignores cache writes outside the reports namespace (no render storm)", async () => {
    await mountProbe(["TB-1"]);
    const before = stats.renders;
    // 25 writes to keys the badge never reads — board patches, an unrelated
    // domain, observer churn. Budget: at most a couple of commits, NOT 25+.
    for (let i = 0; i < 25; i += 1) {
      await act(async () => {
        queryClient!.setQueryData(["unrelated", "write"], i);
        queryClient!.setQueryData(keys.tasks.board(), {
          columns: ["backlog"],
          tasks: [],
          counts: { backlog: 0 },
        });
      });
    }
    expect(stats.renders - before).toBeLessThanOrEqual(3);
  });

  it("re-renders with the new count when SSE bumps a reports count key", async () => {
    await mountProbe(["TB-1"]);
    await act(async () => {
      queryClient!.setQueryData(keys.tasks.reports.count("TB-1"), 3);
    });
    expect(countsText()).toContain("3");

    // The SSE path in applyTaskEventToCache bumps the same key.
    await act(async () => {
      queryClient!.setQueryData<number>(keys.tasks.reports.count("TB-1"), (c) =>
        typeof c === "number" ? c + 1 : 1,
      );
    });
    expect(countsText()).toContain("4");
  });

  it("falls back to the visited detail page count (detail key only)", async () => {
    await mountProbe(["TB-2"]);
    await act(async () => {
      queryClient!.setQueryData(keys.tasks.reports.detail("TB-2"), {
        ok: true,
        task_id: "TB-2",
        count: 7,
        items: [],
      });
    });
    expect(countsText()).toContain("7");
    // Unknown stays unknown — no badge, never a fabricated zero.
    expect(container!.querySelector('[data-testid="count-TB-3"]')).toBeNull();
  });
});
