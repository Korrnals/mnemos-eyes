import { Badge } from "@/components/ui/badge";
import { formatDuration, formatTimestamp } from "@/components/memory/memoryDisplay";
import type { Trace } from "@/gateway/types";

/**
 * One pipeline trace record in a compact table row (component-inventory §10).
 * Expand shows the raw JSON inline via a native <details> element — keyboard
 * and screen-reader accessible by default.
 */
export interface TraceRowProps {
  trace: Trace;
  className?: string;
}

function statusVariant(status: string): "success" | "iris" | "error" | "default" {
  switch (status) {
    case "ok":
    case "success":
      return "success";
    case "running":
    case "pending":
      return "iris";
    case "failed":
    case "error":
      return "error";
    default:
      return "default";
  }
}

export function TraceRow({ trace, className }: TraceRowProps) {
  const status = typeof trace.status === "string" ? trace.status : "unknown";
  const started = typeof trace.started_at === "string" ? trace.started_at : undefined;
  const duration = typeof trace.duration_ms === "number" ? trace.duration_ms : null;

  return (
    <tr className={className}>
      <td
        className="px-4 py-3 text-xs text-foreground"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {trace.id}
      </td>
      <td className="px-4 py-3 text-sm text-foreground">{trace.task_label ?? "—"}</td>
      <td className="px-4 py-3">
        <Badge variant={statusVariant(status)}>{status}</Badge>
      </td>
      <td className="px-4 py-3 text-xs text-foreground-secondary">
        <time dateTime={started}>{formatTimestamp(started)}</time>
      </td>
      <td className="px-4 py-3 text-xs text-foreground-secondary">
        {formatDuration(duration)}
      </td>
      <td className="px-4 py-3">
        <details>
          <summary className="cursor-pointer text-xs text-iris underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-iris-bright">
            Raw JSON
          </summary>
          <pre
            className="mt-2 max-w-md overflow-x-auto rounded-md border border-border-subtle bg-scroll-bg p-3 text-xs text-foreground"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            {JSON.stringify(trace, null, 2)}
          </pre>
        </details>
      </td>
    </tr>
  );
}
