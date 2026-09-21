import { useCallback, useEffect, useMemo, useState } from "react";
import { Search, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { TableRowSkeleton } from "@/components/skeletons/Skeletons";
import type { AssignmentItem, AssignmentLifecycleState, BoardTask } from "@/gateway/boardTypes";
import { isAgentsSource } from "@/gateway/capabilities";
import { useGateway } from "@/gateway/GatewayContext";
import { useI18n, useT } from "@/i18n";
import type { TranslationKey } from "@/i18n";
import { useBoardTasks } from "@/features/tasks/useTasks";
import { formatTaskDate } from "@/features/tasks/taskStatus";
import { ACTIVE_ASSIGNMENT_STATES } from "./assignmentStatus";
import { AgentsUnsupported } from "./AgentsUnsupported";
import { AssignmentDrawer } from "./AssignmentDrawer";
import { AssignExecutorSheet } from "./AssignExecutorSheet";
import type { AssignPrefill } from "./AssignExecutorSheet";
import { ExecutionFeedPanel } from "./ExecutionFeedPanel";
import { ExecutionRow } from "./ExecutionRow";
import { ExecutorStrip } from "./ExecutorStrip";
import { readFeed } from "./executionFeedStore";
import { loadTerminalCollapsed, saveTerminalCollapsed } from "./executionPrefs";
import { useAssignments, useExecutors } from "./useAgents";
import { useAssignmentMutations } from "./useAssignmentMutations";

/**
 * `/agents/execution` (AGW-3, spec §1.1): the THREE layers — presence strip,
 * dense assignment list, UI-10 feed — answering «кто подключён → что делает
 * сейчас → что застряло в очереди». Creation lives on the TASK only (§2.4):
 * this page is observability + cancel/restart; restart opens the sheet of
 * the failed attempt's task pre-filled with its parameters.
 *
 * Filters: state chips + executor (the strip IS the executor filter — never
 * a dropdown, §4.1) + text search + a client-side specialist match (spec
 * §5.5: the server has no specialist filter). j/k walk the DISPLAYED rows;
 * Esc closes the drawer (Radix). The amber SSE marker reads the
 * bridge-mirrored stream state — «данные на HH:MM» only while the socket
 * is down; recovery refetch is the bridge's (AGW-1 §5.9).
 */
export function ExecutionPage() {
  const t = useT();
  const { lang } = useI18n();
  const gateway = useGateway();
  const capable = isAgentsSource(gateway);
  const assignments = useAssignments();
  const executors = useExecutors();
  const board = useBoardTasks();
  const mutations = useAssignmentMutations();

  const [executorFilter, setExecutorFilter] = useState<string | null>(null);
  const [stateFilter, setStateFilter] = useState<AssignmentLifecycleState | null>(null);
  const [query, setQuery] = useState("");
  const [specialistQuery, setSpecialistQuery] = useState("");
  const [terminalCollapsed, setTerminalCollapsed] = useState(loadTerminalCollapsed);
  const [drawerRow, setDrawerRow] = useState<AssignmentItem | null>(null);
  // Retry source (failed/expired row) → opens the task's sheet pre-filled.
  const [retryTask, setRetryTask] = useState<BoardTask | null>(null);
  const [retryPrefill, setRetryPrefill] = useState<AssignPrefill | null>(null);
  // j/k cursor over the DISPLAYED rows (collapsed groups hide their rows).
  const [cursor, setCursor] = useState(0);
  const [streamDown, setStreamDown] = useState(false);
  const [lastDataAt, setLastDataAt] = useState(0);

  // Bridge-mirrored stream state → the amber marker (1 Hz poll of the
  // store; no extra EventSource, no per-render subscription churn).
  useEffect(() => {
    const poll = window.setInterval(() => {
      const feed = readFeed();
      setStreamDown(feed.streamState !== "open");
      setLastDataAt(feed.lastDataAt);
    }, 1000);
    return () => window.clearInterval(poll);
  }, []);

  const executorItems = useMemo(() => executors.data?.items ?? [], [executors.data]);
  const executorName = useCallback(
    (id: string): string => executorItems.find((row) => row.id === id)?.name ?? id,
    [executorItems],
  );
  const titleOf = useCallback(
    (taskId: string): string =>
      (board.data?.tasks ?? []).find((task) => task.id === taskId)?.title ?? "",
    [board.data],
  );

  /** Filtered rows: executor (strip) → state chip → specialist → text. */
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const specialistNeedle = specialistQuery.trim().toLowerCase();
    return (assignments.data?.items ?? [])
      .filter((row) => !executorFilter || row.claimed_by_executor === executorFilter)
      .filter((row) => !stateFilter || row.state === stateFilter)
      .filter(
        (row) =>
          specialistNeedle.length === 0 ||
          row.specialist.toLowerCase().includes(specialistNeedle),
      )
      .filter((row) => {
        if (needle.length === 0) return true;
        return (
          titleOf(row.task_id).toLowerCase().includes(needle) ||
          row.task_id.toLowerCase().includes(needle) ||
          row.specialist.toLowerCase().includes(needle) ||
          executorName(row.claimed_by_executor).toLowerCase().includes(needle)
        );
      });
  }, [
    assignments.data,
    executorFilter,
    stateFilter,
    specialistQuery,
    query,
    titleOf,
    executorName,
  ]);

  /** Grouping (§1.1): активные → очередь → терминальные за сегодня. */
  const { activeRows, queuedRows, terminalRows } = useMemo(() => {
    const today = new Date().toDateString();
    const active: AssignmentItem[] = [];
    const queued: AssignmentItem[] = [];
    const terminal: AssignmentItem[] = [];
    for (const row of filtered) {
      if (row.state === "queued") queued.push(row);
      else if (ACTIVE_ASSIGNMENT_STATES.includes(row.state)) active.push(row);
      else if (row.finished_at && new Date(row.finished_at).toDateString() === today) {
        terminal.push(row);
      }
    }
    const byNewest = (a: AssignmentItem, b: AssignmentItem): number =>
      b.created_at.localeCompare(a.created_at);
    return {
      activeRows: active.sort(byNewest),
      queuedRows: queued.sort(byNewest),
      terminalRows: terminal.sort(byNewest),
    };
  }, [filtered]);

  /** The DISPLAYED rows drive j/k (terminal rows only when expanded). */
  const displayed = useMemo(
    () =>
      terminalCollapsed
        ? [...activeRows, ...queuedRows]
        : [...activeRows, ...queuedRows, ...terminalRows],
    [activeRows, queuedRows, terminalRows, terminalCollapsed],
  );

  // j/k walk the displayed rows; typing surfaces keep their keys.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "j" && event.key !== "k") return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "SELECT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (displayed.length === 0) return;
      event.preventDefault();
      setCursor((current) => {
        const delta = event.key === "j" ? 1 : -1;
        return (current + delta + displayed.length) % displayed.length;
      });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [displayed.length]);

  const restart = (row: AssignmentItem): void => {
    // Retry opens the FAILED attempt's task sheet, pre-filled verbatim —
    // creation stays on the task (§2.4). An off-board task cannot retry
    // here (archived meanwhile) — the honest no-op.
    const task = (board.data?.tasks ?? []).find((candidate) => candidate.id === row.task_id);
    if (!task) return;
    setRetryTask(task);
    setRetryPrefill({ specialist: row.specialist, harness: row.harness });
  };

  if (!capable) {
    return <AgentsUnsupported />;
  }

  const total = displayed.length + (terminalCollapsed ? terminalRows.length : 0);
  const cursorId = displayed[cursor]?.id;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 id="agents-execution-title" className="text-lg font-semibold">
          {t("agents.execution.title")}
        </h1>
        {/* Amber SSE marker (§3.2): ONLY while the socket lies down. */}
        {streamDown && lastDataAt > 0 ? (
          <Badge variant="warning" className="gap-1">
            <WifiOff className="size-3.5" aria-hidden="true" />
            {t("agents.stream.stale", {
              time: formatTaskDate(new Date(lastDataAt).toISOString(), lang),
            })}
          </Badge>
        ) : null}
      </header>

      {/* Layer 1: the presence strip (§1.1 — the one bold element). */}
      <ExecutorStrip
        executors={executorItems}
        meta={executors.data?.meta}
        assignments={assignments.data?.items ?? []}
        selectedId={executorFilter}
        onSelect={setExecutorFilter}
      />

      {/* Filters: state chips + specialist (client) + text search. */}
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            "queued",
            "claimed",
            "running",
            "done",
            "failed",
            "cancelled",
            "expired",
          ] as const
        ).map((state) => (
          <button
            key={state}
            type="button"
            aria-pressed={stateFilter === state}
            onClick={() => setStateFilter(stateFilter === state ? null : state)}
            className={
              "rounded-sm border px-2 py-0.5 text-xs transition-colors duration-instant focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright " +
              (stateFilter === state
                ? "border-iris-bright/60 bg-iris/10 text-iris-bright"
                : "border-border-subtle text-foreground-secondary hover:border-iris-bright/40")
            }
          >
            {t(`agents.state.${state}` as TranslationKey)}
          </button>
        ))}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-foreground-secondary">
            <span className="sr-only">{t("agents.filters.specialist")}</span>
            <input
              value={specialistQuery}
              onChange={(event) => setSpecialistQuery(event.target.value)}
              placeholder={t("agents.filters.specialist")}
              className="h-8 w-36 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            />
          </label>
          <label className="flex items-center gap-1 text-xs text-foreground-secondary">
            <Search className="size-3.5" aria-hidden="true" />
            <span className="sr-only">{t("agents.filters.search")}</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("agents.filters.search")}
              className="h-8 w-44 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
            />
          </label>
        </div>
      </div>

      {/* Layer 2: the dense list — active → queue → terminal-today. */}
      {assignments.isPending ? (
        <div role="status" aria-label={t("agents.list.loading")}>
          <TableRowSkeleton rows={5} columns={3} />
        </div>
      ) : assignments.isError ? (
        <EmptyState
          variant="error"
          title={t("agents.list.failed")}
          message={assignments.error.message}
          action={
            <Button variant="outline" onClick={() => void assignments.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : total === 0 ? (
        <EmptyState
          variant="empty"
          title={t("agents.execution.emptyTitle")}
          message={t("agents.execution.emptyMessage")}
        />
      ) : (
        <div className="space-y-3">
          {activeRows.length > 0 ? (
            <RowGroup
              labelKey="agents.group.active"
              rows={activeRows}
              cursorId={cursorId}
              executorName={executorName}
              titleOf={titleOf}
              onOpenDrawer={setDrawerRow}
              onCancel={mutations.cancelAssignment}
              onRetry={restart}
            />
          ) : null}
          {queuedRows.length > 0 ? (
            <RowGroup
              labelKey="agents.group.queued"
              rows={queuedRows}
              cursorId={cursorId}
              executorName={executorName}
              titleOf={titleOf}
              onOpenDrawer={setDrawerRow}
              onCancel={mutations.cancelAssignment}
              onRetry={restart}
            />
          ) : null}
          {terminalRows.length > 0 ? (
            <section aria-label={t("agents.group.terminal")}>
              <button
                type="button"
                aria-expanded={!terminalCollapsed}
                onClick={() =>
                  setTerminalCollapsed((value) => {
                    saveTerminalCollapsed(!value);
                    return !value;
                  })
                }
                className="flex items-center gap-1.5 rounded-sm py-0.5 text-xs font-medium text-foreground-secondary transition-colors duration-instant hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright"
              >
                <span aria-hidden="true">{terminalCollapsed ? "▸" : "▾"}</span>
                {t("agents.group.terminal")}
                <span className="font-mono text-foreground-muted">
                  {terminalRows.length}
                </span>
              </button>
              {terminalCollapsed ? null : (
                <ul className="mt-1 space-y-1.5">
                  {terminalRows.map((row) => (
                    <ExecutionRow
                      key={row.id}
                      row={row}
                      executorName={executorName}
                      cursor={cursorId === row.id}
                      onOpenDrawer={setDrawerRow}
                      onCancel={mutations.cancelAssignment}
                      onRetry={restart}
                      titleOf={titleOf}
                    />
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </div>
      )}

      {/* Layer 3: the UI-10 feed (collapsed by default, persistent). */}
      <ExecutionFeedPanel />

      <AssignmentDrawer
        row={drawerRow}
        executorName={executorName}
        onCancel={mutations.cancelAssignment}
        onRetry={(row) => {
          setDrawerRow(null);
          restart(row);
        }}
        onClose={() => setDrawerRow(null)}
      />
      {retryTask ? (
        <AssignExecutorSheet
          task={retryTask}
          open
          onOpenChange={(open) => {
            if (!open) {
              setRetryTask(null);
              setRetryPrefill(null);
            }
          }}
          prefill={retryPrefill}
        />
      ) : null}
    </div>
  );
}

/** One labeled group of rows; zero-size groups render nothing (§1.1). */
function RowGroup({
  labelKey,
  rows,
  cursorId,
  executorName,
  titleOf,
  onOpenDrawer,
  onCancel,
  onRetry,
}: {
  labelKey: TranslationKey;
  rows: readonly AssignmentItem[];
  cursorId: number | undefined;
  executorName: (id: string) => string;
  titleOf: (taskId: string) => string;
  onOpenDrawer: (row: AssignmentItem) => void;
  onCancel: (row: AssignmentItem) => void;
  onRetry: (row: AssignmentItem) => void;
}) {
  const t = useT();
  return (
    <section aria-label={t(labelKey)}>
      <p className="flex items-center gap-1.5 text-xs font-medium text-foreground-secondary">
        {t(labelKey)}
        <span className="font-mono text-foreground-muted">{rows.length}</span>
      </p>
      <ul className="mt-1 space-y-1.5">
        {rows.map((row) => (
          <ExecutionRow
            key={row.id}
            row={row}
            executorName={executorName}
            cursor={cursorId === row.id}
            onOpenDrawer={onOpenDrawer}
            onCancel={onCancel}
            onRetry={onRetry}
            titleOf={titleOf}
          />
        ))}
      </ul>
    </section>
  );
}
