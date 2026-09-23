import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
} from "@tanstack/react-query";
import type { ArchivePage, ArchiveParams, BoardSummary } from "@/gateway/boardTypes";
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
 *
 * BE-15 (freeze lesson 1.11.4, hard measurement): in TanStack v5 every
 * `useQuery` re-render runs `observer.setOptions`, which shallow-compares
 * the new options with the previous ones and notifies the cache
 * (`observerOptionsUpdated`) when they differ. BOTH the `queryFn` closure
 * AND the `queryKey` array are compared by reference — an inline arrow (a
 * new function per render) or a bare `keys.tasks.board()` call (a new array
 * per render) makes the compare fail EVERY render, so every re-render of
 * every mount sprays `observerOptionsUpdated` into the cache. That noise is
 * the fuel of the 1.11.4 freeze loop. Contract for this file: every hook
 * pins the queryFn with `useCallback` and the queryKey ARRAY with `useMemo`
 * — re-renders then compare equal and emit nothing. Gate:
 * useTasks.queryFn.test.tsx.
 */

/** Board projection: rows + per-column counts (list page + mini-stats). */
export function useBoardTasks() {
  const gateway = useGateway();
  const capable = isTaskSource(gateway);
  // BE-15: stable queryKey reference + stable queryFn identity (see file doc).
  const queryKey = useMemo(() => keys.tasks.board(), []);
  const queryFn = useCallback(
    ({ signal }: QueryFunctionContext) => {
      if (!isTaskSource(gateway)) {
        throw new Error("useBoardTasks: gateway has no task capability.");
      }
      return gateway.board(undefined, signal);
    },
    [gateway],
  );
  return useQuery({
    queryKey,
    queryFn,
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
  const queryKey = useMemo(() => keys.tasks.board(), []);
  const queryFn = useCallback(
    ({ signal }: QueryFunctionContext) => {
      if (!isTaskSource(gateway) || taskId === undefined) {
        throw new Error("useTask: gateway has no task capability.");
      }
      return gateway.board(undefined, signal);
    },
    [gateway, taskId],
  );
  return useQuery({
    queryKey,
    queryFn,
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
  const id = taskId ?? "";
  const queryKey = useMemo(() => keys.tasks.reports.detail(id), [id]);
  const queryFn = useCallback(
    ({ signal }: QueryFunctionContext) => {
      if (!isTaskSource(gateway) || id === "") {
        throw new Error("useTaskReports: gateway has no task capability.");
      }
      return gateway.reports(id, signal);
    },
    [gateway, id],
  );
  return useQuery({
    queryKey,
    queryFn,
    enabled: capable,
    staleTime: STALE_TIMES.taskDetail,
    gcTime: GC_TIMES.taskDetail,
  });
}

/** Merged audit + memory timeline (detail page «История»). */
export function useTaskHistory(taskId: string | undefined) {
  const gateway = useGateway();
  const capable = isTaskSource(gateway) && taskId !== undefined;
  const id = taskId ?? "";
  const queryKey = useMemo(() => keys.tasks.history(id), [id]);
  const queryFn = useCallback(
    ({ signal }: QueryFunctionContext) => {
      if (!isTaskSource(gateway) || id === "") {
        throw new Error("useTaskHistory: gateway has no task capability.");
      }
      return gateway.history(id, signal);
    },
    [gateway, id],
  );
  return useQuery({
    queryKey,
    queryFn,
    enabled: capable,
    staleTime: STALE_TIMES.taskDetail,
    gcTime: GC_TIMES.taskDetail,
  });
}

/** Resolved memory links (detail page «Память»). */
export function useTaskMemories(taskId: string | undefined) {
  const gateway = useGateway();
  const capable = isTaskSource(gateway) && taskId !== undefined;
  const id = taskId ?? "";
  const queryKey = useMemo(() => keys.tasks.memories(id), [id]);
  const queryFn = useCallback(
    ({ signal }: QueryFunctionContext) => {
      if (!isTaskSource(gateway) || id === "") {
        throw new Error("useTaskMemories: gateway has no task capability.");
      }
      return gateway.taskMemories(id, signal);
    },
    [gateway, id],
  );
  return useQuery({
    queryKey,
    queryFn,
    enabled: capable,
    staleTime: STALE_TIMES.taskDetail,
    gcTime: GC_TIMES.taskDetail,
  });
}

/** Filtered + paginated archive page. */
export function useTaskArchive(params: ArchiveParams) {
  const gateway = useGateway();
  const capable = isTaskSource(gateway);
  // BE-15: normalize the params object so both the key array and the fetch
  // closure stay reference-stable while the CONTENTS change (page flips).
  const { q, status, col, agent, project, limit, offset } = params;
  const normalized = useMemo<ArchiveParams>(
    () => ({ q, status, col, agent, project, limit, offset }),
    [q, status, col, agent, project, limit, offset],
  );
  const queryKey = useMemo(() => keys.tasks.archive(normalized), [normalized]);
  const queryFn = useCallback(
    ({ signal }: QueryFunctionContext) => {
      if (!isTaskSource(gateway)) {
        throw new Error("useTaskArchive: gateway has no task capability.");
      }
      return gateway.archive(normalized, signal);
    },
    [gateway, normalized],
  );
  return useQuery({
    queryKey,
    queryFn,
    enabled: capable,
    staleTime: STALE_TIMES.taskArchive,
    gcTime: GC_TIMES.taskArchive,
    // keepPreviousData: the module-stable form of `(previous) => previous` —
    // an inline lambda here would re-introduce the per-render option churn.
    placeholderData: keepPreviousData, // pagination without flicker
  });
}

/**
 * One ARCHIVED task by exact id (UI-18 pair 4 fallback). Archived rows never
 * travel with /api/board, so /tasks/:id cannot see them through `useTask` —
 * the archive page is their only projection. This hook fires ONLY once the
 * board query settled empty (`enabled`), pulls one bounded archive page and
 * finds the exact id client-side: the wire `q` is a title/summary LIKE with
 * no id semantics, so an id probe would be dishonest. The 200 cap mirrors
 * the server clamp; a hit beyond it degrades to the page's not-found state
 * (the «Открыть архив» escape stays).
 */
const ARCHIVED_TASK_PROBE_LIMIT = 200;

export function useArchivedTask(taskId: string | undefined, enabled: boolean) {
  const gateway = useGateway();
  const capable = isTaskSource(gateway);
  const params = useMemo<ArchiveParams>(
    () => ({ limit: ARCHIVED_TASK_PROBE_LIMIT, offset: 0 }),
    [],
  );
  const queryKey = useMemo(() => keys.tasks.archive(params), [params]);
  // Stable select identity (same discipline as useTask): find the EXACT id.
  const select = useCallback(
    (page: ArchivePage) => page.items.find((task) => task.id === taskId),
    [taskId],
  );
  const queryFn = useCallback(
    ({ signal }: QueryFunctionContext) => {
      if (!isTaskSource(gateway)) {
        throw new Error("useArchivedTask: gateway has no task capability.");
      }
      return gateway.archive(params, signal);
    },
    [gateway, params],
  );
  return useQuery({
    queryKey,
    queryFn,
    enabled: capable && enabled,
    staleTime: STALE_TIMES.taskArchive,
    gcTime: GC_TIMES.taskArchive,
    select,
  });
}

/** AGG-1 inbox mirror. */
export function useTaskInbox(params: InboxParams = {}) {
  const gateway = useGateway();
  const capable = isTaskSource(gateway);
  // BE-15: the only param is a boolean — normalize it to keep the key array
  // and the fetch closure reference-stable across renders.
  const { include_adopted: includeAdopted } = params;
  const normalized = useMemo<InboxParams>(
    () => ({ include_adopted: includeAdopted }),
    [includeAdopted],
  );
  const queryKey = useMemo(() => keys.tasks.inbox(normalized), [normalized]);
  const queryFn = useCallback(
    ({ signal }: QueryFunctionContext) => {
      if (!isTaskSource(gateway)) {
        throw new Error("useTaskInbox: gateway has no task capability.");
      }
      return gateway.inbox(normalized, signal);
    },
    [gateway, normalized],
  );
  return useQuery({
    queryKey,
    queryFn,
    enabled: capable,
    staleTime: STALE_TIMES.taskInbox,
    gcTime: GC_TIMES.taskInbox,
  });
}

/**
 * UI-25: the full task:queue memory card behind an inbox row, fetched only
 * when the owner expands the record (the mirror carries a 300-char excerpt
 * by design, SEC-4). Reuses the shared memory-detail key so the expanded
 * card and the memory surfaces stay one cache entry.
 */
export function useInboxMemory(memoryId: string, enabled: boolean) {
  const gateway = useGateway();
  const queryKey = useMemo(() => keys.memories.detail(memoryId), [memoryId]);
  const queryFn = useCallback(
    ({ signal }: QueryFunctionContext) => gateway.getMemory(memoryId, false, signal),
    [gateway, memoryId],
  );
  return useQuery({
    queryKey,
    queryFn,
    enabled: enabled && memoryId.length > 0,
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
