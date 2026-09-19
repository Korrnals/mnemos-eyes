import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { TraceRow } from "@/components/TraceRow/TraceRow";
import { TableRowSkeleton } from "@/components/skeletons/Skeletons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/errors";
import { useTraces } from "@/hooks/useTraces";
import { useAuth } from "@/features/auth/AuthContext";
import { useT } from "@/i18n";

/**
 * `/traces` — pipeline trace list (component-inventory §10). `?task_label=`
 * drives the server-side filter; the input holds a local draft that a timer
 * commits into the URL (debounced) — no sync effects, URL stays the source of
 * truth.
 *
 * Board mode (owner feedback 1.4.0): the merge-API declares /traces
 * unsupported (501) — that renders the honest "not available in board mode"
 * empty state, never a scary error.
 */
const DEBOUNCE_MS = 300; // same commit budget as the search page keystrokes

export function TracesPage() {
  const t = useT();
  const { adapterMode } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const taskLabel = searchParams.get("task_label") ?? undefined;

  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const value = draft ?? taskLabel ?? "";

  const commit = (next: string) => {
    setSearchParams(
      (prev) => {
        const nextParams = new URLSearchParams(prev);
        if (next.trim()) nextParams.set("task_label", next.trim());
        else nextParams.delete("task_label");
        return nextParams;
      },
      { replace: true },
    );
  };

  const onChange = (next: string) => {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setDraft(null);
      commit(next);
    }, DEBOUNCE_MS);
  };

  const traces = useTraces({ task_label: taskLabel, limit: 50 });

  const boardUnsupported =
    adapterMode === "board" &&
    traces.isError &&
    isApiError(traces.error) &&
    traces.error.status === 501;

  return (
    <section aria-labelledby="traces-title" className="mx-auto max-w-5xl space-y-4">
      <h1 id="traces-title" className="text-xl font-semibold">
        {t("traces.title")}
      </h1>

      <div className="flex flex-col gap-1">
        <label htmlFor="trace-filter" className="text-xs text-foreground-secondary">
          {t("traces.filterLabel")}
        </label>
        <Input
          id="trace-filter"
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t("traces.filterPlaceholder")}
          className="max-w-xs"
        />
      </div>

      {traces.isPending ? (
        <div role="status" aria-label={t("traces.loading")}>
          <TableRowSkeleton rows={5} columns={5} />
        </div>
      ) : boardUnsupported ? (
        <EmptyState
          variant="empty"
          title={t("traces.unavailableBoard")}
          message={t("traces.unavailableBoardMessage")}
          detail={traces.error.message}
        />
      ) : traces.isError ? (
        <EmptyState
          variant="error"
          title={t("traces.loadFailed")}
          message={traces.error.message}
          action={
            <Button variant="outline" onClick={() => void traces.refetch()}>
              {t("common.retry")}
            </Button>
          }
        />
      ) : traces.data.length === 0 ? (
        <EmptyState
          variant="empty"
          title={t("traces.empty")}
          message={
            taskLabel
              ? t("traces.emptyFiltered", { label: taskLabel })
              : t("traces.emptyPlain")
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border-subtle">
          <table className="w-full border-collapse bg-well text-left">
            <caption className="sr-only">{t("traces.caption")}</caption>
            <thead>
              <tr className="border-b border-border-subtle text-xs text-foreground-secondary">
                <th scope="col" className="px-4 py-3 font-medium">
                  {t("traces.colTrace")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t("traces.colTaskLabel")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t("traces.colStatus")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t("traces.colStarted")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t("traces.colDuration")}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t("traces.colDetails")}
                </th>
              </tr>
            </thead>
            <tbody>
              {traces.data.map((trace) => (
                <TraceRow
                  key={trace.id}
                  trace={trace}
                  className="border-b border-border-subtle last:border-b-0"
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
