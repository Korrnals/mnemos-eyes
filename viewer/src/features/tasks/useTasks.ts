import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ArchiveParams, BoardSummary } from "@/gateway/boardTypes";
import type { InboxParams } from "@/gateway/BoardAdapter";
import { isTaskSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { keys } from "@/lib/queryKeys";
import { GC_TIMES, STALE_TIMES } from "@/lib/queryClient";

/**
 * Ф2 task-domain data hooks. Every hook is capability-gated (`isTaskSource`)
 * exactly like the Ф1 pulse/health pair: on the mnemos adapter the queries
 * stay idle and the pages render their honest unsupported states.
 *
 * Caching decision (instruction: "кешируй через TanStack query key
 * tasks.board"): the board API has NO single-task GET, so `useTask(id)`
 * reads the SHARED `tasks.board` projection through a `select` — the list
 * page, the mini-stats and every detail page share one wire call, and SSE
 * patches to `tasks.board` reach all of them at once.
 */

/** Board projection: rows + per-column counts (list page + mini-stats). */
export function useBoardTasks() {
  const gateway = useGateway();
  const capable = isTaskSource(gateway);
  return useQuery({
    queryKey: keys.tasks.board(),
    queryFn: ({ signal }) => {
      if (!isTaskSource(gateway)) {
        throw new Error("useBoardTasks: gateway has no task capability.");
      }
      return gateway.board(undefined, signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.taskBoard,
    gcTime: GC_TIMES.taskBoard,
  });
}

/**
 * One task by id from the shared board projection. `select` keeps the wire
 * call shared; undefined data ⇒ the task is not on the board (archived or
 * unknown) and the page renders its not-found state.
 */
export function useTask(taskId: string | undefined) {
  const gateway = useGateway();
  const capable = isTaskSource(gateway) && taskId !== undefined;
  // Stable select identity: without the memo TanStack re-runs it every render.
  const select = useCallback(
    (board: BoardSummary) => board.tasks.find((task) => task.id === taskId),
    [taskId],
  );
  return useQuery({
    queryKey: keys.tasks.board(),
    queryFn: ({ signal }) => {
      if (!isTaskSource(gateway) || taskId === undefined) {
        throw new Error("useTask: gateway has no task capability.");
      }
      return gateway.board(undefined, signal);
    },
    enabled: capable,
    select,
    staleTime: STALE_TIMES.taskBoard,
    gcTime: GC_TIMES.taskBoard,
  });
}

/** Chronological report history for one task (detail page «Отчёты»). */
export function useTaskReports(taskId: string | undefined) {
  const gateway = useGateway();
  const capable = isTaskSource(gateway) && taskId !== undefined;
  return useQuery({
    queryKey: keys.tasks.reports.detail(taskId ?? ""),
    queryFn: ({ signal }) => {
      if (!isTaskSource(gateway) || taskId === undefined) {
        throw new Error("useTaskReports: gateway has no task capability.");
      }
      return gateway.reports(taskId, signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.taskDetail,
    gcTime: GC_TIMES.taskDetail,
  });
}

/** Merged audit + memory timeline (detail page «История»). */
export function useTaskHistory(taskId: string | undefined) {
  const gateway = useGateway();
  const capable = isTaskSource(gateway) && taskId !== undefined;
  return useQuery({
    queryKey: keys.tasks.history(taskId ?? ""),
    queryFn: ({ signal }) => {
      if (!isTaskSource(gateway) || taskId === undefined) {
        throw new Error("useTaskHistory: gateway has no task capability.");
      }
      return gateway.history(taskId, signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.taskDetail,
    gcTime: GC_TIMES.taskDetail,
  });
}

/** Resolved memory links (detail page «Память»). */
export function useTaskMemories(taskId: string | undefined) {
  const gateway = useGateway();
  const capable = isTaskSource(gateway) && taskId !== undefined;
  return useQuery({
    queryKey: keys.tasks.memories(taskId ?? ""),
    queryFn: ({ signal }) => {
      if (!isTaskSource(gateway) || taskId === undefined) {
        throw new Error("useTaskMemories: gateway has no task capability.");
      }
      return gateway.taskMemories(taskId, signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.taskDetail,
    gcTime: GC_TIMES.taskDetail,
  });
}

/** Filtered + paginated archive page. */
export function useTaskArchive(params: ArchiveParams) {
  const gateway = useGateway();
  const capable = isTaskSource(gateway);
  return useQuery({
    queryKey: keys.tasks.archive(params),
    queryFn: ({ signal }) => {
      if (!isTaskSource(gateway)) {
        throw new Error("useTaskArchive: gateway has no task capability.");
      }
      return gateway.archive(params, signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.taskArchive,
    gcTime: GC_TIMES.taskArchive,
    placeholderData: (previous) => previous, // pagination without flicker
  });
}

/** AGG-1 inbox mirror. */
export function useTaskInbox(params: InboxParams = {}) {
  const gateway = useGateway();
  const capable = isTaskSource(gateway);
  return useQuery({
    queryKey: keys.tasks.inbox(params),
    queryFn: ({ signal }) => {
      if (!isTaskSource(gateway)) {
        throw new Error("useTaskInbox: gateway has no task capability.");
      }
      return gateway.inbox(params, signal);
    },
    enabled: capable,
    staleTime: STALE_TIMES.taskInbox,
    gcTime: GC_TIMES.taskInbox,
  });
}

/**
 * Per-task report counts for the list-page badge. The board wire carries no
 * report count, so this derives what the CLIENT knows: the count key fed by
 * SSE `report` events and by visited detail pages (the effect below syncs
 * it from the loaded ReportsOut). Tasks with no known count render no badge
 * — unknown is not zero.
 *
 * Freeze fix (prod feedback: /tasks ↔ / cycles froze the DOM while
 * pushState kept working). The old implementation `setTick`ed on EVERY
 * query-cache event. That is a self-sustaining loop: every re-render of a
 * sibling `useQuery` with an inline `queryFn` sends
 * `observerOptionsUpdated` back into the cache (unstable options ⇒
 * `QueryObserver.setOptions` notifies), so event → tick → render → event →
 * … never settles — one probe component measured 3994 cache events /
 * 3995 renders in 400 ms, starving the scheduler until paint and router
 * transitions stopped committing (gate: TasksLayout.freeze.test.tsx).
 *
 * The contract now: derive during render (the DOM-free renderToString
 * harness keeps its badge coverage), and let a subscription re-render ONLY
 * when a `tasks.reports.*` key changes AND the derived counts actually
 * differ — the equality guard makes the event → render cycle impossible by
 * construction, while SSE count bumps still update the badges.
 */
export function useReportCounts(taskIds: readonly string[]): Record<string, number> {
  const queryClient = useQueryClient();
  const [revision, setRevision] = useState(0);
  const counts = useMemo(() => {
    void revision; // the subscription below only bumps this to invalidate
    return deriveReportCounts(queryClient, taskIds);
  }, [queryClient, taskIds, revision]);

  // Last RENDERED counts, read by the subscription outside render. Updated
  // in an effect (ref writes during render are forbidden by the compiler
  // rules) — useRef(counts) keeps it correct before the first effect runs.
  const lastCountsRef = useRef(counts);
  useEffect(() => {
    lastCountsRef.current = counts;
  }, [counts]);

  useEffect(() => {
    return queryClient.getQueryCache().subscribe((event) => {
      // Only report keys can change the derived counts. Ignoring the rest
      // (board patches, observer churn on other queries) removes the loop
      // fuel; the value guard below removes the last spark.
      if (!isReportsCacheKey(event.query.queryKey)) return;
      const next = deriveReportCounts(queryClient, taskIds);
      if (sameReportCounts(lastCountsRef.current, next)) return; // no-op write
      setRevision((value) => value + 1);
    });
  }, [queryClient, taskIds]);

  return counts;
}

/** Cache-key filter: everything under `tasks.reports.*` (count + detail). */
function isReportsCacheKey(queryKey: readonly unknown[]): boolean {
  return (
    queryKey[0] === keys.tasks.reports.all[0] &&
    queryKey[1] === keys.tasks.reports.all[1]
  );
}

/** The derivation the old memo did: count key first, visited detail second. */
function deriveReportCounts(
  queryClient: QueryClient,
  taskIds: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const taskId of taskIds) {
    const known = queryClient.getQueryData<number>(keys.tasks.reports.count(taskId));
    if (typeof known === "number" && known > 0) counts[taskId] = known;
    else {
      const reports = queryClient.getQueryData(keys.tasks.reports.detail(taskId));
      const fromDetail = (reports as { count?: number } | undefined)?.count;
      if (typeof fromDetail === "number" && fromDetail > 0) counts[taskId] = fromDetail;
    }
  }
  return counts;
}

/** Referential-stability check for the snapshot (small flat number map). */
function sameReportCounts(
  a: Record<string, number>,
  b: Record<string, number>,
): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/** Sync the count key from a loaded reports page (detail page effect). */
export function useSyncReportCount(taskId: string | undefined, count: number | undefined) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (taskId === undefined || count === undefined) return;
    queryClient.setQueryData(keys.tasks.reports.count(taskId), count);
  }, [queryClient, taskId, count]);
}
