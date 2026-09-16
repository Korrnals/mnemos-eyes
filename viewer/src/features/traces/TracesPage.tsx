import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { EmptyState } from "@/components/EmptyState/EmptyState";
import { TraceRow } from "@/components/TraceRow/TraceRow";
import { TableRowSkeleton } from "@/components/skeletons/Skeletons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useTraces } from "@/hooks/useTraces";

/**
 * `/traces` — pipeline trace list (component-inventory §10). `?task_label=`
 * drives the server-side filter; the input holds a local draft that a timer
 * commits into the URL (debounced) — no sync effects, URL stays the source
 * of truth.
 */
const DEBOUNCE_MS = 250;

export function TracesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const taskLabel = searchParams.get("task_label") ?? undefined;

  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const value = draft ?? (taskLabel ?? "");

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

  return (
    <section aria-labelledby="traces-title" className="mx-auto max-w-5xl space-y-4">
      <h1 id="traces-title" className="text-xl font-semibold">
        Traces
      </h1>

      <div className="flex flex-col gap-1">
        <label htmlFor="trace-filter" className="text-xs text-foreground-secondary">
          Filter by task label
        </label>
        <Input
          id="trace-filter"
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="e.g. l1-t2-gateway"
          className="max-w-xs"
        />
      </div>

      {traces.isPending ? (
        <div role="status" aria-label="Loading traces">
          <TableRowSkeleton rows={5} columns={5} />
        </div>
      ) : traces.isError ? (
        <EmptyState
          variant="error"
          title="Could not load traces"
          message={traces.error.message}
          action={
            <Button variant="outline" onClick={() => void traces.refetch()}>
              Retry
            </Button>
          }
        />
      ) : traces.data.length === 0 ? (
        <EmptyState
          variant="empty"
          title="No traces found"
          message={
            taskLabel
              ? `No pipeline traces carry the label “${taskLabel}”.`
              : "The pipeline has not recorded any traces yet."
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border-subtle">
          <table className="w-full border-collapse bg-well text-left">
            <caption className="sr-only">Pipeline traces, newest first</caption>
            <thead>
              <tr className="border-b border-border-subtle text-xs text-foreground-secondary">
                <th scope="col" className="px-4 py-3 font-medium">Trace</th>
                <th scope="col" className="px-4 py-3 font-medium">Task label</th>
                <th scope="col" className="px-4 py-3 font-medium">Status</th>
                <th scope="col" className="px-4 py-3 font-medium">Started</th>
                <th scope="col" className="px-4 py-3 font-medium">Duration</th>
                <th scope="col" className="px-4 py-3 font-medium">Details</th>
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
